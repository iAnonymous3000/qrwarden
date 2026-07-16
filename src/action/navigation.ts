import {
  type ActiveReport,
  type ReportForActions,
  ReportStore,
} from "../app/reportState";

const openConfirmationBrand: unique symbol = Symbol(
  "qrwarden.open-confirmation",
);

export interface OpenConfirmation<
  Report extends ReportForActions = ReportForActions,
> {
  readonly [openConfirmationBrand]: true;
  readonly reportGeneration: number;
  readonly confirmationGeneration: number;
  readonly activeReport: ActiveReport<Report>;
}

export type NavigationFailure = "link-changed";

function hasLiveUserActivation(): boolean {
  if (!("userActivation" in navigator) || navigator.userActivation === null) {
    return true;
  }
  return navigator.userActivation.isActive;
}

export class NavigationBroker<Report extends ReportForActions> {
  readonly #reports: ReportStore<Report>;
  readonly #onFailure: (failure: NavigationFailure) => void;
  #generation = 0;
  #liveConfirmation: OpenConfirmation<Report> | null = null;

  constructor(
    reports: ReportStore<Report>,
    onFailure: (failure: NavigationFailure) => void,
  ) {
    this.#reports = reports;
    this.#onFailure = onFailure;
  }

  get confirmation(): OpenConfirmation<Report> | null {
    return this.#liveConfirmation;
  }

  beginConfirmation(
    event: MouseEvent,
    candidate: ActiveReport<Report>,
  ): OpenConfirmation<Report> | null {
    if (
      !event.isTrusted ||
      !hasLiveUserActivation() ||
      !this.#reports.isLive(candidate) ||
      candidate.report.actionPolicy !== "confirm-web" ||
      candidate.report.canonicalHref === undefined
    ) {
      this.#fail();
      return null;
    }

    this.#generation += 1;
    const confirmation = Object.freeze({
      [openConfirmationBrand]: true as const,
      reportGeneration: this.#reports.generation,
      confirmationGeneration: this.#generation,
      activeReport: candidate,
    });
    this.#liveConfirmation = confirmation;
    return confirmation;
  }

  clearConfirmation(): void {
    this.#generation += 1;
    this.#liveConfirmation = null;
  }

  openReviewedLink(
    event: MouseEvent,
    candidate: ActiveReport<Report>,
    confirmation: OpenConfirmation<Report> | null,
  ): void {
    const live = this.#reports.active;
    if (
      live === null ||
      candidate !== live ||
      candidate.generation !== this.#reports.generation ||
      candidate.report !== live.report ||
      (live.report.actionPolicy !== "open-web" &&
        live.report.actionPolicy !== "confirm-web") ||
      live.report.canonicalHref === undefined
    ) {
      this.#fail();
      return;
    }

    if (live.report.actionPolicy === "open-web" && confirmation !== null) {
      this.#fail();
      return;
    }

    if (
      live.report.actionPolicy === "confirm-web" &&
      (confirmation === null ||
        this.#liveConfirmation === null ||
        confirmation !== this.#liveConfirmation ||
        confirmation.activeReport !== live ||
        confirmation.reportGeneration !== this.#reports.generation ||
        confirmation.confirmationGeneration !== this.#generation)
    ) {
      this.#fail();
      return;
    }

    if (!event.isTrusted || !hasLiveUserActivation()) {
      this.#fail();
      return;
    }

    const expectedHref = live.report.canonicalHref;
    let parsed: URL;
    try {
      parsed = new URL(expectedHref);
    } catch {
      this.#fail();
      return;
    }

    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.hostname.length === 0 ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.href !== expectedHref
    ) {
      this.#fail();
      return;
    }

    const anchor = document.createElement("a");
    try {
      anchor.href = parsed.href;
      if (anchor.href !== expectedHref) {
        this.#fail();
        return;
      }
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.hidden = true;

      if (
        live.report.actionPolicy === "confirm-web" &&
        !this.#consumeConfirmation(confirmation)
      ) {
        this.#fail();
        return;
      }

      document.body.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
    }
  }

  #consumeConfirmation(
    confirmation: OpenConfirmation<Report> | null,
  ): boolean {
    if (
      confirmation === null ||
      this.#liveConfirmation === null ||
      confirmation !== this.#liveConfirmation
    ) {
      return false;
    }
    this.clearConfirmation();
    return true;
  }

  #fail(): void {
    this.clearConfirmation();
    this.#onFailure("link-changed");
  }
}
