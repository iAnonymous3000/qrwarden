import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { ClipboardBroker, type ClipboardStatus } from "../action/clipboard";
import {
  NavigationBroker,
  type OpenConfirmation,
} from "../action/navigation";
import {
  ANALYZER_DATA_STATUS,
  ANALYZER_VERSION,
  analyzeDecodeResult,
  type AnalysisReport,
  type DisplayField,
} from "../analyzer";
import { ReportStore, type ActiveReport } from "../app/reportState";
import { isRuntimeIdle } from "../app/runtimeIdle";
import {
  retainSelectionPreview,
  selectionPositionLabel,
  type OwnedSelectionPreview,
} from "../app/selectionPreview";
import { PROBLEM_COPY, type ProblemCode } from "../app/problems";
import { WorkState } from "../app/workState";
import { CameraController, type CameraProblem } from "../camera/controller";
import { CameraDecoderAdapter } from "../camera/decoderAdapter";
import { COPY } from "../copy";
import type {
  DecoderOutcome,
  DetectionResult,
} from "../decoder";
import {
  ImageController,
  installDropNavigationGuard,
  type ImageIntakeProblem,
} from "../image/controller";
import type { OfflineState, ServiceWorkerClient } from "../sw/client";
import { presentFieldValue } from "./fieldPresentation";
import { detectInstallGuidance } from "./installGuidance";
import type { ThemeController } from "./theme";
import {
  presentUpdateInstall,
  type UpdateActivationFeedback,
} from "./updateInstallPresentation";

export interface RuntimeBridge {
  isIdle: () => boolean;
  dropReport: () => void;
}

export interface AppStatusDetail {
  readonly offlineState?: OfflineState;
  readonly locked?: boolean;
}

export interface AppProps {
  readonly workerFactory: () => Worker;
  readonly serviceWorker: ServiceWorkerClient | null;
  readonly initialOfflineState: OfflineState;
  readonly initialLocked: boolean;
  readonly releaseId: string;
  readonly signingPublicKey: string;
  readonly signingFingerprint: string;
  readonly dnsKeyOwner: string;
  readonly sourceRepository: string | null;
  readonly statusEvents: EventTarget;
  readonly bridge: RuntimeBridge;
  readonly themeController: ThemeController;
}

interface SelectionEntry {
  readonly detection: DetectionResult;
  readonly report: AnalysisReport | null;
}

type View =
  | { readonly kind: "home" }
  | { readonly kind: "camera" }
  | { readonly kind: "reading" }
  | {
      readonly kind: "selection";
      readonly entries: readonly SelectionEntry[];
      readonly preview: OwnedSelectionPreview;
    }
  | { readonly kind: "result"; readonly active: ActiveReport<AnalysisReport> }
  | { readonly kind: "error"; readonly problem: ProblemCode }
  | { readonly kind: "privacy" }
  | { readonly kind: "about" };

interface CameraUi {
  readonly devices: readonly MediaDeviceInfo[];
  readonly activeDeviceId: string | null;
  readonly zoom: { readonly min: number; readonly max: number; readonly step: number } | null;
  readonly zoomValue: number;
  readonly torchAvailable: boolean;
  readonly torchEnabled: boolean;
  readonly notice: CameraProblem | null;
}

const EMPTY_CAMERA_UI: CameraUi = Object.freeze({
  devices: Object.freeze([]),
  activeDeviceId: null,
  zoom: null,
  zoomValue: 1,
  torchAvailable: false,
  torchEnabled: false,
  notice: null,
});

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";

function releaseValue(value: string): string {
  return /^<SET_[A-Z0-9_]+>$/u.test(value)
    ? "Not configured in this development build"
    : value;
}

function displayedReleaseId(value: string): string {
  return value.endsWith(`+${DEVELOPMENT_COMMIT}`)
    ? `${value.slice(0, -(DEVELOPMENT_COMMIT.length))}development`
    : value;
}

function kindLabel(report: AnalysisReport): string {
  const labels: Readonly<Record<AnalysisReport["kind"], string>> = {
    "web-url": "Web link",
    wifi: "Wi-Fi details",
    otp: "One-time password setup",
    dpp: "Device provisioning",
    contact: "Contact",
    calendar: "Calendar entry",
    email: "Email details",
    sms: "Message details",
    telephone: "Telephone number",
    geo: "Location",
    payment: "Payment details",
    "custom-uri": "App link",
    gs1: "GS1 data",
    "iso-15434": "ISO/IEC 15434 data",
    empty: "Empty QR code",
    text: "Text",
    binary: "Raw bytes",
  };
  return labels[report.kind];
}

function offlineCopy(state: OfflineState): { heading: string; body: string } {
  switch (state) {
    case "ready":
      return { heading: COPY.readyOfflineHeading, body: COPY.readyOfflineBody };
    case "incomplete":
      return {
        heading: COPY.offlineIncompleteHeading,
        body: COPY.offlineIncompleteBody,
      };
    case "update-ready":
      return { heading: COPY.updateReadyHeading, body: COPY.updateReadyBody };
    case "update-failed":
      return { heading: COPY.updateFailedHeading, body: COPY.updateFailedBody };
    case "preparing":
      return {
        heading: COPY.preparingOfflineHeading,
        body: COPY.preparingOfflineBody,
      };
  }
}

function statusForReport(report: AnalysisReport): {
  heading: string;
  body: string;
  tone: "neutral" | "review" | "unavailable";
} {
  if (report.kind === "binary") {
    return {
      heading: COPY.rawBytesHeading,
      body: COPY.rawBytesBody,
      tone: "unavailable",
    };
  }
  if (report.kind === "empty") {
    return {
      heading: COPY.emptyHeading,
      body: COPY.emptyBody,
      tone: "neutral",
    };
  }
  if (report.actionPolicy === "inspect-only") {
    return {
      heading: COPY.inspectOnlyHeading,
      body: COPY.inspectOnlyBody,
      tone: "unavailable",
    };
  }
  if (report.actionPolicy === "confirm-web") {
    return {
      heading: COPY.reviewHeading,
      body: COPY.reviewBody(
        report.signals.filter((signal) => signal.level === "review").length,
      ),
      tone: "review",
    };
  }
  return {
    heading: COPY.noReviewHeading,
    body: COPY.noReviewBody,
    tone: "neutral",
  };
}

function problemFromImage(problem: ImageIntakeProblem): ProblemCode | null {
  if (problem === "cancelled") return null;
  return problem === "image-too-large" ||
    problem === "unsupported-image-type" ||
    problem === "image-unreadable" ||
    problem === "took-too-long" ||
    problem === "reader-stopped" ||
    problem === "choose-one-image"
    ? problem
    : "reader-stopped";
}

function problemFromCamera(problem: CameraProblem): ProblemCode | null {
  return problem === "camera-unavailable" ||
    problem === "camera-access-needed" ||
    problem === "no-camera" ||
    problem === "camera-could-not-start" ||
    problem === "camera-stopped" ||
    problem === "camera-paused" ||
    problem === "reader-stopped"
    ? problem
    : null;
}

function SelectionCanvas({
  preview,
  onUnavailable,
}: {
  readonly preview: OwnedSelectionPreview;
  readonly onUnavailable: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      preview.dispose();
      return;
    }
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      canvas.width = 0;
      canvas.height = 0;
      preview.dispose();
      onUnavailable();
      return;
    }
    if (!preview.attachCanvas(canvas)) return;
    try {
      if (preview.disposed) return;
      context.drawImage(preview.bitmap, 0, 0, preview.width, preview.height);
      context.lineWidth = Math.max(3, Math.min(preview.width, preview.height) / 150);
      context.font = `700 ${Math.max(18, Math.min(preview.width, preview.height) / 18)}px system-ui`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      preview.positions.forEach((position, index) => {
        const points = [
          position.topLeft,
          position.topRight,
          position.bottomRight,
          position.bottomLeft,
        ];
        context.beginPath();
        context.moveTo(points[0]?.x ?? 0, points[0]?.y ?? 0);
        points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
        context.strokeStyle = "#f59e0b";
        context.stroke();
        const x = points.reduce((sum, point) => sum + point.x, 0) / 4;
        const y = points.reduce((sum, point) => sum + point.y, 0) / 4;
        const radius = Math.max(14, Math.min(preview.width, preview.height) / 25);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = "#1c1917";
        context.fill();
        context.fillStyle = "#fff7ed";
        context.fillText(String(index + 1), x, y);
      });
    } finally {
      preview.consumeBitmap();
    }
    return () => preview.dispose();
  }, [preview]);
  return <canvas class="selection-canvas" ref={canvasRef} aria-hidden="true" />;
}

function FieldValue({
  field,
  revealRequested,
  locked,
}: {
  field: DisplayField;
  revealRequested: boolean;
  locked: boolean;
}) {
  const presentation = presentFieldValue(field, revealRequested, locked);
  if (field.collapsed && !presentation.masked) {
    if (locked) {
      return (
        <span class="field-value field-value-long" aria-disabled="true">
          Details unavailable while the app version is checked.
        </span>
      );
    }
    return (
      <details>
        <summary>Show details</summary>
        <bdi dir="auto" class="field-value field-value-long">
          {presentation.value}
        </bdi>
      </details>
    );
  }
  return (
    <bdi dir="auto" class="field-value">
      {presentation.value}
    </bdi>
  );
}

function ConfirmationDialog({
  hostname,
  locked,
  returnFocus,
  onOpen,
  onCancel,
}: {
  hostname: string;
  locked: boolean;
  returnFocus: HTMLElement | null;
  onOpen: (event: MouseEvent) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    cancelRef.current?.focus();

    return () => {
      if (dialog.open) dialog.close();
      const focusTarget = returnFocus ?? previous;
      if (focusTarget?.isConnected === true) focusTarget.focus();
    };
  }, [returnFocus]);

  return (
    <dialog
      class="confirm-dialog"
      ref={dialogRef}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">{COPY.confirmHeading}</h2>
      <div id="confirm-description">
        <p>{COPY.confirmBody(hostname)}</p>
        <p>{COPY.launchNotice}</p>
      </div>
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary-button"
          disabled={locked}
          onClick={onOpen}
        >
          {COPY.openLink}
        </button>
        <button
          ref={cancelRef}
          type="button"
          class="primary-button"
          onClick={onCancel}
        >
          {COPY.cancel}
        </button>
      </div>
    </dialog>
  );
}

export function App(props: AppProps) {
  const reports = useMemo(() => new ReportStore<AnalysisReport>(), []);
  const work = useMemo(() => new WorkState(), []);
  const [view, setView] = useState<View>({ kind: "home" });
  const viewRef = useRef<View>(view);
  const [offlineState, setOfflineState] = useState(props.initialOfflineState);
  const [locked, setLocked] = useState(props.initialLocked);
  const lockedRef = useRef(props.initialLocked);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<ClipboardStatus | null>(null);
  const [confirmation, setConfirmation] =
    useState<OpenConfirmation<AnalysisReport> | null>(null);
  const [updateActivationFeedback, setUpdateActivationFeedback] =
    useState<UpdateActivationFeedback>(null);
  const [cameraUi, setCameraUi] = useState<CameraUi>(EMPTY_CAMERA_UI);
  const videoRef = useRef<HTMLVideoElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const cameraRef = useRef<CameraController<DetectionResult> | null>(null);
  const cameraTaskCount = useRef(0);
  const [cameraTaskRevision, setCameraTaskRevision] = useState(0);
  const [theme, setTheme] = useState(props.themeController.theme);

  useEffect(
    () => props.themeController.subscribe(setTheme),
    [props.themeController],
  );

  const trackCameraTask = (task: Promise<unknown>): void => {
    cameraTaskCount.current += 1;
    setCameraTaskRevision((current) => current + 1);
    const settle = (): void => {
      cameraTaskCount.current = Math.max(0, cameraTaskCount.current - 1);
      setCameraTaskRevision((current) => current + 1);
    };
    void task.then(settle, settle);
  };

  const transitionView = (next: View): void => {
    const previous = viewRef.current;
    if (previous.kind === "selection" && previous !== next) {
      previous.preview.dispose();
    }
    if (previous.kind !== next.kind) {
      window.scrollTo(0, 0);
    }
    viewRef.current = next;
    setView(next);
  };

  const navigation = useMemo(
    () =>
      new NavigationBroker(reports, (failure) => {
        setConfirmation(null);
        if (failure === "link-changed") {
          transitionView({ kind: "error", problem: "link-changed" });
        }
      }, () => lockedRef.current),
    [reports],
  );
  const clipboard = useMemo(
    () =>
      new ClipboardBroker({
        reports,
        getWorkGeneration: () => work.generation,
        isLocked: () => lockedRef.current,
        onStatus: setCopyStatus,
      }),
    [reports, work],
  );

  const showReport = (report: AnalysisReport): void => {
    navigation.clearConfirmation();
    clipboard.invalidate();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyStatus(null);
    transitionView({ kind: "result", active: reports.activate(report) });
  };

  const processOutcome = (outcome: DecoderOutcome): void => {
    switch (outcome.kind) {
      case "no-result":
        transitionView({ kind: "error", problem: "no-result" });
        return;
      case "overflow":
        transitionView({ kind: "error", problem: "overflow" });
        return;
      case "unsupported":
        transitionView({ kind: "error", problem: "unsupported" });
        return;
      case "single":
        showReport(analyzeDecodeResult(outcome.result));
        return;
      case "multiple":
        transitionView({
          kind: "selection",
          entries: Object.freeze(
            outcome.detections.map((detection) => ({
              detection,
              report:
                detection.kind === "supported"
                  ? analyzeDecodeResult(detection.result)
                  : null,
            })),
          ),
          preview: retainSelectionPreview(work, outcome.preview),
        });
    }
  };

  const imageController = useMemo(
    () =>
      new ImageController({
        workerFactory: props.workerFactory,
        onResult: ({ outcome }) => processOutcome(outcome),
        onProblem: (problem) => {
          const mapped = problemFromImage(problem);
          if (mapped !== null) transitionView({ kind: "error", problem: mapped });
        },
      }),
    [props.workerFactory],
  );

  props.bridge.isIdle = () =>
    isRuntimeIdle({
      viewKind: viewRef.current.kind,
      hasActiveReport: reports.active !== null,
      hasOpenConfirmation: navigation.confirmation !== null,
      imageBusy: imageController.busy,
      cameraAttached: cameraRef.current !== null,
      cameraTaskBusy: cameraTaskCount.current > 0,
      clipboardBusy: clipboard.busy,
      hasRetainedResources: work.hasRetainedResources,
    });
  props.bridge.dropReport = () => {
    work.suspend();
    imageController.cancel();
    const camera = cameraRef.current;
    cameraRef.current = null;
    camera?.cancel();
    reports.drop();
    navigation.clearConfirmation();
    clipboard.invalidate();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyStatus(null);
    setCameraUi(EMPTY_CAMERA_UI);
    transitionView({ kind: "home" });
  };

  useLayoutEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<AppStatusDetail>).detail;
      if (detail.offlineState !== undefined) {
        setOfflineState(detail.offlineState);
        setUpdateActivationFeedback(null);
      }
      if (detail.locked !== undefined) {
        lockedRef.current = detail.locked;
        setLocked(detail.locked);
        if (detail.locked) {
          navigation.clearConfirmation();
          clipboard.invalidate();
          setConfirmation(null);
          setRevealed(new Set());
          setCopyStatus(null);
        }
      }
    };
    props.statusEvents.addEventListener("status", handler);
    return () => props.statusEvents.removeEventListener("status", handler);
  }, [clipboard, navigation, props.statusEvents]);

  useEffect(
    () =>
      installDropNavigationGuard((files) => {
        if (!locked && view.kind === "home") {
          work.begin();
          transitionView({ kind: "reading" });
          imageController.choose(files);
        }
      }),
    [imageController, locked, view.kind, work],
  );

  useEffect(() => {
    if (
      props.serviceWorker === null ||
      offlineState !== "ready" ||
      locked ||
      view.kind !== "home"
    ) {
      return;
    }
    const check = (): void => {
      void props.serviceWorker?.checkForUpdateWhenIdle();
    };
    const timer = window.setTimeout(check, 0);
    window.addEventListener("online", check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", check);
    };
  }, [cameraTaskRevision, locked, offlineState, props.serviceWorker, view.kind]);

  useEffect(() => {
    if (view.kind !== "camera" || videoRef.current === null) return;
    let adapter: CameraDecoderAdapter;
    try {
      adapter = new CameraDecoderAdapter(props.workerFactory);
    } catch {
      transitionView({ kind: "error", problem: "reader-stopped" });
      return;
    }
    const controller = new CameraController<DetectionResult>({
      video: videoRef.current,
      decoder: adapter,
      onAccepted: (accepted) => {
        if (accepted.kind === "single") {
          const detection = accepted.detections[0]?.result;
          if (detection?.kind === "supported") {
            showReport(analyzeDecodeResult(detection.result));
          } else {
            transitionView({ kind: "error", problem: "unsupported" });
          }
          return;
        }
        if (accepted.preview === null) {
          transitionView({ kind: "error", problem: "reader-stopped" });
          return;
        }
        const detections = accepted.detections.map((entry) => entry.result);
        transitionView({
          kind: "selection",
          entries: detections.map((detection) => ({
            detection,
            report:
              detection.kind === "supported"
                ? analyzeDecodeResult(detection.result)
                : null,
          })),
          preview: retainSelectionPreview(work, {
            bitmap: accepted.preview,
            width: accepted.preview.width,
            height: accepted.preview.height,
            positions: detections.map((detection) =>
              detection.kind === "supported"
                ? detection.result.position
                : detection.position,
            ),
          }),
        });
      },
      onOverflow: () => transitionView({ kind: "error", problem: "overflow" }),
      onProblem: (problem) => {
        const mapped = problemFromCamera(problem);
        if (mapped !== null) {
          transitionView({ kind: "error", problem: mapped });
        } else {
          setCameraUi((current) => ({ ...current, notice: problem }));
        }
      },
      onDevices: (devices, activeDeviceId) =>
        setCameraUi((current) => ({ ...current, devices, activeDeviceId })),
      onCapabilities: (capabilities) =>
        setCameraUi((current) => ({
          ...current,
          zoom: capabilities.zoom,
          zoomValue: capabilities.zoomValue ?? capabilities.zoom?.min ?? current.zoomValue,
          torchAvailable: capabilities.torch,
          torchEnabled: capabilities.torchEnabled,
        })),
    });
    cameraRef.current = controller;
    const orientation = (): void => controller.orientationChanged();
    window.addEventListener("orientationchange", orientation);
    window.addEventListener("resize", orientation);
    screen.orientation?.addEventListener("change", orientation);
    trackCameraTask(controller.start());
    return () => {
      window.removeEventListener("orientationchange", orientation);
      window.removeEventListener("resize", orientation);
      screen.orientation?.removeEventListener("change", orientation);
      controller.cancel();
      if (cameraRef.current === controller) cameraRef.current = null;
    };
  }, [props.workerFactory, view.kind]);

  useLayoutEffect(() => {
    const suspendWork = (requireHidden: boolean): void => {
      if (requireHidden && document.visibilityState !== "hidden") return;
      work.suspend();
      imageController.cancel();
      cameraRef.current?.suspend(true);
      navigation.clearConfirmation();
      clipboard.invalidate();
      setConfirmation(null);
      setRevealed(new Set());
      const currentKind = viewRef.current.kind;
      if (currentKind === "reading") {
        transitionView({ kind: "error", problem: "image-stopped" });
      } else if (currentKind === "selection") {
        transitionView({ kind: "home" });
      }
    };
    const visibilitySuspend = (): void => suspendWork(true);
    const pageHide = (event: PageTransitionEvent): void => {
      suspendWork(false);
      if (!event.persisted) {
        props.bridge.dropReport();
      }
    };
    document.addEventListener("visibilitychange", visibilitySuspend);
    window.addEventListener("pagehide", pageHide);
    return () => {
      document.removeEventListener("visibilitychange", visibilitySuspend);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [clipboard, imageController, navigation, props.bridge, work]);

  const goHome = (): void => {
    work.suspend();
    imageController.cancel();
    const camera = cameraRef.current;
    cameraRef.current = null;
    camera?.cancel();
    navigation.clearConfirmation();
    clipboard.invalidate();
    reports.drop();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyStatus(null);
    setCameraUi(EMPTY_CAMERA_UI);
    setUpdateActivationFeedback((current) =>
      current === "busy" ? null : current,
    );
    transitionView({ kind: "home" });
  };

  const resumeCamera = (): void => {
    setCameraUi(EMPTY_CAMERA_UI);
    work.begin();
    transitionView({ kind: "camera" });
  };

  const navigateInfo = (kind: "privacy" | "about"): void => {
    goHome();
    transitionView({ kind });
  };

  const offline = offlineCopy(offlineState);
  const controlsDisabled = locked;
  const cameraTaskBusy = cameraTaskCount.current > 0;
  // The visible workflow controls the affordance; the client rechecks the
  // full synchronous idle predicate before sending activation coordination.
  const updateInstall = presentUpdateInstall({
    offlineState,
    locked,
    home: view.kind === "home",
    serviceWorkerAvailable: props.serviceWorker !== null,
    feedback: updateActivationFeedback,
  });

  return (
    <div class={`app-shell view-${view.kind}`}>
      <a class="skip-link" href="#main-content">
        Skip to content
      </a>
      <header class="site-header">
        <button class="brand-button" type="button" onClick={goHome}>
          <span class="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>
            <strong>{COPY.brand}</strong>
            <small>{COPY.tagline}</small>
          </span>
        </button>
        <div class="header-actions">
          <nav aria-label="Information">
            <button
              type="button"
              aria-current={view.kind === "privacy" ? "page" : undefined}
              onClick={() => navigateInfo("privacy")}
            >
              Privacy
            </button>
            <button
              type="button"
              aria-current={view.kind === "about" ? "page" : undefined}
              onClick={() => navigateInfo("about")}
            >
              About
            </button>
          </nav>
          <button
            type="button"
            class="theme-toggle"
            aria-label="Dark mode"
            aria-pressed={theme === "dark"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => props.themeController.toggle()}
          >
            <span class="theme-toggle-label" aria-hidden="true">Dark</span>
            <span class="theme-toggle-track" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
      </header>

      <main id="main-content" class="main-content">
        <div class={`offline-strip offline-${offlineState}`} role="status" aria-live="polite">
          <span class="status-dot" aria-hidden="true" />
          <span>
            <strong>{offline.heading}</strong> {offline.body}
          </span>
          {updateInstall.visible ? (
            <button
              type="button"
              class="compact-button"
              disabled={updateInstall.disabled}
              aria-describedby={updateInstall.message === null ? undefined : "update-feedback"}
              onClick={() => {
                const result = props.serviceWorker?.activateWaitingUpdate();
                setUpdateActivationFeedback(result?.status ?? "unavailable");
              }}
            >
              {COPY.installUpdate}
            </button>
          ) : null}
        </div>
        {updateInstall.message !== null ? (
          <p id="update-feedback" class="strip-feedback" role="status">
            {updateInstall.message}
          </p>
        ) : null}
        {locked ? (
          <div class="version-lock-banner" role="status">
            <span class="lock-glyph" aria-hidden="true" />
            <div>
              <strong>{COPY.checkingVersionHeading}</strong>
              <p>{COPY.checkingVersionBody}</p>
            </div>
          </div>
        ) : null}

        {view.kind === "home" ? (
          <section class="hero" aria-labelledby="hero-title" aria-busy={locked}>
            <div class="eyebrow">Private by design · works offline</div>
            <h1 id="hero-title">{COPY.primaryMessage}</h1>
            <p class="hero-copy">
              Scan with your camera or choose an image. QRWarden decodes and explains the contents on this device without visiting the destination.
            </p>
            <div class="source-grid">
              <button
                type="button"
                class="source-card source-camera"
                disabled={controlsDisabled}
                onClick={() => {
                  work.begin();
                  transitionView({ kind: "camera" });
                }}
              >
                <span class="source-icon camera-icon" aria-hidden="true" />
                <strong>Scan with camera</strong>
                <span>Point your camera at a QR code</span>
              </button>
              <label class={`source-card source-image${controlsDisabled ? " source-disabled" : ""}`}>
                <span class="source-icon image-icon" aria-hidden="true" />
                <strong>Choose an image</strong>
                <span>JPEG, PNG, or WebP · up to 25 MB</span>
                <input
                  class="visually-hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    work.begin();
                    transitionView({ kind: "reading" });
                    imageController.choose(files);
                  }}
                />
              </label>
            </div>
            <div class="privacy-promise">
              <span class="lock-glyph" aria-hidden="true" />
              <div>
                <strong>Your scan stays here.</strong>
                <p>{COPY.privacyStatement}</p>
              </div>
            </div>
            <div class="steps" aria-label="How QRWarden works">
              <div><span>1</span><strong>Scan</strong><small>Camera or image</small></div>
              <div><span>2</span><strong>Inspect</strong><small>See the real contents</small></div>
              <div><span>3</span><strong>Decide</strong><small>You choose what happens</small></div>
            </div>
          </section>
        ) : null}

        {view.kind === "reading" ? (
          <section class="center-card" aria-live="polite" aria-busy={locked}>
            <span class="reader-pulse" aria-hidden="true" />
            <h1>Reading image…</h1>
            <p>The image is being decoded on this device.</p>
            <button type="button" class="secondary-button" onClick={goHome}>Cancel</button>
          </section>
        ) : null}

        {view.kind === "camera" ? (
          <section class="scanner-panel" aria-labelledby="camera-title" aria-busy={locked}>
            <div class="section-heading">
              <div>
                <p class="eyebrow">Camera scan</p>
                <h1 id="camera-title">Hold the QR code inside the frame</h1>
              </div>
              <button type="button" class="secondary-button" onClick={goHome}>Cancel</button>
            </div>
            <div class="video-frame">
              <video
                ref={videoRef}
                aria-label="Live camera preview"
                autoPlay
                muted
                playsInline
              />
              <span class="corner corner-a" aria-hidden="true" />
              <span class="corner corner-b" aria-hidden="true" />
              <span class="corner corner-c" aria-hidden="true" />
              <span class="corner corner-d" aria-hidden="true" />
            </div>
            <p class="camera-search-status" role="status">
              {COPY.lookingForCode}
            </p>
            {cameraUi.notice !== null ? (
              <p class="camera-notice" role="status">
                {cameraUi.notice === "torch-unavailable"
                  ? COPY.torchUnavailableBody
                  : cameraUi.notice === "zoom-unavailable"
                    ? COPY.zoomUnavailableBody
                    : COPY.switchUnavailableBody}
              </p>
            ) : null}
            <div class="camera-controls">
              {cameraUi.devices.length > 1 ? (
                <label>
                  Camera
                  <select
                    value={cameraUi.activeDeviceId ?? ""}
                    disabled={locked || cameraTaskBusy}
                    onChange={(event) => {
                      const task = cameraRef.current?.switchDevice(event.currentTarget.value);
                      if (task !== undefined) trackCameraTask(task);
                    }}
                  >
                    {!cameraUi.devices.some(
                      (device) => device.deviceId === cameraUi.activeDeviceId,
                    ) ? (
                      <option value={cameraUi.activeDeviceId ?? ""} disabled>
                        Camera selected automatically
                      </option>
                    ) : null}
                    {cameraUi.devices.map((device, index) => (
                      <option value={device.deviceId} key={device.deviceId}>
                        {device.label || `Camera ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cameraUi.zoom !== null ? (
                <label>
                  Zoom
                  <input
                    type="range"
                    disabled={locked || cameraTaskBusy}
                    min={cameraUi.zoom.min}
                    max={cameraUi.zoom.max}
                    step={cameraUi.zoom.step}
                    value={cameraUi.zoomValue}
                    onInput={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      const task = cameraRef.current?.setZoom(value);
                      if (task === undefined) return;
                      trackCameraTask(task);
                      void task.then((applied) => {
                        if (applied !== null) {
                          setCameraUi((current) => ({ ...current, zoomValue: applied }));
                        }
                      });
                    }}
                  />
                </label>
              ) : null}
              {cameraUi.torchAvailable ? (
                <button
                  type="button"
                  class="secondary-button"
                  disabled={locked || cameraTaskBusy}
                  aria-pressed={cameraUi.torchEnabled}
                  onClick={() => {
                    const enabled = !cameraUi.torchEnabled;
                    const task = cameraRef.current?.setTorch(enabled);
                    if (task === undefined) return;
                    trackCameraTask(task);
                    void task.then((applied) => {
                      setCameraUi((current) => ({ ...current, torchEnabled: applied }));
                    });
                  }}
                >
                  {cameraUi.torchEnabled ? "Turn torch off" : "Turn torch on"}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {view.kind === "selection" ? (
          <section class="result-layout" aria-labelledby="selection-title" aria-busy={locked}>
            <div class="section-heading">
              <div>
                <p class="eyebrow">Multiple codes</p>
                <h1 id="selection-title">{COPY.chooseQrHeading}</h1>
                <p>{COPY.chooseQrBody}</p>
              </div>
              <button type="button" class="secondary-button" onClick={goHome}>Cancel</button>
            </div>
            <SelectionCanvas
              preview={view.preview}
              onUnavailable={() =>
                transitionView({ kind: "error", problem: "reader-stopped" })
              }
            />
            <ol class="selection-list">
              {view.entries.map((entry, index) => {
                const payloadKind =
                  entry.report === null ? "Unsupported code" : kindLabel(entry.report);
                const position = view.preview.positions[index];
                const positionLabel =
                  position === undefined
                    ? "position unavailable"
                    : selectionPositionLabel(
                        position,
                        view.preview.width,
                        view.preview.height,
                      );
                return (
                  <li key={entry.detection.originalIndex}>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`QR code ${index + 1}, ${positionLabel}, ${payloadKind}`}
                      onClick={() => {
                        if (entry.report === null) {
                          transitionView({ kind: "error", problem: "unsupported" });
                        } else {
                          showReport(entry.report);
                        }
                      }}
                    >
                      <span class="number-badge">{index + 1}</span>
                      <span class="selection-position">{positionLabel}</span>
                      <span class="kind-chip">{payloadKind}</span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {view.kind === "error" ? (() => {
          const problem = PROBLEM_COPY[view.problem];
          const canResumeCamera = problem.primaryAction === "resume-camera";
          return (
            <section
              class={`center-card ${canResumeCamera ? "recovery-card" : "error-card"}`}
              role={canResumeCamera ? "status" : "alert"}
              aria-busy={locked}
            >
              <span class={canResumeCamera ? "recovery-glyph" : "error-glyph"} aria-hidden="true">
                {canResumeCamera ? "||" : "!"}
              </span>
              <h1>{problem.heading}</h1>
              <p>{problem.body}</p>
              {canResumeCamera ? (
                <div class="recovery-actions">
                  <button
                    type="button"
                    class="primary-button"
                    disabled={locked}
                    onClick={resumeCamera}
                  >
                    {COPY.resumeScanning}
                  </button>
                  <button type="button" class="secondary-button" onClick={goHome}>
                    {COPY.tryAnotherCode}
                  </button>
                </div>
              ) : (
                <button type="button" class="primary-button" onClick={goHome}>
                  {COPY.tryAnotherCode}
                </button>
              )}
            </section>
          );
        })() : null}

        {view.kind === "result" ? (() => {
          const report = view.active.report;
          const status = statusForReport(report);
          const hostname = report.displayFields.find((field) => field.kind === "hostname");
          return (
            <section class="result-layout" aria-labelledby="result-title" aria-busy={locked}>
              <div class="result-topline">
                <span class="kind-chip">{kindLabel(report)}</span>
              </div>
              <div class={`result-status status-${status.tone}`}>
                <span class="status-symbol" aria-hidden="true">{status.tone === "review" ? "!" : "i"}</span>
                <div>
                  <h1 id="result-title">{status.heading}</h1>
                  <p>{status.body}</p>
                </div>
              </div>
              {hostname !== undefined ? (
                <div class="destination-card">
                  <span>Actual destination</span>
                  <bdi dir="auto">{hostname.value}</bdi>
                </div>
              ) : null}
              {report.signals.length > 0 ? (
                <section aria-labelledby="signals-title">
                  <h2 id="signals-title">Details to notice</h2>
                  <ul class="signal-list">
                    {report.signals.map((signal) => (
                      <li class={`signal-${signal.level}`} key={signal.code}>
                        <span aria-hidden="true">{signal.level === "review" ? "!" : "i"}</span>
                        <div><strong>{signal.title}</strong><p>{signal.detail}</p></div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section aria-labelledby="contents-title">
                <h2 id="contents-title">Decoded contents</h2>
                <p class="clipboard-warning">{COPY.clipboardWarning}</p>
                <div class="field-list">
                  {report.displayFields.map((field) => {
                    const revealRequested = revealed.has(field.id);
                    const isRevealed = revealRequested && !locked;
                    return (
                      <div class="field-row" key={field.id}>
                        <div class="field-heading">
                          <span>{field.label}</span>
                          {field.sensitive ? <span class="sensitive-chip">Sensitive</span> : null}
                        </div>
                        <FieldValue
                          field={field}
                          revealRequested={revealRequested}
                          locked={locked}
                        />
                        <div class="field-actions">
                          {field.sensitive ? (
                            <button
                              type="button"
                              class="text-button"
                              disabled={locked}
                              aria-expanded={isRevealed}
                              onClick={() => {
                                setRevealed((current) => {
                                  const next = new Set(current);
                                  if (next.has(field.id)) next.delete(field.id);
                                  else next.add(field.id);
                                  return next;
                                });
                              }}
                            >
                              {isRevealed ? "Mask" : "Reveal"}
                            </button>
                          ) : null}
                          {(!field.sensitive || isRevealed) ? (
                            <button
                              type="button"
                              class="text-button"
                              disabled={locked}
                              onClick={(event) =>
                                clipboard.copy(event, view.active, field)
                              }
                            >
                              Copy {field.label.toLowerCase()}
                            </button>
                          ) : null}
                        </div>
                        {field.omittedCount !== undefined && field.omittedCount > 0 ? (
                          <p class="microcopy">
                            {field.omittedCount} omitted from display
                            {field.count === undefined ? "." : ` (${field.count} total).`}
                          </p>
                        ) : null}
                        {field.truncated ? (
                          <p class="microcopy">Value truncated for display.</p>
                        ) : null}
                        {field.sensitive ? <p class="microcopy">{COPY.revealWarning}</p> : null}
                      </div>
                    );
                  })}
                </div>
                {copyStatus !== null ? (
                  <p class="copy-status" role="status">
                    {copyStatus === "copied" ? COPY.copied : COPY.copyFailed}
                  </p>
                ) : null}
              </section>
              {report.kind === "web-url" ? (
                <section class="limitations" aria-labelledby="limits-title">
                  <h2 id="limits-title">What offline analysis cannot check</h2>
                  <p>{COPY.offlineLimitations}</p>
                  <p>{COPY.launchNotice}</p>
                </section>
              ) : null}
              {report.actionPolicy === "open-web" ? (
                <button
                  type="button"
                  class="primary-button action-button"
                  disabled={locked}
                  onClick={(event) =>
                    navigation.openReviewedLink(event, view.active, null)
                  }
                >
                  {COPY.openLink}
                </button>
              ) : null}
              {report.actionPolicy === "confirm-web" ? (
                <button
                  ref={confirmationTriggerRef}
                  type="button"
                  class="review-button action-button"
                  disabled={locked}
                  onClick={(event) => {
                    const next = navigation.beginConfirmation(event, view.active);
                    setConfirmation(next);
                  }}
                >
                  {COPY.continueToLink}
                </button>
              ) : null}
              {confirmation !== null && hostname !== undefined ? (
                <ConfirmationDialog
                  hostname={hostname.value}
                  locked={locked}
                  returnFocus={confirmationTriggerRef.current}
                  onOpen={(event) => {
                    navigation.openReviewedLink(event, view.active, confirmation);
                    setConfirmation(null);
                  }}
                  onCancel={() => {
                    navigation.clearConfirmation();
                    setConfirmation(null);
                  }}
                />
              ) : null}
              <button
                type="button"
                class="secondary-button action-button"
                onClick={goHome}
              >
                {COPY.scanAnother}
              </button>
            </section>
          );
        })() : null}

        {view.kind === "privacy" ? (
          <article class="prose-card" aria-busy={locked}>
            <p class="eyebrow">Privacy</p>
            <h1>What stays on your device</h1>
            <p class="lead">{COPY.privacyStatement}</p>
            <h2>No destination lookup</h2>
            <p>QRWarden does not visit decoded links, request favicons, check reputation, or send scan contents to a server. Analysis uses only the bytes inside the QR code and pinned data shipped with the app.</p>
            <h2>No scan history</h2>
            <p>Images, decoded content, and reports are kept only in memory while you review them. They are not stored in browser databases, caches, or URLs. Offline caches contain application files only, and a short-lived session marker may hold a release identifier while a verified update activates; neither contains scan contents. QRWarden may also store your light or dark appearance choice.</p>
            <h2>App hosting traffic</h2>
            <p>Opening or updating QRWarden sends ordinary HTTPS requests for application files to the host. The host, hosting provider, and network can observe connection metadata such as your IP address, request time, user agent, and requested application files. QRWarden does not add scan contents to those requests.</p>
            <h2>Actions you control</h2>
            <p>Opening a link sends it to your browser or operating system. Copying places the reviewed value on your system clipboard, which may sync with other devices or apps.</p>
            <button type="button" class="primary-button" onClick={goHome}>Back to scanner</button>
          </article>
        ) : null}

        {view.kind === "about" ? (() => {
          const guidance = detectInstallGuidance(navigator.userAgent);
          return (
            <article class="prose-card" aria-busy={locked}>
              <p class="eyebrow">About</p>
              <h1>Built to show evidence, not a verdict.</h1>
              <p class="lead">QRWarden explains observable properties of a QR code. It never calls a destination safe, trusted, malicious, or verified.</p>
              <dl class="about-grid">
                <div><dt>Application release</dt><dd>{displayedReleaseId(props.releaseId)}</dd></div>
                <div><dt>Analyzer</dt><dd>{ANALYZER_VERSION}</dd></div>
                <div><dt>PSL snapshot</dt><dd>{ANALYZER_DATA_STATUS.publicSuffix.captured}</dd></div>
                <div><dt>IANA snapshot</dt><dd>{ANALYZER_DATA_STATUS.ianaSpecialPurpose.captured}</dd></div>
                <div><dt>Unicode</dt><dd>{ANALYZER_DATA_STATUS.unicodeSecurity.unicodeVersion}</dd></div>
                <div><dt>First-party code license</dt><dd>AGPL-3.0-or-later</dd></div>
                <div><dt>Bundled data licenses</dt><dd>MPL-2.0 · CC0-1.0 · Unicode-3.0</dd></div>
                <div><dt>Release key fingerprint</dt><dd><bdi>{releaseValue(props.signingFingerprint)}</bdi></dd></div>
                <div><dt>Release public key</dt><dd><bdi>{releaseValue(props.signingPublicKey)}</bdi></dd></div>
                <div><dt>DNS trust anchor</dt><dd><bdi>{releaseValue(props.dnsKeyOwner)}</bdi></dd></div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <bdi>{props.sourceRepository ?? "Not configured in this development build"}</bdi>
                  </dd>
                </div>
              </dl>
              <section class="install-card">
                <h2>{guidance.heading}</h2>
                <p>{guidance.body}</p>
              </section>
              <button type="button" class="primary-button" onClick={goHome}>Back to scanner</button>
            </article>
          );
        })() : null}
      </main>

      <footer>
        <p>Local analysis only. No app analytics or telemetry. No verdicts.</p>
        <p>QRWarden · AGPL-3.0-or-later</p>
      </footer>
    </div>
  );
}
