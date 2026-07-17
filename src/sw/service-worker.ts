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

// Only documents at the app shell URL run the coordinator that can answer
// PREPARE_UPDATE and REPORT_LOADED_RELEASE; a same-origin window parked on
// any other path (a 404 document, a security.txt tab) holds no report state
// and would silently block every activation for as long as it stays open.
// Only the path decides what the host serves: '/' is the shell for every
// query string (a link may carry foreign parameters for the tab's whole
// lifetime), and such a document runs the full coordinator — excluding it
// would skip its BUSY vote and let an activation destroy its live work.
// An unparseable client URL stays in the quorum: fail closed.
function participatesInCoordination(client: WindowClient): boolean {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && url.pathname === "/";
  } catch {
    return true;
  }
}

async function windowClients(): Promise<readonly WindowClient[]> {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clients
    .filter((client): client is WindowClient => client.type === "window")
    .filter((client) => participatesInCoordination(client))
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

function abortTransaction(
  clients: readonly WindowClient[],
  type: "RELEASE_UPDATE_PREPARE" | "ACTIVATION_FAILED",
): void {
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
    abortTransaction(prepared, "RELEASE_UPDATE_PREPARE");
    return;
  }

  try {
    cacheVerified = await repairWithDeadline(nonce);
  } catch {
    cacheVerified = false;
  }
  cacheVerification = cacheVerified ? "verified" : "failed";
  if (!cacheVerified) {
    abortTransaction(prepared, "ACTIVATION_FAILED");
    return;
  }

  transactionState = "finalizing";
  const finalClients = await windowClients();
  if (!sameClientSet(prepared, finalClients)) {
    if (!(await collectReadiness(finalClients, nonce))) {
      abortTransaction(finalClients, "RELEASE_UPDATE_PREPARE");
      return;
    }
    prepared = finalClients;
  }
  const stableClients = await windowClients();
  if (!sameClientSet(prepared, stableClients)) {
    abortTransaction(stableClients, "RELEASE_UPDATE_PREPARE");
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
    abortTransaction(stableClients, "ACTIVATION_FAILED");
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

// Static marker the share redirect appends so the redirected document knows
// to pull a parked share from the worker. It carries no share data — it is a
// fixed string — and main.tsx removes it via history.replaceState.
const SHARE_TARGET_PENDING_SEARCH = "?share-pending";

registerRoute(
  ({ request, url }) =>
    request.method === "GET" &&
    request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname === "/" &&
    (url.search === "" || url.search === SHARE_TARGET_PENDING_SEARCH),
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
const SHARE_TARGET_PENDING_TTL_MS = 120_000;
const SHARE_TARGET_MAX_PARKED = 4;

type ShareRejectionReason =
  | "multiple-files"
  | "too-large"
  | "unsupported-type"
  | "unreadable";

type SharePayload =
  | { readonly kind: "image"; readonly file: File }
  | { readonly kind: "rejected"; readonly reason: ShareRejectionReason };

interface ParkedShare {
  readonly payload: SharePayload;
  readonly expires: number;
}

// Shares whose resulting client cannot be identified wait here, oldest first,
// for redirected documents to pull them. Rejections park through the same
// bounded queue so an invalid share still reaches the user as an error
// instead of vanishing. Redirected documents pull in navigation order, so
// FIFO keeps overlapping shares paired with their own documents instead of
// letting the newest share overwrite an older parked one. The deadline keeps
// an unclaimed share from outliving the navigation that produced it.
const pendingShares: ParkedShare[] = [];

function parkShare(payload: SharePayload): void {
  while (pendingShares.length > 0 && Date.now() >= pendingShares[0]!.expires) {
    pendingShares.shift();
  }
  if (pendingShares.length >= SHARE_TARGET_MAX_PARKED) {
    // Fail closed: refusing the newest share beats overwriting an older one.
    return;
  }
  pendingShares.push({
    payload,
    expires: Date.now() + SHARE_TARGET_PENDING_TTL_MS,
  });
}

function takePendingShare(): SharePayload | null {
  while (pendingShares.length > 0) {
    const parked = pendingShares.shift()!;
    if (Date.now() < parked.expires) {
      return parked.payload;
    }
  }
  return null;
}

interface PendingPull {
  readonly source: Client | ServiceWorker | MessagePort;
  readonly expires: number;
}

// The redirected document posts PULL_SHARED_IMAGE exactly once, and nothing
// orders that message after the share's multipart parse. Pulls that arrive
// before their share is parked wait here, oldest first, so every in-flight
// delivery can still complete its rendezvous instead of silently dropping
// the share.
const pendingPulls: PendingPull[] = [];

function parkPull(source: PendingPull["source"]): void {
  while (pendingPulls.length > 0 && Date.now() >= pendingPulls[0]!.expires) {
    pendingPulls.shift();
  }
  if (pendingPulls.length >= SHARE_TARGET_MAX_PARKED) {
    return;
  }
  pendingPulls.push({
    source,
    expires: Date.now() + SHARE_TARGET_PENDING_TTL_MS,
  });
}

function takePendingPull(): PendingPull["source"] | null {
  while (pendingPulls.length > 0) {
    const waiting = pendingPulls.shift()!;
    if (Date.now() < waiting.expires) {
      return waiting.source;
    }
  }
  return null;
}

// A document served through the resulting-client push has no further use for
// a pull it parked while its share was still parsing. While another share is
// in flight the settled delivery's cleanup cannot clear the queue wholesale,
// so the served document's own pull must go now — leaving it parked would
// hand that overlapping share to this already-served document while the
// share's real recipient finds nothing. Sources without a client id cannot
// be attributed and stay parked: they are the id-less rendezvous itself.
function dropPendingPullsFor(served: Client): void {
  for (let index = pendingPulls.length - 1; index >= 0; index -= 1) {
    const source = pendingPulls[index]!.source;
    if ("id" in source && source.id === served.id) {
      pendingPulls.splice(index, 1);
    }
  }
}

// Counts share POSTs whose delivery has not settled. A pull may only park
// while a rendezvous is still possible; once every in-flight share settles
// with nothing parked, a waiting pull can never be answered and is dropped
// so a later, unrelated share cannot be misdelivered to a stale document.
let sharesInFlight = 0;

function postSharePayload(
  target: { postMessage(message: unknown): void },
  payload: SharePayload,
): void {
  try {
    if (payload.kind === "image") {
      target.postMessage({
        type: "SHARED_IMAGE",
        release: RELEASE_ID,
        file: payload.file,
      });
    } else {
      target.postMessage({
        type: "SHARE_REJECTED",
        release: RELEASE_ID,
        reason: payload.reason,
      });
    }
  } catch {
    // A vanished document forfeits its share; the sender can re-share.
  }
}

// The manifest declares a single files entry, but Web Share Target appends
// every accepted file under that entry's name, so multi-image shares arrive
// here and are rejected explicitly for this single-image analyzer.
function classifySharedFiles(files: readonly File[]): SharePayload {
  if (files.length > 1) {
    return { kind: "rejected", reason: "multiple-files" };
  }
  const file = files[0];
  if (file === undefined || file.size === 0) {
    return { kind: "rejected", reason: "unreadable" };
  }
  if (file.size > SHARE_TARGET_MAX_BYTES) {
    return { kind: "rejected", reason: "too-large" };
  }
  if (file.type !== "" && !SHARE_TARGET_TYPES.has(file.type)) {
    return { kind: "rejected", reason: "unsupported-type" };
  }
  return { kind: "image", file };
}

/**
 * Finds the document created by the redirected share navigation through its
 * reserved client id. The id survives the worker's 303 redirect in Chromium,
 * but the document may not exist yet when the POST event fires, so the
 * lookup polls on a bounded schedule. When the engine reports no id at all
 * (some native share-sheet launches), this returns null and the share stays
 * parked for the marker-driven pull — the worker never guesses among open
 * windows, because a pre-existing tab would deterministically win.
 */
async function resultingShareClient(event: FetchEvent): Promise<Client | null> {
  const clientId = event.resultingClientId || event.clientId;
  if (clientId === "") {
    return null;
  }
  for (let attempt = 0; attempt < SHARE_TARGET_CLIENT_ATTEMPTS; attempt += 1) {
    const client = await self.clients.get(clientId);
    if (client !== undefined) {
      return client;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SHARE_TARGET_CLIENT_RETRY_MS),
    );
  }
  return null;
}

/**
 * Hands a shared image to the redirected document as an in-memory message.
 * Nothing is written to caches or storage: the share is parked in worker
 * memory behind a short deadline and dropped if no document claims it. The
 * resulting-client push and the marker-driven pull consume the same bounded
 * queue, so each share is delivered at most once and overlapping shares
 * resolve in arrival order. An invalid share travels the same rendezvous as
 * an explicit rejection so the user sees an error instead of silence.
 * Validation here only bounds transport; the image intake pipeline
 * re-validates type and size like any chosen file.
 */
async function deliverSharedImage(event: FetchEvent): Promise<void> {
  sharesInFlight += 1;
  try {
    let payload: SharePayload;
    try {
      const data = await event.request.formData();
      payload = classifySharedFiles(
        data
          .getAll("image")
          .filter((entry): entry is File => entry instanceof File),
      );
    } catch {
      payload = { kind: "rejected", reason: "unreadable" };
    }
    // The resulting client stays authoritative; a parked pull is the fallback
    // for engines that report no client id for the redirected document. The
    // payload stays local to this delivery, so a concurrent share can never
    // replace it or suppress its push. A directly served document also
    // surrenders any pull it parked, so an overlapping share cannot fall
    // back onto a document that already has its image.
    const resulting = await resultingShareClient(event);
    if (resulting !== null) {
      dropPendingPullsFor(resulting);
      postSharePayload(resulting, payload);
      return;
    }
    const waiting = takePendingPull();
    if (waiting !== null) {
      postSharePayload(waiting, payload);
      return;
    }
    parkShare(payload);
  } finally {
    sharesInFlight -= 1;
    if (sharesInFlight === 0 && pendingShares.length === 0) {
      // Every delivery settled with nothing parked: a still-waiting pull can
      // never rendezvous, and keeping it alive would hand the next unrelated
      // share to a stale document.
      pendingPulls.length = 0;
    }
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin === self.location.origin &&
    url.pathname === SHARE_TARGET_PATH
  ) {
    if (event.request.method === "POST") {
      event.respondWith(
        new Response(null, {
          status: 303,
          headers: { Location: `/${SHARE_TARGET_PENDING_SEARCH}` },
        }),
      );
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

  if (data.type === "PULL_SHARED_IMAGE" && event.source !== null) {
    const payload = takePendingShare();
    if (payload === null) {
      // The share POST may still be parsing its multipart body; park the
      // puller so delivery completes once the share settles. With no share
      // parked and none in flight the pull is definitively unanswerable and
      // is dropped, never left to claim a later, unrelated share.
      if (sharesInFlight > 0) {
        parkPull(event.source);
      }
      return;
    }
    postSharePayload(event.source, payload);
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
