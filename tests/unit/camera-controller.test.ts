import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  CameraController,
  type CameraDecodeResponse,
  type CameraFrameDecoder,
} from "../../src/camera/controller";

interface BitmapDouble {
  readonly width: number;
  readonly height: number;
  readonly close: Mock<() => void>;
}

class CanvasDouble {
  width = 0;
  height = 0;
  readonly context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  };
  readonly setAttribute = vi.fn();

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }
}

class VideoDouble extends EventTarget {
  videoWidth = 640;
  videoHeight = 480;
  muted = false;
  playsInline = false;
  srcObject: MediaProvider | null = null;
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly #listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback !== null) {
      const listeners = this.#listeners.get(type) ?? new Set();
      listeners.add(callback);
      this.#listeners.set(type, listeners);
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback !== null) {
      this.#listeners.get(type)?.delete(callback);
    }
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

class TrackDouble extends EventTarget {
  readonly stop = vi.fn();
  readonly settings: {
    deviceId: string;
    torch: boolean;
    zoom: number;
  };
  readonly capabilities = {
    torch: true,
    zoom: { min: 1, max: 4, step: 0.5 },
  };
  readonly getSettings = vi.fn(() => ({ ...this.settings }));
  readonly getCapabilities = vi.fn(() => ({ ...this.capabilities }));
  readonly applyConstraints = vi.fn(async (constraints: MediaTrackConstraints) => {
    const advanced = constraints.advanced?.[0] as
      | { readonly torch?: boolean; readonly zoom?: number }
      | undefined;
    if (advanced?.torch !== undefined) this.settings.torch = advanced.torch;
    if (advanced?.zoom !== undefined) this.settings.zoom = advanced.zoom;
  });

  constructor(deviceId = "front") {
    super();
    this.settings = { deviceId, torch: false, zoom: 1 };
  }
}

class MediaDevicesDouble extends EventTarget {
  readonly getUserMedia = vi.fn<
    (constraints: MediaStreamConstraints) => Promise<MediaStream>
  >();
  readonly enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>();
}

function streamFor(track: TrackDouble): MediaStream {
  return {
    getTracks: vi.fn(() => [track as unknown as MediaStreamTrack]),
    getVideoTracks: vi.fn(() => [track as unknown as MediaStreamTrack]),
  } as unknown as MediaStream;
}

function mediaDevice(
  deviceId: string,
  kind: MediaDeviceKind = "videoinput",
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "group",
    kind,
    label: deviceId,
    toJSON: () => ({ deviceId, kind }),
  };
}

function bitmapDouble(): BitmapDouble {
  return {
    width: 1,
    height: 1,
    close: vi.fn<() => void>(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface Harness {
  readonly controller: CameraController<string>;
  readonly video: VideoDouble;
  readonly track: TrackDouble;
  readonly stream: MediaStream;
  readonly mediaDevices: MediaDevicesDouble;
  readonly canvases: CanvasDouble[];
  readonly bitmaps: BitmapDouble[];
  readonly decoder: {
    readonly decodeCameraFrame: ReturnType<typeof vi.fn>;
    readonly restart: ReturnType<typeof vi.fn>;
    readonly terminate: ReturnType<typeof vi.fn>;
  };
  readonly onAccepted: ReturnType<typeof vi.fn>;
  readonly onOverflow: ReturnType<typeof vi.fn>;
  readonly onProblem: ReturnType<typeof vi.fn>;
  readonly onDevices: ReturnType<typeof vi.fn>;
  readonly onCapabilities: ReturnType<typeof vi.fn>;
  readonly addDeviceListener: ReturnType<typeof vi.spyOn>;
  readonly removeDeviceListener: ReturnType<typeof vi.spyOn>;
}

function createHarness(): Harness {
  const video = new VideoDouble();
  const track = new TrackDouble();
  const stream = streamFor(track);
  const mediaDevices = new MediaDevicesDouble();
  const cameras = [
    mediaDevice("front"),
    mediaDevice("front"),
    mediaDevice(""),
    mediaDevice("microphone", "audioinput"),
    mediaDevice("rear"),
  ];
  mediaDevices.getUserMedia.mockResolvedValue(stream);
  mediaDevices.enumerateDevices.mockResolvedValue(cameras);
  const addDeviceListener = vi.spyOn(mediaDevices, "addEventListener");
  const removeDeviceListener = vi.spyOn(mediaDevices, "removeEventListener");

  const canvases: CanvasDouble[] = [];
  const documentDouble = {
    visibilityState: "visible",
    createElement: vi.fn((tagName: string) => {
      if (tagName !== "canvas") throw new Error(`Unexpected element ${tagName}`);
      const canvas = new CanvasDouble();
      canvases.push(canvas);
      return canvas;
    }),
  };
  const windowDouble = {
    isSecureContext: true,
    setTimeout: (handler: TimerHandler, milliseconds?: number): number =>
      globalThis.setTimeout(handler as () => void, milliseconds) as unknown as number,
    clearTimeout: (handle: number): void => globalThis.clearTimeout(handle),
  };
  const bitmaps: BitmapDouble[] = [];
  const createBitmap = vi.fn(async () => {
    const bitmap = bitmapDouble();
    bitmaps.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal("document", documentDouble);
  vi.stubGlobal("window", windowDouble);
  vi.stubGlobal("navigator", { mediaDevices });
  vi.stubGlobal("createImageBitmap", createBitmap);

  const decoder = {
    decodeCameraFrame: vi.fn(
      async (
        bitmap: ImageBitmap,
        request: { readonly epoch: number; readonly width: number; readonly height: number },
      ): Promise<CameraDecodeResponse<string>> => {
        bitmap.close();
        return { kind: "empty", ...request };
      },
    ),
    restart: vi.fn(),
    terminate: vi.fn(),
  };
  const onAccepted = vi.fn();
  const onOverflow = vi.fn();
  const onProblem = vi.fn();
  const onDevices = vi.fn();
  const onCapabilities = vi.fn();
  const controller = new CameraController<string>({
    video: video as unknown as HTMLVideoElement,
    decoder: decoder as unknown as CameraFrameDecoder<string>,
    onAccepted,
    onOverflow,
    onProblem,
    onDevices,
    onCapabilities,
  });

  return {
    controller,
    video,
    track,
    stream,
    mediaDevices,
    canvases,
    bitmaps,
    decoder,
    onAccepted,
    onOverflow,
    onProblem,
    onDevices,
    onCapabilities,
    addDeviceListener,
    removeDeviceListener,
  };
}

function expectNoMetadataListeners(video: VideoDouble): void {
  expect(video.listenerCount("loadedmetadata")).toBe(0);
  expect(video.listenerCount("resize")).toBe(0);
  expect(video.listenerCount("error")).toBe(0);
}

async function beginMetadataWait(harness: Harness): Promise<{ readonly starting: Promise<void> }> {
  harness.video.videoWidth = 0;
  harness.video.videoHeight = 0;
  const starting = harness.controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.video.listenerCount("loadedmetadata")).toBe(1);
  expect(harness.video.listenerCount("resize")).toBe(1);
  expect(harness.video.listenerCount("error")).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  return { starting };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CameraController lifecycle", () => {
  it("starts with exact constraints, probes capture, publishes bounded devices, and tears down", async () => {
    const harness = createHarness();

    await harness.controller.start();

    expect(harness.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    expect(harness.controller.active).toBe(true);
    expect(harness.controller.epoch).toBe(1);
    expect(harness.video.srcObject).toBe(harness.stream);
    expect(harness.video.muted).toBe(true);
    expect(harness.video.playsInline).toBe(true);
    expect(harness.video.play).toHaveBeenCalledOnce();
    expect(harness.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(harness.canvases[1]).toMatchObject({ width: 0, height: 0 });
    expect(harness.onCapabilities).toHaveBeenCalledWith({
      zoom: { min: 1, max: 4, step: 0.5 },
      zoomValue: 1,
      torch: true,
      torchEnabled: false,
    });
    expect(harness.onDevices).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ deviceId: "front" }),
      expect.objectContaining({ deviceId: "rear" }),
    ]);
    expect(harness.addDeviceListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );

    harness.controller.cancel();

    expect(harness.decoder.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.video.pause).toHaveBeenCalledOnce();
    expect(harness.video.srcObject).toBeNull();
    expect(harness.controller.active).toBe(false);
    expect(harness.removeDeviceListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    expect(harness.onCapabilities).toHaveBeenLastCalledWith({
      zoom: null,
      zoomValue: null,
      torch: false,
      torchEnabled: false,
    });
    expect(harness.canvases[0]).toMatchObject({ width: 0, height: 0 });
  });

  it("starts without optional track capability APIs", async () => {
    const harness = createHarness();
    Object.defineProperties(harness.track, {
      getCapabilities: { configurable: true, value: undefined },
      getSettings: { configurable: true, value: undefined },
    });

    await harness.controller.start();

    expect(harness.controller.active).toBe(true);
    expect(harness.onProblem).not.toHaveBeenCalled();
    expect(harness.onCapabilities).toHaveBeenCalledWith({
      zoom: null,
      zoomValue: null,
      torch: false,
      torchEnabled: false,
    });

    harness.controller.cancel();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("starts when device-change events are unavailable", async () => {
    const harness = createHarness();
    Object.defineProperties(harness.mediaDevices, {
      addEventListener: { configurable: true, value: undefined },
      removeEventListener: { configurable: true, value: undefined },
    });

    await harness.controller.start();

    expect(harness.controller.active).toBe(true);
    expect(harness.onProblem).not.toHaveBeenCalled();
    harness.controller.cancel();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["NotAllowedError", "camera-access-needed"],
    ["SecurityError", "camera-access-needed"],
    ["NotFoundError", "no-camera"],
    ["NotReadableError", "camera-could-not-start"],
  ])("maps %s start failures to %s", async (name, expected) => {
    const harness = createHarness();
    harness.mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException("failed", name));

    await harness.controller.start();

    expect(harness.controller.active).toBe(false);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith(expected);
    expect(harness.decoder.terminate).not.toHaveBeenCalled();
  });

  it("fails closed before permission when camera APIs are unavailable", async () => {
    const harness = createHarness();
    vi.stubGlobal("window", {
      isSecureContext: false,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    await harness.controller.start();

    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-unavailable");
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("stops a stream that resolves after cancellation without surfacing a stale error", async () => {
    const harness = createHarness();
    const lateTrack = new TrackDouble("late");
    const lateStream = streamFor(lateTrack);
    const permission = deferred<MediaStream>();
    harness.mediaDevices.getUserMedia.mockReturnValueOnce(permission.promise);

    const starting = harness.controller.start();
    harness.controller.cancel();
    permission.resolve(lateStream);
    await starting;

    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(harness.controller.active).toBe(false);
    expect(harness.onProblem).not.toHaveBeenCalled();
    expect(harness.decoder.terminate).toHaveBeenCalledOnce();
  });

  it("removes work once on suspension and reports only a hidden suspension", async () => {
    const harness = createHarness();
    await harness.controller.start();

    harness.controller.suspend(false);
    harness.controller.suspend(true);

    expect(harness.decoder.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.onProblem).not.toHaveBeenCalled();
    expect(harness.controller.active).toBe(false);
  });

  it("reports a hidden suspension as camera-paused after releasing the camera", async () => {
    const harness = createHarness();
    await harness.controller.start();

    harness.controller.suspend(true);

    expect(harness.decoder.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.controller.active).toBe(false);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-paused");
  });

  it("tears down and reports when the active video track ends", async () => {
    const harness = createHarness();
    await harness.controller.start();
    const epoch = harness.controller.epoch;

    harness.track.dispatchEvent(new Event("ended"));

    expect(harness.controller.epoch).toBe(epoch + 1);
    expect(harness.controller.active).toBe(false);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-stopped");
    expect(harness.removeDeviceListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
  });

  it("re-enumerates visible device changes and ignores them after teardown", async () => {
    const harness = createHarness();
    await harness.controller.start();
    const epoch = harness.controller.epoch;

    harness.mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();

    expect(harness.controller.epoch).toBe(epoch + 1);
    expect(harness.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);

    harness.controller.cancel();
    harness.mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    expect(harness.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
  });
});

describe("CameraController timeout and constraints", () => {
  it.each(["resolved", "rejected"] as const)(
    "clears a frame deadline after a %s decode",
    async (outcome) => {
      const harness = createHarness();
      await harness.controller.start();
      if (outcome === "rejected") {
        harness.decoder.decodeCameraFrame.mockRejectedValueOnce(new Error("decode failed"));
      }

      await vi.advanceTimersToNextTimerAsync();

      expect(harness.decoder.decodeCameraFrame).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      harness.controller.cancel();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels an in-flight frame deadline during teardown", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.decoder.decodeCameraFrame.mockImplementationOnce(() => new Promise(() => undefined));

    await vi.advanceTimersToNextTimerAsync();
    expect(harness.decoder.decodeCameraFrame).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    harness.controller.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.decoder.restart).not.toHaveBeenCalled();
    expect(harness.onProblem).not.toHaveBeenCalled();
  });

  it("cleans metadata listeners and its deadline after metadata succeeds", async () => {
    const harness = createHarness();
    const { starting } = await beginMetadataWait(harness);

    harness.video.videoWidth = 640;
    harness.video.videoHeight = 480;
    harness.video.dispatchEvent(new Event("loadedmetadata"));
    await starting;

    expectNoMetadataListeners(harness.video);
    expect(vi.getTimerCount()).toBe(1);
    harness.controller.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans metadata listeners and its deadline after a metadata error", async () => {
    const harness = createHarness();
    const { starting } = await beginMetadataWait(harness);

    harness.video.dispatchEvent(new Event("error"));
    await starting;

    expectNoMetadataListeners(harness.video);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-could-not-start");
  });

  it("cleans metadata listeners when metadata times out", async () => {
    const harness = createHarness();
    const { starting } = await beginMetadataWait(harness);

    await vi.advanceTimersByTimeAsync(10_000);
    await starting;

    expectNoMetadataListeners(harness.video);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-could-not-start");
  });

  it("cleans metadata listeners and its deadline when startup is aborted", async () => {
    const harness = createHarness();
    const { starting } = await beginMetadataWait(harness);

    harness.controller.cancel();
    await starting;

    expectNoMetadataListeners(harness.video);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onProblem).not.toHaveBeenCalled();
  });

  it("bounds a stuck frame, replaces the decoder, and clears confirmation state", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.decoder.decodeCameraFrame.mockImplementationOnce(() => new Promise(() => undefined));
    const epoch = harness.controller.epoch;

    await vi.advanceTimersToNextTimerAsync();
    expect(harness.decoder.decodeCameraFrame).toHaveBeenCalledOnce();
    await vi.advanceTimersToNextTimerAsync();

    expect(harness.controller.epoch).toBe(epoch + 1);
    expect(harness.decoder.restart).toHaveBeenCalledOnce();
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("reader-stopped");
    expect(harness.onAccepted).not.toHaveBeenCalled();
    expect(harness.onOverflow).not.toHaveBeenCalled();

    harness.controller.cancel();
  });

  it("stops the camera when decoder replacement fails", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.decoder.decodeCameraFrame.mockRejectedValueOnce(new Error("decode failed"));
    harness.decoder.restart.mockImplementationOnce(() => {
      throw new DOMException("Worker unavailable", "NotSupportedError");
    });

    await vi.advanceTimersToNextTimerAsync();

    expect(harness.decoder.restart).toHaveBeenCalledOnce();
    expect(harness.controller.active).toBe(false);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("reader-stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized live dimensions and stops the stream before decoding", async () => {
    const harness = createHarness();
    harness.video.videoWidth = 8_193;
    harness.video.videoHeight = 1;
    await harness.controller.start();

    await vi.advanceTimersToNextTimerAsync();

    expect(harness.decoder.decodeCameraFrame).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.controller.active).toBe(false);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-could-not-start");
  });

  it("applies torch and zoom, then preserves prior settings on constraint failure", async () => {
    const harness = createHarness();
    await harness.controller.start();

    await expect(harness.controller.setTorch(true)).resolves.toBe(true);
    expect(harness.track.applyConstraints).toHaveBeenLastCalledWith({
      advanced: [{ torch: true }],
    });
    await expect(harness.controller.setZoom(3)).resolves.toBe(3);
    expect(harness.track.applyConstraints).toHaveBeenLastCalledWith({
      advanced: [{ zoom: 3 }],
    });

    harness.track.applyConstraints.mockRejectedValueOnce(new Error("torch failed"));
    await expect(harness.controller.setTorch(false)).resolves.toBe(true);
    expect(harness.onProblem).toHaveBeenCalledWith("torch-unavailable");

    harness.track.applyConstraints.mockRejectedValueOnce(new Error("zoom failed"));
    await expect(harness.controller.setZoom(4)).resolves.toBe(3);
    expect(harness.onProblem).toHaveBeenCalledWith("zoom-unavailable");

    harness.controller.cancel();
  });

  it("recovers the previous device after a failed switch", async () => {
    const harness = createHarness();
    const recoveryTrack = new TrackDouble("front");
    const recoveryStream = streamFor(recoveryTrack);
    harness.mediaDevices.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(harness.stream)
      .mockRejectedValueOnce(new DOMException("rear failed", "NotReadableError"))
      .mockResolvedValueOnce(recoveryStream);
    await harness.controller.start();

    await harness.controller.switchDevice("rear");

    expect(harness.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: false,
      video: {
        deviceId: { exact: "rear" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    expect(harness.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: false,
      video: {
        deviceId: { exact: "front" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.controller.active).toBe(true);
    expect(harness.video.srcObject).toBe(recoveryStream);
    expect(harness.onProblem).toHaveBeenCalledExactlyOnceWith("camera-switch-unavailable");

    harness.controller.cancel();
    expect(recoveryTrack.stop).toHaveBeenCalledOnce();
  });
});
