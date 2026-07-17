import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DecoderFailure,
  DecoderWorkerClient,
  STARTUP_TIMEOUT_MS,
} from "../../src/decoder";
import type { DecoderResponse } from "../../src/decoder/workerProtocol";

class FakeDecoderWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  emit(response: DecoderResponse): void {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("decoder worker client startup deadline", () => {
  it("rejects every waiting caller at the deadline when the worker stays silent", async () => {
    vi.useFakeTimers();
    const worker = new FakeDecoderWorker();
    const client = new DecoderWorkerClient(() => worker as unknown as Worker);
    let startFailure: unknown = null;
    const started = client.start().catch((error: unknown) => {
      startFailure = error;
    });
    let decodeFailure: unknown = null;
    const decode = client
      .decodeImage(new File(["x"], "code.png", { type: "image/png" }), 0)
      .catch((error: unknown) => {
        decodeFailure = error;
      });

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 1);
    expect(startFailure).toBeNull();
    expect(decodeFailure).toBeNull();
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await started;
    await decode;
    expect(startFailure).toBeInstanceOf(DecoderFailure);
    expect((startFailure as DecoderFailure).code).toBe("took-too-long");
    expect(decodeFailure).toBeInstanceOf(DecoderFailure);
    expect((decodeFailure as DecoderFailure).code).toBe("took-too-long");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("clears the deadline once the worker reports ready", async () => {
    vi.useFakeTimers();
    const worker = new FakeDecoderWorker();
    const client = new DecoderWorkerClient(() => worker as unknown as Worker);
    const started = client.start();
    worker.emit({ type: "ready" });
    await expect(started).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(worker.terminate).not.toHaveBeenCalled();

    const smoke = client.smoke(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "smoke",
      jobId: 1,
      epoch: 0,
    });
    worker.emit({ type: "smoke-ok", jobId: 1, epoch: 0 });
    await expect(smoke).resolves.toBeUndefined();
    client.dispose("cancelled");
  });

  it("cancels the deadline for a client disposed before startup settles", async () => {
    vi.useFakeTimers();
    const worker = new FakeDecoderWorker();
    const client = new DecoderWorkerClient(() => worker as unknown as Worker);
    const started = client.start();
    client.dispose("cancelled");

    await expect(started).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "reader-stopped"] as const)(
    "disposes an unstarted client with %s without an unhandled rejection",
    async (code) => {
      const rejections: unknown[] = [];
      const capture = (reason: unknown): void => {
        rejections.push(reason);
      };
      const previous = process.listeners("unhandledRejection");
      process.removeAllListeners("unhandledRejection");
      process.on("unhandledRejection", capture);
      try {
        const worker = new FakeDecoderWorker();
        const client = new DecoderWorkerClient(() => worker as unknown as Worker);
        // Dispose before any caller attaches to readiness, mirroring a camera
        // view cancelled (or a permission denial) before the first frame.
        client.dispose(code);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(rejections).toEqual([]);
        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(client.start()).rejects.toMatchObject({ code });
      } finally {
        process.off("unhandledRejection", capture);
        for (const listener of previous) {
          process.on("unhandledRejection", listener);
        }
      }
    },
  );

  it("keeps the fatal-init rejection ahead of the deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeDecoderWorker();
    const client = new DecoderWorkerClient(() => worker as unknown as Worker);
    const started = client.start();
    worker.emit({ type: "fatal", code: "reader-stopped" });

    await expect(started).rejects.toMatchObject({ code: "reader-stopped" });
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
