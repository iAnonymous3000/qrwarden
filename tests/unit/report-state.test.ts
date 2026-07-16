import { describe, expect, it, vi } from "vitest";

import { NavigationBroker } from "../../src/action/navigation";
import { ReportStore } from "../../src/app/reportState";

describe("active report identity", () => {
  it("invalidates prior objects when a report is replaced or dropped", () => {
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const first = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/",
    });
    expect(reports.isLive(first)).toBe(true);
    reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.org/",
    });
    expect(reports.isLive(first)).toBe(false);
    reports.drop();
    expect(reports.active).toBeNull();
  });

  it("rejects synthetic navigation events", () => {
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed);
    broker.openReviewedLink({ isTrusted: false } as MouseEvent, active, null);
    expect(failed).toHaveBeenCalledWith("link-changed");
  });

  it("cannot revive an old activation by reusing the same report object", () => {
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const report = {
      actionPolicy: "open-web" as const,
      canonicalHref: "https://example.com/",
    };

    const first = reports.activate(report);
    const second = reports.activate(report);

    expect(Object.isFrozen(first)).toBe(true);
    expect(second).not.toBe(first);
    expect(reports.isLive(first)).toBe(false);
    expect(reports.isLive(second)).toBe(true);
  });

  it("rejects a structurally identical forged activation", () => {
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/",
    });
    const forged = { ...active } as typeof active;

    expect(forged).toEqual(active);
    expect(reports.isLive(forged)).toBe(false);
    expect(reports.isLive(active)).toBe(true);
  });

  it("advances the lifetime even when an already-empty store is dropped", () => {
    const reports = new ReportStore();
    const initial = reports.generation;

    reports.drop();
    reports.drop();

    expect(reports.active).toBeNull();
    expect(reports.generation).toBe(initial + 2);
  });

  it("invalidates confirmations when their report lifetime is replaced", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const reports = new ReportStore<{
      actionPolicy: "confirm-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "confirm-web",
      canonicalHref: "https://example.com/",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed);
    const confirmation = broker.beginConfirmation(
      { isTrusted: true } as MouseEvent,
      active,
    );
    reports.activate({
      actionPolicy: "confirm-web",
      canonicalHref: "https://example.org/",
    });

    broker.openReviewedLink(
      { isTrusted: true } as MouseEvent,
      active,
      confirmation,
    );

    expect(failed).toHaveBeenCalledWith("link-changed");
    expect(broker.confirmation).toBeNull();
  });

  it("does not let an earlier confirmation survive a second confirmation", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const reports = new ReportStore<{
      actionPolicy: "confirm-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "confirm-web",
      canonicalHref: "https://example.com/",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed);
    const first = broker.beginConfirmation(
      { isTrusted: true } as MouseEvent,
      active,
    );
    const second = broker.beginConfirmation(
      { isTrusted: true } as MouseEvent,
      active,
    );

    expect(second).not.toBe(first);
    broker.openReviewedLink({ isTrusted: true } as MouseEvent, active, first);

    expect(failed).toHaveBeenCalledWith("link-changed");
    expect(broker.confirmation).toBeNull();
  });
});
