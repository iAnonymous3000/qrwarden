import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const precacheInstall = vi.hoisted(() => ({
  current: (): Promise<void> => Promise.resolve(),
}));

vi.mock("workbox-routing", () => ({ registerRoute: vi.fn() }));
vi.mock("workbox-precaching", () => ({
  PrecacheController: class {
    addToCacheList(): void {}
    getCacheKeyForURL(url: string): string {
      return url;
    }
    install(): Promise<void> {
      return precacheInstall.current();
    }
  },
  PrecacheRoute: class {},
}));

type WorkerHandler = (event: {
  readonly data?: unknown;
  readonly ports?: readonly { postMessage: (message: unknown) => void }[];
  readonly source?: unknown;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

interface WorkerHarness {
  readonly handlers: Map<string, WorkerHandler>;
  readonly client: {
    readonly id: string;
    readonly type: "window";
    postMessage(message: Readonly<Record<string, string>>): void;
  };
  readonly clientMessages: Readonly<Record<string, string>>[];
  readonly cache: {
    readonly keys: ReturnType<typeof vi.fn>;
    readonly match: ReturnType<typeof vi.fn>;
    readonly put: ReturnType<typeof vi.fn>;
    readonly delete: ReturnType<typeof vi.fn>;
  };
  readonly cachesOpen: ReturnType<typeof vi.fn>;
  readonly cachesDelete: ReturnType<typeof vi.fn>;
  readonly claim: ReturnType<typeof vi.fn>;
  readonly registration: {
    active: unknown;
    installing: unknown;
    waiting: unknown;
  };
  readonly skipWaiting: ReturnType<typeof vi.fn>;
}

const RELEASE = `v0.1.0+${"2".repeat(40)}`;
const SHELL = new TextEncoder().encode("verified shell\n");
const REVISION = createHash("sha256").update(SHELL).digest("hex");
const INTEGRITY = `sha384-${createHash("sha384").update(SHELL).digest("base64")}`;

interface HarnessClient {
  readonly id: string;
  readonly type: "window";
  readonly url?: string;
  postMessage(message: Readonly<Record<string, string>>): void;
}

async function loadWorker(
  keys: () => Promise<readonly Request[]>,
  extraClients: readonly HarnessClient[] = [],
  match?: () => Promise<Response | undefined>,
): Promise<WorkerHarness> {
  vi.resetModules();
  const handlers = new Map<string, WorkerHandler>();
  const clientMessages: Readonly<Record<string, string>>[] = [];
  let messageHandler: WorkerHandler | null = null;
  const client = {
    id: "client-a",
    type: "window" as const,
    url: "https://qrwarden.test/",
    postMessage(message: Readonly<Record<string, string>>): void {
      clientMessages.push(message);
      if (message.type === "PREPARE_UPDATE" && messageHandler !== null) {
        messageHandler({
          data: {
            type: "READY",
            nonce: message.nonce,
            release: message.release,
          },
          source: client,
          waitUntil: () => undefined,
        });
      }
    },
  };
  const cache = {
    keys: vi.fn(keys),
    match: vi.fn(match ?? (() => Promise.resolve(new Response(SHELL, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })))),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  const registration = { active: null, installing: null, waiting: null };
  const cachesOpen = vi.fn(() => Promise.resolve(cache));
  const cachesDelete = vi.fn(() => Promise.resolve(true));
  const claim = vi.fn(() => Promise.resolve());
  const skipWaiting = vi.fn(() => Promise.resolve());
  const workerGlobal = {
    __WB_MANIFEST: [{ url: "/", revision: REVISION, integrity: INTEGRITY }],
    location: { origin: "https://qrwarden.test" },
    registration,
    clients: {
      matchAll: vi.fn(() => Promise.resolve([client, ...extraClients])),
      claim,
    },
    skipWaiting,
    addEventListener(type: string, handler: WorkerHandler): void {
      handlers.set(type, handler);
      if (type === "message") messageHandler = handler;
    },
  };

  vi.stubGlobal("__QRWARDEN_RELEASE_ID__", RELEASE);
  vi.stubGlobal("__QRWARDEN_PREVIOUS_CACHE__", null);
  vi.stubGlobal("__QRWARDEN_SIZE_MANIFEST__", [{
    url: "/",
    size: SHELL.byteLength,
    mediaType: "text/html; charset=utf-8",
  }]);
  vi.stubGlobal("self", workerGlobal);
  vi.stubGlobal("caches", {
    open: cachesOpen,
    keys: vi.fn(() => Promise.resolve([])),
    delete: cachesDelete,
  });
  vi.stubGlobal("crypto", webcrypto);

  await import("../../src/sw/service-worker");
  return {
    handlers,
    client,
    clientMessages,
    cache,
    cachesOpen,
    cachesDelete,
    claim,
    registration,
    skipWaiting,
  };
}

function invokeWithLifetime(
  handler: WorkerHandler,
  event: Omit<Parameters<WorkerHandler>[0], "waitUntil">,
): Promise<unknown>[] {
  const lifetime: Promise<unknown>[] = [];
  handler({
    ...event,
    waitUntil: (promise) => lifetime.push(promise),
  });
  return lifetime;
}

afterEach(() => {
  vi.useRealTimers();
  precacheInstall.current = () => Promise.resolve();
});

describe("service-worker state contract", () => {
  it("replies immediately and runs one background verification for concurrent queries", async () => {
    let resolveMatch!: (response: Response | undefined) => void;
    const harness = await loadWorker(
      () => Promise.resolve([]),
      [],
      () => new Promise((resolve) => {
        resolveMatch = resolve;
      }),
    );
    const message = harness.handlers.get("message");
    expect(message).toBeDefined();
    const firstPort = { postMessage: vi.fn() };
    const secondPort = { postMessage: vi.fn() };

    const firstLifetime = invokeWithLifetime(message!, {
      data: { type: "QUERY_WORKER_STATE" },
      ports: [firstPort],
    });
    const secondLifetime = invokeWithLifetime(message!, {
      data: { type: "QUERY_WORKER_STATE" },
      ports: [secondPort],
    });

    expect(firstPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "WORKER_STATE",
      cacheVerified: false,
      cacheVerification: "pending",
    }));
    expect(secondPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      cacheVerification: "pending",
    }));
    await Promise.resolve();
    expect(harness.cachesOpen).toHaveBeenCalledOnce();
    expect(harness.cache.match).toHaveBeenCalledOnce();

    resolveMatch(undefined);
    await Promise.all([...firstLifetime, ...secondLifetime]);
    expect(harness.clientMessages).toContainEqual({
      type: "CACHE_VERIFICATION_COMPLETE",
      release: RELEASE,
    });

    const completedPort = { postMessage: vi.fn() };
    const completedLifetime = invokeWithLifetime(message!, {
      data: { type: "QUERY_WORKER_STATE" },
      ports: [completedPort],
    });
    expect(completedPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      cacheVerified: false,
      cacheVerification: "failed",
    }));
    expect(completedLifetime).toHaveLength(0);
    expect(harness.cachesOpen).toHaveBeenCalledOnce();
  });

  it("commits activation without waiting on a same-origin non-shell window", async () => {
    const strayMessages: Readonly<Record<string, string>>[] = [];
    const stray: HarnessClient = {
      // A window parked off the shell path (mistyped URL, security.txt) runs
      // no coordinator and can never answer PREPARE_UPDATE; it must not hold
      // the readiness quorum hostage.
      id: "stray-404",
      type: "window",
      url: "https://qrwarden.test/nonexistent-404",
      postMessage(message: Readonly<Record<string, string>>): void {
        strayMessages.push(message);
      },
    };
    const harness = await loadWorker(
      () => Promise.resolve([new Request("https://qrwarden.test/")]),
      [stray],
    );
    const install = harness.handlers.get("install");
    const message = harness.handlers.get("message");
    expect(install).toBeDefined();
    expect(message).toBeDefined();

    await Promise.all(invokeWithLifetime(install!, {}));
    await Promise.all(invokeWithLifetime(message!, {
      data: { type: "BEGIN_UPDATE_COORDINATION" },
    }));

    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(strayMessages).toHaveLength(0);
  });

  it("holds activation for a busy shell tab reached with a foreign query string", async () => {
    const busyMessages: Readonly<Record<string, string>>[] = [];
    let replyHandler: WorkerHandler | null = null;
    const busyTab: HarnessClient = {
      // A link-carried query string ('/?utm_source=…') still serves the app
      // shell, so this tab runs the full coordinator and may hold live work;
      // its BUSY vote must hold the quorum, not be filtered out of it.
      id: "busy-query",
      type: "window",
      url: "https://qrwarden.test/?utm_source=newsletter",
      postMessage(message: Readonly<Record<string, string>>): void {
        busyMessages.push(message);
        if (message.type === "PREPARE_UPDATE" && replyHandler !== null) {
          replyHandler({
            data: {
              type: "BUSY",
              nonce: message.nonce,
              release: message.release,
            },
            source: busyTab,
            waitUntil: () => undefined,
          });
        }
      },
    };
    const harness = await loadWorker(
      () => Promise.resolve([new Request("https://qrwarden.test/")]),
      [busyTab],
    );
    const install = harness.handlers.get("install");
    const message = harness.handlers.get("message");
    expect(install).toBeDefined();
    expect(message).toBeDefined();
    replyHandler = message ?? null;

    await Promise.all(invokeWithLifetime(install!, {}));
    await Promise.all(invokeWithLifetime(message!, {
      data: { type: "BEGIN_UPDATE_COORDINATION" },
    }));

    expect(busyMessages.some((entry) => entry.type === "PREPARE_UPDATE")).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it("aborts to a shell that joined the transaction after the snapshot", async () => {
    // windowClients() is polled once at the start of the transaction. A tab
    // opened, reloaded, or navigated into the shell after that point is still
    // told to prepare and still takes a 60s lease, but the abort used to go
    // only to the stale snapshot, leaving that tab's controls disabled until
    // the lease expired with no worker able to release it.
    const lateMessages: Readonly<Record<string, string>>[] = [];
    const late: HarnessClient = {
      id: "late-joiner",
      type: "window",
      url: "https://qrwarden.test/",
      postMessage(message) {
        lateMessages.push(message);
      },
    };
    const extras: HarnessClient[] = [];
    const busy: HarnessClient = {
      id: "busy",
      type: "window",
      url: "https://qrwarden.test/",
      postMessage(message) {
        if (message.type !== "PREPARE_UPDATE") return;
        // Join the transaction while readiness is still being collected.
        if (!extras.includes(late)) extras.push(late);
        replyHandler?.({
          data: { type: "BUSY", nonce: message.nonce, release: message.release },
          source: busy,
          waitUntil: () => undefined,
        });
      },
    };
    let replyHandler: WorkerHandler | null = null;
    extras.push(busy);

    const harness = await loadWorker(
      () => Promise.resolve([new Request("https://qrwarden.test/")]),
      extras,
    );
    const install = harness.handlers.get("install");
    const message = harness.handlers.get("message");
    expect(install).toBeDefined();
    expect(message).toBeDefined();
    replyHandler = message ?? null;

    await Promise.all(invokeWithLifetime(install!, {}));
    await Promise.all(invokeWithLifetime(message!, {
      data: { type: "BEGIN_UPDATE_COORDINATION" },
    }));

    expect(harness.skipWaiting).not.toHaveBeenCalled();
    expect(lateMessages.map((entry) => entry.type)).toContain(
      "RELEASE_UPDATE_PREPARE",
    );
  });

  it("resets a successful commit to idle after preserving client notification", async () => {
    const harness = await loadWorker(() => Promise.resolve([
      new Request("https://qrwarden.test/"),
    ]));
    const install = harness.handlers.get("install");
    const message = harness.handlers.get("message");
    expect(install).toBeDefined();
    expect(message).toBeDefined();

    await Promise.all(invokeWithLifetime(install!, {}));
    await Promise.all(invokeWithLifetime(message!, {
      data: { type: "BEGIN_UPDATE_COORDINATION" },
    }));

    expect(harness.skipWaiting).toHaveBeenCalledOnce();
    expect(harness.clientMessages).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_COMMITTED",
      release: RELEASE,
    }));
    const statePort = { postMessage: vi.fn() };
    invokeWithLifetime(message!, {
      data: { type: "QUERY_WORKER_STATE" },
      ports: [statePort],
    });
    expect(statePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      transactionState: "idle",
      cacheVerified: true,
      cacheVerification: "verified",
    }));
  });

  it("holds activation for a busy tab served at /index.html with a query", async () => {
    // The canonicalizing redirect only fires when there is no query, so
    // '/index.html?utm_source=x' is served the shell verbatim with a 200. That
    // tab runs the full coordinator and can hold a live report; excluding it
    // from the quorum lets an activation commit over that work.
    const busyMessages: Readonly<Record<string, string>>[] = [];
    let replyHandler: WorkerHandler | null = null;
    const busyTab: HarnessClient = {
      id: "busy-index-html",
      type: "window",
      url: "https://qrwarden.test/index.html?utm_source=newsletter",
      postMessage(message: Readonly<Record<string, string>>): void {
        busyMessages.push(message);
        if (message.type === "PREPARE_UPDATE" && replyHandler !== null) {
          replyHandler({
            data: { type: "BUSY", nonce: message.nonce, release: message.release },
            source: busyTab,
            waitUntil: () => undefined,
          });
        }
      },
    };
    const harness = await loadWorker(
      () => Promise.resolve([new Request("https://qrwarden.test/")]),
      [busyTab],
    );
    const install = harness.handlers.get("install");
    const message = harness.handlers.get("message");
    replyHandler = message ?? null;

    await Promise.all(invokeWithLifetime(install!, {}));
    await Promise.all(invokeWithLifetime(message!, {
      data: { type: "BEGIN_UPDATE_COORDINATION" },
    }));

    expect(busyMessages.some((entry) => entry.type === "PREPARE_UPDATE")).toBe(true);
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it("stays verified when a same-release sibling deployment's keys share the cache", async () => {
    // A self-hosted rebuild without QRWARDEN_COMMIT reuses this release id
    // and cache name, so its install writes foreign revision keys next to
    // ours while this worker is still active. Those keys are unservable by
    // this worker and must not fail its verification.
    const harness = await loadWorker(() => Promise.resolve([
      new Request("https://qrwarden.test/"),
      new Request("https://qrwarden.test/?__WB_REVISION__=sibling"),
      new Request("https://qrwarden.test/assets/app-sibling.js?__WB_REVISION__=f00d"),
    ]));
    const install = harness.handlers.get("install");
    expect(install).toBeDefined();

    await Promise.all(invokeWithLifetime(install!, {}));

    const statePort = { postMessage: vi.fn() };
    invokeWithLifetime(harness.handlers.get("message")!, {
      data: { type: "QUERY_WORKER_STATE" },
      ports: [statePort],
    });
    expect(statePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      cacheVerified: true,
      cacheVerification: "verified",
    }));
    expect(harness.cache.delete).not.toHaveBeenCalled();
    expect(harness.cachesDelete).not.toHaveBeenCalled();
  });

  it("never deletes the shared cache when precache install fails", async () => {
    // An active sibling worker may still be serving from CURRENT_CACHE; a
    // failed install must not turn into an outage for its open tabs. With
    // every cached manifest entry still valid there is nothing to remove.
    precacheInstall.current = () => Promise.reject(new Error("fetch failed"));
    const harness = await loadWorker(() => Promise.resolve([
      new Request("https://qrwarden.test/"),
    ]));
    const install = harness.handlers.get("install");
    expect(install).toBeDefined();

    const lifetime = invokeWithLifetime(install!, {});
    await expect(Promise.all(lifetime)).rejects.toThrow("fetch failed");

    expect(harness.cachesDelete).not.toHaveBeenCalled();
    expect(harness.cache.delete).not.toHaveBeenCalled();
  });

  it("drops only its own invalid entries when install verification fails", async () => {
    // A truncated or tampered cached response must be evicted so the retried
    // install refetches it — without touching the rest of the shared cache.
    const harness = await loadWorker(
      () => Promise.resolve([new Request("https://qrwarden.test/")]),
      [],
      () => Promise.resolve(new Response("tampered bytes", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })),
    );
    const install = harness.handlers.get("install");
    expect(install).toBeDefined();

    const lifetime = invokeWithLifetime(install!, {});
    await expect(Promise.all(lifetime)).rejects.toThrow("Precache verification failed");

    expect(harness.cache.delete).toHaveBeenCalledExactlyOnceWith("/");
    expect(harness.cachesDelete).not.toHaveBeenCalled();
  });

  it("defers pruning while a sibling deployment is still installing", async () => {
    // The installing sibling's freshly written entries are indistinguishable
    // from a superseded build's leftovers; deleting them would fail its
    // install for no reason.
    const harness = await loadWorker(() => Promise.resolve([
      new Request("https://qrwarden.test/"),
      new Request("https://qrwarden.test/?__WB_REVISION__=sibling"),
    ]));
    harness.registration.installing = {};
    const activate = harness.handlers.get("activate");
    expect(activate).toBeDefined();

    await Promise.all(invokeWithLifetime(activate!, {}));

    expect(harness.cache.delete).not.toHaveBeenCalled();
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it("prunes foreign cache keys at activation and still claims clients", async () => {
    // Activation makes this worker the cache's sole owner: sibling leftovers
    // are deleted here, where no other worker can still be serving them.
    const foreignShell = new Request("https://qrwarden.test/?__WB_REVISION__=sibling");
    const foreignAsset = new Request("https://qrwarden.test/assets/app-sibling.js?__WB_REVISION__=f00d");
    const harness = await loadWorker(() => Promise.resolve([
      new Request("https://qrwarden.test/"),
      foreignShell,
      foreignAsset,
    ]));
    const activate = harness.handlers.get("activate");
    expect(activate).toBeDefined();

    await Promise.all(invokeWithLifetime(activate!, {}));

    expect(harness.cache.delete).toHaveBeenCalledTimes(2);
    expect(harness.cache.delete).toHaveBeenCalledWith(foreignShell);
    expect(harness.cache.delete).toHaveBeenCalledWith(foreignAsset);
    expect(harness.cachesDelete).not.toHaveBeenCalled();
    expect(harness.claim).toHaveBeenCalledOnce();
  });
});
