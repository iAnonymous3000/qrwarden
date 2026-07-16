import type { WorkerDecodeResult } from "./frozenBytes";
import type {
  DecodeResult,
  DetectionFingerprint,
  Quadrilateral,
  TextDecoding,
} from "./types";

export type DecoderFailureCode =
  | "image-too-large"
  | "unsupported-image-type"
  | "image-unreadable"
  | "took-too-long"
  | "reader-stopped"
  | "cancelled";

export type DecodeImageRequest = {
  readonly type: "decode-image";
  readonly jobId: number;
  readonly epoch: number;
  readonly file: File;
};

export type DecodeCameraRequest = {
  readonly type: "decode-camera";
  readonly jobId: number;
  readonly epoch: number;
  readonly bitmap: ImageBitmap;
};

export type DecoderSmokeRequest = {
  readonly type: "smoke";
  readonly jobId: number;
  readonly epoch: number;
};

export type DecoderRequest =
  | DecodeImageRequest
  | DecodeCameraRequest
  | DecoderSmokeRequest;

export interface WorkerDetectionBase {
  readonly rawBytes: Uint8Array;
  readonly bytesECI: Uint8Array;
  readonly hasECI: boolean;
  readonly contentType: string;
  readonly format: string;
  readonly symbologyIdentifier: string;
  readonly sequenceSize: number;
  readonly sequenceIndex: number;
  readonly sequenceId: string;
  readonly position: Quadrilateral;
  readonly originalIndex: number;
}

export interface WorkerSupportedDetection extends WorkerDetectionBase {
  readonly kind: "supported";
  readonly symbolVersion: number;
  readonly decoding: TextDecoding;
}

export interface WorkerUnsupportedDetection extends WorkerDetectionBase {
  readonly kind: "unsupported";
  readonly symbolVersion: number | null;
  readonly reason: string;
}

export type WorkerDetection =
  | WorkerSupportedDetection
  | WorkerUnsupportedDetection;

export type WorkerDecoderOutcome =
  | { readonly kind: "no-result" }
  | { readonly kind: "overflow" }
  | { readonly kind: "detections"; readonly detections: readonly WorkerDetection[] }
  | {
      readonly kind: "selection";
      readonly detections: readonly WorkerDetection[];
      readonly preview: ImageBitmap;
      readonly width: number;
      readonly height: number;
      readonly positions: readonly Quadrilateral[];
    };

export type DecoderResponse =
  | { readonly type: "ready" }
  | {
      readonly type: "smoke-ok";
      readonly jobId: number;
      readonly epoch: number;
    }
  | {
      readonly type: "result";
      readonly jobId: number;
      readonly epoch: number;
      readonly outcome: WorkerDecoderOutcome;
    }
  | {
      readonly type: "failure";
      readonly jobId: number;
      readonly epoch: number;
      readonly code: Exclude<DecoderFailureCode, "cancelled">;
    }
  | { readonly type: "fatal"; readonly code: "reader-stopped" };

export interface UnsupportedDetection {
  readonly kind: "unsupported";
  readonly reason: string;
  readonly fingerprint: DetectionFingerprint;
  readonly contentType: string;
  readonly position: Quadrilateral;
  readonly originalIndex: number;
}

export interface SupportedDetection {
  readonly kind: "supported";
  readonly result: DecodeResult;
  readonly fingerprint: DetectionFingerprint;
  readonly originalIndex: number;
}

export type DetectionResult = SupportedDetection | UnsupportedDetection;

export interface SelectionPreview {
  /** Ownership belongs to the caller, which must draw once and close in finally. */
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly positions: readonly Quadrilateral[];
}

export type DecoderOutcome =
  | { readonly kind: "no-result"; readonly epoch: number }
  | { readonly kind: "overflow"; readonly epoch: number }
  | {
      readonly kind: "unsupported";
      readonly epoch: number;
      readonly detection: UnsupportedDetection;
    }
  | { readonly kind: "single"; readonly epoch: number; readonly result: DecodeResult }
  | {
      readonly kind: "multiple";
      readonly epoch: number;
      readonly detections: readonly DetectionResult[];
      readonly preview: SelectionPreview;
    };

export class DecoderFailure extends Error {
  readonly code: DecoderFailureCode;

  constructor(code: DecoderFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DecoderFailure";
    this.code = code;
  }
}

export function supportedDetectionToWorkerResult(
  detection: WorkerSupportedDetection,
  source: DecodeResult["source"],
): WorkerDecodeResult {
  return {
    rawBytes: detection.rawBytes,
    bytesECI: detection.bytesECI,
    hasECI: detection.hasECI,
    contentType: detection.contentType,
    format: detection.format,
    symbologyIdentifier: detection.symbologyIdentifier,
    symbolVersion: detection.symbolVersion,
    structuredAppend: null,
    decoding: detection.decoding,
    source,
    position: detection.position,
  };
}
