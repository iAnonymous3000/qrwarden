export type ActionPolicy = "open-web" | "confirm-web" | "inspect-only";

export interface ReportForActions {
  readonly actionPolicy: ActionPolicy;
  readonly canonicalHref?: string;
}

const activeReportBrand: unique symbol = Symbol("qrwarden.active-report");

export interface ActiveReport<
  Report extends ReportForActions = ReportForActions,
> {
  readonly [activeReportBrand]: true;
  readonly generation: number;
  readonly report: Report;
}

export class ReportStore<Report extends ReportForActions = ReportForActions> {
  #generation = 0;
  #active: ActiveReport<Report> | null = null;

  get generation(): number {
    return this.#generation;
  }

  get active(): ActiveReport<Report> | null {
    return this.#active;
  }

  activate(report: Report): ActiveReport<Report> {
    this.#generation += 1;
    const active = Object.freeze({
      [activeReportBrand]: true as const,
      generation: this.#generation,
      report,
    });
    this.#active = active;
    return active;
  }

  drop(): void {
    this.#generation += 1;
    this.#active = null;
  }

  isLive(candidate: ActiveReport<Report>): boolean {
    return (
      this.#active !== null &&
      candidate === this.#active &&
      candidate.generation === this.#generation &&
      candidate.report === this.#active.report
    );
  }
}
