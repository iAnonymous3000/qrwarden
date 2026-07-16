import type { ReadResult } from "zxing-wasm/reader";
import { capturePublicResult, type CapturedReaderResult } from "../src/decoder/publicResultAdapter";
import type {
  WorkerDecoderOutcome,
  WorkerDetection,
} from "../src/decoder/workerProtocol";
import type { Quadrilateral } from "../src/decoder/types";
import { decodeCapturedPayload } from "./eci";
import { enforceResultCount } from "./model2";
import { createSelectionPreview } from "./raster";
import {
  checkSupportedSymbol,
  parseCanonicalSymbolVersion,
} from "./symbolProfiles";

export function captureReaderResults(
  results: readonly ReadResult[],
): CapturedReaderResult[] {
  return results.map((result, index) => capturePublicResult(result, index));
}
function detectionFrom(result: CapturedReaderResult): WorkerDetection {
  const base = {
    rawBytes: result.bytes,
    bytesECI: result.bytesECI,
    hasECI: result.hasECI,
    contentType: result.contentType,
    format: result.format,
    symbologyIdentifier: result.symbologyIdentifier,
    sequenceSize: result.sequenceSize,
    sequenceIndex: result.sequenceIndex,
    sequenceId: result.sequenceId,
    position: result.position,
    originalIndex: result.originalIndex,
  } as const;
  const check = checkSupportedSymbol(result);
  if (check.kind === "unsupported") {
    return {
      ...base,
      kind: "unsupported",
      symbolVersion: parseCanonicalSymbolVersion(result.format, result.extra),
      reason: check.reason,
    };
  }

  return {
    ...base,
    kind: "supported",
    symbolVersion: check.version,
    decoding: decodeCapturedPayload(result),
  };
}

function scaledPosition(
  position: Quadrilateral,
  scaleX: number,
  scaleY: number,
): Quadrilateral {
  const scale = (point: Quadrilateral["topLeft"]) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
  });
  return {
    topLeft: scale(position.topLeft),
    topRight: scale(position.topRight),
    bottomRight: scale(position.bottomRight),
    bottomLeft: scale(position.bottomLeft),
  };
}

function centroid(position: Quadrilateral): { x: number; y: number } {
  return {
    x:
      (position.topLeft.x +
        position.topRight.x +
        position.bottomRight.x +
        position.bottomLeft.x) /
      4,
    y:
      (position.topLeft.y +
        position.topRight.y +
        position.bottomRight.y +
        position.bottomLeft.y) /
      4,
  };
}

function scaleDetection(
  detection: WorkerDetection,
  scaleX: number,
  scaleY: number,
): WorkerDetection {
  return {
    ...detection,
    position: scaledPosition(detection.position, scaleX, scaleY),
  };
}

function selectionOrder(left: WorkerDetection, right: WorkerDetection): number {
  const leftCenter = centroid(left.position);
  const rightCenter = centroid(right.position);
  return (
    leftCenter.y - rightCenter.y ||
    leftCenter.x - rightCenter.x ||
    left.originalIndex - right.originalIndex
  );
}

export function buildWorkerOutcome(
  results: readonly CapturedReaderResult[],
  canvas?: OffscreenCanvas,
): WorkerDecoderOutcome {
  const counted = enforceResultCount(results);
  if (counted.kind === "none") return { kind: "no-result" };
  if (counted.kind === "overflow") return { kind: "overflow" };

  const detections = counted.results.map(detectionFrom);
  if (detections.length === 1) {
    return { kind: "detections", detections };
  }
  if (canvas === undefined) {
    throw new TypeError("A multi-symbol result requires its exact decoded raster");
  }

  const preview = createSelectionPreview(canvas);
  try {
    const ordered = detections
      .map((detection) =>
        scaleDetection(detection, preview.scaleX, preview.scaleY),
      )
      .sort(selectionOrder);
    return {
      kind: "selection",
      detections: ordered,
      preview: preview.bitmap,
      width: preview.width,
      height: preview.height,
      positions: ordered.map((detection) => detection.position),
    };
  } catch (error) {
    preview.bitmap.close();
    throw error;
  }
}
