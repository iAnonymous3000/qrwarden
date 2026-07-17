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
  readonly source?: unknown;
  readonly request?: Request;
  readonly resultingClientId?: string;
  readonly clientId?: string;
  respondWith?(response: unknown): void;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

interface MessageClient {
  readonly id: string;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

interface WorkerHarness {
  readonly handlers: Map<string, WorkerHandler>;
  readonly clientsGet: ReturnType<
    typeof vi.fn<(id: string) => Promise<unknown>>
  >;
  readonly matchAll: ReturnType<typeof vi.fn>;
  readonly backgroundClient: MessageClient & { readonly url: string };
  readonly registerRoute: ReturnType<typeof vi.fn>;
}

const RELEASE = `v0.1.0+${"2".repeat(40)}`;
const SHARE_TTL_MS = 120_000;

async function loadWorker(): Promise<WorkerHarness> {
  vi.resetModules();
  const handlers = new Map<string, WorkerHandler>();
  const backgroundClient = {
    id: "background-tab",
    type: "window" as const,
    url: "https://qrwarden.test/",
    postMessage: vi.fn(),
  };
  const clientsGet = vi.fn(
    (_id: string): Promise<unknown> => Promise.resolve(undefined),
  );
  const matchAll = vi.fn(() => Promise.resolve([backgroundClient]));
  const workerGlobal = {
    __WB_MANIFEST: [
      { url: "/", revision: "0".repeat(64), integrity: "sha384-unused" },
    ],
    location: { origin: "https://qrwarden.test" },
    registration: { active: null, installing: null, waiting: null },
    clients: {
      get: clientsGet,
      matchAll,
      claim: vi.fn(() => Promise.resolve()),
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    addEventListener(type: string, handler: WorkerHandler): void {
      handlers.set(type, handler);
    },
  };

  vi.stubGlobal("__QRWARDEN_RELEASE_ID__", RELEASE);
  vi.stubGlobal("__QRWARDEN_PREVIOUS_CACHE__", null);
  vi.stubGlobal("__QRWARDEN_SIZE_MANIFEST__", [
    { url: "/", size: 1, mediaType: "text/html; charset=utf-8" },
  ]);
  vi.stubGlobal("self", workerGlobal);
  vi.stubGlobal("caches", {
    open: vi.fn(() =>
      Promise.resolve({
        keys: vi.fn(() => Promise.resolve([])),
        match: vi.fn(() => Promise.resolve(undefined)),
        put: vi.fn(() => Promise.resolve()),
      }),
    ),
    keys: vi.fn(() => Promise.resolve([])),
    delete: vi.fn(() => Promise.resolve(true)),
  });

  await import("../../src/sw/service-worker");
  const routing = await import("workbox-routing");
  return {
    handlers,
    clientsGet,
    matchAll,
    backgroundClient,
    registerRoute: vi.mocked(routing.registerRoute) as ReturnType<typeof vi.fn>,
  };
}

function dispatchShareForm(
  handler: WorkerHandler,
  form: FormData,
  ids: { readonly resultingClientId?: string; readonly clientId?: string } = {},
): {
  readonly lifetime: readonly Promise<unknown>[];
  readonly respondWith: ReturnType<typeof vi.fn>;
} {
  const lifetime: Promise<unknown>[] = [];
  const respondWith = vi.fn();
  handler({
    request: new Request("https://qrwarden.test/share-target", {
      method: "POST",
      body: form,
    }),
    resultingClientId: ids.resultingClientId ?? "",
    clientId: ids.clientId ?? "",
    respondWith,
    waitUntil: (promise) => lifetime.push(promise),
  });
  return { lifetime, respondWith };
}

function dispatchSharePost(
  handler: WorkerHandler,
  ids: {
    readonly resultingClientId?: string;
    readonly clientId?: string;
    readonly fileName?: string;
  } = {},
): {
  readonly lifetime: readonly Promise<unknown>[];
  readonly respondWith: ReturnType<typeof vi.fn>;
} {
  const form = new FormData();
  form.append(
    "image",
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      ids.fileName ?? "shared.png",
      { type: "image/png" },
    ),
  );
  return dispatchShareForm(handler, form, ids);
}

function messageClient(id: string): MessageClient {
  return { id, postMessage: vi.fn() };
}

function dispatchPull(handler: WorkerHandler, source: unknown): void {
  handler({
    data: { type: "PULL_SHARED_IMAGE" },
    source,
    waitUntil: () => undefined,
  });
}

function sharedImageMessages(
  client: MessageClient,
): readonly { readonly release?: string; readonly file?: unknown }[] {
  return client.postMessage.mock.calls
    .map((call) => call[0] as { readonly type?: string })
    .filter(
      (message): message is { readonly release?: string; readonly file?: unknown } =>
        message.type === "SHARED_IMAGE",
    );
}

function shareRejectedMessages(
  client: MessageClient,
): readonly { readonly release?: string; readonly reason?: string }[] {
  return client.postMessage.mock.calls
    .map((call) => call[0] as { readonly type?: string })
    .filter(
      (message): message is { readonly release?: string; readonly reason?: string } =>
        message.type === "SHARE_REJECTED",
    );
}

function sharedFileName(client: MessageClient, index = 0): string | undefined {
  const file = sharedImageMessages(client)[index]?.file;
  return file instanceof File ? file.name : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("service-worker share-target delivery", () => {
  it("redirects the share POST to the static pending marker", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    expect(fetchHandler).toBeDefined();

    const { lifetime, respondWith } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    expect(respondWith).toHaveBeenCalledOnce();
    const response = respondWith.mock.calls[0]?.[0] as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/?share-pending");
  });

  it("parks an id-less share instead of posting to an arbitrary window and serves exactly one pull", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    expect(fetchHandler).toBeDefined();
    expect(message).toBeDefined();

    const { lifetime } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    expect(harness.clientsGet).not.toHaveBeenCalled();
    expect(harness.matchAll).not.toHaveBeenCalled();
    expect(harness.backgroundClient.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument);
    const delivered = sharedImageMessages(redirectedDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect(delivered[0]?.file).toBeInstanceOf(File);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    const latecomer = messageClient("latecomer");
    dispatchPull(message!, latecomer);
    dispatchPull(message!, redirectedDocument);
    expect(sharedImageMessages(latecomer)).toHaveLength(0);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(1);
  });

  it("delivers an id-less share to a pull that raced ahead of parking", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const { lifetime } = dispatchSharePost(fetchHandler!);
    // The redirected document's single pull can be processed while the
    // multipart body is still parsing; the share must not be dropped.
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(0);
    await Promise.all(lifetime);

    const delivered = sharedImageMessages(redirectedDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    const latecomer = messageClient("latecomer");
    dispatchPull(message!, latecomer);
    expect(sharedImageMessages(latecomer)).toHaveLength(0);
  });

  it("expires a parked pull so a later share is not misdelivered to it", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const staleDocument = messageClient("stale-document");
    dispatchPull(message!, staleDocument);

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + SHARE_TTL_MS);
    const { lifetime } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);
    nowSpy.mockRestore();

    expect(sharedImageMessages(staleDocument)).toHaveLength(0);
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(1);
  });

  it("drops an unclaimed share once the pending deadline passes", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const { lifetime } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SHARE_TTL_MS);
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument);
    expect(redirectedDocument.postMessage).not.toHaveBeenCalled();
  });

  it("delivers through the resulting client id and leaves nothing to pull", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const resultingDocument = messageClient("resulting-1");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-1" ? resultingDocument : undefined),
    );

    const { lifetime } = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-1",
    });
    await Promise.all(lifetime);

    expect(harness.matchAll).not.toHaveBeenCalled();
    const delivered = sharedImageMessages(resultingDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    dispatchPull(message!, resultingDocument);
    expect(sharedImageMessages(resultingDocument)).toHaveLength(1);
  });

  it("keeps the share pullable when the resulting client never materializes", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { lifetime } = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-9",
    });
    // Form parsing settles on real microtasks; only the bounded client
    // lookup uses timers. Interleave real ticks with fake advances so every
    // retry both schedules and fires.
    for (let slice = 0; slice < 25; slice += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    await Promise.all(lifetime);

    expect(harness.clientsGet).toHaveBeenCalledTimes(20);
    expect(harness.clientsGet).toHaveBeenCalledWith("resulting-9");
    expect(harness.matchAll).not.toHaveBeenCalled();
    expect(harness.backgroundClient.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(1);
  });

  it("drops a marker pull left over from a delivered share so a later share cannot reach it", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const tabA = messageClient("resulting-1");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-1" ? tabA : undefined),
    );

    const first = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-1",
      fileName: "first.png",
    });
    await Promise.all(first.lifetime);
    expect(sharedFileName(tabA)).toBe("first.png");

    // The redirected document posts its marker pull unconditionally, even
    // after a direct delivery. With nothing parked and nothing in flight the
    // pull must be dropped, not left waiting for the next share.
    dispatchPull(message!, tabA);

    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all(second.lifetime);

    expect(sharedImageMessages(tabA)).toHaveLength(1);
    const tabB = messageClient("redirected-2");
    dispatchPull(message!, tabB);
    expect(sharedFileName(tabB)).toBe("second.png");
  });

  it("clears a raced-ahead pull once its share settles through the resulting client", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const tabA = messageClient("resulting-1");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-1" ? tabA : undefined),
    );

    const first = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-1",
      fileName: "first.png",
    });
    // The marker pull can be processed while the multipart body still
    // parses; once the share settles directly, the parked pull is stale.
    dispatchPull(message!, tabA);
    await Promise.all(first.lifetime);
    expect(sharedFileName(tabA)).toBe("first.png");

    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all(second.lifetime);

    expect(sharedImageMessages(tabA)).toHaveLength(1);
    const tabB = messageClient("redirected-2");
    dispatchPull(message!, tabB);
    expect(sharedFileName(tabB)).toBe("second.png");
  });

  it("queues overlapping id-less shares in arrival order instead of overwriting", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const first = dispatchSharePost(fetchHandler!, { fileName: "first.png" });
    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all([...first.lifetime, ...second.lifetime]);

    const docA = messageClient("doc-a");
    const docB = messageClient("doc-b");
    dispatchPull(message!, docA);
    dispatchPull(message!, docB);
    expect(sharedFileName(docA)).toBe("first.png");
    expect(sharedFileName(docB)).toBe("second.png");
  });

  it("delivers each overlapping share to its own document on the push path", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const docA = messageClient("resulting-a");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-a" ? docA : undefined),
    );

    const first = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-a",
      fileName: "first.png",
    });
    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all([...first.lifetime, ...second.lifetime]);

    expect(sharedImageMessages(docA)).toHaveLength(1);
    expect(sharedFileName(docA)).toBe("first.png");
    const docB = messageClient("doc-b");
    dispatchPull(message!, docB);
    expect(sharedFileName(docB)).toBe("second.png");
  });

  it("parks an explicit rejection for a multi-file share", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const form = new FormData();
    for (const name of ["one.png", "two.png", "three.png"]) {
      form.append(
        "image",
        new File([new Uint8Array([1])], name, { type: "image/png" }),
      );
    }

    const { lifetime, respondWith } = dispatchShareForm(fetchHandler!, form);
    await Promise.all(lifetime);

    const response = respondWith.mock.calls[0]?.[0] as Response;
    expect(response.status).toBe(303);
    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc);
    expect(sharedImageMessages(doc)).toHaveLength(0);
    const rejections = shareRejectedMessages(doc);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("multiple-files");
    expect(rejections[0]?.release).toBe(RELEASE);
  });

  it("rejects an oversized share through the resulting client", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const doc = messageClient("resulting-1");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-1" ? doc : undefined),
    );
    const form = new FormData();
    form.append(
      "image",
      new File([new Uint8Array(25_000_001)], "huge.jpg", {
        type: "image/jpeg",
      }),
    );

    const { lifetime } = dispatchShareForm(fetchHandler!, form, {
      resultingClientId: "resulting-1",
    });
    await Promise.all(lifetime);

    expect(sharedImageMessages(doc)).toHaveLength(0);
    const rejections = shareRejectedMessages(doc);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("too-large");
  });

  it("rejects an unsupported media type instead of dropping it silently", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const form = new FormData();
    form.append(
      "image",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", {
        type: "application/pdf",
      }),
    );

    const { lifetime } = dispatchShareForm(fetchHandler!, form);
    await Promise.all(lifetime);

    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc);
    expect(shareRejectedMessages(doc)[0]?.reason).toBe("unsupported-type");
  });

  it("rejects a file-less share as unreadable", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const form = new FormData();
    form.append("text", "not an image");

    const { lifetime } = dispatchShareForm(fetchHandler!, form);
    await Promise.all(lifetime);

    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc);
    expect(shareRejectedMessages(doc)[0]?.reason).toBe("unreadable");
  });

  it("serves the offline shell for the share marker navigation", async () => {
    const harness = await loadWorker();
    const capture = harness.registerRoute.mock.calls
      .map((call) => call[0] as unknown)
      .find((candidate) => typeof candidate === "function");
    expect(capture).toBeTypeOf("function");
    const matches = capture as (options: {
      readonly request: { readonly method: string; readonly mode: string };
      readonly url: URL;
    }) => boolean;

    const navigation = { method: "GET", mode: "navigate" };
    expect(
      matches({ request: navigation, url: new URL("https://qrwarden.test/") }),
    ).toBe(true);
    expect(
      matches({
        request: navigation,
        url: new URL("https://qrwarden.test/?share-pending"),
      }),
    ).toBe(true);
    expect(
      matches({
        request: navigation,
        url: new URL("https://qrwarden.test/?unrelated"),
      }),
    ).toBe(false);
  });
});
