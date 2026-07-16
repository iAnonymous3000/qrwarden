import {
  matchConsecutiveFrames,
  orderDetections,
  type CameraDetection,
  type DetectionFrame,
} from "./matcher";

const FRAME_INTERVAL_MS = 1000 / 6;
const ATTEMPT_TIMEOUT_MS = 5_000;
const METADATA_TIMEOUT_MS = 10_000;
const MAX_INPUT_AXIS = 8_192;
const MAX_INPUT_PIXELS = 25_000_000;
const MAX_CAPTURE_AXIS = 2_048;

export type CameraProblem =
  | "camera-unavailable"
  | "camera-access-needed"
  | "no-camera"
  | "camera-could-not-start"
  | "camera-stopped"
  | "camera-paused"
  | "reader-stopped"
  | "torch-unavailable"
  | "zoom-unavailable"
  | "camera-switch-unavailable";

export interface CameraDecodedDetection<Result> extends CameraDetection {
  readonly result: Result;
}

export type CameraDecodeResponse<Result> =
  | {
      readonly kind: "empty";
      readonly epoch: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "overflow";
      readonly epoch: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "detections";
      readonly epoch: number;
      readonly width: number;
      readonly height: number;
      readonly detections: readonly CameraDecodedDetection<Result>[];
      readonly preview: ImageBitmap | null;
    };

export interface CameraFrameDecoder<Result> {
  decodeCameraFrame(
    bitmap: ImageBitmap,
    request: { readonly epoch: number; readonly width: number; readonly height: number },
  ): Promise<CameraDecodeResponse<Result>>;
  restart(): void;
  terminate(): void;
}

export interface CameraAccepted<Result> {
  readonly kind: "single" | "selection";
  readonly detections: readonly CameraDecodedDetection<Result>[];
  readonly preview: ImageBitmap | null;
  readonly epoch: number;
}

export interface CameraControllerOptions<Result> {
  readonly video: HTMLVideoElement;
  readonly decoder: CameraFrameDecoder<Result>;
  readonly onAccepted: (accepted: CameraAccepted<Result>) => void;
  readonly onOverflow: () => void;
  readonly onProblem: (problem: CameraProblem) => void;
  readonly onDevices: (devices: readonly MediaDeviceInfo[]) => void;
  readonly onCapabilities: (capabilities: {
    readonly zoom: { readonly min: number; readonly max: number; readonly step: number } | null;
    readonly zoomValue: number | null;
    readonly torch: boolean;
    readonly torchEnabled: boolean;
  }) => void;
}

interface ExtendedCapabilities extends MediaTrackCapabilities {
  readonly torch?: boolean;
  readonly zoom?: { readonly min?: number; readonly max?: number; readonly step?: number };
}

interface ExtendedSettings extends MediaTrackSettings {
  readonly torch?: boolean;
  readonly zoom?: number;
}

function capabilitiesFor(track: MediaStreamTrack): ExtendedCapabilities {
  try {
    const getCapabilities = track.getCapabilities;
    return typeof getCapabilities === "function"
      ? getCapabilities.call(track) as ExtendedCapabilities
      : {};
  } catch {
    return {};
  }
}

function settingsFor(track: MediaStreamTrack): ExtendedSettings {
  try {
    const getSettings = track.getSettings;
    return typeof getSettings === "function"
      ? getSettings.call(track) as ExtendedSettings
      : {};
  } catch {
    return {};
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function mapStartError(error: unknown): CameraProblem {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "camera-access-needed";
    }
    if (error.name === "NotFoundError") {
      return "no-camera";
    }
  }
  return "camera-could-not-start";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function withCancellableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timeout: number | null = null;

    const cleanup = (): void => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      parentSignal?.removeEventListener("abort", onParentAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (error: unknown): void => {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      rejectOnce(error);
    };
    const onParentAbort = (): void => {
      if (parentSignal !== undefined) {
        cancel(abortReason(parentSignal));
      }
    };

    if (parentSignal?.aborted === true) {
      onParentAbort();
      return;
    }
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    timeout = window.setTimeout(() => {
      cancel(new DOMException("Operation timed out", "TimeoutError"));
    }, milliseconds);

    try {
      void operation(controller.signal).then(resolveOnce, rejectOnce);
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function waitForMetadata(video: HTMLVideoElement, parentSignal: AbortSignal): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }
  await withCancellableTimeout(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        function cleanup(): void {
          video.removeEventListener("loadedmetadata", onMetadata);
          video.removeEventListener("resize", onMetadata);
          video.removeEventListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        }
        function resolveOnce(): void {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
        function rejectOnce(error: unknown): void {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
        function onMetadata(): void {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            resolveOnce();
          }
        }
        function onError(): void {
          rejectOnce(new DOMException("Video metadata failed", "NotReadableError"));
        }
        function onAbort(): void {
          rejectOnce(abortReason(signal));
        }

        video.addEventListener("loadedmetadata", onMetadata);
        video.addEventListener("resize", onMetadata);
        video.addEventListener("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        } else {
          onMetadata();
        }
      }),
    METADATA_TIMEOUT_MS,
    parentSignal,
  );
}

function exactInitialConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

function exactDeviceConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

export class CameraController<Result> {
  readonly #video: HTMLVideoElement;
  readonly #decoder: CameraFrameDecoder<Result>;
  readonly #captureCanvas = document.createElement("canvas");
  readonly #onAccepted: CameraControllerOptions<Result>["onAccepted"];
  readonly #onOverflow: CameraControllerOptions<Result>["onOverflow"];
  readonly #onProblem: CameraControllerOptions<Result>["onProblem"];
  readonly #onDevices: CameraControllerOptions<Result>["onDevices"];
  readonly #onCapabilities: CameraControllerOptions<Result>["onCapabilities"];

  #stream: MediaStream | null = null;
  #activeDeviceId: string | null = null;
  #epoch = 0;
  #timer: number | null = null;
  #inFlight = false;
  #metadataAbort: AbortController | null = null;
  #frameAbort: AbortController | null = null;
  #pendingFrame: DetectionFrame | null = null;
  #suspended = false;
  #lastZoom: number | null = null;
  #torch = false;
  #deviceChangeInstalled = false;

  constructor(options: CameraControllerOptions<Result>) {
    this.#video = options.video;
    this.#decoder = options.decoder;
    this.#onAccepted = options.onAccepted;
    this.#onOverflow = options.onOverflow;
    this.#onProblem = options.onProblem;
    this.#onDevices = options.onDevices;
    this.#onCapabilities = options.onCapabilities;
    this.#captureCanvas.setAttribute("aria-hidden", "true");
  }

  get epoch(): number {
    return this.#epoch;
  }

  get active(): boolean {
    return this.#stream !== null;
  }

  async start(): Promise<void> {
    if (
      !window.isSecureContext ||
      navigator.mediaDevices === undefined ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      this.#onProblem("camera-unavailable");
      return;
    }
    this.#suspended = false;
    const epoch = this.#advanceEpoch();
    try {
      await this.#startStream(exactInitialConstraints(), epoch);
    } catch (error) {
      if (epoch === this.#epoch) {
        this.#teardownStream();
        this.#onProblem(mapStartError(error));
      }
    }
  }

  async switchDevice(deviceId: string): Promise<void> {
    if (deviceId.length === 0 || deviceId === this.#activeDeviceId) {
      return;
    }
    const previousId = this.#activeDeviceId;
    const switchEpoch = this.#advanceEpoch();
    this.#teardownStream();
    try {
      await this.#startStream(exactDeviceConstraints(deviceId), switchEpoch);
      return;
    } catch {
      this.#teardownStream();
    }

    if (previousId !== null) {
      const recoveryEpoch = this.#advanceEpoch();
      try {
        await this.#startStream(exactDeviceConstraints(previousId), recoveryEpoch);
        this.#onProblem("camera-switch-unavailable");
        return;
      } catch {
        this.#teardownStream();
      }
    }
    this.#onProblem("camera-could-not-start");
  }

  async setTorch(enabled: boolean): Promise<boolean> {
    const track = this.#stream?.getVideoTracks()[0];
    if (track === undefined) {
      return this.#torch;
    }
    const previous = this.#torch;
    const epoch = this.#advanceEpoch();
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
      if (epoch !== this.#epoch) {
        return this.#torch;
      }
      this.#torch = enabled;
      this.#schedule(0);
      return this.#torch;
    } catch {
      if (epoch === this.#epoch) {
        this.#torch = previous;
        this.#onProblem("torch-unavailable");
        this.#schedule(0);
      }
      return this.#torch;
    }
  }

  async setZoom(value: number): Promise<number | null> {
    const track = this.#stream?.getVideoTracks()[0];
    if (track === undefined || !Number.isFinite(value)) {
      return this.#lastZoom;
    }
    const epoch = this.#advanceEpoch();
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
      if (epoch !== this.#epoch) {
        return this.#lastZoom;
      }
      const settings = settingsFor(track);
      this.#lastZoom = settings.zoom ?? value;
      this.#schedule(0);
      return this.#lastZoom;
    } catch {
      if (epoch === this.#epoch) {
        const settings = settingsFor(track);
        this.#lastZoom = settings.zoom ?? this.#lastZoom;
        this.#onProblem("zoom-unavailable");
        this.#schedule(0);
      }
      return this.#lastZoom;
    }
  }

  orientationChanged(): void {
    if (this.#stream === null) {
      return;
    }
    this.#advanceEpoch();
    this.#schedule(0);
  }

  suspend(hidden = true): void {
    if (this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#advanceEpoch();
    this.#decoder.terminate();
    this.#teardownStream();
    if (hidden) {
      this.#onProblem("camera-paused");
    }
  }

  cancel(): void {
    this.#suspended = true;
    this.#advanceEpoch();
    this.#decoder.terminate();
    this.#teardownStream();
  }

  async #startStream(
    constraints: MediaStreamConstraints,
    epoch: number,
  ): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (epoch !== this.#epoch || this.#suspended || document.visibilityState !== "visible") {
      stopStream(stream);
      throw new DOMException("Stale camera start", "AbortError");
    }

    this.#stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track === undefined) {
      stopStream(stream);
      this.#stream = null;
      throw new DOMException("No video track", "NotFoundError");
    }
    this.#activeDeviceId = settingsFor(track).deviceId ?? null;
    this.#video.muted = true;
    this.#video.playsInline = true;
    this.#video.srcObject = stream;

    try {
      const metadataAbort = new AbortController();
      this.#metadataAbort = metadataAbort;
      try {
        await this.#video.play();
        await waitForMetadata(this.#video, metadataAbort.signal);
      } finally {
        if (this.#metadataAbort === metadataAbort) {
          this.#metadataAbort = null;
        }
      }
      if (epoch !== this.#epoch || this.#stream !== stream) {
        throw new DOMException("Stale camera playback", "AbortError");
      }
      await this.#captureConformanceProbe();
    } catch (error) {
      stopStream(stream);
      if (this.#stream === stream) {
        this.#stream = null;
        this.#video.srcObject = null;
      }
      throw error;
    }

    track.addEventListener(
      "ended",
      () => {
        if (this.#stream === stream) {
          this.#advanceEpoch();
          this.#teardownStream();
          this.#onProblem("camera-stopped");
        }
      },
      { once: true },
    );
    this.#publishCapabilities(track);
    await this.#enumerateDevices();
    this.#installDeviceChange();
    if (epoch === this.#epoch) {
      this.#schedule(0);
    }
  }

  async #captureConformanceProbe(): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw new DOMException("Canvas unavailable", "NotSupportedError");
    }
    context.drawImage(this.#video, 0, 0, 1, 1);
    const bitmap = await createImageBitmap(canvas);
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }

  #publishCapabilities(track: MediaStreamTrack): void {
    const capabilities = capabilitiesFor(track);
    const settings = settingsFor(track);
    const rawZoom = capabilities.zoom;
    const zoom =
      rawZoom !== undefined &&
      typeof rawZoom.min === "number" &&
      typeof rawZoom.max === "number"
        ? {
            min: rawZoom.min,
            max: rawZoom.max,
            step: typeof rawZoom.step === "number" && rawZoom.step > 0 ? rawZoom.step : 0.1,
          }
        : null;
    this.#lastZoom = settings.zoom ?? zoom?.min ?? null;
    this.#torch = settings.torch ?? false;
    this.#onCapabilities({
      zoom,
      zoomValue: this.#lastZoom,
      torch: capabilities.torch === true,
      torchEnabled: this.#torch,
    });
  }

  async #enumerateDevices(): Promise<void> {
    if (
      document.visibilityState !== "visible" ||
      typeof navigator.mediaDevices.enumerateDevices !== "function"
    ) {
      return;
    }
    const epoch = this.#epoch;
    const stream = this.#stream;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (epoch !== this.#epoch || stream === null || this.#stream !== stream || this.#suspended) {
        return;
      }
      const seen = new Set<string>();
      const cameras = devices.filter((device) => {
        if (
          device.kind !== "videoinput" ||
          device.deviceId.length === 0 ||
          seen.has(device.deviceId)
        ) {
          return false;
        }
        seen.add(device.deviceId);
        return true;
      });
      this.#onDevices(Object.freeze(cameras));
    } catch {
      if (epoch === this.#epoch && stream !== null && this.#stream === stream && !this.#suspended) {
        this.#onDevices(Object.freeze([]));
      }
    }
  }

  #installDeviceChange(): void {
    if (
      this.#deviceChangeInstalled ||
      typeof navigator.mediaDevices.addEventListener !== "function"
    ) {
      return;
    }
    this.#deviceChangeInstalled = true;
    navigator.mediaDevices.addEventListener("devicechange", this.#onDeviceChange);
  }

  #schedule(delay: number): void {
    if (this.#stream === null || this.#suspended || this.#inFlight) {
      return;
    }
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer);
    }
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      void this.#capture();
    }, Math.max(0, delay));
  }

  async #capture(): Promise<void> {
    if (this.#inFlight || this.#stream === null || this.#suspended) {
      return;
    }
    const started = performance.now();
    const epoch = this.#epoch;
    const inputWidth = this.#video.videoWidth;
    const inputHeight = this.#video.videoHeight;
    if (inputWidth === 0 || inputHeight === 0) {
      this.#schedule(FRAME_INTERVAL_MS);
      return;
    }
    if (
      inputWidth > MAX_INPUT_AXIS ||
      inputHeight > MAX_INPUT_AXIS ||
      inputWidth * inputHeight > MAX_INPUT_PIXELS
    ) {
      this.#advanceEpoch();
      this.#teardownStream();
      this.#onProblem("camera-could-not-start");
      return;
    }

    const scale = Math.min(1, MAX_CAPTURE_AXIS / Math.max(inputWidth, inputHeight));
    const width = Math.max(1, Math.floor(inputWidth * scale));
    const height = Math.max(1, Math.floor(inputHeight * scale));
    this.#captureCanvas.width = width;
    this.#captureCanvas.height = height;
    const context = this.#captureCanvas.getContext("2d", { alpha: false });
    if (context === null) {
      this.#onProblem("reader-stopped");
      return;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    let bitmap: ImageBitmap | null = null;
    const frameAbort = new AbortController();
    this.#frameAbort = frameAbort;
    this.#inFlight = true;
    try {
      context.drawImage(this.#video, 0, 0, width, height);
      bitmap = await createImageBitmap(this.#captureCanvas);
      context.clearRect(0, 0, width, height);
      const ownedBitmap = bitmap;
      const response = await withCancellableTimeout(
        () => {
          const decoding = this.#decoder.decodeCameraFrame(ownedBitmap, { epoch, width, height });
          bitmap = null;
          return decoding;
        },
        ATTEMPT_TIMEOUT_MS,
        frameAbort.signal,
      );
      if (epoch !== this.#epoch || response.epoch !== epoch) {
        if (response.kind === "detections") {
          response.preview?.close();
        }
        return;
      }
      this.#handleResponse(response);
    } catch {
      bitmap?.close();
      context.clearRect(0, 0, width, height);
      this.#pendingFrame = null;
      if (epoch === this.#epoch) {
        this.#advanceEpoch();
        try {
          this.#decoder.restart();
        } catch {
          this.#teardownStream();
        }
        this.#onProblem("reader-stopped");
      }
    } finally {
      if (this.#frameAbort === frameAbort) {
        this.#frameAbort = null;
      }
      this.#inFlight = false;
      context.clearRect(0, 0, width, height);
      if (this.#stream === null || this.#suspended) {
        this.#clearCanvas();
      } else {
        const elapsed = performance.now() - started;
        this.#schedule(Math.max(0, FRAME_INTERVAL_MS - elapsed));
      }
    }
  }

  #handleResponse(response: CameraDecodeResponse<Result>): void {
    if (response.kind === "empty") {
      this.#pendingFrame = null;
      return;
    }
    if (response.kind === "overflow") {
      this.#pendingFrame = null;
      this.#advanceEpoch();
      this.#teardownStream();
      this.#onOverflow();
      return;
    }

    if (response.detections.length < 1 || response.detections.length > 8) {
      response.preview?.close();
      this.#pendingFrame = null;
      return;
    }

    const current: DetectionFrame = {
      width: response.width,
      height: response.height,
      detections: response.detections,
    };
    const previous = this.#pendingFrame;
    if (previous === null) {
      response.preview?.close();
      this.#pendingFrame = current;
      return;
    }

    const match = matchConsecutiveFrames(previous, current);
    if (match.kind !== "accepted") {
      response.preview?.close();
      this.#pendingFrame = current;
      return;
    }

    this.#pendingFrame = null;
    const acceptedEpoch = response.epoch;
    const ordered = orderDetections(response.detections) as readonly CameraDecodedDetection<Result>[];
    const isSelection = ordered.length > 1;
    if (!isSelection) {
      response.preview?.close();
    }
    this.#advanceEpoch();
    this.#teardownStream();
    this.#onAccepted({
      kind: isSelection ? "selection" : "single",
      detections: ordered,
      preview: isSelection ? response.preview : null,
      epoch: acceptedEpoch,
    });
  }

  #advanceEpoch(): number {
    this.#epoch += 1;
    this.#pendingFrame = null;
    const abort = new DOMException("Camera operation superseded", "AbortError");
    this.#metadataAbort?.abort(abort);
    this.#metadataAbort = null;
    this.#frameAbort?.abort(abort);
    this.#frameAbort = null;
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#epoch;
  }

  #teardownStream(): void {
    if (this.#deviceChangeInstalled) {
      if (typeof navigator.mediaDevices.removeEventListener === "function") {
        navigator.mediaDevices.removeEventListener("devicechange", this.#onDeviceChange);
      }
      this.#deviceChangeInstalled = false;
    }
    stopStream(this.#stream);
    this.#stream = null;
    this.#activeDeviceId = null;
    this.#video.pause();
    this.#video.srcObject = null;
    this.#torch = false;
    this.#lastZoom = null;
    this.#onCapabilities({
      zoom: null,
      zoomValue: null,
      torch: false,
      torchEnabled: false,
    });
    this.#clearCanvas();
  }

  readonly #onDeviceChange = (): void => {
    if (document.visibilityState !== "visible" || this.#stream === null || this.#suspended) {
      return;
    }
    this.#advanceEpoch();
    this.#schedule(0);
    void this.#enumerateDevices();
  };

  #clearCanvas(): void {
    this.#captureCanvas.width = 0;
    this.#captureCanvas.height = 0;
  }
}
