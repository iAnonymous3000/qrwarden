import {
  type ActiveReport,
  type ReportForActions,
  ReportStore,
} from "../app/reportState";

export type ClipboardStatus = "copied" | "failed";

export interface ClipboardActionField {
  readonly actionValue: string;
}

export interface ReportForClipboardActions extends ReportForActions {
  readonly displayFields: readonly ClipboardActionField[];
}

export interface ClipboardBrokerOptions<Report extends ReportForClipboardActions> {
  readonly reports: ReportStore<Report>;
  readonly getWorkGeneration: () => number;
  readonly isLocked: () => boolean;
  readonly onStatus: (status: ClipboardStatus) => void;
}

function clickIsLive(event: MouseEvent): boolean {
  if (!event.isTrusted) {
    return false;
  }
  return !(
    "userActivation" in navigator &&
    navigator.userActivation !== null &&
    !navigator.userActivation.isActive
  );
}

export class ClipboardBroker<Report extends ReportForClipboardActions> {
  readonly #reports: ReportStore<Report>;
  readonly #getWorkGeneration: () => number;
  readonly #isLocked: () => boolean;
  readonly #onStatus: (status: ClipboardStatus) => void;
  #copyGeneration = 0;
  #pendingCopies = 0;

  constructor(options: ClipboardBrokerOptions<Report>) {
    this.#reports = options.reports;
    this.#getWorkGeneration = options.getWorkGeneration;
    this.#isLocked = options.isLocked;
    this.#onStatus = options.onStatus;
  }

  invalidate(): void {
    this.#copyGeneration += 1;
  }

  get busy(): boolean {
    return this.#pendingCopies > 0;
  }

  copy(
    event: MouseEvent,
    candidate: ActiveReport<Report>,
    reviewedField: Report["displayFields"][number],
  ): void {
    this.#copyValue(event, candidate, (live) =>
      live.displayFields.includes(reviewedField) &&
      typeof reviewedField.actionValue === "string"
        ? reviewedField.actionValue
        : null,
    );
  }

  /**
   * Copies a plain-text rendering of the live report. The renderer runs only
   * after every liveness guard passes and receives the live report, so the
   * copied text can never describe a superseded result.
   */
  copyReport(
    event: MouseEvent,
    candidate: ActiveReport<Report>,
    renderReport: (report: Report) => string,
  ): void {
    this.#copyValue(event, candidate, (live) => {
      try {
        return renderReport(live);
      } catch {
        return null;
      }
    });
  }

  #copyValue(
    event: MouseEvent,
    candidate: ActiveReport<Report>,
    resolveValue: (live: Report) => string | null,
  ): void {
    this.#copyGeneration += 1;
    const copyGeneration = this.#copyGeneration;
    const reportGeneration = this.#reports.generation;
    const workGeneration = this.#getWorkGeneration();

    const live = this.#reports.active;
    const value =
      live !== null &&
      !this.#isLocked() &&
      clickIsLive(event) &&
      this.#reports.isLive(candidate)
        ? resolveValue(live.report)
        : null;
    if (
      value === null ||
      typeof navigator.clipboard?.writeText !== "function"
    ) {
      this.#settle(
        "failed",
        candidate,
        copyGeneration,
        reportGeneration,
        workGeneration,
      );
      return;
    }

    let write: Promise<void>;
    try {
      write = navigator.clipboard.writeText(value);
    } catch {
      this.#settle(
        "failed",
        candidate,
        copyGeneration,
        reportGeneration,
        workGeneration,
      );
      return;
    }
    this.#pendingCopies += 1;
    void write.then(
      () => {
        this.#settle(
          "copied",
          candidate,
          copyGeneration,
          reportGeneration,
          workGeneration,
        );
      },
      () => {
        this.#settle(
          "failed",
          candidate,
          copyGeneration,
          reportGeneration,
          workGeneration,
        );
      },
    ).finally(() => {
      this.#pendingCopies -= 1;
    });
  }

  #settle(
    status: ClipboardStatus,
    candidate: ActiveReport<Report>,
    copyGeneration: number,
    reportGeneration: number,
    workGeneration: number,
  ): void {
    if (
      copyGeneration !== this.#copyGeneration ||
      reportGeneration !== this.#reports.generation ||
      workGeneration !== this.#getWorkGeneration() ||
      !this.#reports.isLive(candidate)
    ) {
      return;
    }
    this.#onStatus(status);
  }
}
