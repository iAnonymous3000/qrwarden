import { render } from "preact";

import {
  createQrwardenModuleWorker,
  initializeTrustedWorkerScripts,
} from "./app/trustedScripts";
import { APP_LOCALE } from "./copy/locale";
import { DecoderWorkerClient } from "./decoder";
import { App, type AppStatusDetail, type RuntimeBridge } from "./render/App";
import "./render/styles.css";
import { createBrowserThemeController } from "./render/theme";
import {
  replayServiceWorkerStatus,
  requestPendingShare,
  ServiceWorkerClient,
  type OfflineState,
} from "./sw/client";
import { readShareDeliveryMessage } from "./sw/protocol";
import {
  shareAdmissionRejectionFromUrl,
  sharePendingTokenFromUrl,
} from "./sw/shareToken";

declare const __QRWARDEN_RELEASE_ID__: string;
declare const __QRWARDEN_SIGNING_PUBLIC_KEY__: string;
declare const __QRWARDEN_SIGNING_FINGERPRINT__: string;
declare const __QRWARDEN_DNS_KEY_OWNER__: string;
declare const __QRWARDEN_SOURCE_REPOSITORY__: string | null;

const root = document.getElementById("app");
if (root === null) {
  throw new TypeError("Missing application root");
}
const themeController = createBrowserThemeController();
document.documentElement.lang = APP_LOCALE;

const trustedScripts = initializeTrustedWorkerScripts();
const workerFactory = (): Worker =>
  createQrwardenModuleWorker(trustedScripts.decoder);

const statusEvents = new EventTarget();
const bridge: RuntimeBridge = {
  // The update coordinator must not enroll this document before App has
  // mounted and installed its authoritative idle predicate.
  isIdle: () => false,
  dropReport: () => undefined,
};
const emit = (detail: AppStatusDetail): void => {
  statusEvents.dispatchEvent(new CustomEvent("status", { detail }));
};

let offlineState: OfflineState = "preparing";
let locked = true;
let serviceWorker: ServiceWorkerClient | null = null;

// Share-target images arrive as an in-memory service-worker message for the
// redirected document. The listener is installed before the first render so
// browser-buffered messages cannot be dropped; App owns consumption gating.
navigator.serviceWorker?.addEventListener("message", (event) => {
  const message = readShareDeliveryMessage(event.data, __QRWARDEN_RELEASE_ID__);
  if (message?.type === "SHARED_IMAGE") {
    emit({ sharedImage: message.file });
  } else if (message?.type === "SHARE_REJECTED") {
    emit({ shareRejected: message.reason });
  }
});
// addEventListener alone never enables the client message queue; without this
// call a message posted before (or after) load is buffered forever.
navigator.serviceWorker?.startMessages();

// A share whose redirected document the worker could not identify waits in
// worker memory behind an unguessable, per-share ?share-pending token. The
// token carries no share data: it correlates this document with exactly one
// parked payload even when simultaneous multipart parses finish out of order.
// It is removed only once the pull was actually posted, so it neither persists
// in history nor re-triggers after delivery — while a failed pull (missing or
// redundant controller) keeps it for a reload within the parking deadline.
const startupUrl = new URL(window.location.href);
const pendingShareToken = sharePendingTokenFromUrl(startupUrl);
const startupShareRejection = shareAdmissionRejectionFromUrl(startupUrl);
if (startupShareRejection !== null) {
  startupUrl.search = "";
  history.replaceState(history.state, "", startupUrl);
}
if (pendingShareToken !== null) {
  if (
    requestPendingShare(
      navigator.serviceWorker?.controller ?? null,
      pendingShareToken,
    )
  ) {
    startupUrl.searchParams.delete("share-pending");
    history.replaceState(history.state, "", startupUrl);
  }
}

const smokeDecoder = async (): Promise<boolean> => {
  let client: DecoderWorkerClient | null = null;
  try {
    client = new DecoderWorkerClient(workerFactory);
    await client.start();
    await client.smoke(0);
    return true;
  } catch {
    return false;
  } finally {
    client?.dispose("cancelled");
  }
};

if (import.meta.env.DEV) {
  offlineState = "incomplete";
  locked = false;
} else {
  serviceWorker = new ServiceWorkerClient({
    loadedRelease: __QRWARDEN_RELEASE_ID__,
    scriptURL: trustedScripts.serviceWorker,
    isIdle: () => bridge.isIdle(),
    onLockChange: (next) => {
      locked = next;
      emit({ locked: next });
    },
    onState: (next) => {
      offlineState = next;
      emit({ offlineState: next });
    },
    dropReport: () => bridge.dropReport(),
    decoderSmoke: smokeDecoder,
  });
}

render(
  <App
    workerFactory={workerFactory}
    serviceWorker={serviceWorker}
    initialOfflineState={offlineState}
    initialLocked={locked}
    releaseId={__QRWARDEN_RELEASE_ID__}
    signingPublicKey={__QRWARDEN_SIGNING_PUBLIC_KEY__}
    signingFingerprint={__QRWARDEN_SIGNING_FINGERPRINT__}
    dnsKeyOwner={__QRWARDEN_DNS_KEY_OWNER__}
    sourceRepository={__QRWARDEN_SOURCE_REPOSITORY__}
    statusEvents={statusEvents}
    bridge={bridge}
    themeController={themeController}
  />,
  root,
);

if (startupShareRejection !== null) {
  queueMicrotask(() => emit({ shareRejected: startupShareRejection }));
}

// Render the locked shell before service-worker registration or state queries.
// Slow mobile storage and lifecycle APIs must not leave a blank page, while no
// scan or report action becomes available until the gate explicitly unlocks.
if (serviceWorker !== null) {
  void serviceWorker.gate().catch(() => {
    offlineState = "update-failed";
    locked = true;
    emit({ offlineState, locked });
  });
}

// Replay the authoritative snapshot after App's subscription is installed so
// a synchronous startup state cannot be lost around the first commit.
replayServiceWorkerStatus(
  () => ({ offlineState, locked }),
  (snapshot) => emit(snapshot),
);
