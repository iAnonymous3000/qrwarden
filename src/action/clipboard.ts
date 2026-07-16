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
    this.#copyGeneration += 1;
    const copyGeneration = this.#copyGeneration;
    const reportGeneration = this.#reports.generation;
    const workGeneration = this.#getWorkGeneration();

    const live = this.#reports.active;
    if (
      this.#isLocked() ||
      !clickIsLive(event) ||
      live === null ||
      !this.#reports.isLive(candidate) ||
      !live.report.displayFields.includes(reviewedField) ||
      typeof reviewedField.actionValue !== "string" ||
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
      write = navigator.clipboard.writeText(reviewedField.actionValue);
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
