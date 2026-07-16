import {
  freezeDecodeResult,
  freezeDetectionFingerprint,
  freezeQuadrilateral,
} from "./frozenBytes";
import {
  DecoderFailure,
  supportedDetectionToWorkerResult,
  type DecoderOutcome,
  type DecoderRequest,
  type DecoderResponse,
  type DetectionResult,
  type SelectionPreview,
  type WorkerDetection,
  type WorkerDecoderOutcome,
} from "./workerProtocol";
import type { DecodeSource } from "./types";

export const DEFAULT_DECODE_TIMEOUT_MS = 5_000;

interface PendingJob {
  readonly jobId: number;
  readonly epoch: number;
  readonly kind: "decode" | "smoke";
  readonly source: DecodeSource | null;
  readonly resolve: (outcome: DecoderOutcome | undefined) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function adaptDetection(
  detection: WorkerDetection,
  source: DecodeSource,
): DetectionResult {
  const fingerprint = freezeDetectionFingerprint({
    format: detection.format,
    symbologyIdentifier: detection.symbologyIdentifier,
    symbolVersion: detection.symbolVersion,
    hasECI: detection.hasECI,
    bytesECI: detection.bytesECI,
    rawBytes: detection.rawBytes,
    sequenceSize: detection.sequenceSize,
    sequenceIndex: detection.sequenceIndex,
    sequenceId: detection.sequenceId,
  });

  if (detection.kind === "unsupported") {
    return Object.freeze({
      kind: "unsupported",
      reason: detection.reason,
      fingerprint,
      contentType: detection.contentType,
      position: freezeQuadrilateral(detection.position),
      originalIndex: detection.originalIndex,
    });
  }

  return Object.freeze({
    kind: "supported",
    result: freezeDecodeResult(supportedDetectionToWorkerResult(detection, source)),
    fingerprint,
    originalIndex: detection.originalIndex,
  });
}

function adaptPreview(outcome: Extract<WorkerDecoderOutcome, { kind: "selection" }>): SelectionPreview {
  return {
    bitmap: outcome.preview,
    width: outcome.width,
    height: outcome.height,
    positions: Object.freeze(outcome.positions.map(freezeQuadrilateral)),
  };
}

function adaptOutcome(
  outcome: WorkerDecoderOutcome,
  epoch: number,
  source: DecodeSource,
): DecoderOutcome {
  if (outcome.kind === "no-result" || outcome.kind === "overflow") {
    return Object.freeze({ kind: outcome.kind, epoch });
  }

  if (outcome.kind === "selection") {
    const detections = Object.freeze(
      outcome.detections.map((detection) => adaptDetection(detection, source)),
    );
    return {
      kind: "multiple",
      epoch,
      detections,
      preview: adaptPreview(outcome),
    };
  }

  if (outcome.detections.length !== 1) {
    throw new TypeError("Single decoder outcome must contain exactly one detection");
  }
  const detection = adaptDetection(outcome.detections[0]!, source);
  if (detection.kind === "unsupported") {
    return Object.freeze({ kind: "unsupported", epoch, detection });
  }
  return Object.freeze({ kind: "single", epoch, result: detection.result });
}

/**
 * Owns one worker and at most one in-flight decode. Image callers should create
 * a fresh client per File and dispose it after settlement; camera callers may
 * reuse the ready worker for sequential bounded frames.
 */
export class DecoderWorkerClient {
  readonly #worker: Worker;
  readonly #timeoutMs: number;
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (reason: unknown) => void;
  #isReady = false;
  #disposed = false;
  #nextJobId = 1;
  #pending: PendingJob | null = null;

  constructor(workerFactory: () => Worker, timeoutMs = DEFAULT_DECODE_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Decoder timeout must be a positive finite duration");
    }
    this.#timeoutMs = timeoutMs;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker = workerFactory();
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("error", this.#onWorkerError);
    this.#worker.addEventListener("messageerror", this.#onWorkerError);
  }

  start(): Promise<void> {
    return this.#ready;
  }

  decodeImage(file: File, epoch: number): Promise<DecoderOutcome> {
    return this.#decode({ type: "decode-image", file }, epoch, "image");
  }

  decodeCamera(bitmap: ImageBitmap, epoch: number): Promise<DecoderOutcome> {
    return this.#decode({ type: "decode-camera", bitmap }, epoch, "camera");
  }

  /** Runs a bundled, network-free QR fixture through the initialized WASM reader. */
  async smoke(epoch: number): Promise<void> {
    await this.#ready;
    if (this.#disposed) throw new DecoderFailure("cancelled");
    if (this.#pending !== null) {
      throw new DecoderFailure("reader-stopped", {
        cause: new Error("Only one decoder request may be in flight"),
      });
    }
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new RangeError("Decoder epoch must be a non-negative safe integer");
    }

    const jobId = this.#nextJobId;
    this.#nextJobId += 1;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.jobId !== jobId) return;
        this.#pending = null;
        this.dispose("cancelled");
        reject(new DecoderFailure("took-too-long"));
      }, this.#timeoutMs);
      this.#pending = {
        jobId,
        epoch,
        kind: "smoke",
        source: null,
        resolve: (outcome) => {
          if (outcome !== undefined) {
            reject(new DecoderFailure("reader-stopped"));
            return;
          }
          resolve();
        },
        reject,
        timer,
      };
    });
    try {
      this.#worker.postMessage({ type: "smoke", jobId, epoch } satisfies DecoderRequest);
    } catch (error) {
      this.#rejectPending(new DecoderFailure("reader-stopped", { cause: error }));
    }
    return promise;
  }

  dispose(code: "cancelled" | "reader-stopped" = "cancelled"): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onWorkerError);
    this.#worker.removeEventListener("messageerror", this.#onWorkerError);
    this.#worker.terminate();
    this.#rejectReady(new DecoderFailure(code));
    this.#rejectPending(new DecoderFailure(code));
  }

  async #decode(
    payload:
      | Pick<Extract<DecoderRequest, { type: "decode-image" }>, "type" | "file">
      | Pick<Extract<DecoderRequest, { type: "decode-camera" }>, "type" | "bitmap">,
    epoch: number,
    source: DecodeSource,
  ): Promise<DecoderOutcome> {
    try {
      await this.#ready;
    } catch (error) {
      if (payload.type === "decode-camera") payload.bitmap.close();
      throw error;
    }

    if (this.#disposed) {
      if (payload.type === "decode-camera") payload.bitmap.close();
      throw new DecoderFailure("cancelled");
    }
    if (this.#pending !== null) {
      if (payload.type === "decode-camera") payload.bitmap.close();
      throw new DecoderFailure("reader-stopped", {
        cause: new Error("Only one decoder request may be in flight"),
      });
    }
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      if (payload.type === "decode-camera") payload.bitmap.close();
      throw new RangeError("Decoder epoch must be a non-negative safe integer");
    }

    const jobId = this.#nextJobId;
    this.#nextJobId += 1;

    const promise = new Promise<DecoderOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.jobId !== jobId) return;
        this.#pending = null;
        this.dispose("cancelled");
        reject(new DecoderFailure("took-too-long"));
      }, this.#timeoutMs);
      this.#pending = {
        jobId,
        epoch,
        kind: "decode",
        source,
        resolve: (outcome) => {
          if (outcome === undefined) {
            reject(new DecoderFailure("reader-stopped"));
            return;
          }
          resolve(outcome);
        },
        reject,
        timer,
      };
    });

    const request: DecoderRequest =
      payload.type === "decode-image"
        ? { type: "decode-image", jobId, epoch, file: payload.file }
        : { type: "decode-camera", jobId, epoch, bitmap: payload.bitmap };

    try {
      if (request.type === "decode-camera") {
        this.#worker.postMessage(request, [request.bitmap]);
      } else {
        this.#worker.postMessage(request);
      }
    } catch (error) {
      if (request.type === "decode-camera") request.bitmap.close();
      this.#rejectPending(new DecoderFailure("reader-stopped", { cause: error }));
    }

    return promise;
  }

  readonly #onMessage = (event: MessageEvent<DecoderResponse>): void => {
    const message = event.data;
    if (message?.type === "ready") {
      if (this.#isReady || this.#disposed) return;
      this.#isReady = true;
      this.#resolveReady();
      return;
    }

    if (message?.type === "fatal") {
      const failure = new DecoderFailure(message.code);
      this.#rejectReady(failure);
      this.#rejectPending(failure);
      this.dispose("reader-stopped");
      return;
    }

    if (
      message?.type !== "result" &&
      message?.type !== "failure" &&
      message?.type !== "smoke-ok"
    ) return;
    const pending = this.#pending;
    if (
      pending === null ||
      message.jobId !== pending.jobId ||
      message.epoch !== pending.epoch
    ) {
      if (message.type === "result" && message.outcome.kind === "selection") {
        message.outcome.preview.close();
      }
      return;
    }

    this.#pending = null;
    clearTimeout(pending.timer);
    if (message.type === "failure") {
      pending.reject(new DecoderFailure(message.code));
      return;
    }

    if (message.type === "smoke-ok") {
      if (pending.kind !== "smoke") {
        pending.reject(new DecoderFailure("reader-stopped"));
        return;
      }
      pending.resolve(undefined);
      return;
    }

    try {
      if (pending.kind !== "decode" || pending.source === null) {
        if (message.outcome.kind === "selection") message.outcome.preview.close();
        pending.reject(new DecoderFailure("reader-stopped"));
        return;
      }
      pending.resolve(adaptOutcome(message.outcome, message.epoch, pending.source));
    } catch (error) {
      if (message.outcome.kind === "selection") message.outcome.preview.close();
      pending.reject(new DecoderFailure("reader-stopped", { cause: error }));
    }
  };

  readonly #onWorkerError = (event: Event): void => {
    if (this.#disposed) return;
    const failure = new DecoderFailure("reader-stopped", { cause: event });
    if (!this.#isReady) this.#rejectReady(failure);
    this.#rejectPending(failure);
    this.dispose("reader-stopped");
  };

  #rejectPending(reason: unknown): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.reject(reason);
  }
}
