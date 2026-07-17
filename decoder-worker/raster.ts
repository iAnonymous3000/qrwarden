import {
  MAX_ENCODED_AXIS,
  MAX_ENCODED_PIXELS,
  orientationCorrectedDimensions,
  type ImageHeader,
} from "./imageHeaders";

export const PASS_1_MAX_EDGE = 2_048;
export const PASS_2_MAX_EDGE = 4_096;
export const PASS_2_MAX_PIXELS = 16_777_216;

export class RasterError extends Error {
  constructor() {
    super("image-unreadable");
    this.name = "RasterError";
  }
}

export interface RasterSize {
  readonly width: number;
  readonly height: number;
}

export function boundedRasterSize(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number,
): RasterSize {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(maxEdge) ||
    maxEdge <= 0 ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels <= 0
  ) {
    throw new RasterError();
  }

  const scale = Math.min(
    1,
    maxEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  const scaledWidth = Math.max(1, Math.floor(width * scale));
  const scaledHeight = Math.max(1, Math.floor(height * scale));

  if (
    scaledWidth > maxEdge ||
    scaledHeight > maxEdge ||
    scaledWidth * scaledHeight > maxPixels
  ) {
    throw new RasterError();
  }
  return { width: scaledWidth, height: scaledHeight };
}

function contextFor(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (context === null) throw new RasterError();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function assertBrowserDimensions(bitmap: ImageBitmap, header: ImageHeader): void {
  const oriented = orientationCorrectedDimensions(header);
  // Engines disagree on applying declared PNG/WebP EXIF orientation, so a
  // transposing orientation accepts the oriented or the encoded dimensions.
  const transposed = header.orientation >= 5 && header.orientation <= 8;
  const matchesOriented =
    bitmap.width === oriented.width && bitmap.height === oriented.height;
  const matchesEncoded =
    bitmap.width === header.width && bitmap.height === header.height;
  if (
    (!matchesOriented && !(transposed && matchesEncoded)) ||
    bitmap.width > MAX_ENCODED_AXIS ||
    bitmap.height > MAX_ENCODED_AXIS ||
    bitmap.width * bitmap.height > MAX_ENCODED_PIXELS
  ) {
    throw new RasterError();
  }
}

export async function withRasterizedFile<T>(
  file: Blob,
  header: ImageHeader,
  maxEdge: number,
  maxPixels: number,
  consume: (
    imageData: ImageData,
    canvas: OffscreenCanvas,
    size: RasterSize,
  ) => Promise<T>,
): Promise<T> {
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  let imageData: ImageData | null = null;
  let consuming = false;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    assertBrowserDimensions(bitmap, header);
    const size = boundedRasterSize(bitmap.width, bitmap.height, maxEdge, maxPixels);
    canvas = new OffscreenCanvas(size.width, size.height);
    const context = contextFor(canvas);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    // drawImage is the bitmap's last use; closing it here keeps the
    // full-resolution pixels from staying live alongside the canvas and
    // ImageData for the whole decode.
    bitmap.close();
    bitmap = null;
    imageData = context.getImageData(0, 0, size.width, size.height);
    consuming = true;
    return await consume(imageData, canvas, size);
  } catch (error) {
    if (consuming) throw error;
    if (error instanceof RasterError) throw error;
    throw new RasterError();
  } finally {
    imageData = null;
    bitmap?.close();
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/** Rasterizes a borrowed camera bitmap; the request owner closes the bitmap. */
export async function withCameraRaster<T>(
  bitmap: ImageBitmap,
  consume: (
    imageData: ImageData,
    canvas: OffscreenCanvas,
    size: RasterSize,
  ) => Promise<T>,
): Promise<T> {
  let canvas: OffscreenCanvas | null = null;
  let imageData: ImageData | null = null;
  let consuming = false;
  try {
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      bitmap.width > PASS_1_MAX_EDGE ||
      bitmap.height > PASS_1_MAX_EDGE ||
      bitmap.width * bitmap.height > PASS_1_MAX_EDGE * PASS_1_MAX_EDGE
    ) {
      throw new RasterError();
    }
    const size = { width: bitmap.width, height: bitmap.height };
    canvas = new OffscreenCanvas(size.width, size.height);
    const context = contextFor(canvas);
    context.drawImage(bitmap, 0, 0);
    imageData = context.getImageData(0, 0, size.width, size.height);
    consuming = true;
    return await consume(imageData, canvas, size);
  } catch (error) {
    if (consuming) throw error;
    if (error instanceof RasterError) throw error;
    throw new RasterError();
  } finally {
    imageData = null;
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export interface PreviewRaster {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function createSelectionPreview(canvas: OffscreenCanvas): PreviewRaster {
  const size = boundedRasterSize(
    canvas.width,
    canvas.height,
    PASS_1_MAX_EDGE,
    PASS_1_MAX_EDGE * PASS_1_MAX_EDGE,
  );
  let previewCanvas: OffscreenCanvas | null = new OffscreenCanvas(size.width, size.height);
  try {
    const context = contextFor(previewCanvas);
    context.drawImage(canvas, 0, 0, size.width, size.height);
    const bitmap = previewCanvas.transferToImageBitmap();
    return {
      bitmap,
      width: size.width,
      height: size.height,
      scaleX: size.width / canvas.width,
      scaleY: size.height / canvas.height,
    };
  } catch {
    throw new RasterError();
  } finally {
    if (previewCanvas !== null) {
      previewCanvas.width = 0;
      previewCanvas.height = 0;
      previewCanvas = null;
    }
  }
}
