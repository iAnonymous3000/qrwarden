/// <reference lib="webworker" />

import { registerRoute } from "workbox-routing";
import {
  PrecacheController,
  PrecacheRoute,
} from "workbox-precaching";
import { requestActivationCommit } from "./activationCommit";

declare const __QRWARDEN_RELEASE_ID__: string;
declare const __QRWARDEN_PREVIOUS_CACHE__: string | null;
declare const __QRWARDEN_SIZE_MANIFEST__: readonly {
  readonly url: string;
  readonly size: number;
  readonly mediaType: string;
}[];

interface VerifiedManifestEntry {
  readonly url: string;
  readonly revision: string;
  readonly integrity: string;
  readonly size: number;
  readonly mediaType: string;
}

declare const self: ServiceWorkerGlobalScope;

const RELEASE_ID = __QRWARDEN_RELEASE_ID__;
const CURRENT_CACHE = `qrwarden-precache-${RELEASE_ID.replace("+", "-")}`;
const PREVIOUS_CACHE = __QRWARDEN_PREVIOUS_CACHE__;
const PREPARE_TIMEOUT_MS = 5_000;
const VERIFY_TIMEOUT_MS = 20_000;
const CLIENT_REPLY = new Map<string, "READY" | "BUSY">();
const CLEANUP_REPLY = new Map<string, string>();
let cleanupInFlight = false;
let cleanupNonce: string | null = null;

function readManifest(): readonly VerifiedManifestEntry[] {
  const metadata = new Map(
    __QRWARDEN_SIZE_MANIFEST__.map((entry) => [
      entry.url,
      { size: entry.size, mediaType: entry.mediaType },
    ]),
  );
  return self.__WB_MANIFEST.map((entry) => {
    const candidate: unknown = entry;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("url" in candidate) ||
      typeof candidate.url !== "string" ||
      !("revision" in candidate) ||
      typeof candidate.revision !== "string" ||
      !("integrity" in candidate) ||
      typeof candidate.integrity !== "string" ||
      !metadata.has(candidate.url)
    ) {
      throw new TypeError("Invalid QRWarden precache manifest entry");
    }
    const entryMetadata = metadata.get(candidate.url)!;
    return Object.freeze({
      url: candidate.url,
      revision: candidate.revision,
      integrity: candidate.integrity,
      size: entryMetadata.size,
      mediaType: entryMetadata.mediaType,
    });
  });
}

const manifest = readManifest();
const rootEntry = manifest.find((entry) => entry.url === "/");
if (rootEntry === undefined) {
  throw new TypeError("Missing root shell precache entry");
}
const precache = new PrecacheController({
  cacheName: CURRENT_CACHE,
  fallbackToNetwork: false,
});
precache.addToCacheList([...manifest]);

type TransactionState = "idle" | "preparing" | "finalizing" | "committing";
type CacheVerification = "pending" | "verified" | "failed";
let transactionState: TransactionState = "idle";
let transactionNonce: string | null = null;
let cacheVerified = false;
let cacheVerification: CacheVerification = "pending";
let cacheVerificationInFlight: Promise<boolean> | null = null;

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function digestHex(algorithm: "SHA-256", bytes: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest(algorithm, bytes).then(bytesToHex);
}

async function digestIntegrity(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  const chunks: string[] = [];
  for (let offset = 0; offset < digest.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...digest.subarray(offset, offset + 32_768)));
  }
  return `sha384-${btoa(chunks.join(""))}`;
}

function normalizedMediaType(value: string | null): string | null {
  if (value === null) return null;
  return value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .join("; ");
}

function cacheKey(entry: VerifiedManifestEntry): string {
  const key = precache.getCacheKeyForURL(entry.url);
  if (key === undefined) {
    throw new TypeError("Missing precache key");
  }
  return key;
}

async function verifyCurrentCache(): Promise<boolean> {
  const cache = await caches.open(CURRENT_CACHE);
  const expected = new Map(
    manifest.map((entry) => [new URL(cacheKey(entry), self.location.origin).href, entry]),
  );
  const keys = await cache.keys();
  if (keys.length !== expected.size) {
    return false;
  }
  for (const request of keys) {
    if (!expected.has(request.url)) {
      return false;
    }
  }
  for (const entry of manifest) {
    const response = await cache.match(cacheKey(entry));
    if (
      response === undefined ||
      !response.ok ||
      normalizedMediaType(response.headers.get("Content-Type")) !== entry.mediaType
    ) {
      return false;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== entry.size) {
      return false;
    }
    if ((await digestHex("SHA-256", bytes)) !== entry.revision) {
      return false;
    }
    if ((await digestIntegrity(bytes)) !== entry.integrity) return false;
  }
  return true;
}

function refreshCacheVerification(): Promise<boolean> {
  if (cacheVerification === "verified") {
    return Promise.resolve(true);
  }
  if (cacheVerificationInFlight !== null) {
    return cacheVerificationInFlight;
  }
  const attempt = (async (): Promise<boolean> => {
    let verified: boolean;
    try {
      verified = await verifyCurrentCache();
    } catch {
      verified = false;
    }
    cacheVerified = verified;
    cacheVerification = verified ? "verified" : "failed";
    try {
      const clients = await windowClients();
      for (const client of clients) {
        try {
          client.postMessage({
            type: "CACHE_VERIFICATION_COMPLETE",
            release: RELEASE_ID,
          });
        } catch {
          // Verification remains valid if a client disappears mid-notify.
        }
      }
    } catch {
      // A later client query observes the verified in-memory state.
    }
    return verified;
  })();
  cacheVerificationInFlight = attempt;
  void attempt.then(() => {
    if (cacheVerificationInFlight === attempt) {
      cacheVerificationInFlight = null;
    }
  });
  return attempt;
}

function repairIsLive(nonce: string, signal: AbortSignal): boolean {
  return (
    !signal.aborted &&
    transactionState === "preparing" &&
    transactionNonce === nonce
  );
}

async function repairAndVerifyCache(
  nonce: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (await verifyCurrentCache()) {
    return repairIsLive(nonce, signal);
  }
  if (!repairIsLive(nonce, signal)) return false;
  const cache = await caches.open(CURRENT_CACHE);
  const staged: Array<readonly [string, Response]> = [];
  for (const entry of manifest) {
    if (!repairIsLive(nonce, signal)) return false;
    const current = await cache.match(cacheKey(entry));
    let valid = false;
    if (current !== undefined && current.ok) {
      const currentBytes = await current.clone().arrayBuffer();
      valid =
        normalizedMediaType(current.headers.get("Content-Type")) === entry.mediaType &&
        currentBytes.byteLength === entry.size &&
        (await digestHex("SHA-256", currentBytes)) === entry.revision &&
        (await digestIntegrity(currentBytes)) === entry.integrity;
    }
    if (valid) {
      continue;
    }
    const response = await fetch(new URL(entry.url, self.location.origin), {
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      integrity: entry.integrity,
      signal,
    });
    if (
      response.type !== "basic" ||
      response.status !== 200 ||
      !response.ok ||
      normalizedMediaType(response.headers.get("Content-Type")) !== entry.mediaType
    ) {
      return false;
    }
    const bytes = await response.clone().arrayBuffer();
    if (
      bytes.byteLength !== entry.size ||
      (await digestHex("SHA-256", bytes)) !== entry.revision ||
      (await digestIntegrity(bytes)) !== entry.integrity
    ) {
      return false;
    }
    staged.push([cacheKey(entry), response.clone()]);
  }
  for (const [key, response] of staged) {
    if (!repairIsLive(nonce, signal)) return false;
    await cache.put(key, response);
  }
  return repairIsLive(nonce, signal) && (await verifyCurrentCache());
}

async function repairWithDeadline(nonce: string): Promise<boolean> {
  const abort = new AbortController();
  let timeout = 0;
  try {
    return await Promise.race([
      repairAndVerifyCache(nonce, abort.signal),
      new Promise<boolean>((_, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new DOMException("Deadline exceeded", "TimeoutError"));
        }, VERIFY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function nonce128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function windowClients(): Promise<readonly WindowClient[]> {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clients
    .filter((client): client is WindowClient => client.type === "window")
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

async function activeReleaseIsCurrent(): Promise<boolean> {
  const active = self.registration.active;
  if (active === null) return false;
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (matches: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      resolve(matches);
    };
    const timeout = setTimeout(() => finish(false), 1_000);
    channel.port1.onmessage = (event: MessageEvent<{ readonly releaseId?: string }>) => {
      finish(event.data?.releaseId === RELEASE_ID);
    };
    try {
      active.postMessage({ type: "QUERY_WORKER_STATE" }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

function sameClientSet(
  left: readonly WindowClient[],
  right: readonly WindowClient[],
): boolean {
  return (
    left.length === right.length &&
    left.every((client, index) => client.id === right[index]?.id)
  );
}

function postTo(
  clients: readonly WindowClient[],
  message: Readonly<Record<string, string>>,
): void {
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function collectReadiness(
  clients: readonly WindowClient[],
  nonce: string,
): Promise<boolean> {
  CLIENT_REPLY.clear();
  postTo(clients, { type: "PREPARE_UPDATE", nonce, release: RELEASE_ID });
  const deadline = performance.now() + PREPARE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (
      clients.some((client) => CLIENT_REPLY.get(client.id) === "BUSY")
    ) {
      return false;
    }
    if (clients.every((client) => CLIENT_REPLY.get(client.id) === "READY")) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function abortTransaction(
  clients: readonly WindowClient[],
  type: "RELEASE_UPDATE_PREPARE" | "ACTIVATION_FAILED",
): Promise<void> {
  const nonce = transactionNonce;
  if (nonce !== null) {
    postTo(clients, { type, nonce, release: RELEASE_ID });
  }
  transactionState = "idle";
  transactionNonce = null;
  CLIENT_REPLY.clear();
}

async function cleanupStaleCaches(nonce: string): Promise<void> {
  if (
    cleanupInFlight ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    self.registration.installing !== null ||
    self.registration.waiting !== null
  ) {
    return;
  }
  cleanupInFlight = true;
  cleanupNonce = nonce;
  try {
    const candidates = (await caches.keys())
      .filter(
        (name) =>
          name.startsWith("qrwarden-precache-") &&
          name !== CURRENT_CACHE &&
          name !== PREVIOUS_CACHE,
      )
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (candidates.length === 0) return;

    const initialClients = await windowClients();
    CLEANUP_REPLY.clear();
    postTo(initialClients, {
      type: "REPORT_LOADED_RELEASE",
      nonce,
      release: RELEASE_ID,
    });
    const deadline = performance.now() + PREPARE_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (
        initialClients.some((client) => {
          const release = CLEANUP_REPLY.get(client.id);
          return release !== undefined && release !== RELEASE_ID;
        })
      ) {
        return;
      }
      if (initialClients.every((client) => CLEANUP_REPLY.get(client.id) === RELEASE_ID)) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (!initialClients.every((client) => CLEANUP_REPLY.get(client.id) === RELEASE_ID)) {
      return;
    }
    const stableClients = await windowClients();
    if (!sameClientSet(initialClients, stableClients)) return;

    for (const candidate of candidates) {
      if (
        self.registration.installing !== null ||
        self.registration.waiting !== null ||
        !(await activeReleaseIsCurrent())
      ) {
        return;
      }
      await caches.delete(candidate);
    }
  } finally {
    CLEANUP_REPLY.clear();
    cleanupInFlight = false;
    cleanupNonce = null;
  }
}

async function coordinateActivation(): Promise<void> {
  if (transactionState !== "idle") {
    return;
  }
  const nonce = nonce128();
  transactionNonce = nonce;
  transactionState = "preparing";
  let prepared = await windowClients();
  if (!(await collectReadiness(prepared, nonce))) {
    await abortTransaction(prepared, "RELEASE_UPDATE_PREPARE");
    return;
  }

  try {
    cacheVerified = await repairWithDeadline(nonce);
  } catch {
    cacheVerified = false;
  }
  cacheVerification = cacheVerified ? "verified" : "failed";
  if (!cacheVerified) {
    await abortTransaction(prepared, "ACTIVATION_FAILED");
    return;
  }

  transactionState = "finalizing";
  const finalClients = await windowClients();
  if (!sameClientSet(prepared, finalClients)) {
    if (!(await collectReadiness(finalClients, nonce))) {
      await abortTransaction(finalClients, "RELEASE_UPDATE_PREPARE");
      return;
    }
    prepared = finalClients;
  }
  const stableClients = await windowClients();
  if (!sameClientSet(prepared, stableClients)) {
    await abortTransaction(stableClients, "RELEASE_UPDATE_PREPARE");
    return;
  }

  transactionState = "committing";
  const committed = await requestActivationCommit(
    () => self.skipWaiting(),
    stableClients,
    {
      type: "ACTIVATION_COMMITTED",
      nonce,
      release: RELEASE_ID,
    },
  );
  if (!committed) {
    await abortTransaction(stableClients, "ACTIVATION_FAILED");
    return;
  }
  transactionState = "idle";
  transactionNonce = null;
  CLIENT_REPLY.clear();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await precache.install(event);
        cacheVerified = await verifyCurrentCache();
        cacheVerification = cacheVerified ? "verified" : "failed";
        if (!cacheVerified) {
          throw new DOMException("Precache verification failed", "SecurityError");
        }
      } catch (error) {
        await caches.delete(CURRENT_CACHE);
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim().catch(() => undefined));
});

registerRoute(
  new PrecacheRoute(precache, {
    ignoreURLParametersMatching: [],
    cleanURLs: false,
    // Workbox's declaration omits null although its URL variation helper
    // accepts it to disable directory-index inference.
    // @ts-expect-error Workbox's declaration excludes the supported null value.
    directoryIndex: null,
  }),
);

registerRoute(
  ({ request, url }) =>
    request.method === "GET" &&
    request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname === "/" &&
    url.search === "",
  async () => {
    const cache = await caches.open(CURRENT_CACHE);
    const response = await cache.match(cacheKey(rootEntry));
    return response ?? new Response("Offline", { status: 503 });
  },
);

const SHARE_TARGET_PATH = "/share-target";
const SHARE_TARGET_MAX_BYTES = 25_000_000;
const SHARE_TARGET_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SHARE_TARGET_CLIENT_ATTEMPTS = 20;
const SHARE_TARGET_CLIENT_RETRY_MS = 250;

/**
 * Finds the document created by the redirected share navigation. Browsers
 * discard the reserved client of a redirected POST navigation, so the id
 * lookup is only a fast path; the fallback takes the most recently focused
 * same-scope root document, which is the tab the share just opened.
 */
async function resultingShareClient(event: FetchEvent): Promise<Client | null> {
  for (let attempt = 0; attempt < SHARE_TARGET_CLIENT_ATTEMPTS; attempt += 1) {
    const clientId = event.resultingClientId || event.clientId;
    if (clientId !== "") {
      const client = await self.clients.get(clientId);
      if (client !== undefined) {
        return client;
      }
    }
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const candidate = windows.find((client) => {
      try {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname === "/";
      } catch {
        return false;
      }
    });
    if (candidate !== undefined) {
      return candidate;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SHARE_TARGET_CLIENT_RETRY_MS),
    );
  }
  return null;
}

/**
 * Hands a shared image to the redirected document as an in-memory message.
 * Nothing is written to caches or storage: if no client appears, the share
 * is dropped. Validation here only bounds transport; the image intake
 * pipeline re-validates type and size like any chosen file.
 */
async function deliverSharedImage(event: FetchEvent): Promise<void> {
  let file: File | null = null;
  try {
    const data = await event.request.formData();
    const entry = data.get("image");
    if (
      entry instanceof File &&
      entry.size > 0 &&
      entry.size <= SHARE_TARGET_MAX_BYTES &&
      (entry.type === "" || SHARE_TARGET_TYPES.has(entry.type))
    ) {
      file = entry;
    }
  } catch {
    return;
  }
  if (file === null) {
    return;
  }
  const client = await resultingShareClient(event);
  client?.postMessage({ type: "SHARED_IMAGE", release: RELEASE_ID, file });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin === self.location.origin &&
    url.pathname === SHARE_TARGET_PATH
  ) {
    if (event.request.method === "POST") {
      event.respondWith(Response.redirect("/", 303));
      event.waitUntil(deliverSharedImage(event));
      return;
    }
    if (event.request.method === "GET" && event.request.mode === "navigate") {
      event.respondWith(
        Promise.resolve(
          new Response(null, {
            status: 303,
            headers: { Location: "/" },
          }),
        ),
      );
      return;
    }
  }
  if (
    event.request.method === "GET" &&
    event.request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname === "/index.html" &&
    url.search === ""
  ) {
    event.respondWith(
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { Location: "/" },
        }),
      ),
    );
    return;
  }
  if (
    event.request.method === "GET" &&
    event.request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname !== "/"
  ) {
    event.respondWith(
      fetch(event.request).catch(
        () =>
          new Response("Not found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
      ),
    );
  }
});

self.addEventListener("message", (event) => {
  const data = event.data as {
    readonly type?: string;
    readonly nonce?: string;
    readonly release?: string;
  };
  if (data.type === "QUERY_WORKER_STATE") {
    event.ports[0]?.postMessage({
      type: "WORKER_STATE",
      releaseId: RELEASE_ID,
      transactionState,
      cacheVerified,
      cacheVerification,
    });
    if (cacheVerification === "pending") {
      event.waitUntil(refreshCacheVerification().then(() => undefined));
    }
    return;
  }

  if (data.type === "BEGIN_UPDATE_COORDINATION") {
    event.waitUntil(coordinateActivation());
    return;
  }

  if (
    data.type === "CLEANUP_STALE_CACHES" &&
    data.release === RELEASE_ID &&
    typeof data.nonce === "string"
  ) {
    event.waitUntil(cleanupStaleCaches(data.nonce));
    return;
  }

  if (
    data.type === "LOADED_RELEASE" &&
    typeof data.nonce === "string" &&
    data.nonce === cleanupNonce &&
    typeof data.release === "string" &&
    event.source !== null &&
    "id" in event.source
  ) {
    CLEANUP_REPLY.set(event.source.id, data.release);
    return;
  }

  if (
    (data.type === "READY" || data.type === "BUSY") &&
    transactionNonce !== null &&
    data.nonce === transactionNonce &&
    data.release === RELEASE_ID &&
    event.source !== null &&
    "id" in event.source
  ) {
    CLIENT_REPLY.set(event.source.id, data.type);
    return;
  }

  if (data.type === "JOIN_UPDATE_STATE" && event.source !== null) {
    if (transactionState === "idle" || transactionNonce === null) {
      event.source.postMessage({ type: "NO_ACTIVE_PREPARE", release: RELEASE_ID });
    } else {
      event.source.postMessage({
        type: "PREPARE_UPDATE",
        nonce: transactionNonce,
        release: RELEASE_ID,
      });
    }
  }
});

export { CURRENT_CACHE, PREVIOUS_CACHE };
