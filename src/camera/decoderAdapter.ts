import {
  DecoderWorkerClient,
  type DecodeResult,
  type DecoderOutcome,
  type DetectionFingerprint as DecoderFingerprint,
  type DetectionResult,
} from "../decoder";
import type {
  CameraDecodeResponse,
  CameraDecodedDetection,
  CameraFrameDecoder,
} from "./controller";
import type { DetectionFingerprint } from "./matcher";

function matcherFingerprint(
  fingerprint: DecoderFingerprint,
): DetectionFingerprint {
  return Object.freeze({
    format: fingerprint.format,
    symbologyIdentifier: fingerprint.symbologyIdentifier,
    parsedVersion: fingerprint.symbolVersion,
    hasECI: fingerprint.hasECI,
    bytesECI: fingerprint.bytesECI,
    sequenceSize: fingerprint.sequenceSize,
    sequenceIndex: fingerprint.sequenceIndex,
    sequenceId: fingerprint.sequenceId,
    rawBytes: fingerprint.rawBytes,
  });
}

function supportedDetection(result: DecodeResult): DetectionResult {
  const fingerprint: DecoderFingerprint = Object.freeze({
    format: result.format,
    symbologyIdentifier: result.symbologyIdentifier,
    symbolVersion: result.symbolVersion,
    hasECI: result.hasECI,
    bytesECI: result.bytesECI,
    rawBytes: result.rawBytes,
    sequenceSize: -1,
    sequenceIndex: -1,
    sequenceId: "",
  });
  return Object.freeze({
    kind: "supported" as const,
    result,
    fingerprint,
    originalIndex: 0,
  });
}

function adaptDetection(
  detection: DetectionResult,
): CameraDecodedDetection<DetectionResult> {
  return Object.freeze({
    fingerprint: matcherFingerprint(detection.fingerprint),
    position:
      detection.kind === "supported"
        ? detection.result.position
        : detection.position,
    originalIndex: detection.originalIndex,
    result: detection,
  });
}

function adaptOutcome(
  outcome: DecoderOutcome,
  width: number,
  height: number,
): CameraDecodeResponse<DetectionResult> {
  if (outcome.kind === "no-result") {
    return { kind: "empty", epoch: outcome.epoch, width, height };
  }
  if (outcome.kind === "overflow") {
    return { kind: "overflow", epoch: outcome.epoch, width, height };
  }
  if (outcome.kind === "unsupported") {
    return {
      kind: "detections",
      epoch: outcome.epoch,
      width,
      height,
      detections: [adaptDetection(outcome.detection)],
      preview: null,
    };
  }
  if (outcome.kind === "single") {
    return {
      kind: "detections",
      epoch: outcome.epoch,
      width,
      height,
      detections: [adaptDetection(supportedDetection(outcome.result))],
      preview: null,
    };
  }
  return {
    kind: "detections",
    epoch: outcome.epoch,
    width,
    height,
    detections: outcome.detections.map(adaptDetection),
    preview: outcome.preview.bitmap,
  };
}

export class CameraDecoderAdapter
  implements CameraFrameDecoder<DetectionResult>
{
  readonly #workerFactory: () => Worker;
  #client: DecoderWorkerClient;

  constructor(workerFactory: () => Worker) {
    this.#workerFactory = workerFactory;
    this.#client = new DecoderWorkerClient(workerFactory);
  }

  // Worker startup is bounded by the client's own startup deadline, which
  // rejects fail-closed if the WASM reader never becomes ready; the camera
  // controller awaits this outside its per-frame deadline so a slow first
  // fetch is not misread as a stopped reader.
  ready(): Promise<void> {
    return this.#client.start();
  }

  async decodeCameraFrame(
    bitmap: ImageBitmap,
    request: { readonly epoch: number; readonly width: number; readonly height: number },
  ): Promise<CameraDecodeResponse<DetectionResult>> {
    // decodeCamera owns the bitmap immediately and closes it if worker
    // readiness fails before the transfer can occur.
    const outcome = await this.#client.decodeCamera(bitmap, request.epoch);
    return adaptOutcome(outcome, request.width, request.height);
  }

  restart(): void {
    this.#client.dispose("reader-stopped");
    this.#client = new DecoderWorkerClient(this.#workerFactory);
  }

  terminate(): void {
    this.#client.dispose("cancelled");
  }
}
