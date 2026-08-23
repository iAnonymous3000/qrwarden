import { useRef } from "preact/hooks";
import type { RefObject } from "preact";

import { PROBLEM_COPY, type ProblemCode } from "../app/problems";
import { COPY } from "../copy";

interface ProblemViewProps {
  readonly problemCode: ProblemCode;
  readonly braveIos: boolean;
  readonly locked: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement>;
  readonly onResumeCamera: () => void;
  readonly onChooseImages: (files: readonly File[]) => void;
  readonly onDismiss: () => void;
}

export function ProblemView({
  problemCode,
  braveIos,
  locked,
  headingRef,
  onResumeCamera,
  onChooseImages,
  onDismiss,
}: ProblemViewProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const problem = PROBLEM_COPY[problemCode];
  const canResumeCamera = problem.primaryAction === "resume-camera";
  const canRetryCamera = problem.primaryAction === "retry-camera";
  const hasCameraAction = canResumeCamera || canRetryCamera;
  const canChooseImage = problem.imageFallback === true;
  const isRecovery = problem.tone === "recovery";
  const dismissLabel = problem.dismissLabel ?? COPY.tryAnotherCode;

  // Every image-sourced failure tells the reader to try another image
  // ("Choose the image again to continue", "Try a sharper image"). Before,
  // `imageFallback` was only honoured beside a camera restart, so those views
  // offered one button that returned home and the instruction named an action
  // the screen did not have. The picker is now reachable without a camera
  // action, and the dismiss control stays so the recovery contract in
  // tests/browser/failure-views.spec.ts still holds.
  const imagePicker = canChooseImage ? (
    <>
      <button
        type="button"
        class={hasCameraAction ? "secondary-button" : "primary-button"}
        disabled={locked}
        onClick={() => imageInputRef.current?.click()}
      >
        {COPY.chooseImage}
      </button>
      <input
        ref={imageInputRef}
        class="visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept="image/jpeg,image/png,image/webp"
        disabled={locked}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          onChooseImages(files);
        }}
      />
    </>
  ) : null;

  const dismissButton = (
    <button
      type="button"
      class={hasCameraAction || canChooseImage ? "secondary-button" : "primary-button"}
      disabled={locked}
      onClick={onDismiss}
    >
      {dismissLabel}
    </button>
  );

  return (
    <section
      class={`center-card ${isRecovery ? "recovery-card" : "error-card"}`}
      role="alert"
    >
      <span class={isRecovery ? "recovery-glyph" : "error-glyph"} aria-hidden="true">
        {canResumeCamera ? "↻" : isRecovery ? "i" : "!"}
      </span>
      <h1 ref={headingRef} tabIndex={-1}>{problem.heading}</h1>
      <p>{problem.body}</p>
      {problemCode === "camera-access-needed" && braveIos ? (
        <p>{COPY.braveIosCameraBody}</p>
      ) : null}
      {hasCameraAction ? (
        <div class="recovery-actions">
          <button
            type="button"
            class="primary-button"
            disabled={locked}
            onClick={onResumeCamera}
          >
            {canResumeCamera ? COPY.resumeScanning : COPY.retryCamera}
          </button>
          {canChooseImage ? imagePicker : dismissButton}
        </div>
      ) : canChooseImage ? (
        <div class="recovery-actions">
          {imagePicker}
          {dismissButton}
        </div>
      ) : (
        dismissButton
      )}
    </section>
  );
}
