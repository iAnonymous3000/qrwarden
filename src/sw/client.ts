import type { QrwardenTrustedScriptURL } from "../app/trustedScripts";

const QUERY_TIMEOUT_MS = 2_000;
const QUERY_RETRY_MS = 500;
const PREPARE_LEASE_MS = 60_000;
const UPDATE_MARKER = "qrwarden-update-check";

export type OfflineState =
  | "preparing"
  | "ready"
  | "incomplete"
  | "update-ready"
  | "update-failed";

export interface WorkerState {
  readonly releaseId: string;
  readonly transactionState:
    | "idle"
    | "preparing"
    | "finalizing"
    | "committing";
  readonly cacheVerified: boolean;
  readonly cacheVerification: "pending" | "verified" | "failed";
}

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

interface WorkerMessage {
  readonly type?: string;
  readonly nonce?: string;
  readonly release?: string;
  readonly releaseId?: string;
  readonly transactionState?: WorkerState["transactionState"];
  readonly cacheVerified?: boolean;
  readonly cacheVerification?: WorkerState["cacheVerification"];
}

type WorkerQueryResult =
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "state"; readonly state: WorkerState };

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
    channel.port1.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      const cacheVerification = data.cacheVerification ??
        (data.cacheVerified === true ? "verified" : "pending");
      if (
        data.type !== "WORKER_STATE" ||
        typeof data.releaseId !== "string" ||
        (data.transactionState !== "idle" &&
          data.transactionState !== "preparing" &&
          data.transactionState !== "finalizing" &&
          data.transactionState !== "committing") ||
        typeof data.cacheVerified !== "boolean" ||
        (cacheVerification !== "pending" &&
          cacheVerification !== "verified" &&
          cacheVerification !== "failed") ||
        (cacheVerification === "verified") !== data.cacheVerified
      ) {
        finish({ kind: "unavailable" });
        return;
      }
      finish({
        kind: "state",
        state: {
          releaseId: data.releaseId,
          transactionState: data.transactionState,
          cacheVerified: data.cacheVerified,
          cacheVerification,
        },
      });
    };
    try {
      worker.postMessage({ type: "QUERY_WORKER_STATE" }, [channel.port2]);
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
  #reloadStarted = false;
  #lease: UpdateLease | null = null;
  #listenersInstalled = false;
  #gateInFlight: Promise<ReleaseGateResult> | null = null;
  #gateReplayRequested = false;
  #queryRetryTimer: number | null = null;

  constructor(options: ServiceWorkerClientOptions) {
    this.#options = options;
  }

  async gate(): Promise<ReleaseGateResult> {
    // Lifecycle callers must synchronously disable every report/action control
    // before the first asynchronous registration query can yield.
    this.#options.onLockChange(true);
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
    this.#installListeners();
    const expectedAfterReload = sessionStorage.getItem(UPDATE_MARKER);

    let registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) {
      this.#firstInstall = true;
      registration = await navigator.serviceWorker.register(this.#options.scriptURL, {
        scope: "/",
        type: "module",
        updateViaCache: "none",
      });
    }
    this.#registration = registration;

    const [activeQuery, controllerQuery, waitingQuery] = await Promise.all([
      queryWorker(registration.active),
      queryWorker(navigator.serviceWorker.controller),
      queryWorker(registration.waiting),
    ]);
    if (queryUnavailable(activeQuery, controllerQuery, waitingQuery)) {
      this.#scheduleQueryRetry();
      return this.#applyGateResult(false, "preparing");
    }
    this.#clearQueryRetry();
    const active = queriedState(activeQuery);
    const controller = queriedState(controllerQuery);
    const waiting = queriedState(waitingQuery);

    if (expectedAfterReload !== null) {
      if (
        expectedAfterReload === this.#options.loadedRelease &&
        active?.releaseId === expectedAfterReload &&
        controller?.releaseId === expectedAfterReload
      ) {
        const readiness = await this.#readinessState(active);
        if (readiness === "ready") {
          sessionStorage.removeItem(UPDATE_MARKER);
          return this.#applyGateResult(true, readiness);
        }
        if (readiness === "preparing") {
          this.#scheduleQueryRetry(QUERY_TIMEOUT_MS);
          return this.#applyGateResult(false, readiness);
        }
        this.#options.dropReport();
        return this.#applyGateResult(false, "update-failed");
      }
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
    this.#guardedReload(this.#options.loadedRelease);
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
      waiting.postMessage({ type: "BEGIN_UPDATE_COORDINATION" });
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
      this.#handleWorkerMessage(event);
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      this.#options.onLockChange(true);
      void this.#handleControllerChange();
    });
    window.addEventListener("pageshow", (event) => {
      if ((event as PageTransitionEvent).persisted) {
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
    return smokePassed ? "ready" : "incomplete";
  }

  async #completeReadiness(active: WorkerState): Promise<ReleaseGateResult> {
    const state = await this.#readinessState(active);
    if (state === "preparing") {
      this.#scheduleQueryRetry(QUERY_TIMEOUT_MS);
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
        this.#scheduleQueryRetry();
        this.#applyGateResult(false, "preparing");
        return;
      }
      const active = queriedState(activeQuery);
      if (active?.releaseId !== this.#options.loadedRelease) {
        throw new DOMException("First install release mismatch", "SecurityError");
      }
      if (navigator.serviceWorker.controller === null) {
        this.#guardedReload(this.#options.loadedRelease);
        return;
      }
      const controllerQuery = await queryWorker(
        navigator.serviceWorker.controller,
      );
      if (controllerQuery.kind === "unavailable") {
        this.#scheduleQueryRetry();
        this.#applyGateResult(false, "preparing");
        return;
      }
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

  #handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
    const message = event.data;
    if (
      message.type === "PREPARE_UPDATE" &&
      typeof message.nonce === "string" &&
      typeof message.release === "string"
    ) {
      const source = event.source;
      if (this.#leaseMatches(message)) {
        source?.postMessage({
          type: "READY",
          nonce: message.nonce,
          release: message.release,
        });
        return;
      }
      if (!this.#options.isIdle() || this.#lease !== null) {
        source?.postMessage({
          type: "BUSY",
          nonce: message.nonce,
          release: message.release,
        });
        return;
      }
      this.#acquireLease(message.nonce, message.release);
      source?.postMessage({
        type: "READY",
        nonce: message.nonce,
        release: message.release,
      });
      return;
    }

    if (
      message.type === "REPORT_LOADED_RELEASE" &&
      typeof message.nonce === "string" &&
      /^[0-9a-f]{32}$/.test(message.nonce)
    ) {
      event.source?.postMessage({
        type: "LOADED_RELEASE",
        nonce: message.nonce,
        release: this.#options.loadedRelease,
      });
      return;
    }

    if (
      message.type === "CACHE_VERIFICATION_COMPLETE" &&
      message.release === this.#options.loadedRelease
    ) {
      this.#regateFromLifecycle();
      return;
    }

    if (
      (message.type === "RELEASE_UPDATE_PREPARE" ||
        message.type === "ACTIVATION_FAILED") &&
      this.#leaseMatches(message)
    ) {
      void this.#reconcileLease(false);
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
          void this.#reconcileLease(true);
        }, Math.max(0, shortenedDeadline - performance.now()));
      }
    }
  }

  #joinWaitingUpdate(worker: ServiceWorker | null, state: WorkerState): void {
    if (worker === null || state.transactionState === "idle") {
      return;
    }
    worker.postMessage({
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
    worker.postMessage({
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
      void this.#reconcileLease(true);
    }, PREPARE_LEASE_MS);
    this.#lease = lease;
    this.#options.onLockChange(true);
  }

  #releaseLease(failed: boolean): void {
    if (this.#lease !== null) {
      window.clearTimeout(this.#lease.timeout);
      this.#lease = null;
    }
    this.#options.onLockChange(this.#reloadStarted);
    if (failed) {
      this.#setState("update-failed");
    }
  }

  #leaseMatches(message: WorkerMessage): boolean {
    return (
      this.#lease !== null &&
      message.nonce === this.#lease.nonce &&
      message.release === this.#lease.release
    );
  }

  async #reconcileLease(afterCommit: boolean): Promise<void> {
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
    if (queryUnavailable(activeQuery, controllerQuery, waitingQuery)) {
      if (this.#lease === lease) {
        window.clearTimeout(lease.timeout);
        lease.timeout = window.setTimeout(() => {
          void this.#reconcileLease(afterCommit);
        }, QUERY_RETRY_MS);
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
    if (afterCommit || performance.now() >= lease.deadline) {
      this.#guardedReload(lease.release);
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
    this.#options.onLockChange(true);
    this.#clearQueryRetry();
    if (this.#reloadStarted) {
      this.#options.dropReport();
      this.#setState("update-failed");
      return;
    }
    this.#reloadStarted = true;
    sessionStorage.setItem(UPDATE_MARKER, expectedRelease);
    (this.#options.reload ?? (() => location.reload()))();
  }

  #setState(state: OfflineState): void {
    this.#options.onState(state);
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
    this.#options.onLockChange(!effectiveControlsEnabled);
    this.#setState(offlineState);
    return { controlsEnabled: effectiveControlsEnabled, offlineState };
  }

  #regateFromLifecycle(): void {
    this.#options.onLockChange(true);
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
