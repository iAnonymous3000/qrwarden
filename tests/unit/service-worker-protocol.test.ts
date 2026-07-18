import { describe, expect, it, vi } from "vitest";

import {
  postClientToWorker,
  postWorkerToClient,
  readClientToWorkerMessage,
  readShareDeliveryMessage,
  readWorkerToClientMessage,
} from "../../src/sw/protocol";

const RELEASE = `v0.1.0+${"a".repeat(40)}`;
const STALE_RELEASE = `v0.1.0+${"b".repeat(40)}`;
const NONCE = "c".repeat(32);

describe("service-worker protocol", () => {
  it("accepts share delivery only from the exact loaded release", () => {
    const file = new File(["image"], "shared.png", { type: "image/png" });

    expect(
      readShareDeliveryMessage(
        { type: "SHARED_IMAGE", release: RELEASE, file },
        RELEASE,
      ),
    ).toEqual({ type: "SHARED_IMAGE", release: RELEASE, file });
    expect(
      readShareDeliveryMessage(
        { type: "SHARE_REJECTED", release: RELEASE, reason: "too-large" },
        RELEASE,
      ),
    ).toEqual({
      type: "SHARE_REJECTED",
      release: RELEASE,
      reason: "too-large",
    });
  });

  it.each([
    ["missing image release", { type: "SHARED_IMAGE", file: new File(["x"], "x.png") }],
    [
      "stale image release",
      {
        type: "SHARED_IMAGE",
        release: STALE_RELEASE,
        file: new File(["x"], "x.png"),
      },
    ],
    ["missing rejection release", { type: "SHARE_REJECTED", reason: "unreadable" }],
    [
      "stale rejection release",
      { type: "SHARE_REJECTED", release: STALE_RELEASE, reason: "unreadable" },
    ],
  ])("rejects %s before share intake", (_label, message) => {
    expect(readShareDeliveryMessage(message, RELEASE)).toBeNull();
  });

  it("rejects malformed or drifted client messages", () => {
    expect(
      readClientToWorkerMessage({
        type: "PULL_SHARED_IMAGE",
        token: "d".repeat(32),
        unexpected: true,
      }),
    ).toBeNull();
    expect(
      readClientToWorkerMessage({
        type: "CLEANUP_STALE_CACHES",
        nonce: "not-a-nonce",
        release: RELEASE,
      }),
    ).toBeNull();
    expect(readClientToWorkerMessage({ type: "FUTURE_COMMAND" })).toBeNull();
  });

  it("rejects malformed or internally inconsistent worker messages", () => {
    expect(
      readWorkerToClientMessage({
        type: "WORKER_STATE",
        releaseId: RELEASE,
        transactionState: "idle",
        cacheVerified: true,
      }),
    ).toBeNull();
    expect(
      readWorkerToClientMessage({
        type: "WORKER_STATE",
        releaseId: RELEASE,
        transactionState: "idle",
        cacheVerified: true,
        cacheVerification: "pending",
      }),
    ).toBeNull();
    expect(
      readWorkerToClientMessage({
        type: "ACTIVATION_COMMITTED",
        nonce: NONCE,
        release: RELEASE,
        unexpected: true,
      }),
    ).toBeNull();
    expect(
      readWorkerToClientMessage({
        type: "SHARE_REJECTED",
        release: RELEASE,
        reason: "future-reason",
      }),
    ).toBeNull();
  });

  it("posts only typed messages through the directional helpers", () => {
    const toWorker = { postMessage: vi.fn() };
    const toClient = { postMessage: vi.fn() };

    postClientToWorker(toWorker, {
      type: "CLEANUP_STALE_CACHES",
      nonce: NONCE,
      release: RELEASE,
    });
    postWorkerToClient(toClient, {
      type: "CACHE_VERIFICATION_COMPLETE",
      release: RELEASE,
    });

    expect(toWorker.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "CLEANUP_STALE_CACHES",
      nonce: NONCE,
      release: RELEASE,
    });
    expect(toClient.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "CACHE_VERIFICATION_COMPLETE",
      release: RELEASE,
    });
  });
});
