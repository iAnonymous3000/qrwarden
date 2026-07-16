import { describe, expect, it, vi } from "vitest";

import { requestActivationCommit } from "../../src/sw/activationCommit";

describe("service-worker activation commit boundary", () => {
  it("stays committed and continues notification when one client throws", async () => {
    const second = { postMessage: vi.fn() };
    const committed = await requestActivationCommit(
      () => Promise.resolve(),
      [
        {
          postMessage: () => {
            throw new DOMException("gone", "InvalidStateError");
          },
        },
        second,
      ],
      { type: "ACTIVATION_COMMITTED", nonce: "a".repeat(32), release: "v2" },
    );

    expect(committed).toBe(true);
    expect(second.postMessage).toHaveBeenCalledOnce();
  });

  it("reports failure only before skipWaiting resolves", async () => {
    const client = { postMessage: vi.fn() };

    await expect(
      requestActivationCommit(
        () => Promise.reject(new DOMException("failed", "InvalidStateError")),
        [client],
        { type: "ACTIVATION_COMMITTED" },
      ),
    ).resolves.toBe(false);
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});
