export type DecodeSource = "camera" | "image";

export type SupportedEci = 3 | 20 | 26;

export type TextEncoding = "utf-8" | "shift_jis" | "iso-8859-1";

export interface EciMetadata {
  readonly assignment: SupportedEci;
  readonly encoding: TextEncoding;
  readonly source: "bytesECI";
}

export interface StructuredAppendMetadata {
  readonly size: number;
  readonly index: number;
  readonly id: string;
}

/**
 * An immutable, structured-clone-safe byte representation.
 *
 * Uint8Array instances cannot be deeply frozen when non-empty. Decoder messages
 * therefore cross the worker boundary as typed arrays and are immediately
 * converted to this canonical representation by the document-side adapter.
 */
export interface FrozenBytes {
  readonly byteLength: number;
  readonly hex: string;
}

export type BinaryReason =
  | "invalid-utf8"
  | "invalid-eci-text"
  | "ambiguous-eci-text"
  | "unsupported-eci"
  | "mixed-eci"
  | "malformed-eci"
  | "eci-payload-mismatch"
  | "reader-content-type";

export type TextDecoding =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly encoding: TextEncoding;
      readonly eci: EciMetadata | null;
    }
  | {
      readonly kind: "binary";
      readonly reason: BinaryReason;
      readonly eci: null;
    };

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Quadrilateral {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomRight: Point;
  readonly bottomLeft: Point;
}

export interface DecodeResult {
  readonly rawBytes: FrozenBytes;
  readonly bytesECI: FrozenBytes;
  readonly hasECI: boolean;
  readonly contentType: string;
  readonly format: string;
  readonly symbologyIdentifier: string;
  readonly symbolVersion: number;
  readonly structuredAppend: StructuredAppendMetadata | null;
  readonly decoding: TextDecoding;
  readonly source: DecodeSource;
  readonly position: Quadrilateral;
}

export interface DetectionFingerprint {
  readonly format: string;
  readonly symbologyIdentifier: string;
  readonly symbolVersion: number | null;
  readonly hasECI: boolean;
  readonly bytesECI: FrozenBytes;
  readonly rawBytes: FrozenBytes;
  readonly sequenceSize: number;
  readonly sequenceIndex: number;
  readonly sequenceId: string;
}

export interface ContentTypePolicy {
  readonly renderText: boolean;
  readonly urlEligible: boolean;
}

export const contentTypePolicy = (contentType: string): ContentTypePolicy => {
  if (contentType === "Text") {
    return Object.freeze({ renderText: true, urlEligible: true });
  }

  if (contentType === "GS1" || contentType === "ISO15434") {
    return Object.freeze({ renderText: true, urlEligible: false });
  }

  return Object.freeze({ renderText: false, urlEligible: false });
};
