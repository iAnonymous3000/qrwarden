import { describe, expect, it, vi } from "vitest";

import { filesFromDrop, ImageController } from "../../src/image/controller";

describe("image intake", () => {
  it("rejects multiple files before creating a worker", () => {
    const workerFactory = vi.fn<() => Worker>();
    const onProblem = vi.fn();
    const controller = new ImageController({
      workerFactory,
      onResult: vi.fn(),
      onProblem,
    });
    controller.choose([
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ]);
    expect(onProblem).toHaveBeenCalledWith("choose-one-image");
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("never needs dropped string data", () => {
    const file = new File(["x"], "code.png", { type: "image/png" });
    const transfer = {
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => file },
      ],
      files: [],
      getData: vi.fn(() => "https://should-not-be-read.example"),
    } as unknown as DataTransfer;
    expect(filesFromDrop(transfer)).toEqual([file]);
    expect(transfer.getData).not.toHaveBeenCalled();
  });
});
