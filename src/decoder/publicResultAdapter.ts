import type { Quadrilateral } from "./types";

/**
 * Deliberately mirrors only the public zxing-wasm fields QRWarden is allowed to
 * consume. Do not add convenience/deprecated result fields here.
 */
export interface PublicReaderResult {
  readonly isValid: boolean;
  readonly error: string;
  readonly format: string;
  readonly symbology: string;
  readonly bytes: Uint8Array;
  readonly bytesECI: Uint8Array;
  readonly contentType: string;
  readonly hasECI: boolean;
  readonly position: Quadrilateral;
  readonly symbologyIdentifier: string;
  readonly sequenceSize: number;
  readonly sequenceIndex: number;
  readonly sequenceId: string;
  readonly extra: string;
}
export interface CapturedReaderResult {
  readonly isValid: boolean;
  readonly error: string;
  readonly format: string;
  readonly symbology: string;
  readonly bytes: Uint8Array;
  readonly bytesECI: Uint8Array;
  readonly contentType: string;
  readonly hasECI: boolean;
  readonly position: Quadrilateral;
  readonly symbologyIdentifier: string;
  readonly sequenceSize: number;
  readonly sequenceIndex: number;
  readonly sequenceId: string;
  readonly extra: string;
  readonly originalIndex: number;
}

function copyPosition(position: Quadrilateral): Quadrilateral {
  return {
    topLeft: { x: position.topLeft.x, y: position.topLeft.y },
    topRight: { x: position.topRight.x, y: position.topRight.y },
    bottomRight: { x: position.bottomRight.x, y: position.bottomRight.y },
    bottomLeft: { x: position.bottomLeft.x, y: position.bottomLeft.y },
  };
}

/**
 * Copies the bounded public surface and intentionally performs no object spread.
 * A poisoned extra property on the upstream object therefore cannot be observed.
 */
export function capturePublicResult(
  result: PublicReaderResult,
  originalIndex = 0,
): CapturedReaderResult {
  return {
    isValid: result.isValid,
    error: result.error,
    format: result.format,
    symbology: result.symbology,
    bytes: new Uint8Array(result.bytes),
    bytesECI: new Uint8Array(result.bytesECI),
    contentType: result.contentType,
    hasECI: result.hasECI,
    position: copyPosition(result.position),
    symbologyIdentifier: result.symbologyIdentifier,
    sequenceSize: result.sequenceSize,
    sequenceIndex: result.sequenceIndex,
    sequenceId: result.sequenceId,
    extra: result.extra,
    originalIndex,
  };
}
