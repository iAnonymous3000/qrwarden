import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkerToClientMessage } from "../../src/sw/protocol";

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

function dispatchShareFormRequest(
  handler: WorkerHandler,
  form: FormData,
  ids: { readonly resultingClientId?: string; readonly clientId?: string } = {},
  readForm?: () => Promise<FormData>,
): {
  readonly lifetime: readonly Promise<unknown>[];
  readonly respondWith: ReturnType<typeof vi.fn>;
  readonly location: string;
} {
  const lifetime: Promise<unknown>[] = [];
  const respondWith = vi.fn();
  const request = new Request("https://qrwarden.test/share-target", {
      method: "POST",
      body: form,
  });
  if (readForm !== undefined) {
    vi.spyOn(request, "formData").mockImplementation(readForm);
  }
  handler({
    request,
    resultingClientId: ids.resultingClientId ?? "",
    clientId: ids.clientId ?? "",
    respondWith,
    waitUntil: (promise) => lifetime.push(promise),
  });
  const response = respondWith.mock.calls[0]?.[0] as Response | undefined;
  const location = response?.headers.get("Location") ?? "";
  return { lifetime, respondWith, location };
}

function dispatchShareForm(
  handler: WorkerHandler,
  form: FormData,
  ids: { readonly resultingClientId?: string; readonly clientId?: string } = {},
  readForm?: () => Promise<FormData>,
): {
  readonly lifetime: readonly Promise<unknown>[];
  readonly respondWith: ReturnType<typeof vi.fn>;
  readonly token: string;
} {
  const { lifetime, respondWith, location } = dispatchShareFormRequest(
    handler,
    form,
    ids,
    readForm,
  );
  const token = new URL(location, "https://qrwarden.test").searchParams.get(
    "share-pending",
  );
  if (token === null) throw new TypeError("Missing share-pending token");
  return { lifetime, respondWith, token };
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
  readonly token: string;
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

function deferredForm(): {
  readonly promise: Promise<FormData>;
  readonly resolve: (form: FormData) => void;
} {
  let resolve!: (form: FormData) => void;
  const promise = new Promise<FormData>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function imageForm(fileName: string): FormData {
  const form = new FormData();
  form.append(
    "image",
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], fileName, {
      type: "image/png",
    }),
  );
  return form;
}

function messageClient(id: string): MessageClient {
  return { id, postMessage: vi.fn() };
}

function dispatchPull(
  handler: WorkerHandler,
  source: unknown,
  token: string,
): void {
  handler({
    data: { type: "PULL_SHARED_IMAGE", token },
    source,
    waitUntil: () => undefined,
  });
}

function sharedImageMessages(
  client: MessageClient,
): readonly Extract<
  NonNullable<ReturnType<typeof readWorkerToClientMessage>>,
  { readonly type: "SHARED_IMAGE" }
>[] {
  return client.postMessage.mock.calls
    .flatMap((call) => {
      const message = readWorkerToClientMessage(call[0]);
      return message?.type === "SHARED_IMAGE" ? [message] : [];
    });
}

function shareRejectedMessages(
  client: MessageClient,
): readonly Extract<
  NonNullable<ReturnType<typeof readWorkerToClientMessage>>,
  { readonly type: "SHARE_REJECTED" }
>[] {
  return client.postMessage.mock.calls
    .flatMap((call) => {
      const message = readWorkerToClientMessage(call[0]);
      return message?.type === "SHARE_REJECTED" ? [message] : [];
    });
}

function sharedFileName(client: MessageClient, index = 0): string | undefined {
  const file = sharedImageMessages(client)[index]?.file;
  return file instanceof File ? file.name : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("service-worker share-target delivery", () => {
  it("redirects the share POST to a strict per-share pending token", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    expect(fetchHandler).toBeDefined();

    const { lifetime, respondWith, token } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    expect(respondWith).toHaveBeenCalledOnce();
    const response = respondWith.mock.calls[0]?.[0] as Response;
    expect(response.status).toBe(303);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get("Location")).toBe(
      `/?share-pending=${token}`,
    );
  });

  it("parks an id-less share instead of posting to an arbitrary window and serves exactly one pull", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    expect(fetchHandler).toBeDefined();
    expect(message).toBeDefined();

    const { lifetime, token } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    expect(harness.clientsGet).not.toHaveBeenCalled();
    expect(harness.matchAll).not.toHaveBeenCalled();
    expect(harness.backgroundClient.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, token);
    const delivered = sharedImageMessages(redirectedDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect(delivered[0]?.file).toBeInstanceOf(File);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    const latecomer = messageClient("latecomer");
    dispatchPull(message!, latecomer, token);
    dispatchPull(message!, redirectedDocument, token);
    expect(sharedImageMessages(latecomer)).toHaveLength(0);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(1);
  });

  it("delivers an id-less share to a pull that raced ahead of parking", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const { lifetime, token } = dispatchSharePost(fetchHandler!);
    // The redirected document's single pull can be processed while the
    // multipart body is still parsing; the share must not be dropped.
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, token);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(0);
    await Promise.all(lifetime);

    const delivered = sharedImageMessages(redirectedDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    const latecomer = messageClient("latecomer");
    dispatchPull(message!, latecomer, token);
    expect(sharedImageMessages(latecomer)).toHaveLength(0);
  });

  it("drops an unknown token so a later share cannot be misdelivered to it", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const staleDocument = messageClient("stale-document");
    dispatchPull(message!, staleDocument, "a".repeat(32));

    const { lifetime, token } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    expect(sharedImageMessages(staleDocument)).toHaveLength(0);
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, token);
    expect(sharedImageMessages(redirectedDocument)).toHaveLength(1);
  });

  it("rejects malformed pull tokens without consuming a parked share", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const share = dispatchSharePost(fetchHandler!);
    await Promise.all(share.lifetime);

    const invalidDocument = messageClient("invalid-document");
    for (const token of [
      undefined,
      null,
      "",
      "a".repeat(31),
      "A".repeat(32),
      `${"a".repeat(32)}x`,
    ]) {
      message!({
        data: { type: "PULL_SHARED_IMAGE", token },
        source: invalidDocument,
        waitUntil: () => undefined,
      });
    }
    expect(invalidDocument.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, share.token);
    expect(sharedFileName(redirectedDocument)).toBe("shared.png");
  });

  it("expires a raced-ahead pull without losing its matching share", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const form = imageForm("delayed.png");
    const parse = deferredForm();
    const share = dispatchShareForm(
      fetchHandler!,
      form,
      {},
      () => parse.promise,
    );
    const staleDocument = messageClient("stale-document");
    dispatchPull(message!, staleDocument, share.token);

    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + SHARE_TTL_MS);
    parse.resolve(form);
    await Promise.all(share.lifetime);
    clock.mockRestore();
    expect(staleDocument.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, share.token);
    expect(sharedFileName(redirectedDocument)).toBe("delayed.png");
  });

  it("drops an unclaimed share once the pending deadline passes", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const { lifetime, token } = dispatchSharePost(fetchHandler!);
    await Promise.all(lifetime);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SHARE_TTL_MS);
    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, token);
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

    const { lifetime, token } = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-1",
    });
    await Promise.all(lifetime);

    expect(harness.matchAll).not.toHaveBeenCalled();
    const delivered = sharedImageMessages(resultingDocument);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.release).toBe(RELEASE);
    expect((delivered[0]?.file as File).name).toBe("shared.png");

    dispatchPull(message!, resultingDocument, token);
    expect(sharedImageMessages(resultingDocument)).toHaveLength(1);
  });

  it("never delivers a share POST to the initiating client id", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const initiatingDocument = messageClient("initiating-1");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "initiating-1" ? initiatingDocument : undefined),
    );

    const { lifetime, token } = dispatchSharePost(fetchHandler!, {
      clientId: "initiating-1",
    });
    await Promise.all(lifetime);

    expect(harness.clientsGet).not.toHaveBeenCalled();
    expect(initiatingDocument.postMessage).not.toHaveBeenCalled();

    const redirectedDocument = messageClient("redirected-document");
    dispatchPull(message!, redirectedDocument, token);
    expect(sharedFileName(redirectedDocument)).toBe("shared.png");
  });

  it("keeps the share pullable when the resulting client never materializes", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { lifetime, token } = dispatchSharePost(fetchHandler!, {
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
    dispatchPull(message!, redirectedDocument, token);
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
    dispatchPull(message!, tabA, first.token);

    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all(second.lifetime);

    expect(sharedImageMessages(tabA)).toHaveLength(1);
    const tabB = messageClient("redirected-2");
    dispatchPull(message!, tabB, second.token);
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
    dispatchPull(message!, tabA, first.token);
    await Promise.all(first.lifetime);
    expect(sharedFileName(tabA)).toBe("first.png");

    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all(second.lifetime);

    expect(sharedImageMessages(tabA)).toHaveLength(1);
    const tabB = messageClient("redirected-2");
    dispatchPull(message!, tabB, second.token);
    expect(sharedFileName(tabB)).toBe("second.png");
  });

  it("keeps an overlapping share from a document already served directly", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const tabA = messageClient("resulting-a");
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(id === "resulting-a" ? tabA : undefined),
    );

    const first = dispatchSharePost(fetchHandler!, {
      resultingClientId: "resulting-a",
      fileName: "first.png",
    });
    // Doc A's marker pull lands while share A still parses, so it parks.
    dispatchPull(message!, tabA, first.token);
    // Share B arrives before share A settles: the settled delivery cannot
    // clear the pull queue wholesale, so doc A's parked pull must be
    // dropped by its own direct delivery instead.
    const second = dispatchSharePost(fetchHandler!, { fileName: "second.png" });
    await Promise.all([...first.lifetime, ...second.lifetime]);

    expect(sharedImageMessages(tabA)).toHaveLength(1);
    expect(sharedFileName(tabA)).toBe("first.png");
    const tabB = messageClient("redirected-b");
    dispatchPull(message!, tabB, second.token);
    expect(sharedFileName(tabB)).toBe("second.png");
  });

  it("keeps simultaneous id-less shares correlated when parsing finishes in reverse", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");

    const firstForm = imageForm("first.png");
    const secondForm = imageForm("second.png");
    const firstParse = deferredForm();
    const secondParse = deferredForm();
    const first = dispatchShareForm(
      fetchHandler!,
      firstForm,
      {},
      () => firstParse.promise,
    );
    const second = dispatchShareForm(
      fetchHandler!,
      secondForm,
      {},
      () => secondParse.promise,
    );
    expect(first.token).not.toBe(second.token);

    // The second POST's body settles first. A completion-ordered FIFO parks
    // second.png ahead of first.png and cross-wires the two redirect tabs.
    secondParse.resolve(secondForm);
    await Promise.all(second.lifetime);
    firstParse.resolve(firstForm);
    await Promise.all(first.lifetime);

    const docA = messageClient("doc-a");
    const docB = messageClient("doc-b");
    dispatchPull(message!, docA, first.token);
    dispatchPull(message!, docB, second.token);
    expect(sharedFileName(docA)).toBe("first.png");
    expect(sharedFileName(docB)).toBe("second.png");
  });

  it("bounds overlapping POST admission before parsing and retains ownership while parked", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const forms = Array.from({ length: 4 }, (_, index) =>
      imageForm(`share-${index + 1}.png`),
    );
    const parses = forms.map(() => deferredForm());
    const admitted = forms.map((form, index) =>
      dispatchShareForm(
        fetchHandler!,
        form,
        {},
        () => parses[index]!.promise,
      ),
    );

    const refusedForm = imageForm("share-5.png");
    const refusedRead = vi.fn(() => Promise.resolve(refusedForm));
    const refused = dispatchShareFormRequest(
      fetchHandler!,
      refusedForm,
      {},
      refusedRead,
    );
    expect(refused.location).toBe("/?share-rejected=busy");
    expect(
      (refused.respondWith.mock.calls[0]?.[0] as Response).status,
    ).toBe(303);
    expect(refused.lifetime).toHaveLength(0);
    expect(refusedRead).not.toHaveBeenCalled();

    for (let index = admitted.length - 1; index >= 0; index -= 1) {
      parses[index]!.resolve(forms[index]!);
      await Promise.all(admitted[index]!.lifetime);
    }

    // Settled payloads still own their slots until their redirect pages claim
    // them, so a later POST cannot parse and then disappear from a full park.
    const parkedRefusalForm = imageForm("still-full.png");
    const parkedRefusalRead = vi.fn(() => Promise.resolve(parkedRefusalForm));
    const parkedRefusal = dispatchShareFormRequest(
      fetchHandler!,
      parkedRefusalForm,
      {},
      parkedRefusalRead,
    );
    expect(parkedRefusal.location).toBe("/?share-rejected=busy");
    expect(parkedRefusalRead).not.toHaveBeenCalled();

    for (const [index, share] of admitted.entries()) {
      const document = messageClient(`doc-${index + 1}`);
      dispatchPull(message!, document, share.token);
      expect(sharedFileName(document)).toBe(`share-${index + 1}.png`);
    }

    const afterClaim = dispatchSharePost(fetchHandler!, {
      fileName: "after-claim.png",
    });
    expect(afterClaim.token).toMatch(/^[0-9a-f]{32}$/);
    await Promise.all(afterClaim.lifetime);
  });

  it("releases every admission when multipart parsing misses its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const stalled = Array.from({ length: 4 }, (_, index) => ({
      form: imageForm(`stalled-${index + 1}.png`),
      parse: deferredForm(),
      document: messageClient(`resulting-${index + 1}`),
    }));
    harness.clientsGet.mockImplementation((id) =>
      Promise.resolve(stalled.find((entry) => entry.document.id === id)?.document),
    );
    const admitted = stalled.map((entry) =>
      dispatchShareForm(
        fetchHandler!,
        entry.form,
        { resultingClientId: entry.document.id },
        () => entry.parse.promise,
      ),
    );

    const refused = dispatchShareFormRequest(
      fetchHandler!,
      imageForm("refused-before-deadline.png"),
    );
    expect(refused.location).toBe("/?share-rejected=busy");

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(admitted.flatMap((entry) => entry.lifetime));
    for (const entry of stalled) {
      expect(shareRejectedMessages(entry.document)).toEqual([
        { type: "SHARE_REJECTED", release: RELEASE, reason: "unreadable" },
      ]);
    }

    const afterDeadline = dispatchSharePost(fetchHandler!, {
      fileName: "after-deadline.png",
    });
    expect(afterDeadline.token).toMatch(/^[0-9a-f]{32}$/);
    await Promise.all(afterDeadline.lifetime);

    // Settling a timed-out parse later must not create a second delivery.
    for (const entry of stalled) entry.parse.resolve(entry.form);
    await Promise.resolve();
    for (const entry of stalled) {
      expect(sharedImageMessages(entry.document)).toHaveLength(0);
      expect(shareRejectedMessages(entry.document)).toHaveLength(1);
    }
  });

  it("matches raced-ahead pulls by token when parsing finishes in reverse", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const firstForm = imageForm("first.png");
    const secondForm = imageForm("second.png");
    const firstParse = deferredForm();
    const secondParse = deferredForm();
    const first = dispatchShareForm(
      fetchHandler!,
      firstForm,
      {},
      () => firstParse.promise,
    );
    const second = dispatchShareForm(
      fetchHandler!,
      secondForm,
      {},
      () => secondParse.promise,
    );
    const docA = messageClient("doc-a");
    const docB = messageClient("doc-b");
    dispatchPull(message!, docA, first.token);
    dispatchPull(message!, docB, second.token);

    secondParse.resolve(secondForm);
    await Promise.all(second.lifetime);
    firstParse.resolve(firstForm);
    await Promise.all(first.lifetime);

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
    dispatchPull(message!, docB, second.token);
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

    const { lifetime, respondWith, token } = dispatchShareForm(
      fetchHandler!,
      form,
    );
    await Promise.all(lifetime);

    const response = respondWith.mock.calls[0]?.[0] as Response;
    expect(response.status).toBe(303);
    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc, token);
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

    const { lifetime, token } = dispatchShareForm(fetchHandler!, form);
    await Promise.all(lifetime);

    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc, token);
    expect(shareRejectedMessages(doc)[0]?.reason).toBe("unsupported-type");
  });

  it("rejects a file-less share as unreadable", async () => {
    const harness = await loadWorker();
    const fetchHandler = harness.handlers.get("fetch");
    const message = harness.handlers.get("message");
    const form = new FormData();
    form.append("text", "not an image");

    const { lifetime, token } = dispatchShareForm(fetchHandler!, form);
    await Promise.all(lifetime);

    const doc = messageClient("redirected-document");
    dispatchPull(message!, doc, token);
    expect(shareRejectedMessages(doc)[0]?.reason).toBe("unreadable");
  });

  it("serves the offline shell for every same-origin root navigation", async () => {
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
        url: new URL(`https://qrwarden.test/?share-pending=${"a".repeat(32)}`),
      }),
    ).toBe(true);
    for (const url of [
      "https://qrwarden.test/?share-pending",
      `https://qrwarden.test/?share-pending=${"A".repeat(32)}`,
      `https://qrwarden.test/?share-pending=${"a".repeat(32)}&extra=1`,
      `https://qrwarden.test/?share-pending=${"a".repeat(32)}&share-pending=${"b".repeat(32)}`,
      "https://qrwarden.test/?unrelated",
      "https://qrwarden.test/?utm_source=installed-app",
    ]) {
      expect(matches({ request: navigation, url: new URL(url) })).toBe(true);
    }
    expect(
      matches({
        request: navigation,
        url: new URL("https://qrwarden.test/not-root?unrelated"),
      }),
    ).toBe(false);
    expect(
      matches({
        request: navigation,
        url: new URL("https://different-origin.test/?unrelated"),
      }),
    ).toBe(false);
    expect(
      matches({
        request: { method: "POST", mode: "navigate" },
        url: new URL("https://qrwarden.test/?unrelated"),
      }),
    ).toBe(false);
  });
});
