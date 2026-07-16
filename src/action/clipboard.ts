import {
  type ActiveReport,
  type ReportForActions,
  ReportStore,
} from "../app/reportState";

export type ClipboardStatus = "copied" | "failed";

export interface ClipboardBrokerOptions<Report extends ReportForActions> {
  readonly reports: ReportStore<Report>;
  readonly getWorkGeneration: () => number;
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

export class ClipboardBroker<Report extends ReportForActions> {
  readonly #reports: ReportStore<Report>;
  readonly #getWorkGeneration: () => number;
  readonly #onStatus: (status: ClipboardStatus) => void;
  #copyGeneration = 0;
  #pendingCopies = 0;

  constructor(options: ClipboardBrokerOptions<Report>) {
    this.#reports = options.reports;
    this.#getWorkGeneration = options.getWorkGeneration;
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
    reviewedValue: string,
  ): void {
    this.#copyGeneration += 1;
    const copyGeneration = this.#copyGeneration;
    const reportGeneration = this.#reports.generation;
    const workGeneration = this.#getWorkGeneration();

    if (
      !clickIsLive(event) ||
      !this.#reports.isLive(candidate) ||
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
      write = navigator.clipboard.writeText(reviewedValue);
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
