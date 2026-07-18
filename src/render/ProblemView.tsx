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
  const canChooseImage = problem.imageFallback === true;
  const isRecovery = problem.tone === "recovery";
  const dismissLabel = problem.dismissLabel ?? COPY.tryAnotherCode;

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
      {canResumeCamera || canRetryCamera ? (
        <div class="recovery-actions">
          <button
            type="button"
            class="primary-button"
            disabled={locked}
            onClick={onResumeCamera}
          >
            {canResumeCamera ? COPY.resumeScanning : COPY.retryCamera}
          </button>
          {canChooseImage ? (
            <>
              <button
                type="button"
                class="secondary-button"
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
          ) : (
            <button type="button" class="secondary-button" onClick={onDismiss}>
              {dismissLabel}
            </button>
          )}
        </div>
      ) : (
        <button type="button" class="primary-button" onClick={onDismiss}>
          {dismissLabel}
        </button>
      )}
    </section>
  );
}
