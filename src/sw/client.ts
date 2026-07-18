import type { QrwardenTrustedScriptURL } from "../app/trustedScripts";
import {
  postClientToWorker,
  postClientToWorkerWithTransfer,
  readWorkerToClientMessage,
  type WorkerState,
  type WorkerToClientMessage,
} from "./protocol";
import { isSharePendingToken } from "./shareToken";

export type { WorkerState } from "./protocol";

const QUERY_TIMEOUT_MS = 2_000;
const QUERY_RETRY_MS = 500;
const REGISTRATION_TIMEOUT_MS = 10_000;
const MAX_REQUIRED_QUERY_ATTEMPTS = 3;
const PREPARE_LEASE_MS = 60_000;
const UPDATE_MARKER = "qrwarden-update-check";

function readUpdateMarker(): string | null {
  try {
    return sessionStorage.getItem(UPDATE_MARKER);
  } catch {
    return null;
  }
}

function writeUpdateMarker(release: string): boolean {
  try {
    sessionStorage.setItem(UPDATE_MARKER, release);
    return true;
  } catch {
    return false;
  }
}

function removeUpdateMarker(): void {
  try {
    sessionStorage.removeItem(UPDATE_MARKER);
  } catch {
    // Storage-restricted browser sessions remain usable without persistence.
  }
}

export type OfflineState =
  | "preparing"
  | "ready"
  | "incomplete"
  | "update-ready"
  | "update-failed";

export interface ReleaseGateResult {
  readonly controlsEnabled: boolean;
  readonly offlineState: OfflineState;
}

export type WaitingUpdateActivationResult =
  | { readonly status: "started" }
  | { readonly status: "busy" }
  | { readonly status: "unavailable" };

export interface ServiceWorkerStatusSnapshot {
  readonly offlineState: OfflineState;
  readonly locked: boolean;
}

export function replayServiceWorkerStatus(
  read: () => ServiceWorkerStatusSnapshot,
  publish: (snapshot: ServiceWorkerStatusSnapshot) => void,
): void {
  queueMicrotask(() => publish(read()));
}

/**
 * Asks the controlling worker for a parked share-target image. Returns true
 * only when the pull was actually posted: a missing controller cannot serve
 * the pull, and a redundant one throws from postMessage — in both cases the
 * caller must keep the tokenized ?share-pending marker so a reload under the
 * replacing worker can still claim its parked share, and startup must not
 * abort. Invalid tokens never cross the worker boundary.
 */
export function requestPendingShare(
  controller: ServiceWorker | null,
  token: string,
): boolean {
  if (controller === null || !isSharePendingToken(token)) {
    return false;
  }
  try {
    postClientToWorker(controller, { type: "PULL_SHARED_IMAGE", token });
    return true;
  } catch {
    return false;
  }
}

export interface ServiceWorkerClientOptions {
  readonly loadedRelease: string;
  readonly scriptURL: string | URL | QrwardenTrustedScriptURL;
  readonly isIdle: () => boolean;
  readonly onLockChange: (locked: boolean) => void;
  readonly onState: (state: OfflineState) => void;
  readonly dropReport: () => void;
  readonly decoderSmoke: () => Promise<boolean>;
  readonly reload?: () => void;
}

interface UpdateLease {
  readonly nonce: string;
  readonly release: string;
  readonly deadline: number;
  timeout: number;
}

type LeaseReconcileOutcome = "committed" | "failed" | "unknown";

type WorkerQueryResult =
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "state"; readonly state: WorkerState };

function settleBeforeTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Service worker operation timed out", "TimeoutError"));
    }, milliseconds);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function queryWorker(
  worker: ServiceWorker | null,
): Promise<WorkerQueryResult> {
  if (worker === null) {
    return { kind: "absent" };
  }
  return new Promise<WorkerQueryResult>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (result: WorkerQueryResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(result);
    };
    const timeout = window.setTimeout(
      () => finish({ kind: "unavailable" }),
      QUERY_TIMEOUT_MS,
    );
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = readWorkerToClientMessage(event.data);
      if (data?.type !== "WORKER_STATE") {
        finish({ kind: "unavailable" });
        return;
      }
      finish({
        kind: "state",
        state: {
          releaseId: data.releaseId,
          transactionState: data.transactionState,
          cacheVerified: data.cacheVerified,
          cacheVerification: data.cacheVerification,
        },
      });
    };
    try {
      postClientToWorkerWithTransfer(
        worker,
        { type: "QUERY_WORKER_STATE" },
        [channel.port2],
      );
    } catch {
      finish({ kind: "unavailable" });
    }
  });
}

function queriedState(result: WorkerQueryResult): WorkerState | null {
  return result.kind === "state" ? result.state : null;
}

function queryUnavailable(...results: readonly WorkerQueryResult[]): boolean {
  return results.some(({ kind }) => kind === "unavailable");
}

function waitForState(
  worker: ServiceWorker,
  accepted: readonly ServiceWorkerState[],
  milliseconds: number,
): Promise<ServiceWorkerState> {
  if (accepted.includes(worker.state)) {
    return Promise.resolve(worker.state);
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new DOMException("Service worker state timed out", "TimeoutError"));
    }, milliseconds);
    const onChange = (): void => {
      if (accepted.includes(worker.state)) {
        cleanup();
        resolve(worker.state);
      }
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onChange);
    };
    worker.addEventListener("statechange", onChange);
  });
}

export class ServiceWorkerClient {
  readonly #options: ServiceWorkerClientOptions;
  #registration: ServiceWorkerRegistration | null = null;
  #firstInstall = false;
  #firstInstallInFlight: Promise<void> | null = null;
  #firstInstallRecheckTimer: number | null = null;
  #reloadStarted = false;
  #lease: UpdateLease | null = null;
  #listenersInstalled = false;
  #gateInFlight: Promise<ReleaseGateResult> | null = null;
  #gateReplayRequested = false;
  #queryRetryTimer: number | null = null;
  #requiredQueryAttempts = 0;
  #terminalGateResult: ReleaseGateResult | null = null;

  constructor(options: ServiceWorkerClientOptions) {
    this.#options = options;
  }

  async gate(): Promise<ReleaseGateResult> {
    if (this.#terminalGateResult !== null) {
      return this.#applyGateResult(
        this.#terminalGateResult.controlsEnabled,
        this.#terminalGateResult.offlineState,
      );
    }
    // Lifecycle callers must synchronously disable every report/action control
    // before the first asynchronous registration query can yield.
    this.#publishLock(true);
    if (this.#gateInFlight !== null) {
      return this.#gateInFlight;
    }
    const run = this.#runGate();
    this.#gateInFlight = run;
    try {
      return await run;
    } finally {
      if (this.#gateInFlight === run) {
        this.#gateInFlight = null;
      }
      if (this.#gateReplayRequested) {
        this.#gateReplayRequested = false;
        queueMicrotask(() => this.#regateFromLifecycle());
      }
    }
  }

  async #runGate(): Promise<ReleaseGateResult> {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return this.#applyGateResult(true, "incomplete");
    }
    const expectedAfterReload = readUpdateMarker();

    let registration: ServiceWorkerRegistration;
    try {
      this.#installListeners();
      const existing = await settleBeforeTimeout(
        navigator.serviceWorker.getRegistration("/"),
        REGISTRATION_TIMEOUT_MS,
      );
      if (
        existing === undefined ||
        (existing.active === null &&
          existing.installing === null &&
          existing.waiting === null)
      ) {
        this.#firstInstall = true;
        registration = await settleBeforeTimeout(
          navigator.serviceWorker.register(this.#options.scriptURL, {
            scope: "/",
            type: "module",
            updateViaCache: "none",
          }),
          REGISTRATION_TIMEOUT_MS,
        );
      } else {
        registration = existing;
      }
    } catch (error) {
      this.#registration = null;
      this.#firstInstall = false;
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";
      if (
        expectedAfterReload !== null ||
        navigator.serviceWorker.controller !== null ||
        this.#lease !== null ||
        this.#reloadStarted
      ) {
        this.#options.dropReport();
        return timedOut
          ? this.#latchGateResult(false, "update-failed")
          : this.#applyGateResult(false, "update-failed");
      }
      return timedOut
        ? this.#latchGateResult(true, "incomplete")
        : this.#applyGateResult(true, "incomplete");
    }
    this.#registration = registration;

    const controllerSnapshot = navigator.serviceWorker.controller;
    const [activeQuery, controllerQuery, waitingQuery] = await Promise.all([
      queryWorker(registration.active),
      queryWorker(controllerSnapshot),
      queryWorker(registration.waiting),
    ]);
    if (
      activeQuery.kind === "unavailable" ||
      controllerQuery.kind === "unavailable"
    ) {
      return this.#handleRequiredQueryFailure(
        expectedAfterReload,
        controllerSnapshot,
      );
    }
    this.#resetRequiredQueryFailures();
    this.#clearQueryRetry();
    const active = queriedState(activeQuery);
    const controller = queriedState(controllerQuery);
    const waiting = waitingQuery.kind === "unavailable"
      ? null
      : queriedState(waitingQuery);

    if (expectedAfterReload !== null) {
      if (
        expectedAfterReload === this.#options.loadedRelease &&
        active?.releaseId === expectedAfterReload &&
        controller?.releaseId === expectedAfterReload
      ) {
        const readiness = await this.#readinessState(active);
        if (readiness === "ready") {
          removeUpdateMarker();
          return this.#applyGateResult(true, readiness);
        }
        if (readiness === "preparing") {
          this.#scheduleQueryRetry(QUERY_TIMEOUT_MS);
          return this.#applyGateResult(false, readiness);
        }
        this.#options.dropReport();
        return this.#applyGateResult(false, "update-failed");
      }
      // A marker that disagrees with the live worker state can never be
      // satisfied by this document; leaving it in sessionStorage would re-fail
      // every later gate, locking the tab for its whole session. Drop it so
      // the next lifecycle regate or manual reload re-evaluates from live
      // worker state, while this gate still fails closed.
      removeUpdateMarker();
      this.#options.dropReport();
      return this.#applyGateResult(false, "update-failed");
    }

    if (
      active?.releaseId === this.#options.loadedRelease &&
      controller?.releaseId === this.#options.loadedRelease
    ) {
      this.#firstInstall = false;
      if (waiting !== null && waiting.releaseId !== this.#options.loadedRelease) {
        if (waiting.transactionState !== "idle") {
          this.#joinWaitingUpdate(registration.waiting, waiting);
          return this.#applyGateResult(false, "update-ready");
        }
        return this.#applyGateResult(true, "update-ready");
      }
      return this.#completeReadiness(active);
    }

    if (this.#firstInstall) {
      const result = this.#applyGateResult(true, "preparing");
      this.#startFirstInstall(registration);
      return result;
    }

    this.#options.dropReport();
    // The reloaded document is served by the controlling worker (or the
    // active worker when uncontrolled), so that release — not this dying
    // page's — is what the post-reload gate must accept.
    const servedRelease = controller?.releaseId ?? active?.releaseId;
    if (servedRelease === undefined) {
      return this.#applyGateResult(false, "update-failed");
    }
    this.#guardedReload(servedRelease);
    return this.#applyGateResult(false, "update-failed");
  }

  async checkForUpdateWhenIdle(): Promise<void> {
    if (
      !this.#options.isIdle() ||
      !navigator.onLine ||
      this.#registration === null ||
      this.#lease !== null
    ) {
      return;
    }
    try {
      await this.#registration.update();
      // update() resolves while a new worker may still be installing; bridge
      // the installing-to-waiting gap so the check observes the parked worker
      // instead of missing the update until the next lifecycle event.
      const installing = this.#registration.installing;
      if (installing !== null) {
        const state = await waitForState(
          installing,
          ["installed", "activated", "redundant"],
          30_000,
        );
        if (state === "redundant") {
          return;
        }
      }
      if (!this.#options.isIdle()) {
        return;
      }
      const waitingQuery = await queryWorker(this.#registration.waiting);
      if (waitingQuery.kind === "unavailable") {
        return;
      }
      const waitingState = queriedState(waitingQuery);
      if (
        waitingState !== null &&
        waitingState.releaseId !== this.#options.loadedRelease
      ) {
        this.#setState("update-ready");
        return;
      }
      this.#requestStaleCacheCleanup();
    } catch {
      // A later online-idle launch retries; active work remains usable.
    }
  }

  activateWaitingUpdate(): WaitingUpdateActivationResult {
    if (!this.#options.isIdle()) {
      return { status: "busy" };
    }
    const waiting = this.#registration?.waiting;
    if (waiting === null || waiting === undefined) {
      queueMicrotask(() => this.#regateFromLifecycle());
      return { status: "unavailable" };
    }
    try {
      postClientToWorker(waiting, { type: "BEGIN_UPDATE_COORDINATION" });
      return { status: "started" };
    } catch {
      queueMicrotask(() => this.#regateFromLifecycle());
      return { status: "unavailable" };
    }
  }

  #installListeners(): void {
    if (this.#listenersInstalled) {
      return;
    }
    this.#listenersInstalled = true;
    navigator.serviceWorker.addEventListener("message", (event) => {
      // #handleWorkerMessage validates every field before acting on it.
      this.#handleWorkerMessage(
        event as MessageEvent<unknown> & { readonly source: ServiceWorker | null },
      );
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      this.#resetRequiredQueryFailures();
      this.#publishLock(true);
      void this.#handleControllerChange();
    });
    window.addEventListener("pageshow", (event) => {
      if ((event).persisted) {
        this.#regateFromLifecycle();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.#regateFromLifecycle();
      }
    });
  }

  async #readinessState(active: WorkerState): Promise<OfflineState> {
    if (active.cacheVerification === "pending") {
      return "preparing";
    }
    if (active.cacheVerification === "failed") return "incomplete";
    const smokePassed = await this.#options.decoderSmoke();
    return smokePassed ? "ready" : "update-failed";
  }

  async #completeReadiness(active: WorkerState): Promise<ReleaseGateResult> {
    const state = await this.#readinessState(active);
    if (state === "preparing") {
      this.#scheduleQueryRetry(QUERY_TIMEOUT_MS);
    }
    if (state === "update-failed") {
      this.#options.dropReport();
      return this.#applyGateResult(false, state);
    }
    return this.#applyGateResult(true, state);
  }

  #startFirstInstall(registration: ServiceWorkerRegistration): void {
    if (this.#firstInstallInFlight !== null) {
      return;
    }
    const run = this.#finishFirstInstall(registration);
    this.#firstInstallInFlight = run;
    void run.then(() => {
      if (this.#firstInstallInFlight === run) {
        this.#firstInstallInFlight = null;
      }
    });
  }

  // Rechecks bypass #regateFromLifecycle on purpose: a regate pulses the
  // lock, which clears open confirmations and flickers controls — exactly
  // the interruption the deferred reload is avoiding.
  #scheduleFirstInstallRecheck(registration: ServiceWorkerRegistration): void {
    if (this.#firstInstallRecheckTimer !== null || this.#reloadStarted) {
      return;
    }
    this.#firstInstallRecheckTimer = window.setTimeout(() => {
      this.#firstInstallRecheckTimer = null;
      if (this.#firstInstall && !this.#reloadStarted) {
        this.#startFirstInstall(registration);
      }
    }, QUERY_RETRY_MS);
  }

  async #finishFirstInstall(
    registration: ServiceWorkerRegistration,
  ): Promise<void> {
    try {
      const installing = registration.installing;
      if (installing !== null) {
        const state = await waitForState(
          installing,
          ["activated", "redundant", "installed"],
          30_000,
        );
        if (state === "redundant") {
          throw new DOMException("First install was redundant", "AbortError");
        }
      }
      const activeQuery = await queryWorker(registration.active);
      if (activeQuery.kind === "unavailable") {
        this.#handleRequiredQueryFailure(
          readUpdateMarker(),
          navigator.serviceWorker.controller,
        );
        return;
      }
      const active = queriedState(activeQuery);
      if (active?.releaseId !== this.#options.loadedRelease) {
        throw new DOMException("First install release mismatch", "SecurityError");
      }
      if (navigator.serviceWorker.controller === null) {
        // clients.claim() usually hands this page to the verified worker
        // without a navigation; the reload is only the fallback for losing
        // that race. It must never land on top of live work, so while the
        // runtime is busy keep rechecking quietly instead of reloading.
        if (!this.#options.isIdle()) {
          this.#scheduleFirstInstallRecheck(registration);
          return;
        }
        this.#guardedReload(this.#options.loadedRelease);
        return;
      }
      const controllerQuery = await queryWorker(
        navigator.serviceWorker.controller,
      );
      if (controllerQuery.kind === "unavailable") {
        this.#handleRequiredQueryFailure(
          readUpdateMarker(),
          navigator.serviceWorker.controller,
        );
        return;
      }
      this.#resetRequiredQueryFailures();
      const controller = queriedState(controllerQuery);
      if (controller?.releaseId !== this.#options.loadedRelease) {
        throw new DOMException("First install controller mismatch", "SecurityError");
      }
      this.#firstInstall = false;
      await this.#completeReadiness(active);
    } catch {
      this.#applyGateResult(true, "incomplete");
    }
  }

  #handleWorkerMessage(
    event: MessageEvent<unknown> & { readonly source: ServiceWorker | null },
  ): void {
    const message = readWorkerToClientMessage(event.data);
    if (message === null) return;
    if (message.type === "PREPARE_UPDATE") {
      const source = event.source;
      if (this.#leaseMatches(message)) {
        if (source !== null) {
          postClientToWorker(source, {
            type: "READY",
            nonce: message.nonce,
            release: message.release,
          });
        }
        return;
      }
      if (!this.#options.isIdle() || this.#lease !== null) {
        if (source !== null) {
          postClientToWorker(source, {
            type: "BUSY",
            nonce: message.nonce,
            release: message.release,
          });
        }
        return;
      }
      this.#acquireLease(message.nonce, message.release);
      if (source !== null) {
        postClientToWorker(source, {
          type: "READY",
          nonce: message.nonce,
          release: message.release,
        });
      }
      return;
    }

    if (message.type === "REPORT_LOADED_RELEASE") {
      if (event.source !== null) {
        postClientToWorker(event.source, {
          type: "LOADED_RELEASE",
          nonce: message.nonce,
          release: this.#options.loadedRelease,
        });
      }
      return;
    }

    if (
      message.type === "CACHE_VERIFICATION_COMPLETE" &&
      message.release === this.#options.loadedRelease
    ) {
      this.#resetRequiredQueryFailures();
      this.#regateFromLifecycle();
      return;
    }

    if (
      message.type === "RELEASE_UPDATE_PREPARE" &&
      this.#leaseMatches(message)
    ) {
      // Another client being busy (or the prepared client set changing) is a
      // benign deferral, not an activation failure. Release this document's
      // prepare lease, then re-read the authoritative worker state so the
      // waiting update remains retryable when it is still present.
      this.#resetRequiredQueryFailures();
      this.#releaseLease(false);
      this.#regateFromLifecycle();
      return;
    }

    if (
      message.type === "ACTIVATION_FAILED" &&
      this.#leaseMatches(message)
    ) {
      this.#resetRequiredQueryFailures();
      void this.#reconcileLease("failed");
      return;
    }

    if (
      (message.type === "RELEASE_UPDATE_PREPARE" ||
        message.type === "ACTIVATION_FAILED" ||
        message.type === "NO_ACTIVE_PREPARE") &&
      this.#lease === null
    ) {
      this.#regateFromLifecycle();
      return;
    }

    if (message.type === "ACTIVATION_COMMITTED" && this.#leaseMatches(message)) {
      const lease = this.#lease;
      if (lease !== null) {
        window.clearTimeout(lease.timeout);
        const shortenedDeadline = Math.min(lease.deadline, performance.now() + 30_000);
        lease.timeout = window.setTimeout(() => {
          void this.#reconcileLease("committed");
        }, Math.max(0, shortenedDeadline - performance.now()));
      }
    }
  }

  #joinWaitingUpdate(worker: ServiceWorker | null, state: WorkerState): void {
    if (worker === null || state.transactionState === "idle") {
      return;
    }
    postClientToWorker(worker, {
      type: "JOIN_UPDATE_STATE",
      loadedRelease: this.#options.loadedRelease,
    });
  }

  #requestStaleCacheCleanup(): void {
    const worker = this.#registration?.active;
    if (worker === null || worker === undefined || !this.#options.isIdle()) return;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    postClientToWorker(worker, {
      type: "CLEANUP_STALE_CACHES",
      nonce,
      release: this.#options.loadedRelease,
    });
  }

  #acquireLease(nonce: string, release: string): void {
    const deadline = performance.now() + PREPARE_LEASE_MS;
    const lease: UpdateLease = {
      nonce,
      release,
      deadline,
      timeout: 0,
    };
    lease.timeout = window.setTimeout(() => {
      void this.#reconcileLease("unknown");
    }, PREPARE_LEASE_MS);
    this.#lease = lease;
    this.#publishLock(true);
  }

  #releaseLease(failed: boolean): void {
    if (this.#lease !== null) {
      window.clearTimeout(this.#lease.timeout);
      this.#lease = null;
    }
    this.#publishLock(this.#reloadStarted);
    if (failed) {
      this.#setState("update-failed");
    }
  }

  #failUnverifiedLease(): void {
    if (this.#lease !== null) {
      window.clearTimeout(this.#lease.timeout);
    }
    this.#options.dropReport();
    this.#latchGateResult(false, "update-failed");
  }

  #leaseMatches(
    message: Extract<WorkerToClientMessage, { readonly nonce: string }>,
  ): boolean {
    return (
      this.#lease !== null &&
      message.nonce === this.#lease.nonce &&
      message.release === this.#lease.release
    );
  }

  async #reconcileLease(outcome: LeaseReconcileOutcome): Promise<void> {
    const lease = this.#lease;
    const registration = this.#registration;
    if (lease === null || registration === null) {
      return;
    }
    const [activeQuery, controllerQuery, waitingQuery] = await Promise.all([
      queryWorker(registration.active),
      queryWorker(navigator.serviceWorker.controller),
      queryWorker(registration.waiting),
    ]);
    if (this.#lease !== lease) {
      return;
    }
    if (queryUnavailable(activeQuery, controllerQuery, waitingQuery)) {
      const remaining = lease.deadline - performance.now();
      if (outcome === "committed") {
        this.#guardedReload(lease.release);
        return;
      }
      if (remaining <= 0) {
        if (outcome === "failed") {
          this.#releaseLease(true);
        } else {
          this.#failUnverifiedLease();
        }
        return;
      }
      if (this.#lease === lease) {
        window.clearTimeout(lease.timeout);
        lease.timeout = window.setTimeout(() => {
          void this.#reconcileLease(outcome);
        }, Math.min(QUERY_RETRY_MS, remaining));
      }
      return;
    }
    const active = queriedState(activeQuery);
    const controller = queriedState(controllerQuery);
    const waiting = queriedState(waitingQuery);
    if (
      active?.releaseId === lease.release ||
      controller?.releaseId === lease.release
    ) {
      this.#guardedReload(lease.release);
      return;
    }
    if (
      active?.releaseId === this.#options.loadedRelease &&
      controller?.releaseId === this.#options.loadedRelease &&
      waiting?.releaseId === lease.release
    ) {
      this.#releaseLease(true);
      return;
    }
    if (outcome === "committed") {
      this.#guardedReload(lease.release);
      return;
    }
    if (performance.now() >= lease.deadline) {
      const currentReleaseVerified =
        active?.releaseId === this.#options.loadedRelease &&
        controller?.releaseId === this.#options.loadedRelease;
      if (outcome === "failed" || currentReleaseVerified) {
        this.#releaseLease(true);
      } else {
        this.#failUnverifiedLease();
      }
    }
  }

  #handleControllerChange(): void {
    const lease = this.#lease;
    if (lease === null) {
      this.#regateFromLifecycle();
      return;
    }
    this.#guardedReload(lease.release);
  }

  #guardedReload(expectedRelease: string): void {
    this.#publishLock(true);
    this.#clearQueryRetry();
    if (this.#reloadStarted) {
      this.#options.dropReport();
      this.#setState("update-failed");
      return;
    }
    this.#reloadStarted = true;
    if (!writeUpdateMarker(expectedRelease)) {
      this.#options.dropReport();
      this.#setState("update-failed");
      return;
    }
    (this.#options.reload ?? (() => location.reload()))();
  }

  #setState(state: OfflineState): void {
    this.#options.onState(state);
  }

  // The gate proposes a lock state, but lease/reload/replay ownership is
  // authoritative. Keeping that derivation here prevents one lifecycle path
  // from publishing an unlock while another still owns the lock.
  #publishLock(requestedLocked: boolean): void {
    const lifecycleRequiresLock =
      this.#lease !== null || this.#reloadStarted || this.#gateReplayRequested;
    const locked = requestedLocked || lifecycleRequiresLock;
    this.#assertLockInvariant(locked);
    this.#options.onLockChange(locked);
  }

  #assertLockInvariant(locked: boolean): void {
    if (!import.meta.env.DEV || locked) return;
    if (
      this.#lease !== null ||
      this.#reloadStarted ||
      this.#gateReplayRequested
    ) {
      throw new Error("Service worker lifecycle attempted an unsafe unlock");
    }
  }

  #scheduleQueryRetry(milliseconds = QUERY_RETRY_MS): void {
    if (this.#queryRetryTimer !== null || this.#reloadStarted) {
      return;
    }
    this.#queryRetryTimer = window.setTimeout(() => {
      this.#queryRetryTimer = null;
      this.#regateFromLifecycle();
    }, milliseconds);
  }

  #handleRequiredQueryFailure(
    expectedAfterReload: string | null,
    controllerSnapshot: ServiceWorker | null,
  ): ReleaseGateResult {
    this.#requiredQueryAttempts += 1;
    if (this.#requiredQueryAttempts < MAX_REQUIRED_QUERY_ATTEMPTS) {
      this.#scheduleQueryRetry();
      return this.#applyGateResult(false, "preparing");
    }

    this.#clearQueryRetry();
    const canDegrade =
      expectedAfterReload === null &&
      controllerSnapshot === null &&
      this.#lease === null &&
      !this.#reloadStarted;
    if (canDegrade) {
      this.#firstInstall = false;
      return this.#latchGateResult(true, "incomplete");
    }

    this.#options.dropReport();
    return this.#latchGateResult(false, "update-failed");
  }

  #latchGateResult(
    controlsEnabled: boolean,
    offlineState: OfflineState,
  ): ReleaseGateResult {
    const result = this.#applyGateResult(controlsEnabled, offlineState);
    this.#terminalGateResult = result;
    return result;
  }

  #resetRequiredQueryFailures(): void {
    this.#requiredQueryAttempts = 0;
    this.#terminalGateResult = null;
    this.#clearQueryRetry();
  }

  #clearQueryRetry(): void {
    if (this.#queryRetryTimer === null) {
      return;
    }
    window.clearTimeout(this.#queryRetryTimer);
    this.#queryRetryTimer = null;
  }

  #applyGateResult(
    controlsEnabled: boolean,
    offlineState: OfflineState,
  ): ReleaseGateResult {
    const effectiveControlsEnabled =
      controlsEnabled && this.#lease === null && !this.#reloadStarted;
    // A lifecycle event that arrives during this gate requests one fresh pass
    // over worker state. Do not publish a transient unlock between those two
    // passes: App could otherwise consume in-memory work and have the replay's
    // immediate lock cancel it. Preserve the effective result for callers and
    // terminal latching; only the UI publication waits for the replay.
    const publishedControlsEnabled =
      effectiveControlsEnabled && !this.#gateReplayRequested;
    this.#publishLock(!publishedControlsEnabled);
    this.#setState(offlineState);
    return { controlsEnabled: effectiveControlsEnabled, offlineState };
  }

  #regateFromLifecycle(): void {
    if (this.#terminalGateResult !== null) {
      this.#applyGateResult(
        this.#terminalGateResult.controlsEnabled,
        this.#terminalGateResult.offlineState,
      );
      return;
    }
    this.#publishLock(true);
    if (this.#gateInFlight !== null) {
      this.#gateReplayRequested = true;
      return;
    }
    void this.gate().catch(() => {
      this.#options.dropReport();
      this.#applyGateResult(false, "update-failed");
    });
  }
}
