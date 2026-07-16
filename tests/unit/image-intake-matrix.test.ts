import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filesFromDrop,
  ImageController,
  installDropNavigationGuard,
} from "../../src/image/controller";

class IdleWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
}

function fileLike(size: number, type: string, name = "code.png"): File {
  return { name, size, type } as File;
}

function transferWith(
  items: readonly { readonly kind: string; readonly getAsFile: () => File | null }[],
  files: readonly File[] = [],
): DataTransfer {
  return {
    items,
    files,
    getData: vi.fn(() => "must-not-be-read"),
  } as unknown as DataTransfer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image intake validation matrix", () => {
  it.each([
    ["no files", []],
    ["more than one file", [fileLike(1, "image/png"), fileLike(1, "image/jpeg")]],
  ])("rejects %s before worker creation", (_label, files) => {
    const workerFactory = vi.fn<() => Worker>();
    const onProblem = vi.fn();
    const controller = new ImageController({
      workerFactory,
      onResult: vi.fn(),
      onProblem,
    });

    controller.choose(files);

    expect(onProblem).toHaveBeenCalledExactlyOnceWith("choose-one-image");
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized PNG", fileLike(25_000_001, "image/png"), "image-too-large"],
    ["SVG", fileLike(100, "image/svg+xml", "code.svg"), "unsupported-image-type"],
    ["generic binary", fileLike(100, "application/octet-stream"), "unsupported-image-type"],
    ["case-variant MIME", fileLike(100, "IMAGE/PNG"), "unsupported-image-type"],
  ])("rejects %s before worker creation", (_label, file, expected) => {
    const workerFactory = vi.fn<() => Worker>();
    const onProblem = vi.fn();
    const controller = new ImageController({
      workerFactory,
      onResult: vi.fn(),
      onProblem,
    });

    controller.choose([file]);

    expect(onProblem).toHaveBeenCalledExactlyOnceWith(expected);
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["JPEG", fileLike(1, "image/jpeg", "code.jpg")],
    ["PNG", fileLike(1, "image/png")],
    ["WebP", fileLike(1, "image/webp", "code.webp")],
    ["sniffable empty MIME", fileLike(1, "")],
    ["exact file-size boundary", fileLike(25_000_000, "image/png")],
  ])("accepts %s into the worker-owned path", async (_label, file) => {
    const worker = new IdleWorker();
    const workerFactory = vi.fn(() => worker as unknown as Worker);
    const onProblem = vi.fn();
    const controller = new ImageController({
      workerFactory,
      onResult: vi.fn(),
      onProblem,
    });

    controller.choose([file]);
    expect(workerFactory).toHaveBeenCalledOnce();
    expect(controller.busy).toBe(true);
    expect(onProblem).not.toHaveBeenCalled();

    controller.cancel();
    await Promise.resolve();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(controller.busy).toBe(false);
  });

  it("reports a synchronous decoder-worker startup failure", () => {
    const workerFactory = vi.fn<() => Worker>(() => {
      throw new DOMException("Worker unavailable", "NotSupportedError");
    });
    const onProblem = vi.fn();
    const controller = new ImageController({
      workerFactory,
      onResult: vi.fn(),
      onProblem,
    });

    controller.choose([fileLike(1, "image/png")]);

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(onProblem).toHaveBeenCalledExactlyOnceWith("reader-stopped");
    expect(controller.busy).toBe(false);
  });

  it("filters drop items without reading strings or falling back from a nonempty item list", () => {
    const accepted = fileLike(1, "image/png", "accepted.png");
    const ignoredFallback = fileLike(1, "image/png", "fallback.png");
    const transfer = transferWith(
      [
        { kind: "string", getAsFile: vi.fn(() => null) },
        { kind: "file", getAsFile: vi.fn(() => null) },
        { kind: "file", getAsFile: vi.fn(() => accepted) },
      ],
      [ignoredFallback],
    );

    const files = filesFromDrop(transfer);

    expect(files).toEqual([accepted]);
    expect(Object.isFrozen(files)).toBe(true);
    expect(transfer.getData).not.toHaveBeenCalled();
  });

  it("uses DataTransfer.files only when the item list is empty", () => {
    const first = fileLike(1, "image/png", "first.png");
    const second = fileLike(1, "image/jpeg", "second.jpg");
    const transfer = transferWith([], [first, second]);

    expect(filesFromDrop(transfer)).toEqual([first, second]);
    expect(transfer.getData).not.toHaveBeenCalled();
  });

  it("prevents drag navigation, forwards files, and removes both window guards", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const file = fileLike(1, "image/png");
    const transfer = transferWith([{ kind: "file", getAsFile: () => file }]);
    const onFiles = vi.fn();
    const remove = installDropNavigationGuard(onFiles);
    const drag = new Event("dragover", { cancelable: true });
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    target.dispatchEvent(drag);
    target.dispatchEvent(drop);

    expect(drag.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);

    remove();
    target.dispatchEvent(new Event("drop", { cancelable: true }));
    expect(onFiles).toHaveBeenCalledOnce();
  });
});
