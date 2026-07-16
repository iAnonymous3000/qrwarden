import { describe, expect, it, vi } from "vitest";
import type {
  DecoderRequest,
  DecoderResponse,
  WorkerDecoderOutcome,
} from "../../src/decoder/workerProtocol";

const workerMocks = vi.hoisted(() => ({
  inspectImageHeader: vi.fn(),
  prepareZXingModule: vi.fn(),
  readBarcodes: vi.fn(),
  validateStaticImageStructure: vi.fn(),
  withCameraRaster: vi.fn(),
  withRasterizedFile: vi.fn(),
}));

vi.mock("zxing-wasm/reader", () => ({
  prepareZXingModule: workerMocks.prepareZXingModule,
  readBarcodes: workerMocks.readBarcodes,
}));
vi.mock("zxing-wasm/reader/zxing_reader.wasm?url", () => ({
  default: "/assets/zxing_reader.wasm",
}));
vi.mock("../../decoder-worker/imageHeaders", () => ({
  ImageHeaderError: class extends Error {
    readonly code = "invalid-image";
  },
  inspectImageHeader: workerMocks.inspectImageHeader,
  validateStaticImageStructure: workerMocks.validateStaticImageStructure,
}));
vi.mock("../../decoder-worker/raster", () => ({
  PASS_1_MAX_EDGE: 2_048,
  PASS_2_MAX_EDGE: 4_096,
  PASS_2_MAX_PIXELS: 25_000_000,
  RasterError: class extends Error {},
  withCameraRaster: workerMocks.withCameraRaster,
  withRasterizedFile: workerMocks.withRasterizedFile,
}));

type WorkerHandler = (event: { readonly data: DecoderRequest }) => void;

interface WorkerHarness {
  readonly messages: DecoderResponse[];
  dispatch(request: DecoderRequest): void;
}

async function loadWorker(): Promise<WorkerHarness> {
  vi.resetModules();
  workerMocks.prepareZXingModule.mockResolvedValue(undefined);
  workerMocks.inspectImageHeader.mockResolvedValue({});
  workerMocks.validateStaticImageStructure.mockResolvedValue(undefined);

  const handlers = new Map<string, WorkerHandler>();
  const messages: DecoderResponse[] = [];
  vi.stubGlobal("self", {
    location: { origin: "https://qrwarden.test" },
    addEventListener(type: string, handler: WorkerHandler): void {
      handlers.set(type, handler);
    },
    postMessage(message: DecoderResponse): void {
      messages.push(message);
    },
  });

  await import("../../decoder-worker/index");
  const messageHandler = handlers.get("message");
  expect(messageHandler).toBeDefined();
  return {
    messages,
    dispatch(request): void {
      messageHandler!({ data: request });
    },
  };
}

function fakeBitmap(): { readonly bitmap: ImageBitmap; readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    bitmap: { width: 1, height: 1, close } as unknown as ImageBitmap,
    close,
  };
}

describe("decoder worker request lifecycle", () => {
  it("closes a transferred camera bitmap exactly once when rejecting a busy request", async () => {
    let finishActiveRequest!: (value: {
      readonly done: true;
      readonly outcome: WorkerDecoderOutcome;
    }) => void;
    workerMocks.withRasterizedFile.mockReturnValue(new Promise((resolve) => {
      finishActiveRequest = resolve;
    }));
    const harness = await loadWorker();

    harness.dispatch({
      type: "decode-image",
      jobId: 10,
      epoch: 2,
      file: {} as File,
    });
    await vi.waitFor(() => expect(workerMocks.withRasterizedFile).toHaveBeenCalledOnce());

    const rejected = fakeBitmap();
    harness.dispatch({
      type: "decode-camera",
      jobId: 11,
      epoch: 3,
      bitmap: rejected.bitmap,
    });

    expect(harness.messages).toContainEqual({
      type: "failure",
      jobId: 11,
      epoch: 3,
      code: "reader-stopped",
    });
    expect(rejected.close).toHaveBeenCalledOnce();

    finishActiveRequest({ done: true, outcome: { kind: "no-result" } });
    await vi.waitFor(() => expect(harness.messages).toContainEqual({
      type: "result",
      jobId: 10,
      epoch: 2,
      outcome: { kind: "no-result" },
    }));
  });

  it("retains exactly-once bitmap cleanup for an accepted camera request", async () => {
    workerMocks.withCameraRaster.mockResolvedValue({ kind: "no-result" });
    const harness = await loadWorker();
    const accepted = fakeBitmap();

    harness.dispatch({
      type: "decode-camera",
      jobId: 20,
      epoch: 4,
      bitmap: accepted.bitmap,
    });

    await vi.waitFor(() => expect(harness.messages).toContainEqual({
      type: "result",
      jobId: 20,
      epoch: 4,
      outcome: { kind: "no-result" },
    }));
    expect(accepted.close).toHaveBeenCalledOnce();
  });

  it("leaves a caller-owned camera bitmap open after rasterization", async () => {
    class FakeOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(): OffscreenCanvasRenderingContext2D {
        return {
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({} as ImageData)),
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
        } as unknown as OffscreenCanvasRenderingContext2D;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const { withCameraRaster } = await vi.importActual<
      typeof import("../../decoder-worker/raster")
    >("../../decoder-worker/raster");
    const callerOwned = fakeBitmap();
    const consume = vi.fn(async () => "decoded");

    await expect(withCameraRaster(callerOwned.bitmap, consume)).resolves.toBe("decoded");

    expect(consume).toHaveBeenCalledOnce();
    expect(callerOwned.close).not.toHaveBeenCalled();
  });
});
