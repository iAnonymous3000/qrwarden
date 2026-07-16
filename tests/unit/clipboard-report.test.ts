import { describe, expect, it, vi } from "vitest";

import { ClipboardBroker } from "../../src/action/clipboard";
import { ReportStore } from "../../src/app/reportState";

function setup(writeText: (value: string) => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const reports = new ReportStore<{
    readonly actionPolicy: "inspect-only";
    readonly displayFields: readonly { readonly actionValue: string }[];
    readonly label: string;
  }>();
  const active = reports.activate({
    actionPolicy: "inspect-only",
    displayFields: Object.freeze([]),
    label: "live-report",
  });
  const onStatus = vi.fn();
  let locked = false;
  const broker = new ClipboardBroker({
    reports,
    getWorkGeneration: () => 1,
    isLocked: () => locked,
    onStatus,
  });
  return {
    active,
    broker,
    onStatus,
    reports,
    setLocked: (next: boolean) => {
      locked = next;
    },
  };
}

describe("clipboard report copies", () => {
  it("renders from the live report only after guards pass", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, onStatus } = setup(writeText);
    const render = vi.fn(
      (report: { readonly label: string }) => `report:${report.label}`,
    );

    broker.copyReport({ isTrusted: true } as MouseEvent, active, render);
    await Promise.resolve();
    await Promise.resolve();

    expect(render).toHaveBeenCalledWith(active.report);
    expect(writeText).toHaveBeenCalledWith("report:live-report");
    expect(onStatus).toHaveBeenCalledWith("copied");
  });

  it("does not render or write for untrusted events", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, onStatus } = setup(writeText);
    const render = vi.fn(() => "unreachable");

    broker.copyReport({ isTrusted: false } as MouseEvent, active, render);

    expect(render).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("failed");
  });

  it("does not render or write while locked or for superseded reports", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, onStatus, reports, setLocked } = setup(writeText);
    const render = vi.fn(() => "unreachable");

    setLocked(true);
    broker.copyReport({ isTrusted: true } as MouseEvent, active, render);
    setLocked(false);
    reports.activate({
      actionPolicy: "inspect-only",
      displayFields: Object.freeze([]),
      label: "newer-report",
    });
    broker.copyReport({ isTrusted: true } as MouseEvent, active, render);

    expect(render).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenNthCalledWith(1, "failed");
  });

  it("fails closed when the renderer throws", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, onStatus } = setup(writeText);

    broker.copyReport({ isTrusted: true } as MouseEvent, active, () => {
      throw new Error("render failure");
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("failed");
  });
});
