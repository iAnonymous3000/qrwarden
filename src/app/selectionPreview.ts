import type { SelectionPreview } from "../decoder";
import type { Quadrilateral } from "../decoder/types";
import { WorkState } from "./workState";

export interface OwnedSelectionPreview extends SelectionPreview {
  readonly disposed: boolean;
  /** Transfers lifecycle ownership to the rendered selection canvas. */
  readonly attachCanvas: (canvas: HTMLCanvasElement) => boolean;
  /** Closes the transferred bitmap after its one permitted draw. */
  readonly consumeBitmap: () => void;
  /** Closes the bitmap, clears an attached canvas, and releases ownership. */
  readonly dispose: () => void;
}

/**
 * Registers a transferred selection bitmap before UI state is scheduled.
 * This closes the ownership gap between receiving the worker message and the
 * deferred canvas effect that consumes it.
 */
export function retainSelectionPreview(
  work: WorkState,
  preview: SelectionPreview,
): OwnedSelectionPreview {
  let disposed = false;
  let bitmapClosed = false;
  let canvas: HTMLCanvasElement | null = null;
  let release = (): void => undefined;
  const consumeBitmap = (): void => {
    if (bitmapClosed) return;
    bitmapClosed = true;
    preview.bitmap.close();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    release();
    consumeBitmap();
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;
    }
  };
  const attachCanvas = (next: HTMLCanvasElement): boolean => {
    if (disposed || bitmapClosed) {
      next.width = 0;
      next.height = 0;
      return false;
    }
    canvas = next;
    return true;
  };
  release = work.retain(dispose);

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    bitmap: preview.bitmap,
    width: preview.width,
    height: preview.height,
    positions: preview.positions,
    attachCanvas,
    consumeBitmap,
    dispose,
  });
}

function centroid(position: Quadrilateral): { readonly x: number; readonly y: number } {
  const points = [
    position.topLeft,
    position.topRight,
    position.bottomRight,
    position.bottomLeft,
  ];
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/** Returns one bounded, stable relative-position label for accessible selection. */
export function selectionPositionLabel(
  position: Quadrilateral,
  width: number,
  height: number,
): string {
  const center = centroid(position);
  const horizontal = center.x < width / 3 ? "left" : center.x > (width * 2) / 3 ? "right" : "center";
  const vertical = center.y < height / 3 ? "top" : center.y > (height * 2) / 3 ? "bottom" : "middle";

  if (vertical === "middle" && horizontal === "center") return "center";
  if (vertical === "middle") return horizontal;
  if (horizontal === "center") return vertical;
  return `${vertical} ${horizontal}`;
}
