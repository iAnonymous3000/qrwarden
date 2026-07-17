import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workbox-routing", () => ({ registerRoute: vi.fn() }));
vi.mock("workbox-precaching", () => ({
  PrecacheController: class {
    addToCacheList(): void {}
    getCacheKeyForURL(url: string): string {
      return url;
    }
    install(): Promise<void> {
      return Promise.resolve();
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
  };
  readonly cachesOpen: ReturnType<typeof vi.fn>;
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
    match: vi.fn(() => Promise.resolve(new Response(SHELL, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }))),
    put: vi.fn(() => Promise.resolve()),
  };
  const cachesOpen = vi.fn(() => Promise.resolve(cache));
  const skipWaiting = vi.fn(() => Promise.resolve());
  const workerGlobal = {
    __WB_MANIFEST: [{ url: "/", revision: REVISION, integrity: INTEGRITY }],
    location: { origin: "https://qrwarden.test" },
    registration: { active: null, installing: null, waiting: null },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([client, ...extraClients])),
      claim: vi.fn(() => Promise.resolve()),
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
    delete: vi.fn(() => Promise.resolve(true)),
  });
  vi.stubGlobal("crypto", webcrypto);

  await import("../../src/sw/service-worker");
  return {
    handlers,
    client,
    clientMessages,
    cache,
    cachesOpen,
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
});

describe("service-worker state contract", () => {
  it("replies immediately and runs one background verification for concurrent queries", async () => {
    let resolveKeys!: (keys: readonly Request[]) => void;
    const harness = await loadWorker(
      () => new Promise((resolve) => {
        resolveKeys = resolve;
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
    expect(harness.cache.keys).toHaveBeenCalledOnce();

    resolveKeys([]);
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
    expect(harness.cache.keys).toHaveBeenCalledOnce();
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
});
