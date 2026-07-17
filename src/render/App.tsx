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
import {
  ENGLISH_EVIDENCE_LANG,
  translateFieldLabel,
  translateSignalTitle,
} from "../copy/evidence";
import { APP_LOCALE } from "../copy/locale";
import type {
  DecoderOutcome,
  DetectionResult,
} from "../decoder";
import {
  filesFromDrop,
  ImageController,
  installDropNavigationGuard,
  type ImageIntakeProblem,
} from "../image/controller";
import type { OfflineState, ServiceWorkerClient } from "../sw/client";
import { detectBraveIos } from "./braveGuidance";
import { fieldLabelForSentence, presentFieldValue } from "./fieldPresentation";
import { detectInstallGuidance } from "./installGuidance";
import { reportAsText } from "./reportText";
import { SIGNAL_GLOSSARY, SIGNAL_GLOSSARY_CODES } from "./signalGlossary";
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
  readonly sharedImage?: File;
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
  | { readonly kind: "about" }
  | { readonly kind: "glossary" };

interface CameraUi {
  readonly devices: readonly MediaDeviceInfo[];
  readonly activeDeviceId: string | null;
  readonly zoom: { readonly min: number; readonly max: number; readonly step: number } | null;
  readonly zoomValue: number;
  readonly torchAvailable: boolean;
  readonly torchEnabled: boolean;
  readonly notice: CameraProblem | null;
  readonly starting: boolean;
}

const EMPTY_CAMERA_UI: CameraUi = Object.freeze({
  devices: Object.freeze([]),
  activeDeviceId: null,
  zoom: null,
  zoomValue: 1,
  torchAvailable: false,
  torchEnabled: false,
  notice: null,
  starting: false,
});

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";

// Copy feedback names its target so the confirmation renders beside the
// button that was clicked; the field namespace keeps ids from colliding
// with the whole-report target.
const COPY_REPORT_TARGET = "report";
const COPY_FEEDBACK_CLEAR_MS = 4000;

interface CopyFeedback {
  readonly target: string;
  readonly status: ClipboardStatus;
  readonly nonce: number;
}

function copyFeedbackText(status: ClipboardStatus): string {
  return status === "copied" ? COPY.copied : COPY.copyFailed;
}

function releaseValue(value: string): string {
  return /^<SET_[A-Z0-9_]+>$/u.test(value) ? COPY.notConfiguredValue : value;
}

function sourceRepositorySegments(value: string): readonly string[] {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => `/${segment}`);
    return [
      `${parsed.protocol}//${parsed.host}`,
      ...path,
      `${parsed.search}${parsed.hash}`,
    ].filter((segment) => segment.length > 0);
  } catch {
    return [value];
  }
}

function displayedReleaseId(value: string): string {
  return value.endsWith(`+${DEVELOPMENT_COMMIT}`)
    ? `${value.slice(0, -(DEVELOPMENT_COMMIT.length))}development`
    : value;
}

function kindLabel(report: AnalysisReport): string {
  return COPY.kindLabels[report.kind];
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

function destinationOrigin(report: AnalysisReport): string | null {
  if (report.kind !== "web-url" || report.canonicalHref === undefined) return null;
  try {
    const parsed = new URL(report.canonicalHref);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function documentTitleForView(kind: View["kind"]): string {
  const titles: Readonly<Record<View["kind"], string>> = {
    home: COPY.tagline,
    camera: COPY.titleCamera,
    reading: COPY.titleReading,
    selection: COPY.titleSelection,
    result: COPY.titleResult,
    error: COPY.titleError,
    privacy: COPY.titlePrivacy,
    about: COPY.titleAbout,
    glossary: COPY.titleGlossary,
  };
  return kind === "home" ? `${COPY.brand}: ${titles[kind]}` : `${titles[kind]} · ${COPY.brand}`;
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
    if (!preview.attachCanvas(canvas)) {
      if (!preview.disposed) onUnavailable();
      return;
    }
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
    } catch {
      preview.dispose();
      onUnavailable();
    } finally {
      preview.consumeBitmap();
    }
    return () => preview.dispose();
  }, [preview]);
  return <canvas class="selection-canvas" ref={canvasRef} aria-hidden="true" />;
}

function FieldValue({
  field,
  label,
  revealRequested,
  locked,
  valueId,
}: {
  field: DisplayField;
  label: string;
  revealRequested: boolean;
  locked: boolean;
  valueId: string;
}) {
  const presentation = presentFieldValue(field, revealRequested, locked);
  if (field.collapsed && !presentation.masked && !field.sensitive) {
    if (locked) {
      return (
        <span id={valueId} class="field-value field-value-long" aria-disabled="true">
          {COPY.lockedFieldDetails}
        </span>
      );
    }
    return (
      <details>
        <summary>
          <span class="summary-closed-label">
            {COPY.showField(fieldLabelForSentence(label))}
          </span>
          <span class="summary-open-label">
            {COPY.hideField(fieldLabelForSentence(label))}
          </span>
        </summary>
        <bdi dir="auto" class="field-value field-value-long">
          {presentation.value}
        </bdi>
      </details>
    );
  }
  return (
    <bdi id={valueId} dir="auto" class="field-value">
      {presentation.value}
    </bdi>
  );
}

function ConfirmationDialog({
  destination,
  canonicalHref,
  locked,
  returnFocus,
  onOpen,
  onCancel,
}: {
  destination: string;
  canonicalHref: string;
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
        <p>{COPY.confirmBody(destination)}</p>
        <p class="confirm-full-url">
          <span>{COPY.confirmFullUrlLabel}</span>
          <bdi dir="auto">{canonicalHref}</bdi>
        </p>
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
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousViewKindRef = useRef<View["kind"]>(view.kind);
  const [offlineState, setOfflineState] = useState(props.initialOfflineState);
  const [locked, setLocked] = useState(props.initialLocked);
  const lockedRef = useRef(props.initialLocked);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const copyTargetRef = useRef<string>(COPY_REPORT_TARGET);
  const copyNonceRef = useRef(0);
  const [confirmation, setConfirmation] =
    useState<OpenConfirmation<AnalysisReport> | null>(null);
  const [updateActivationFeedback, setUpdateActivationFeedback] =
    useState<UpdateActivationFeedback>(null);
  const [cameraUi, setCameraUi] = useState<CameraUi>(EMPTY_CAMERA_UI);
  const videoRef = useRef<HTMLVideoElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const recoveryImageInputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<CameraController<DetectionResult> | null>(null);
  const cameraTaskCount = useRef(0);
  const cameraTaskGeneration = useRef(0);
  const [cameraTaskRevision, setCameraTaskRevision] = useState(0);
  const [theme, setTheme] = useState(props.themeController.theme);
  const [followsSystemTheme, setFollowsSystemTheme] = useState(
    props.themeController.followsSystem,
  );
  const [braveIos, setBraveIos] = useState(false);
  const pendingShareRef = useRef<File | null>(null);
  const [shareRevision, setShareRevision] = useState(0);

  useEffect(
    () => props.themeController.subscribe(setTheme),
    [props.themeController],
  );

  useEffect(() => {
    let live = true;
    void detectBraveIos(navigator).then((detected) => {
      if (live && detected) setBraveIos(true);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (copyFeedback === null) return;
    const timer = window.setTimeout(
      () => setCopyFeedback(null),
      COPY_FEEDBACK_CLEAR_MS,
    );
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);

  useLayoutEffect(() => {
    document.title = documentTitleForView(view.kind);
    const previousKind = previousViewKindRef.current;
    previousViewKindRef.current = view.kind;
    if (previousKind === view.kind || view.kind === "error") return;
    viewHeadingRef.current?.focus({ preventScroll: true });
  }, [view.kind]);

  const resetCameraTasks = (): void => {
    cameraTaskGeneration.current += 1;
    cameraTaskCount.current = 0;
    setCameraTaskRevision((current) => current + 1);
  };

  const trackCameraTask = (task: Promise<unknown>): void => {
    const generation = cameraTaskGeneration.current;
    cameraTaskCount.current += 1;
    setCameraTaskRevision((current) => current + 1);
    const settle = (): void => {
      if (generation !== cameraTaskGeneration.current) return;
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
      setCopyFeedback(null);
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
        onStatus: (status) => {
          // A fresh nonce per settlement forces a new DOM text node in the
          // live region, so repeat copies of the same value re-announce.
          copyNonceRef.current += 1;
          setCopyFeedback({
            target: copyTargetRef.current,
            status,
            nonce: copyNonceRef.current,
          });
        },
      }),
    [reports, work],
  );

  const showReport = (report: AnalysisReport): void => {
    navigation.clearConfirmation();
    clipboard.invalidate();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyFeedback(null);
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

  const chooseImages = (files: readonly File[]): void => {
    work.begin();
    transitionView({ kind: "reading" });
    imageController.choose(files);
  };

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
    resetCameraTasks();
    reports.drop();
    navigation.clearConfirmation();
    clipboard.invalidate();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyFeedback(null);
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
          setCopyFeedback(null);
        }
      }
      if (detail.sharedImage !== undefined) {
        pendingShareRef.current = detail.sharedImage;
        setShareRevision((current) => current + 1);
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
    if (locked || view.kind !== "home") return;
    const file = pendingShareRef.current;
    if (file === null) return;
    pendingShareRef.current = null;
    chooseImages([file]);
  }, [locked, shareRevision, view.kind]);

  useEffect(() => {
    if (locked || view.kind !== "home") return;
    const onPaste = (event: ClipboardEvent): void => {
      const transfer = event.clipboardData;
      if (transfer === null) return;
      const files = filesFromDrop(transfer);
      if (files.length === 0) return;
      event.preventDefault();
      chooseImages(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [imageController, locked, view.kind, work]);

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
        navigator.vibrate?.(30);
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
    setCameraUi((current) => ({ ...current, starting: true }));
    const start = controller.start();
    trackCameraTask(start);
    const finishStart = (): void => {
      if (cameraRef.current === controller) {
        setCameraUi((current) => ({ ...current, starting: false }));
      }
    };
    void start.then(finishStart, finishStart);
    return () => {
      window.removeEventListener("orientationchange", orientation);
      window.removeEventListener("resize", orientation);
      screen.orientation?.removeEventListener("change", orientation);
      controller.cancel();
      resetCameraTasks();
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
    resetCameraTasks();
    navigation.clearConfirmation();
    clipboard.invalidate();
    reports.drop();
    setConfirmation(null);
    setRevealed(new Set());
    setCopyFeedback(null);
    setCameraUi(EMPTY_CAMERA_UI);
    setUpdateActivationFeedback((current) =>
      current === "busy" ? null : current,
    );
    transitionView({ kind: "home" });
  };

  const resumeCamera = (): void => {
    resetCameraTasks();
    setCameraUi(EMPTY_CAMERA_UI);
    work.begin();
    transitionView({ kind: "camera" });
  };

  const navigateInfo = (kind: "privacy" | "about" | "glossary"): void => {
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
        {COPY.skipToContent}
      </a>
      <header class="site-header">
        <button
          class="brand-button"
          type="button"
          aria-label={COPY.brandHomeLabel}
          onClick={goHome}
        >
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
          <nav aria-label={COPY.navInfoLabel}>
            <button
              type="button"
              aria-current={view.kind === "privacy" ? "page" : undefined}
              onClick={() => navigateInfo("privacy")}
            >
              {COPY.navPrivacy}
            </button>
            <button
              type="button"
              aria-current={view.kind === "about" ? "page" : undefined}
              onClick={() => navigateInfo("about")}
            >
              {COPY.navAbout}
            </button>
          </nav>
          <button
            type="button"
            class="theme-toggle"
            aria-label={COPY.themeToggleName}
            aria-pressed={theme === "dark"}
            title={theme === "dark" ? COPY.themeToLight : COPY.themeToDark}
            onClick={() => {
              props.themeController.toggle();
              setFollowsSystemTheme(false);
            }}
          >
            <span class="theme-toggle-label" aria-hidden="true">{COPY.themeToggleLabel}</span>
            <span class="theme-toggle-icon" aria-hidden="true">
              {theme === "dark" ? "☾" : "☀"}
            </span>
            <span class="theme-toggle-track" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
      </header>

      <main id="main-content" class="main-content" tabIndex={-1}>
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
            {offlineState === "update-failed" ? (
              <button
                type="button"
                class="compact-button"
                onClick={() => location.reload()}
              >
                {COPY.reloadApp}
              </button>
            ) : null}
          </div>
        ) : null}

        {view.kind === "home" ? (
          <section class="hero" aria-labelledby="hero-title" aria-busy={locked}>
            <div class="eyebrow">{COPY.heroEyebrow}</div>
            <h1 id="hero-title" ref={viewHeadingRef} tabIndex={-1}>
              {COPY.primaryMessage}
            </h1>
            <p class="hero-copy">{COPY.heroCopy}</p>
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
                <span class="source-icon camera-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M4 8.5h3l1.4-2h7.2l1.4 2h3v10H4z" />
                    <circle cx="12" cy="13.5" r="3.25" />
                  </svg>
                </span>
                <strong>{COPY.sourceCameraTitle}</strong>
                <span>{COPY.sourceCameraBody}</span>
              </button>
              <label class={`source-card source-image${controlsDisabled ? " source-disabled" : ""}`}>
                <span class="source-icon image-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                    <circle cx="8.25" cy="9" r="1.5" />
                    <path d="m5.5 17 4.5-4.5 3 3 2-2 3.5 3.5" />
                  </svg>
                </span>
                <strong>{COPY.sourceImageTitle}</strong>
                <span>{COPY.sourceImageBody}</span>
                <input
                  class="visually-hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    chooseImages(files);
                  }}
                />
              </label>
            </div>
            <p class="microcopy intake-hint">{COPY.pasteHint}</p>
            <div class="privacy-promise">
              <span class="lock-glyph" aria-hidden="true" />
              <div>
                <strong>{COPY.privacyPromiseTitle}</strong>
                <p>{COPY.privacyStatement}</p>
              </div>
            </div>
            <div class="steps" aria-label={COPY.stepsLabel}>
              <div><span>1</span><strong>{COPY.stepScan}</strong><small>{COPY.stepScanDetail}</small></div>
              <div><span>2</span><strong>{COPY.stepInspect}</strong><small>{COPY.stepInspectDetail}</small></div>
              <div><span>3</span><strong>{COPY.stepDecide}</strong><small>{COPY.stepDecideDetail}</small></div>
            </div>
          </section>
        ) : null}

        {view.kind === "reading" ? (
          <section class="center-card" aria-live="polite" aria-busy={locked}>
            <span class="reader-pulse" aria-hidden="true" />
            <h1 ref={viewHeadingRef} tabIndex={-1}>{COPY.readingHeading}</h1>
            <p>{COPY.readingBody}</p>
            <button type="button" class="secondary-button" onClick={goHome}>{COPY.cancel}</button>
          </section>
        ) : null}

        {view.kind === "camera" ? (
          <section class="scanner-panel" aria-labelledby="camera-title" aria-busy={locked}>
            <div class="section-heading">
              <div>
                <p class="eyebrow">{COPY.cameraEyebrow}</p>
                <h1 id="camera-title" ref={viewHeadingRef} tabIndex={-1}>
                  {COPY.cameraHeading}
                </h1>
              </div>
              <button type="button" class="secondary-button" onClick={goHome}>{COPY.cancel}</button>
            </div>
            <div class="video-frame">
              <video
                ref={videoRef}
                aria-label={COPY.videoPreviewLabel}
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
              {cameraUi.starting ? COPY.startingCamera : COPY.lookingForCode}
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
                  {COPY.cameraSelectLabel}
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
                        {COPY.cameraSelectedAutomatically}
                      </option>
                    ) : null}
                    {cameraUi.devices.map((device, index) => (
                      <option value={device.deviceId} key={device.deviceId}>
                        {device.label || `${COPY.cameraSelectLabel} ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cameraUi.zoom !== null ? (
                <label>
                  <span class="camera-control-label">
                    {COPY.zoomLabel} <output>{Math.round(cameraUi.zoomValue * 10) / 10}×</output>
                  </span>
                  <input
                    type="range"
                    aria-label={COPY.zoomLabel}
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
                  {cameraUi.torchEnabled ? COPY.torchOff : COPY.torchOn}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {view.kind === "selection" ? (
          <section class="result-layout" aria-labelledby="selection-title" aria-busy={locked}>
            <div class="section-heading">
              <div>
                <p class="eyebrow">{COPY.selectionEyebrow}</p>
                <h1 id="selection-title" ref={viewHeadingRef} tabIndex={-1}>
                  {COPY.chooseQrHeading}
                </h1>
                <p>{COPY.chooseQrBody}</p>
              </div>
              <button type="button" class="secondary-button" onClick={goHome}>{COPY.cancel}</button>
            </div>
            <SelectionCanvas
              preview={view.preview}
              onUnavailable={() =>
                transitionView({ kind: "error", problem: "reader-stopped" })
              }
            />
            <ol class="selection-list">
              {view.entries.map((entry, index) => {
                const entryReport = entry.report;
                const payloadKind =
                  entryReport === null ? COPY.unsupportedCodeChip : kindLabel(entryReport);
                const position = view.preview.positions[index];
                const positionLabel =
                  position === undefined
                    ? COPY.positionUnavailable
                    : selectionPositionLabel(
                        position,
                        view.preview.width,
                        view.preview.height,
                      );
                const label = COPY.selectionOptionLabel(index + 1, positionLabel, payloadKind);
                if (entryReport === null) {
                  return (
                    <li key={entry.detection.originalIndex}>
                      <div
                        class="selection-option selection-option-unavailable"
                        aria-label={`${label}, ${COPY.selectionUnavailable}`}
                      >
                        <span class="number-badge">{index + 1}</span>
                        <span class="selection-position">{positionLabel}</span>
                        <span class="kind-chip">{payloadKind}</span>
                        <span class="selection-unavailable">{COPY.selectionUnavailable}</span>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={entry.detection.originalIndex}>
                    <button
                      type="button"
                      class="selection-option"
                      disabled={locked}
                      aria-label={label}
                      onClick={() => showReport(entryReport)}
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
          const canRetryCamera = problem.primaryAction === "retry-camera";
          const canChooseImage = problem.imageFallback === true;
          const isRecovery = problem.tone === "recovery";
          return (
            <section
              class={`center-card ${isRecovery ? "recovery-card" : "error-card"}`}
              role="alert"
              aria-busy={locked}
            >
              <span class={isRecovery ? "recovery-glyph" : "error-glyph"} aria-hidden="true">
                {canResumeCamera ? "↻" : isRecovery ? "i" : "!"}
              </span>
              <h1 ref={viewHeadingRef} tabIndex={-1}>{problem.heading}</h1>
              <p>{problem.body}</p>
              {view.problem === "camera-access-needed" && braveIos ? (
                <p>{COPY.braveIosCameraBody}</p>
              ) : null}
              {canResumeCamera || canRetryCamera ? (
                <div class="recovery-actions">
                  <button
                    type="button"
                    class="primary-button"
                    disabled={locked}
                    onClick={resumeCamera}
                  >
                    {canResumeCamera ? COPY.resumeScanning : COPY.retryCamera}
                  </button>
                  {canChooseImage ? (
                    <>
                      <button
                        type="button"
                        class="secondary-button"
                        disabled={locked}
                        onClick={() => recoveryImageInputRef.current?.click()}
                      >
                        {COPY.chooseImage}
                      </button>
                      <input
                        ref={recoveryImageInputRef}
                        class="visually-hidden"
                        type="file"
                        tabIndex={-1}
                        aria-hidden="true"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={locked}
                        onChange={(event) => {
                          const files = Array.from(event.currentTarget.files ?? []);
                          event.currentTarget.value = "";
                          chooseImages(files);
                        }}
                      />
                    </>
                  ) : (
                    <button type="button" class="secondary-button" onClick={goHome}>
                      {COPY.tryAnotherCode}
                    </button>
                  )}
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
          const destination = destinationOrigin(report);
          return (
            <section class="result-layout" aria-labelledby="result-title" aria-busy={locked}>
              <div class="result-topline">
                <span class="kind-chip">{kindLabel(report)}</span>
              </div>
              <div class={`result-status status-${status.tone}`}>
                <span class="status-symbol" aria-hidden="true">{status.tone === "review" ? "!" : "i"}</span>
                <div>
                  <h1 id="result-title" ref={viewHeadingRef} tabIndex={-1}>
                    {status.heading}
                  </h1>
                  <p>{status.body}</p>
                </div>
              </div>
              {destination !== null ? (
                <div class="destination-card">
                  <span>{COPY.actualDestination}</span>
                  <bdi dir="auto">{destination}</bdi>
                </div>
              ) : null}
              {report.signals.length > 0 ? (
                <section aria-labelledby="signals-title">
                  <h2 id="signals-title">{COPY.signalsHeading}</h2>
                  <ul class="signal-list">
                    {report.signals.map((signal) => {
                      const title = translateSignalTitle(signal.title);
                      return (
                        <li class={`signal-${signal.level}`} key={signal.code}>
                          <span aria-hidden="true">{signal.level === "review" ? "!" : "i"}</span>
                          <div>
                            <small class="signal-level">
                              {signal.level === "review"
                                ? COPY.signalNeedsReview
                                : COPY.signalContext}
                            </small>
                            <strong lang={title.lang}>{title.text}</strong>
                            <p lang={ENGLISH_EVIDENCE_LANG}>{signal.detail}</p>
                            <details class="signal-explainer">
                              <summary>{COPY.signalExplainerSummary}</summary>
                              <p>{SIGNAL_GLOSSARY[signal.code].explanation}</p>
                            </details>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              <section aria-labelledby="contents-title">
                <h2 id="contents-title">{COPY.contentsHeading}</h2>
                <p class="clipboard-warning">{COPY.clipboardWarning}</p>
                <div class="field-list">
                  {report.displayFields.map((field) => {
                    const revealRequested = revealed.has(field.id);
                    const isRevealed = revealRequested && !locked;
                    const valueId = `field-value-${field.id}`;
                    const fieldLabel = translateFieldLabel(field.label);
                    const sentenceLabel = fieldLabelForSentence(fieldLabel.text);
                    const copyTarget = `field:${field.id}`;
                    return (
                      <div class="field-row" key={field.id}>
                        <div class="field-heading">
                          <span lang={fieldLabel.lang}>{fieldLabel.text}</span>
                          {field.sensitive ? <span class="sensitive-chip">{COPY.sensitiveChip}</span> : null}
                        </div>
                        <FieldValue
                          field={field}
                          label={fieldLabel.text}
                          revealRequested={revealRequested}
                          locked={locked}
                          valueId={valueId}
                        />
                        <div class="field-actions">
                          {field.sensitive ? (
                            <button
                              type="button"
                              class="text-button"
                              disabled={locked}
                              aria-controls={valueId}
                              aria-expanded={isRevealed}
                              aria-label={`${isRevealed ? COPY.mask : COPY.reveal} ${sentenceLabel}`}
                              onClick={() => {
                                setRevealed((current) => {
                                  const next = new Set(current);
                                  if (next.has(field.id)) next.delete(field.id);
                                  else next.add(field.id);
                                  return next;
                                });
                              }}
                            >
                              {isRevealed ? COPY.mask : COPY.reveal}
                            </button>
                          ) : null}
                          {(!field.sensitive || isRevealed) ? (
                            <button
                              type="button"
                              class="text-button"
                              disabled={locked}
                              onClick={(event) => {
                                copyTargetRef.current = copyTarget;
                                clipboard.copy(event, view.active, field);
                              }}
                            >
                              {COPY.copyField(sentenceLabel)}
                            </button>
                          ) : null}
                          {copyFeedback !== null && copyFeedback.target === copyTarget ? (
                            <span class="copy-feedback" aria-hidden="true">
                              {copyFeedbackText(copyFeedback.status)}
                            </span>
                          ) : null}
                        </div>
                        {field.omittedCount !== undefined && field.omittedCount > 0 ? (
                          <p class="microcopy">
                            {COPY.omittedFromDisplay(field.omittedCount, field.count)}
                          </p>
                        ) : null}
                        {field.truncated ? (
                          <p class="microcopy">{COPY.truncatedNote}</p>
                        ) : null}
                        {field.sensitive ? <p class="microcopy">{COPY.revealWarning}</p> : null}
                      </div>
                    );
                  })}
                </div>
              </section>
              {report.kind === "web-url" ? (
                <section class="limitations" aria-labelledby="limits-title">
                  <h2 id="limits-title">{COPY.limitsHeading}</h2>
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
              <button
                type="button"
                class="secondary-button action-button"
                disabled={locked}
                onClick={(event) => {
                  copyTargetRef.current = COPY_REPORT_TARGET;
                  clipboard.copyReport(event, view.active, (live) =>
                    reportAsText({
                      report: live,
                      kindLabel: kindLabel(live),
                      statusHeading: statusForReport(live).heading,
                    }),
                  );
                }}
              >
                {COPY.copyReportButton}
              </button>
              {copyFeedback !== null &&
              copyFeedback.target === COPY_REPORT_TARGET ? (
                <p class="copy-status" aria-hidden="true">
                  {copyFeedbackText(copyFeedback.status)}
                </p>
              ) : null}
              {confirmation !== null &&
              destination !== null &&
              report.canonicalHref !== undefined ? (
                <ConfirmationDialog
                  destination={destination}
                  canonicalHref={report.canonicalHref}
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
            <p class="eyebrow">{COPY.privacyEyebrow}</p>
            <h1 ref={viewHeadingRef} tabIndex={-1}>{COPY.privacyTitle}</h1>
            <p class="lead">{COPY.privacyStatement}</p>
            <h2>{COPY.privacyNoLookupHeading}</h2>
            <p>{COPY.privacyNoLookupBody}</p>
            <h2>{COPY.privacyNoHistoryHeading}</h2>
            <p>{COPY.privacyNoHistoryBody}</p>
            <h2>{COPY.privacyHostingHeading}</h2>
            <p>{COPY.privacyHostingBody}</p>
            <h2>{COPY.privacyActionsHeading}</h2>
            <p>{COPY.privacyActionsBody}</p>
            <button type="button" class="primary-button" onClick={goHome}>{COPY.backToScanner}</button>
          </article>
        ) : null}

        {view.kind === "about" ? (() => {
          const guidance = detectInstallGuidance(navigator.userAgent);
          return (
            <article class="prose-card" aria-busy={locked}>
              <p class="eyebrow">{COPY.aboutEyebrow}</p>
              <h1 ref={viewHeadingRef} tabIndex={-1}>
                {COPY.aboutTitle}
              </h1>
              <p class="lead">{COPY.aboutLead}</p>
              <p>
                <button
                  type="button"
                  class="text-button"
                  onClick={() => navigateInfo("glossary")}
                >
                  {COPY.glossaryLink}
                </button>
              </p>
              {APP_LOCALE === "en" ? null : (
                <p class="microcopy">{COPY.aboutEnglishEvidenceNote}</p>
              )}
              <section class="install-card">
                <h2>{guidance.heading}</h2>
                <p>{guidance.body}</p>
              </section>
              <section class="appearance-card" aria-labelledby="appearance-title">
                <h2 id="appearance-title">{COPY.appearanceHeading}</h2>
                <p>
                  {followsSystemTheme
                    ? COPY.appearanceFollowing(theme)
                    : COPY.appearanceUsing(theme)}
                </p>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={followsSystemTheme}
                  onClick={() => {
                    props.themeController.useSystemTheme();
                    setFollowsSystemTheme(true);
                  }}
                >
                  {followsSystemTheme ? COPY.usingDeviceSetting : COPY.useDeviceSetting}
                </button>
              </section>
              <details class="technical-details">
                <summary>{COPY.technicalDetails}</summary>
                <dl class="about-grid">
                  <div><dt>{COPY.aboutReleaseLabel}</dt><dd>{displayedReleaseId(props.releaseId)}</dd></div>
                  <div><dt>{COPY.analyzerLabel}</dt><dd>{ANALYZER_VERSION}</dd></div>
                  <div><dt>{COPY.aboutPslSnapshotLabel}</dt><dd>{ANALYZER_DATA_STATUS.publicSuffix.captured}</dd></div>
                  <div><dt>{COPY.aboutIanaSnapshotLabel}</dt><dd>{ANALYZER_DATA_STATUS.ianaSpecialPurpose.captured}</dd></div>
                  <div><dt>{COPY.aboutUnicodeLabel}</dt><dd>{ANALYZER_DATA_STATUS.unicodeSecurity.unicodeVersion}</dd></div>
                  <div><dt>{COPY.aboutCodeLicenseLabel}</dt><dd>AGPL-3.0-or-later</dd></div>
                  <div><dt>{COPY.aboutDataLicensesLabel}</dt><dd>MPL-2.0 · CC0-1.0 · Unicode-3.0</dd></div>
                  <div><dt>{COPY.aboutFingerprintLabel}</dt><dd><bdi>{releaseValue(props.signingFingerprint)}</bdi></dd></div>
                  <div><dt>{COPY.aboutPublicKeyLabel}</dt><dd><bdi>{releaseValue(props.signingPublicKey)}</bdi></dd></div>
                  <div><dt>{COPY.aboutDnsAnchorLabel}</dt><dd><bdi>{releaseValue(props.dnsKeyOwner)}</bdi></dd></div>
                  <div>
                    <dt>{COPY.aboutSourceLabel}</dt>
                    <dd class="source-repository">
                      {props.sourceRepository === null ? (
                        COPY.notConfiguredValue
                      ) : (
                        <bdi>
                          {sourceRepositorySegments(props.sourceRepository).map((segment) => (
                            <span class="repository-segment" key={segment}>
                              {segment}<wbr />
                            </span>
                          ))}
                        </bdi>
                      )}
                    </dd>
                  </div>
                </dl>
              </details>
              <button type="button" class="primary-button" onClick={goHome}>{COPY.backToScanner}</button>
            </article>
          );
        })() : null}

        {view.kind === "glossary" ? (
          <article class="prose-card" aria-busy={locked}>
            <p class="eyebrow">{COPY.glossaryEyebrow}</p>
            <h1 ref={viewHeadingRef} tabIndex={-1}>{COPY.glossaryTitle}</h1>
            <p class="lead">{COPY.glossaryLead}</p>
            <dl class="glossary-list">
              {SIGNAL_GLOSSARY_CODES.map((code) => (
                <div key={code}>
                  <dt>{SIGNAL_GLOSSARY[code].title}</dt>
                  <dd>{SIGNAL_GLOSSARY[code].explanation}</dd>
                </div>
              ))}
            </dl>
            <div class="prose-actions">
              <button
                type="button"
                class="secondary-button"
                onClick={() => navigateInfo("about")}
              >
                {COPY.backToAbout}
              </button>
              <button type="button" class="primary-button" onClick={goHome}>{COPY.backToScanner}</button>
            </div>
          </article>
        ) : null}

        {/*
          Always-mounted announcement region for copy results. The visible
          confirmations render beside the button that was clicked and stay
          out of the accessibility tree; the keyed span replaces its text
          node on every copy so repeat copies re-announce reliably.
        */}
        <p class="visually-hidden" role="status">
          {copyFeedback === null ? null : (
            <span key={copyFeedback.nonce}>
              {copyFeedbackText(copyFeedback.status)}
            </span>
          )}
        </p>
      </main>

      <footer>
        <p>{COPY.footerFacts}</p>
        <p>{COPY.footerLicense}</p>
      </footer>
    </div>
  );
}
