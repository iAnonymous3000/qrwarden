import { afterEach, describe, expect, it, vi } from "vitest";

import { DecoderWorkerClient, STARTUP_TIMEOUT_MS } from "../../src/decoder";
import {
  replayServiceWorkerStatus,
  requestPendingShare,
  ServiceWorkerClient,
  type OfflineState,
  type WorkerState,
} from "../../src/sw/client";

type EventHandler = (event: Record<string, unknown>) => void;

class FakePort {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  peer: FakePort | null = null;

  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }

  close(): void {}
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeWorker {
  state: ServiceWorkerState = "activated";
  response: WorkerState | "malformed" | null;
  queryCount = 0;
  stateListenerAdds = 0;
  responseDelayMs = 0;
  readonly messages: Array<{ readonly type?: string }> = [];
  throwsOnPost = false;
  readonly #listeners = new Set<() => void>();

  constructor(response: WorkerState | "malformed" | null) {
    this.response = response;
  }

  postMessage(message: { readonly type?: string }, transfer?: readonly FakePort[]): void {
    if (this.throwsOnPost) throw new DOMException("Worker unavailable", "InvalidStateError");
    this.messages.push(message);
    if (message.type !== "QUERY_WORKER_STATE") return;
    this.queryCount += 1;
    if (this.response === null) return;
    const data = this.response === "malformed"
      ? { type: "WORKER_STATE", releaseId: 7 }
      : { type: "WORKER_STATE", ...this.response };
    const respond = (): void => transfer?.[0]?.postMessage(data);
    if (this.responseDelayMs > 0) {
      setTimeout(respond, this.responseDelayMs);
    } else {
      respond();
    }
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "statechange") {
      this.stateListenerAdds += 1;
      this.#listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "statechange") this.#listeners.delete(listener);
  }

  transition(state: ServiceWorkerState): void {
    this.state = state;
    for (const listener of this.#listeners) listener();
  }
}

interface Harness {
  readonly registration: {
    active: FakeWorker | null;
    waiting: FakeWorker | null;
    installing: FakeWorker | null;
    readonly update: ReturnType<typeof vi.fn>;
  };
  readonly serviceWorkers: {
    controller: FakeWorker | null;
    readonly getRegistration: ReturnType<typeof vi.fn>;
    readonly register: ReturnType<typeof vi.fn>;
  };
  readonly windowHandlers: Map<string, EventHandler>;
  readonly workerHandlers: Map<string, EventHandler>;
  readonly storage: Map<string, string>;
}

const RELEASE = `v0.1.0+${"1".repeat(40)}`;

function installHarness(worker: FakeWorker | null): Harness {
  const windowHandlers = new Map<string, EventHandler>();
  const workerHandlers = new Map<string, EventHandler>();
  const documentHandlers = new Map<string, EventHandler>();
  const storage = new Map<string, string>();
  const registration = {
    active: worker,
    waiting: null,
    installing: null,
    update: vi.fn(() => Promise.resolve()),
  };
  const serviceWorkers = {
    controller: worker,
    getRegistration: vi.fn(() => Promise.resolve(registration)),
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: vi.fn((type: string, handler: EventHandler) => {
      workerHandlers.set(type, handler);
    }),
  };
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  vi.stubGlobal("window", {
    isSecureContext: true,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, handler: EventHandler) => {
      windowHandlers.set(type, handler);
    },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type: string, handler: EventHandler) => {
      documentHandlers.set(type, handler);
    },
  });
  vi.stubGlobal("navigator", {
    onLine: true,
    serviceWorker: serviceWorkers,
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  return {
    registration,
    serviceWorkers,
    windowHandlers,
    workerHandlers,
    storage,
  };
}

function createClient(overrides: Partial<{
  readonly loadedRelease: string;
  readonly isIdle: () => boolean;
  readonly onLockChange: (locked: boolean) => void;
  readonly onState: (state: OfflineState) => void;
  readonly dropReport: () => void;
  readonly decoderSmoke: () => Promise<boolean>;
  readonly reload: () => void;
}> = {}): ServiceWorkerClient {
  return new ServiceWorkerClient({
    loadedRelease: overrides.loadedRelease ?? RELEASE,
    scriptURL: "/sw.js",
    isIdle: overrides.isIdle ?? (() => true),
    onLockChange: overrides.onLockChange ?? (() => undefined),
    onState: overrides.onState ?? (() => undefined),
    dropReport: overrides.dropReport ?? (() => undefined),
    decoderSmoke: overrides.decoderSmoke ?? (() => Promise.resolve(true)),
    reload: overrides.reload ?? (() => undefined),
  });
}

function readyState(cacheVerified = true): WorkerState {
  return {
    releaseId: RELEASE,
    transactionState: "idle",
    cacheVerified,
    cacheVerification: cacheVerified ? "verified" : "pending",
  };
}

function failedCacheState(): WorkerState {
  return {
    releaseId: RELEASE,
    transactionState: "idle",
    cacheVerified: false,
    cacheVerification: "failed",
  };
}

function waitingState(): WorkerState {
  return {
    releaseId: `v0.2.0+${"2".repeat(40)}`,
    transactionState: "idle",
    cacheVerified: true,
    cacheVerification: "verified",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("service-worker release gate races", () => {
  it("replays the latest status snapshot after the subscriber is installed", async () => {
    let current = { offlineState: "preparing" as OfflineState, locked: true };
    const publish = vi.fn();

    replayServiceWorkerStatus(() => current, publish);
    current = { offlineState: "ready", locked: false };
    await Promise.resolve();

    expect(publish).toHaveBeenCalledWith({
      offlineState: "ready",
      locked: false,
    });
  });

  it("keeps controls usable when registration lookup is blocked", async () => {
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockRejectedValueOnce(
      new DOMException("Storage blocked", "SecurityError"),
    );
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "incomplete",
    });
    expect(locks.at(-1)).toBe(false);
    expect(states.at(-1)).toBe("incomplete");
  });

  it("stays locked when registration lookup cannot verify an active controller", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    harness.serviceWorkers.getRegistration.mockRejectedValueOnce(
      new DOMException("Storage blocked", "SecurityError"),
    );
    const dropReport = vi.fn();
    const client = createClient({ dropReport });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(dropReport).toHaveBeenCalledOnce();
  });

  it("keeps controls usable when first registration is blocked", async () => {
    const harness = installHarness(null);
    harness.serviceWorkers.register.mockRejectedValueOnce(
      new DOMException("Registration blocked", "SecurityError"),
    );
    const client = createClient();

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "incomplete",
    });
  });

  it("continues without a reload marker when session storage is unavailable", async () => {
    const worker = new FakeWorker(readyState());
    installHarness(worker);
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
    const client = createClient();

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "ready",
    });
  });

  it("stays locked when a known post-update registration check fails", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    harness.storage.set("qrwarden-update-check", RELEASE);
    harness.serviceWorkers.getRegistration.mockRejectedValueOnce(
      new DOMException("Registration blocked", "SecurityError"),
    );
    const dropReport = vi.fn();
    const client = createClient({ dropReport });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(dropReport).toHaveBeenCalledOnce();
  });

  it("stays locked instead of reload-looping when marker storage is blocked", async () => {
    const mismatchedWorker = new FakeWorker(waitingState());
    installHarness(mismatchedWorker);
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      removeItem: () => undefined,
    });
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const reload = vi.fn();
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      reload,
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(locks.at(-1)).toBe(true);
    expect(states.at(-1)).toBe("update-failed");
  });

  it("recovers a release mismatch by expecting the serving worker's release", async () => {
    const worker = new FakeWorker(waitingState());
    const harness = installHarness(worker);
    const reload = vi.fn();
    const dropReport = vi.fn();
    const client = createClient({ reload, dropReport });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(dropReport).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    // The marker must name the release the reloaded document will actually
    // run — the controlling worker's — not the dying page's.
    expect(harness.storage.get("qrwarden-update-check")).toBe(
      waitingState().releaseId,
    );

    // The reloaded document runs the worker's release and must be accepted.
    const reloaded = createClient({ loadedRelease: waitingState().releaseId });
    await expect(reloaded.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "ready",
    });
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);
  });

  it("clears a poisoned reload marker so the tab session can recover", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    harness.storage.set("qrwarden-update-check", `v0.0.9+${"3".repeat(40)}`);
    const reload = vi.fn();
    const states: OfflineState[] = [];
    const client = createClient({
      onState: (state) => states.push(state),
      reload,
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);

    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
  });

  it("keeps a timed-out query locked and retries instead of treating it as a mismatch", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(null);
    const harness = installHarness(worker);
    harness.storage.set("qrwarden-update-check", RELEASE);
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const dropReport = vi.fn();
    const reload = vi.fn();
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      dropReport,
      reload,
    });

    const gate = client.gate();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(gate).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "preparing",
    });
    expect(locks.at(-1)).toBe(true);
    expect(dropReport).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(harness.storage.get("qrwarden-update-check")).toBe(RELEASE);

    worker.response = readyState();
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("ready");
    expect(locks.at(-1)).toBe(false);
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);
  });

  it.each([
    ["a controlled release", false],
    ["a post-update release", true],
  ] as const)(
    "bounds persistent worker-query failures for %s",
    async (_label, hasMarker) => {
      vi.useFakeTimers();
      const worker = new FakeWorker(null);
      const harness = installHarness(worker);
      if (hasMarker) harness.storage.set("qrwarden-update-check", RELEASE);
      const locks: boolean[] = [];
      const states: OfflineState[] = [];
      const dropReport = vi.fn();
      const client = createClient({
        onLockChange: (locked) => locks.push(locked),
        onState: (state) => states.push(state),
        dropReport,
      });

      const first = client.gate();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toEqual({
        controlsEnabled: false,
        offlineState: "preparing",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(2_500);

      expect(states.at(-1)).toBe("update-failed");
      expect(locks.at(-1)).toBe(true);
      expect(dropReport).toHaveBeenCalledOnce();
      expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(3);
      if (hasMarker) {
        expect(harness.storage.get("qrwarden-update-check")).toBe(RELEASE);
      }

      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(3);
    },
  );

  it("degrades an unresponsive controller-free registration without polling forever", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(null);
    const harness = installHarness(worker);
    harness.serviceWorkers.controller = null;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const dropReport = vi.fn();
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      dropReport,
    });

    const first = client.gate();
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(states.at(-1)).toBe("incomplete");
    expect(locks.at(-1)).toBe(false);
    expect(dropReport).not.toHaveBeenCalled();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(3);

    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await Promise.resolve();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(3);
    expect(locks.at(-1)).toBe(false);
  });

  it.each([false, true])(
    "ignores an unresponsive waiting worker after required state is verified (marker: %s)",
    async (hasMarker) => {
      vi.useFakeTimers();
      const active = new FakeWorker(readyState());
      const waiting = new FakeWorker(null);
      const harness = installHarness(active);
      harness.registration.waiting = waiting;
      if (hasMarker) harness.storage.set("qrwarden-update-check", RELEASE);
      const client = createClient();

      const gate = client.gate();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(gate).resolves.toEqual({
        controlsEnabled: true,
        offlineState: "ready",
      });
      expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();
      expect(harness.storage.has("qrwarden-update-check")).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();
    },
  );

  it("bounds a registration lookup that never settles", async () => {
    vi.useFakeTimers();
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const client = createClient();

    const gate = client.gate();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(gate).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "incomplete",
    });
    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await Promise.resolve();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();
  });

  it("bounds a first registration that never settles", async () => {
    vi.useFakeTimers();
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockResolvedValueOnce(undefined);
    harness.serviceWorkers.register.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const client = createClient();

    const gate = client.gate();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(gate).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "incomplete",
    });
    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await Promise.resolve();
    expect(harness.serviceWorkers.register).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent lifecycle gates into one registration pass", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    let resolveRegistration!: (value: typeof harness.registration) => void;
    harness.serviceWorkers.getRegistration.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRegistration = resolve;
      }),
    );
    const decoderSmoke = vi.fn(() => Promise.resolve(true));
    const client = createClient({ decoderSmoke });

    const first = client.gate();
    const second = client.gate();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();
    resolveRegistration(harness.registration);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { controlsEnabled: true, offlineState: "ready" },
      { controlsEnabled: true, offlineState: "ready" },
    ]);
    expect(worker.queryCount).toBe(2);
    expect(decoderSmoke).toHaveBeenCalledOnce();
  });

  it("re-gates pages restored from bfcache but ignores ordinary pageshow", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    const client = createClient();
    await client.gate();
    const pageshow = harness.windowHandlers.get("pageshow");
    expect(pageshow).toBeDefined();

    pageshow?.({ persisted: false });
    await Promise.resolve();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();

    pageshow?.({ persisted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(2);
  });

  it("retains the reload marker until cache and decoder validation succeed", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(readyState(false));
    const harness = installHarness(worker);
    harness.storage.set("qrwarden-update-check", RELEASE);
    const client = createClient();

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "preparing",
    });
    expect(harness.storage.get("qrwarden-update-check")).toBe(RELEASE);

    worker.response = readyState(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);
  });

  it("settles the gate fail-closed when the decoder worker never becomes ready", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(readyState());
    installHarness(worker);
    class SilentDecoderWorker extends EventTarget {
      readonly postMessage = vi.fn();
      readonly terminate = vi.fn();
    }
    // Mirrors the main.tsx smoke wiring: a decoder worker that starts but
    // never posts "ready" must not leave gate() pending with controls locked.
    const decoderSmoke = async (): Promise<boolean> => {
      const decoder = new DecoderWorkerClient(
        () => new SilentDecoderWorker() as unknown as Worker,
      );
      try {
        await decoder.start();
        await decoder.smoke(0);
        return true;
      } catch {
        return false;
      } finally {
        decoder.dispose("cancelled");
      }
    };
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      decoderSmoke,
    });

    const gate = client.gate();
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);

    await expect(gate).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(locks.at(-1)).toBe(true);
    expect(states.at(-1)).toBe("update-failed");
  });

  it("keeps the reload marker when post-reload decoder validation fails", async () => {
    const worker = new FakeWorker(readyState());
    const harness = installHarness(worker);
    harness.storage.set("qrwarden-update-check", RELEASE);
    const dropReport = vi.fn();
    const client = createClient({
      decoderSmoke: () => Promise.resolve(false),
      dropReport,
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: false,
      offlineState: "update-failed",
    });
    expect(harness.storage.get("qrwarden-update-check")).toBe(RELEASE);
    expect(dropReport).toHaveBeenCalledOnce();
  });

  it("converges a completed cache failure without polling forever", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(failedCacheState());
    const harness = installHarness(worker);
    const client = createClient();

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "incomplete",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledOnce();
    expect(worker.queryCount).toBe(2);
  });

  it("publishes first-install readiness after the non-blocking preparing result", async () => {
    const installing = new FakeWorker(null);
    installing.state = "installing";
    const active = new FakeWorker(readyState());
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockResolvedValueOnce(undefined);
    harness.registration.installing = installing;
    const states: OfflineState[] = [];
    const client = createClient({ onState: (state) => states.push(state) });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "preparing",
    });
    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(installing.stateListenerAdds).toBe(1);
    harness.registration.active = active;
    harness.serviceWorkers.controller = active;
    installing.transition("activated");
    await vi.waitFor(() => expect(states).toContain("ready"));
  });

  it("defers the uncontrolled first-install reload until the runtime is idle", async () => {
    vi.useFakeTimers();
    const installing = new FakeWorker(null);
    installing.state = "installing";
    const active = new FakeWorker(readyState());
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockResolvedValueOnce(undefined);
    harness.registration.installing = installing;
    let idle = false;
    const reload = vi.fn();
    const dropReport = vi.fn();
    const client = createClient({ isIdle: () => idle, reload, dropReport });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "preparing",
    });
    harness.registration.active = active;
    harness.registration.installing = null;
    installing.transition("activated");
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();

    // Still mid-scan at the first recheck: the reload keeps waiting.
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).not.toHaveBeenCalled();

    idle = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledOnce();
    expect(dropReport).not.toHaveBeenCalled();
  });

  it("finishes a deferred first install without reloading once claim lands", async () => {
    vi.useFakeTimers();
    const installing = new FakeWorker(null);
    installing.state = "installing";
    const active = new FakeWorker(readyState());
    const harness = installHarness(null);
    harness.serviceWorkers.getRegistration.mockResolvedValueOnce(undefined);
    harness.registration.installing = installing;
    const idle = false;
    const reload = vi.fn();
    const states: OfflineState[] = [];
    const client = createClient({
      isIdle: () => idle,
      reload,
      onState: (state) => states.push(state),
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "preparing",
    });
    harness.registration.active = active;
    harness.registration.installing = null;
    installing.transition("activated");
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();

    // clients.claim() hands over control while the deferral timer is pending.
    harness.serviceWorkers.controller = active;
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(states).toContain("ready"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("retries an empty registration left by a failed first install", async () => {
    const installing = new FakeWorker(null);
    installing.state = "installing";
    const active = new FakeWorker(readyState());
    const harness = installHarness(null);
    harness.serviceWorkers.register.mockImplementationOnce(() => {
      harness.registration.installing = installing;
      return Promise.resolve(harness.registration);
    });
    const states: OfflineState[] = [];
    const dropReport = vi.fn();
    const reload = vi.fn();
    const client = createClient({
      onState: (state) => states.push(state),
      dropReport,
      reload,
    });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "preparing",
    });
    expect(harness.serviceWorkers.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      type: "module",
      updateViaCache: "none",
    });
    expect(dropReport).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    harness.registration.active = active;
    harness.serviceWorkers.controller = active;
    installing.transition("activated");
    await vi.waitFor(() => expect(states).toContain("ready"));
  });
});

describe("idle update checks", () => {
  it("bridges an update that is still installing when the check runs", async () => {
    const active = new FakeWorker(readyState());
    const harness = installHarness(active);
    const installing = new FakeWorker(null);
    installing.state = "installing";
    const waiting = new FakeWorker(waitingState());
    harness.registration.update.mockImplementation(() => {
      harness.registration.installing = installing;
      return Promise.resolve();
    });
    const states: OfflineState[] = [];
    const client = createClient({ onState: (state) => states.push(state) });
    await client.gate();

    const check = client.checkForUpdateWhenIdle();
    await vi.waitFor(() => expect(installing.stateListenerAdds).toBe(1));
    harness.registration.installing = null;
    harness.registration.waiting = waiting;
    installing.transition("installed");
    await check;

    expect(states.at(-1)).toBe("update-ready");
  });

  it("abandons an idle check whose new worker becomes redundant", async () => {
    const active = new FakeWorker(readyState());
    const harness = installHarness(active);
    const installing = new FakeWorker(null);
    installing.state = "installing";
    harness.registration.update.mockImplementation(() => {
      harness.registration.installing = installing;
      return Promise.resolve();
    });
    const states: OfflineState[] = [];
    const client = createClient({ onState: (state) => states.push(state) });
    await client.gate();

    const check = client.checkForUpdateWhenIdle();
    await vi.waitFor(() => expect(installing.stateListenerAdds).toBe(1));
    harness.registration.installing = null;
    installing.transition("redundant");
    await check;

    expect(states.at(-1)).toBe("ready");
    expect(active.messages).not.toContainEqual(
      expect.objectContaining({ type: "CLEANUP_STALE_CACHES" }),
    );
  });
});

describe("pending share marker pull", () => {
  it("reports a posted pull only for a live controller", () => {
    const token = "a".repeat(32);
    expect(requestPendingShare(null, token)).toBe(false);

    const controller = new FakeWorker(null);
    expect(
      requestPendingShare(controller as unknown as ServiceWorker, token),
    ).toBe(true);
    expect(controller.messages).toContainEqual({
      type: "PULL_SHARED_IMAGE",
      token,
    });
  });

  it("refuses malformed or ambiguous share capabilities", () => {
    const controller = new FakeWorker(null);

    for (const token of [
      "",
      "a".repeat(31),
      "A".repeat(32),
      `${"a".repeat(32)}x`,
    ]) {
      expect(
        requestPendingShare(controller as unknown as ServiceWorker, token),
      ).toBe(false);
    }
    expect(controller.messages).toHaveLength(0);
  });

  it("survives a redundant controller rejecting the pull", () => {
    const controller = new FakeWorker(null);
    controller.throwsOnPost = true;

    expect(
      requestPendingShare(
        controller as unknown as ServiceWorker,
        "b".repeat(32),
      ),
    ).toBe(false);
  });
});

describe("waiting update activation", () => {
  it("reports busy without messaging the waiting worker when work is active", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    let idle = true;
    const client = createClient({ isIdle: () => idle });

    await expect(client.gate()).resolves.toEqual({
      controlsEnabled: true,
      offlineState: "update-ready",
    });
    idle = false;

    expect(client.activateWaitingUpdate()).toEqual({ status: "busy" });
    expect(waiting.messages).not.toContainEqual({
      type: "BEGIN_UPDATE_COORDINATION",
    });
  });

  it("reports started after messaging an idle waiting worker", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const client = createClient();

    await client.gate();

    expect(client.activateWaitingUpdate()).toEqual({ status: "started" });
    expect(waiting.messages).toContainEqual({
      type: "BEGIN_UPDATE_COORDINATION",
    });
  });

  it("restores a deferred waiting update as unlocked and retryable", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
    });
    const nonce = "a".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    expect(message).toBeDefined();
    locks.length = 0;
    states.length = 0;
    expect(client.activateWaitingUpdate()).toEqual({ status: "started" });
    message?.({
      data: { type: "PREPARE_UPDATE", nonce, release },
      source: waiting,
    });
    expect(locks.at(-1)).toBe(true);
    expect(waiting.messages).toContainEqual({ type: "READY", nonce, release });

    message?.({
      data: { type: "RELEASE_UPDATE_PREPARE", nonce, release },
      source: waiting,
    });

    await vi.waitFor(() => expect(states.at(-1)).toBe("update-ready"));
    expect(states).not.toContain("update-failed");
    expect(locks.at(-1)).toBe(false);
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(2);
    expect(client.activateWaitingUpdate()).toEqual({ status: "started" });
    expect(
      waiting.messages.filter((entry) => entry.type === "BEGIN_UPDATE_COORDINATION"),
    ).toHaveLength(2);
  });

  it("retains update-failed for a genuine activation failure", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
    });
    const nonce = "b".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    expect(message).toBeDefined();
    locks.length = 0;
    states.length = 0;
    message?.({
      data: { type: "PREPARE_UPDATE", nonce, release },
      source: waiting,
    });
    expect(locks.at(-1)).toBe(true);

    message?.({
      data: { type: "ACTIVATION_FAILED", nonce, release },
      source: waiting,
    });

    await vi.waitFor(() => expect(states.at(-1)).toBe("update-failed"));
    expect(locks.at(-1)).toBe(false);
  });

  it("does not retry lease reconciliation forever when workers stop responding", async () => {
    vi.useFakeTimers();
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const reload = vi.fn();
    const client = createClient({ reload });
    const nonce = "c".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    message?.({
      data: { type: "PREPARE_UPDATE", nonce, release },
      source: waiting,
    });
    active.response = null;
    waiting.response = null;
    message?.({
      data: { type: "ACTIVATION_COMMITTED", nonce, release },
      source: waiting,
    });

    await vi.advanceTimersByTimeAsync(32_000);

    expect(reload).toHaveBeenCalledOnce();
    expect(harness.storage.get("qrwarden-update-check")).toBe(release);
  });

  it("does not mark an unresponsive failed activation as committed", async () => {
    vi.useFakeTimers();
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const reload = vi.fn();
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      reload,
    });
    const nonce = "d".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    message?.({
      data: { type: "PREPARE_UPDATE", nonce, release },
      source: waiting,
    });
    active.response = null;
    waiting.response = null;
    message?.({
      data: { type: "ACTIVATION_FAILED", nonce, release },
      source: waiting,
    });

    await vi.advanceTimersByTimeAsync(62_000);

    expect(reload).not.toHaveBeenCalled();
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);
    expect(states.at(-1)).toBe("update-failed");
    expect(locks.at(-1)).toBe(false);
  });

  it("keeps an unknown unresponsive lease locked without writing a marker", async () => {
    vi.useFakeTimers();
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const dropReport = vi.fn();
    const reload = vi.fn();
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
      dropReport,
      reload,
    });
    const nonce = "e".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    message?.({
      data: { type: "PREPARE_UPDATE", nonce, release },
      source: waiting,
    });
    active.response = null;
    waiting.response = null;

    await vi.advanceTimersByTimeAsync(62_000);

    expect(reload).not.toHaveBeenCalled();
    expect(harness.storage.has("qrwarden-update-check")).toBe(false);
    expect(dropReport).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("update-failed");
    expect(locks.at(-1)).toBe(true);

    active.response = readyState();
    waiting.response = waitingState();
    message?.({
      data: { type: "ACTIVATION_FAILED", nonce, release },
      source: waiting,
    });
    await vi.waitFor(() => expect(locks.at(-1)).toBe(false));
    harness.windowHandlers.get("pageshow")?.({ persisted: true });
    await vi.waitFor(() => expect(states.at(-1)).toBe("update-ready"));
    expect(locks.at(-1)).toBe(false);
  });

  it("does not let stale lease reconciliation release a newer lease", async () => {
    vi.useFakeTimers();
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const locks: boolean[] = [];
    const states: OfflineState[] = [];
    const client = createClient({
      onLockChange: (locked) => locks.push(locked),
      onState: (state) => states.push(state),
    });
    const firstNonce = "f".repeat(32);
    const secondNonce = "0".repeat(32);
    const release = waitingState().releaseId;

    await client.gate();
    const message = harness.workerHandlers.get("message");
    message?.({
      data: { type: "PREPARE_UPDATE", nonce: firstNonce, release },
      source: waiting,
    });
    active.responseDelayMs = 1_000;
    waiting.responseDelayMs = 1_000;
    message?.({
      data: { type: "ACTIVATION_FAILED", nonce: firstNonce, release },
      source: waiting,
    });
    message?.({
      data: { type: "RELEASE_UPDATE_PREPARE", nonce: firstNonce, release },
      source: waiting,
    });
    message?.({
      data: { type: "PREPARE_UPDATE", nonce: secondNonce, release },
      source: waiting,
    });
    locks.length = 0;
    states.length = 0;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(locks).not.toContain(false);
    expect(states).not.toContain("update-failed");
  });

  it("reports unavailable and reconciles when no waiting worker remains", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const states: OfflineState[] = [];
    const client = createClient({ onState: (state) => states.push(state) });

    await client.gate();
    harness.registration.waiting = null;

    expect(client.activateWaitingUpdate()).toEqual({ status: "unavailable" });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable and reconciles when the waiting worker rejects the message", async () => {
    const active = new FakeWorker(readyState());
    const waiting = new FakeWorker(waitingState());
    const harness = installHarness(active);
    harness.registration.waiting = waiting;
    const states: OfflineState[] = [];
    const client = createClient({ onState: (state) => states.push(state) });

    await client.gate();
    waiting.throwsOnPost = true;

    expect(client.activateWaitingUpdate()).toEqual({ status: "unavailable" });
    harness.registration.waiting = null;
    await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
    expect(harness.serviceWorkers.getRegistration).toHaveBeenCalledTimes(2);
  });
});
