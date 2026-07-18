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
    const broker = new NavigationBroker(reports, failed, () => false);
    broker.openReviewedLink({ isTrusted: false } as MouseEvent, active, null);
    expect(failed).toHaveBeenCalledWith("link-changed");
  });

  it("rejects trusted navigation after live user activation expires", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed, () => false);

    broker.openReviewedLink({ isTrusted: true } as MouseEvent, active, null);

    expect(createElement).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith("link-changed");
  });

  it("preserves trusted unlocked navigation to the reviewed canonical URL", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const anchor = {
      href: "",
      target: "",
      rel: "",
      referrerPolicy: "",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/reviewed",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed, () => false);

    broker.openReviewedLink({ isTrusted: true } as MouseEvent, active, null);

    expect(append).toHaveBeenCalledExactlyOnceWith(anchor);
    expect(anchor).toMatchObject({
      href: "https://example.com/reviewed",
      target: "_blank",
      rel: "noopener noreferrer",
      referrerPolicy: "no-referrer",
      hidden: true,
    });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
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
    const broker = new NavigationBroker(reports, failed, () => false);
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
    const broker = new NavigationBroker(reports, failed, () => false);
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

  it("fails closed when confirmation is requested after the app locks", () => {
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
    let locked = false;
    const broker = new NavigationBroker(reports, failed, () => locked);
    locked = true;

    expect(
      broker.beginConfirmation({ isTrusted: true } as MouseEvent, active),
    ).toBeNull();
    expect(failed).toHaveBeenCalledExactlyOnceWith("locked");
    expect(broker.confirmation).toBeNull();
  });

  it("does not create a navigation sink for a locked open-web action", () => {
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    const reports = new ReportStore<{
      actionPolicy: "open-web";
      canonicalHref: string;
    }>();
    const active = reports.activate({
      actionPolicy: "open-web",
      canonicalHref: "https://example.com/",
    });
    const failed = vi.fn();
    const broker = new NavigationBroker(reports, failed, () => true);

    broker.openReviewedLink({ isTrusted: true } as MouseEvent, active, null);

    expect(createElement).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith("locked");
  });

  it("invalidates a live confirmation if the app locks before opening", () => {
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
    let locked = false;
    const broker = new NavigationBroker(reports, failed, () => locked);
    const confirmation = broker.beginConfirmation(
      { isTrusted: true } as MouseEvent,
      active,
    );
    expect(confirmation).not.toBeNull();
    locked = true;

    broker.openReviewedLink(
      { isTrusted: true } as MouseEvent,
      active,
      confirmation,
    );

    expect(failed).toHaveBeenCalledExactlyOnceWith("locked");
    expect(broker.confirmation).toBeNull();
  });
});
