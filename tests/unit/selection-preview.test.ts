import { describe, expect, it, vi } from "vitest";

import {
  retainSelectionPreview,
  selectionPositionLabel,
} from "../../src/app/selectionPreview";
import { WorkState } from "../../src/app/workState";
import type { Quadrilateral } from "../../src/decoder/types";

function square(x: number, y: number): Quadrilateral {
  return {
    topLeft: { x, y },
    topRight: { x: x + 10, y },
    bottomRight: { x: x + 10, y: y + 10 },
    bottomLeft: { x, y: y + 10 },
  };
}

describe("selection preview ownership", () => {
  it("closes a preview retained before a deferred canvas effect", () => {
    const close = vi.fn();
    const work = new WorkState();
    const preview = retainSelectionPreview(work, {
      bitmap: { close } as unknown as ImageBitmap,
      width: 100,
      height: 100,
      positions: [square(5, 5)],
    });

    expect(work.hasRetainedResources).toBe(true);
    work.suspend();
    preview.dispose();

    expect(close).toHaveBeenCalledTimes(1);
    expect(work.hasRetainedResources).toBe(false);
  });

  it("releases lifecycle ownership after the canvas consumes the bitmap", () => {
    const close = vi.fn();
    const work = new WorkState();
    const preview = retainSelectionPreview(work, {
      bitmap: { close } as unknown as ImageBitmap,
      width: 100,
      height: 100,
      positions: [],
    });

    const canvas = { width: 100, height: 100 } as HTMLCanvasElement;
    expect(preview.attachCanvas(canvas)).toBe(true);
    preview.consumeBitmap();
    expect(work.hasRetainedResources).toBe(true);
    work.suspend();

    expect(close).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(work.hasRetainedResources).toBe(false);
  });

  it("prevents a deferred effect from drawing after suspension", () => {
    const close = vi.fn();
    const work = new WorkState();
    const preview = retainSelectionPreview(work, {
      bitmap: { close } as unknown as ImageBitmap,
      width: 100,
      height: 100,
      positions: [],
    });
    const canvas = { width: 100, height: 100 } as HTMLCanvasElement;

    work.suspend();

    expect(preview.attachCanvas(canvas)).toBe(false);
    expect(preview.disposed).toBe(true);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a preview that arrives after work is already suspended", () => {
    const close = vi.fn();
    const work = new WorkState();
    work.suspend();

    const preview = retainSelectionPreview(work, {
      bitmap: { close } as unknown as ImageBitmap,
      width: 100,
      height: 100,
      positions: [],
    });
    const canvas = { width: 100, height: 100 } as HTMLCanvasElement;

    expect(preview.disposed).toBe(true);
    expect(preview.attachCanvas(canvas)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(work.hasRetainedResources).toBe(false);
  });
});

describe("selection position labels", () => {
  it("maps bounded geometry to stable relative positions", () => {
    expect(selectionPositionLabel(square(5, 5), 100, 100)).toBe("top left");
    expect(selectionPositionLabel(square(45, 45), 100, 100)).toBe("center");
    expect(selectionPositionLabel(square(85, 85), 100, 100)).toBe("bottom right");
  });
});
