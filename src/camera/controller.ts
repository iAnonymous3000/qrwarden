import {
  matchConsecutiveFrames,
  orderDetections,
  type CameraDetection,
  type DetectionFrame,
} from "./matcher";

const FRAME_INTERVAL_MS = 1000 / 6;
const ATTEMPT_TIMEOUT_MS = 5_000;
const USER_MEDIA_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_INPUT_AXIS = 8_192;
const MAX_INPUT_PIXELS = 25_000_000;
const MAX_CAPTURE_AXIS = 2_048;
const EMPTY_DEVICES: readonly MediaDeviceInfo[] = Object.freeze([]);

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
  /**
   * Settles once the underlying reader can accept frames. Awaited outside the
   * per-frame deadline so a slow startup is bounded only by the decoder's own
   * startup budget; rejection means that budget expired or the reader died.
   */
  ready(): Promise<void>;
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
  readonly onDevices: (
    devices: readonly MediaDeviceInfo[],
    activeDeviceId: string | null,
  ) => void;
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
    return typeof track.getCapabilities === "function"
      ? track.getCapabilities()
      : {};
  } catch {
    return {};
  }
}

function settingsFor(track: MediaStreamTrack): ExtendedSettings {
  try {
    return typeof track.getSettings === "function"
      ? track.getSettings()
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

function requestUserMedia(
  constraints: MediaStreamConstraints,
  signal: AbortSignal,
): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => rejectOnce(abortReason(signal));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let request: Promise<MediaStream>;
    try {
      request = navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    void request.then(
      (stream) => {
        if (settled || signal.aborted) {
          stopStream(stream);
          return;
        }
        settled = true;
        cleanup();
        resolve(stream);
      },
      rejectOnce,
    );
  });
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
  #decodeJob: Promise<CameraDecodeResponse<Result>> | null = null;
  #startupAbort: AbortController | null = null;
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
      if (switchEpoch !== this.#epoch) {
        return;
      }
      this.#teardownStream();
    }

    if (previousId !== null) {
      const recoveryEpoch = this.#advanceEpoch();
      try {
        await this.#startStream(exactDeviceConstraints(previousId), recoveryEpoch);
        this.#onProblem("camera-switch-unavailable");
        return;
      } catch {
        if (recoveryEpoch !== this.#epoch) {
          return;
        }
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
    // A resize is one of the events that can make video metadata usable. Do not
    // abort that startup wait; doing so would make the original start stale and
    // leave the camera view mounted without a live stream or an error.
    if (this.#startupAbort !== null) {
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
    this.#decodeJob = null;
    this.#decoder.terminate();
    this.#teardownStream();
    if (hidden) {
      this.#onProblem("camera-paused");
    }
  }

  cancel(): void {
    this.#suspended = true;
    this.#advanceEpoch();
    this.#decodeJob = null;
    this.#decoder.terminate();
    this.#teardownStream();
  }

  async #startStream(
    constraints: MediaStreamConstraints,
    epoch: number,
  ): Promise<void> {
    const stream = await withCancellableTimeout(
      (signal) => requestUserMedia(constraints, signal),
      USER_MEDIA_TIMEOUT_MS,
    );
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

    const startupAbort = new AbortController();
    this.#startupAbort = startupAbort;
    try {
      try {
        await this.#video.play();
        await waitForMetadata(this.#video, startupAbort.signal);
        if (
          startupAbort.signal.aborted ||
          epoch !== this.#epoch ||
          this.#stream !== stream ||
          this.#suspended
        ) {
          throw new DOMException("Stale camera playback", "AbortError");
        }
        // createImageBitmap has no abort support, so bound the wait; a stalled
        // probe otherwise leaves the camera live forever with startup frozen.
        // The probe closes its own bitmap if one arrives after the deadline.
        await withCancellableTimeout(
          () => this.#captureConformanceProbe(),
          PROBE_TIMEOUT_MS,
          startupAbort.signal,
        );
        if (
          startupAbort.signal.aborted ||
          epoch !== this.#epoch ||
          this.#stream !== stream ||
          this.#suspended
        ) {
          throw new DOMException("Stale camera probe", "AbortError");
        }
      } finally {
        if (this.#startupAbort === startupAbort) {
          this.#startupAbort = null;
        }
      }
    } catch (error) {
      stopStream(stream);
      if (this.#stream === stream) {
        this.#stream = null;
        this.#video.srcObject = null;
      }
      throw error;
    }

    if (epoch !== this.#epoch || this.#stream !== stream || this.#suspended) {
      throw new DOMException("Stale camera publication", "AbortError");
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
    if (epoch !== this.#epoch || this.#stream !== stream || this.#suspended) {
      throw new DOMException("Stale camera listener", "AbortError");
    }
    // Hide choices from the previous stream until fresh enumeration completes,
    // while synchronously publishing which camera is actually active.
    this.#onDevices(EMPTY_DEVICES, this.#activeDeviceId);
    if (epoch !== this.#epoch || this.#stream !== stream || this.#suspended) {
      throw new DOMException("Stale camera device publication", "AbortError");
    }
    this.#installDeviceChange();
    this.#schedule(0);
    void this.#enumerateDevices();
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
      this.#onDevices(Object.freeze(cameras), this.#activeDeviceId);
    } catch {
      if (epoch === this.#epoch && stream !== null && this.#stream === stream && !this.#suspended) {
        this.#onDevices(EMPTY_DEVICES, this.#activeDeviceId);
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
    if (this.#decodeJob !== null) {
      // A decode abandoned by an earlier epoch still occupies the worker's
      // single in-flight slot. Submitting another job would trip its
      // single-flight guard and read as a stopped reader; skip this frame and
      // let the decoder's own job deadline bound the wait.
      this.#schedule(FRAME_INTERVAL_MS);
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
    let submitted: Promise<CameraDecodeResponse<Result>> | null = null;
    const frameAbort = new AbortController();
    this.#frameAbort = frameAbort;
    this.#inFlight = true;
    try {
      // Worker startup (a first visit downloads and compiles the WASM reader)
      // is governed by the decoder's own startup deadline. Await it before
      // arming the per-frame deadline so a slow start is not misread as a
      // stopped reader; readiness failure still lands in the catch below.
      await this.#decoder.ready();
      if (epoch !== this.#epoch || this.#stream === null || this.#suspended) {
        return;
      }
      context.drawImage(this.#video, 0, 0, width, height);
      // createImageBitmap has no abort support; bound the wait so a stalled
      // capture fails like a stuck decode instead of freezing the scan loop
      // with the camera live, and close a bitmap delivered after the deadline.
      bitmap = await withCancellableTimeout(
        async (signal) => {
          const captured = await createImageBitmap(this.#captureCanvas);
          if (signal.aborted) {
            captured.close();
            throw abortReason(signal);
          }
          return captured;
        },
        ATTEMPT_TIMEOUT_MS,
        frameAbort.signal,
      );
      context.clearRect(0, 0, width, height);
      const ownedBitmap = bitmap;
      const response = await withCancellableTimeout(
        () => {
          const decoding = this.#decoder.decodeCameraFrame(ownedBitmap, { epoch, width, height });
          submitted = decoding;
          this.#decodeJob = decoding;
          bitmap = null;
          return decoding;
        },
        ATTEMPT_TIMEOUT_MS,
        frameAbort.signal,
      );
      if (this.#decodeJob === submitted) {
        this.#decodeJob = null;
      }
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
      if (submitted !== null) {
        // The worker may still hold this job even though the frame settled;
        // watch it so later frames wait for the slot to free and any late
        // payload is released instead of leaking.
        this.#reapAbandonedDecode(submitted);
      }
      if (epoch === this.#epoch) {
        this.#advanceEpoch();
        this.#decodeJob = null;
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

  // A decode abandoned by an abort or deadline may settle long after its
  // frame. Free the busy-worker tracking when it does, and close any preview
  // bitmap it delivers because no live frame will consume it.
  #reapAbandonedDecode(job: Promise<CameraDecodeResponse<Result>>): void {
    const release = (): void => {
      if (this.#decodeJob === job) {
        this.#decodeJob = null;
      }
    };
    void job.then((response) => {
      release();
      if (response.kind === "detections") {
        response.preview?.close();
      }
    }, release);
  }

  #advanceEpoch(): number {
    this.#epoch += 1;
    this.#pendingFrame = null;
    const abort = new DOMException("Camera operation superseded", "AbortError");
    this.#startupAbort?.abort(abort);
    this.#startupAbort = null;
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
