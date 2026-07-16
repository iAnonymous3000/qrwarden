import type {
  DecodeResult,
  DetectionFingerprint,
  FrozenBytes,
  Point,
  Quadrilateral,
  TextDecoding,
} from "./types";

const LOWERCASE_HEX = /^(?:[0-9a-f]{2})*$/;

export function freezeBytes(bytes: Uint8Array): FrozenBytes {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return Object.freeze({ byteLength: bytes.byteLength, hex });
}
export function validateFrozenBytes(value: FrozenBytes): FrozenBytes {
  if (
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    !LOWERCASE_HEX.test(value.hex) ||
    value.hex.length !== value.byteLength * 2
  ) {
    throw new TypeError("FrozenBytes is not canonical");
  }

  return Object.freeze({ byteLength: value.byteLength, hex: value.hex });
}

export function thawBytes(value: FrozenBytes): Uint8Array {
  const frozen = validateFrozenBytes(value);
  const output = new Uint8Array(frozen.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(frozen.hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function freezePoint(point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("Decoder position contains a non-finite coordinate");
  }
  return Object.freeze({ x: point.x, y: point.y });
}

export function freezeQuadrilateral(position: Quadrilateral): Quadrilateral {
  return Object.freeze({
    topLeft: freezePoint(position.topLeft),
    topRight: freezePoint(position.topRight),
    bottomRight: freezePoint(position.bottomRight),
    bottomLeft: freezePoint(position.bottomLeft),
  });
}

function freezeDecoding(decoding: TextDecoding): TextDecoding {
  if (decoding.kind === "binary") {
    return Object.freeze({ kind: "binary", reason: decoding.reason, eci: null });
  }

  return Object.freeze({
    kind: "text",
    text: decoding.text,
    encoding: decoding.encoding,
    eci:
      decoding.eci === null
        ? null
        : Object.freeze({
            assignment: decoding.eci.assignment,
            encoding: decoding.eci.encoding,
            source: "bytesECI" as const,
          }),
  });
}

export interface WorkerDecodeResult {
  rawBytes: Uint8Array;
  bytesECI: Uint8Array;
  hasECI: boolean;
  contentType: string;
  format: string;
  symbologyIdentifier: string;
  symbolVersion: number;
  structuredAppend: null;
  decoding: TextDecoding;
  source: DecodeResult["source"];
  position: Quadrilateral;
}

/**
 * Detaches document state from the mutable structured-clone message and deeply
 * freezes every retained object.
 */
export function freezeDecodeResult(message: WorkerDecodeResult): DecodeResult {
  return Object.freeze({
    rawBytes: freezeBytes(message.rawBytes),
    bytesECI: freezeBytes(message.bytesECI),
    hasECI: message.hasECI,
    contentType: message.contentType,
    format: message.format,
    symbologyIdentifier: message.symbologyIdentifier,
    symbolVersion: message.symbolVersion,
    structuredAppend: null,
    decoding: freezeDecoding(message.decoding),
    source: message.source,
    position: freezeQuadrilateral(message.position),
  });
}

export interface FingerprintInput {
  format: string;
  symbologyIdentifier: string;
  symbolVersion: number | null;
  hasECI: boolean;
  bytesECI: Uint8Array;
  rawBytes: Uint8Array;
  sequenceSize: number;
  sequenceIndex: number;
  sequenceId: string;
}

export function freezeDetectionFingerprint(
  input: FingerprintInput,
): DetectionFingerprint {
  return Object.freeze({
    format: input.format,
    symbologyIdentifier: input.symbologyIdentifier,
    symbolVersion: input.symbolVersion,
    hasECI: input.hasECI,
    bytesECI: freezeBytes(input.bytesECI),
    rawBytes: freezeBytes(input.rawBytes),
    sequenceSize: input.sequenceSize,
    sequenceIndex: input.sequenceIndex,
    sequenceId: input.sequenceId,
  });
}
