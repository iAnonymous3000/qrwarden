/// <reference lib="webworker" />

import {
  prepareZXingModule,
  readBarcodes,
  type ReadResult,
} from "zxing-wasm/reader";
import readerWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import type {
  DecoderFailureCode,
  DecoderRequest,
  DecoderResponse,
  WorkerDecoderOutcome,
} from "../src/decoder/workerProtocol";
import { captureReaderResults, buildWorkerOutcome } from "./decode";
import {
  ImageHeaderError,
  inspectImageHeader,
  validateStaticImageStructure,
} from "./imageHeaders";
import { createStrictLocateFile } from "./locateFile";
import { isValidQrFamilyResult } from "./model2";
import {
  PASS_1_MAX_EDGE,
  PASS_2_MAX_EDGE,
  PASS_2_MAX_PIXELS,
  RasterError,
  withCameraRaster,
  withRasterizedFile,
} from "./raster";
import { makeReaderOptions } from "./readerOptions";
import { createSmokeFixture, SMOKE_TEXT } from "./smokeFixture";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const WORKER_DEADLINE_MS = 5_000;

class DeadlineError extends Error {}

function now(): number {
  return performance.now();
}

function assertBefore(deadline: number): void {
  if (now() >= deadline) throw new DeadlineError();
}

async function readCaptured(imageData: ImageData): Promise<ReturnType<typeof captureReaderResults>> {
  const results: ReadResult[] = await readBarcodes(imageData, makeReaderOptions());
  return captureReaderResults(results);
}

async function decodeImage(
  file: File,
  deadline: number,
): Promise<WorkerDecoderOutcome> {
  assertBefore(deadline);
  const header = await inspectImageHeader(file);
  assertBefore(deadline);
  await validateStaticImageStructure(file, header);
  assertBefore(deadline);

  const first = await withRasterizedFile(
    file,
    header,
    PASS_1_MAX_EDGE,
    PASS_1_MAX_EDGE * PASS_1_MAX_EDGE,
    async (imageData, canvas) => {
      assertBefore(deadline);
      const results = await readCaptured(imageData);
      assertBefore(deadline);
      if (results.some(isValidQrFamilyResult)) {
        return { done: true as const, outcome: buildWorkerOutcome(results, canvas) };
      }
      return { done: false as const };
    },
  );
  if (first.done) return first.outcome;

  // The first bitmap, canvas, ImageData and reader results are out of scope and
  // released before the source File is decoded a second time.
  assertBefore(deadline);
  return withRasterizedFile(
    file,
    header,
    PASS_2_MAX_EDGE,
    PASS_2_MAX_PIXELS,
    async (imageData, canvas) => {
      assertBefore(deadline);
      const results = await readCaptured(imageData);
      assertBefore(deadline);
      return buildWorkerOutcome(results, canvas);
    },
  );
}

async function decodeCamera(
  bitmap: ImageBitmap,
  deadline: number,
): Promise<WorkerDecoderOutcome> {
  assertBefore(deadline);
  return withCameraRaster(bitmap, async (imageData, canvas) => {
    const results = await readCaptured(imageData);
    assertBefore(deadline);
    return buildWorkerOutcome(results, canvas);
  });
}

async function runSmoke(deadline: number): Promise<void> {
  assertBefore(deadline);
  const results = captureReaderResults(
    await readBarcodes(createSmokeFixture(), makeReaderOptions()),
  );
  assertBefore(deadline);
  const outcome = buildWorkerOutcome(results);
  if (
    outcome.kind !== "detections" ||
    outcome.detections.length !== 1 ||
    outcome.detections[0]?.kind !== "supported" ||
    outcome.detections[0].decoding.kind !== "text" ||
    outcome.detections[0].decoding.text !== SMOKE_TEXT
  ) {
    throw new Error("Bundled decoder smoke fixture did not round-trip");
  }
}

function failureCode(error: unknown): Exclude<DecoderFailureCode, "cancelled"> {
  if (error instanceof DeadlineError) return "took-too-long";
  if (error instanceof RasterError) return "image-unreadable";
  if (error instanceof ImageHeaderError) {
    if (error.code === "file-too-large" || error.code === "invalid-dimensions") {
      return "image-too-large";
    }
    if (
      error.code === "unsupported-format" ||
      error.code === "mime-mismatch" ||
      error.code === "animated-image"
    ) {
      return "unsupported-image-type";
    }
    return "image-unreadable";
  }
  return "reader-stopped";
}

function transferablesFor(outcome: WorkerDecoderOutcome): Transferable[] {
  if (outcome.kind !== "detections" && outcome.kind !== "selection") return [];
  const transfers = new Set<Transferable>();
  for (const detection of outcome.detections) {
    transfers.add(detection.rawBytes.buffer as ArrayBuffer);
    transfers.add(detection.bytesECI.buffer as ArrayBuffer);
  }
  if (outcome.kind === "selection") transfers.add(outcome.preview);
  return [...transfers];
}

function closePreview(outcome: WorkerDecoderOutcome): void {
  if (outcome.kind === "selection") outcome.preview.close();
}

let busy = false;

async function handleRequest(request: DecoderRequest): Promise<void> {
  if (busy) {
    workerScope.postMessage({
      type: "failure",
      jobId: request.jobId,
      epoch: request.epoch,
      code: "reader-stopped",
    } satisfies DecoderResponse);
    return;
  }
  busy = true;
  const deadline = now() + WORKER_DEADLINE_MS;
  let outcome: WorkerDecoderOutcome | null = null;
  try {
    if (request.type === "smoke") {
      await runSmoke(deadline);
      workerScope.postMessage({
        type: "smoke-ok",
        jobId: request.jobId,
        epoch: request.epoch,
      } satisfies DecoderResponse);
      return;
    }

    outcome =
      request.type === "decode-image"
        ? await decodeImage(request.file, deadline)
        : await decodeCamera(request.bitmap, deadline);
    assertBefore(deadline);
    const response: DecoderResponse = {
      type: "result",
      jobId: request.jobId,
      epoch: request.epoch,
      outcome,
    };
    workerScope.postMessage(response, transferablesFor(outcome));
    outcome = null;
  } catch (error) {
    closePreview(outcome ?? { kind: "no-result" });
    workerScope.postMessage({
      type: "failure",
      jobId: request.jobId,
      epoch: request.epoch,
      code: failureCode(error),
    } satisfies DecoderResponse);
  } finally {
    if (request.type === "decode-camera") request.bitmap.close();
    busy = false;
  }
}

workerScope.addEventListener("message", (event: MessageEvent<DecoderRequest>) => {
  const request = event.data;
  if (
    request?.type !== "decode-image" &&
    request?.type !== "decode-camera" &&
    request?.type !== "smoke"
  ) {
    return;
  }
  void handleRequest(request);
});

const wasmHref = new URL(readerWasmUrl, workerScope.location.origin).href;
Promise.resolve(
  prepareZXingModule({
    overrides: {
      locateFile: createStrictLocateFile(wasmHref, workerScope.location.origin),
    },
    fireImmediately: true,
  }),
).then(
  () => workerScope.postMessage({ type: "ready" } satisfies DecoderResponse),
  () => workerScope.postMessage({ type: "fatal", code: "reader-stopped" } satisfies DecoderResponse),
);
