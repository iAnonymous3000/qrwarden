import { isSharePendingToken } from "./shareToken";

export type WorkerTransactionState =
  | "idle"
  | "preparing"
  | "finalizing"
  | "committing";

export type CacheVerification = "pending" | "verified" | "failed";

export interface WorkerState {
  readonly releaseId: string;
  readonly transactionState: WorkerTransactionState;
  readonly cacheVerified: boolean;
  readonly cacheVerification: CacheVerification;
}

export type ShareRejectionReason =
  | "busy"
  | "multiple-files"
  | "too-large"
  | "unsupported-type"
  | "unreadable";

export type ClientToWorkerMessage =
  | { readonly type: "QUERY_WORKER_STATE" }
  | { readonly type: "BEGIN_UPDATE_COORDINATION" }
  | { readonly type: "PULL_SHARED_IMAGE"; readonly token: string }
  | {
      readonly type: "CLEANUP_STALE_CACHES";
      readonly nonce: string;
      readonly release: string;
    }
  | {
      readonly type: "LOADED_RELEASE" | "READY" | "BUSY";
      readonly nonce: string;
      readonly release: string;
    }
  | { readonly type: "JOIN_UPDATE_STATE"; readonly loadedRelease: string };

export interface WorkerStateMessage extends WorkerState {
  readonly type: "WORKER_STATE";
}

export interface ActivationCommittedMessage {
  readonly type: "ACTIVATION_COMMITTED";
  readonly nonce: string;
  readonly release: string;
}

export interface SharedImageMessage {
  readonly type: "SHARED_IMAGE";
  readonly release: string;
  readonly file: File;
}

export interface ShareRejectedMessage {
  readonly type: "SHARE_REJECTED";
  readonly release: string;
  readonly reason: ShareRejectionReason;
}

export type ShareDeliveryMessage = SharedImageMessage | ShareRejectedMessage;

export type WorkerToClientMessage =
  | WorkerStateMessage
  | {
      readonly type:
        | "PREPARE_UPDATE"
        | "REPORT_LOADED_RELEASE"
        | "RELEASE_UPDATE_PREPARE"
        | "ACTIVATION_FAILED";
      readonly nonce: string;
      readonly release: string;
    }
  | ActivationCommittedMessage
  | {
      readonly type: "CACHE_VERIFICATION_COMPLETE" | "NO_ACTIVE_PREPARE";
      readonly release: string;
    }
  | SharedImageMessage
  | ShareRejectedMessage;

interface MessageTarget {
  postMessage(message: unknown): void;
}

interface TransferMessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export function postClientToWorker(
  target: MessageTarget,
  message: ClientToWorkerMessage,
): void {
  target.postMessage(message);
}

export function postClientToWorkerWithTransfer(
  target: TransferMessageTarget,
  message: ClientToWorkerMessage,
  transfer: Transferable[],
): void {
  target.postMessage(message, transfer);
}

export function postWorkerToClient(
  target: MessageTarget,
  message: WorkerToClientMessage,
): void {
  target.postMessage(message);
}

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function isProtocolNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isRelease(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTransactionState(value: unknown): value is WorkerTransactionState {
  return (
    value === "idle" ||
    value === "preparing" ||
    value === "finalizing" ||
    value === "committing"
  );
}

function isCacheVerification(value: unknown): value is CacheVerification {
  return value === "pending" || value === "verified" || value === "failed";
}

function isShareRejectionReason(value: unknown): value is ShareRejectionReason {
  return (
    value === "busy" ||
    value === "multiple-files" ||
    value === "too-large" ||
    value === "unsupported-type" ||
    value === "unreadable"
  );
}

export function readClientToWorkerMessage(
  value: unknown,
): ClientToWorkerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "QUERY_WORKER_STATE":
    case "BEGIN_UPDATE_COORDINATION":
      return hasExactKeys(value, ["type"]) ? { type: value.type } : null;
    case "PULL_SHARED_IMAGE":
      return hasExactKeys(value, ["type", "token"]) &&
          isSharePendingToken(value.token)
        ? { type: value.type, token: value.token }
        : null;
    case "CLEANUP_STALE_CACHES":
    case "LOADED_RELEASE":
    case "READY":
    case "BUSY":
      return hasExactKeys(value, ["type", "nonce", "release"]) &&
          isProtocolNonce(value.nonce) &&
          isRelease(value.release)
        ? { type: value.type, nonce: value.nonce, release: value.release }
        : null;
    case "JOIN_UPDATE_STATE":
      return hasExactKeys(value, ["type", "loadedRelease"]) &&
          isRelease(value.loadedRelease)
        ? { type: value.type, loadedRelease: value.loadedRelease }
        : null;
    default:
      return null;
  }
}

export function readWorkerToClientMessage(
  value: unknown,
): WorkerToClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "WORKER_STATE": {
      if (
        !hasExactKeys(value, [
          "type",
          "releaseId",
          "transactionState",
          "cacheVerified",
          "cacheVerification",
        ]) ||
        !isRelease(value.releaseId) ||
        !isTransactionState(value.transactionState) ||
        typeof value.cacheVerified !== "boolean" ||
        !isCacheVerification(value.cacheVerification) ||
        (value.cacheVerification === "verified") !== value.cacheVerified
      ) {
        return null;
      }
      return {
        type: value.type,
        releaseId: value.releaseId,
        transactionState: value.transactionState,
        cacheVerified: value.cacheVerified,
        cacheVerification: value.cacheVerification,
      };
    }
    case "PREPARE_UPDATE":
    case "REPORT_LOADED_RELEASE":
    case "RELEASE_UPDATE_PREPARE":
    case "ACTIVATION_FAILED":
    case "ACTIVATION_COMMITTED":
      return hasExactKeys(value, ["type", "nonce", "release"]) &&
          isProtocolNonce(value.nonce) &&
          isRelease(value.release)
        ? { type: value.type, nonce: value.nonce, release: value.release }
        : null;
    case "CACHE_VERIFICATION_COMPLETE":
    case "NO_ACTIVE_PREPARE":
      return hasExactKeys(value, ["type", "release"]) &&
          isRelease(value.release)
        ? { type: value.type, release: value.release }
        : null;
    case "SHARED_IMAGE":
      return hasExactKeys(value, ["type", "release", "file"]) &&
          isRelease(value.release) &&
          typeof File !== "undefined" &&
          value.file instanceof File
        ? { type: value.type, release: value.release, file: value.file }
        : null;
    case "SHARE_REJECTED":
      return hasExactKeys(value, ["type", "release", "reason"]) &&
          isRelease(value.release) &&
          isShareRejectionReason(value.reason)
        ? { type: value.type, release: value.release, reason: value.reason }
        : null;
    default:
      return null;
  }
}

export function readShareDeliveryMessage(
  value: unknown,
  currentRelease: string,
): ShareDeliveryMessage | null {
  const message = readWorkerToClientMessage(value);
  if (
    (message?.type === "SHARED_IMAGE" || message?.type === "SHARE_REJECTED") &&
    message.release === currentRelease
  ) {
    return message;
  }
  return null;
}
