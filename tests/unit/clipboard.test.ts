import { describe, expect, it, vi } from "vitest";

import { ClipboardBroker } from "../../src/action/clipboard";
import { ANALYZER_LIMITS, analyzeText } from "../../src/analyzer";
import { ReportStore } from "../../src/app/reportState";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromiseHandlers(promise: Promise<void>): Promise<void> {
  await promise.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
}

function setup(writeText: (value: string) => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const field = Object.freeze({
    id: "reviewed",
    value: "[U+202E]display value",
    actionValue: "\u202Ereviewed value",
  });
  const reports = new ReportStore<{
    readonly actionPolicy: "inspect-only";
    readonly displayFields: readonly (typeof field)[];
  }>();
  const active = reports.activate({
    actionPolicy: "inspect-only",
    displayFields: Object.freeze([field]),
  });
  const onStatus = vi.fn();
  let workGeneration = 1;
  let locked = false;
  const broker = new ClipboardBroker({
    reports,
    getWorkGeneration: () => workGeneration,
    isLocked: () => locked,
    onStatus,
  });
  return {
    active,
    broker,
    field,
    onStatus,
    reports,
    advanceWork: () => {
      workGeneration += 1;
    },
    setLocked: (next: boolean) => {
      locked = next;
    },
  };
}

describe("clipboard action lifetime", () => {
  it("copies the exact analyzer action value rather than escaped or truncated display text", () => {
    const source = `before\u202Eafter${"x".repeat(ANALYZER_LIMITS.fieldScalars + 5)}`;
    const report = analyzeText(source);
    const reviewedField = report.displayFields.find((field) => field.id === "text");
    expect(reviewedField).toBeDefined();
    expect(reviewedField?.value).not.toBe(source);

    const reports = new ReportStore<typeof report>();
    const active = reports.activate(report);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const broker = new ClipboardBroker({
      reports,
      getWorkGeneration: () => 1,
      isLocked: () => false,
      onStatus: vi.fn(),
    });

    broker.copy({ isTrusted: true } as MouseEvent, active, reviewedField!);

    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("copies an exact near-limit Wi-Fi password after its display value is escaped", () => {
    const password = `${"x".repeat(ANALYZER_LIMITS.fieldScalars - 8)}\u202Esecret`;
    const report = analyzeText(`WIFI:S:network;T:WPA;P:${password};;`);
    const reviewedField = report.displayFields.find((field) => field.id === "password");
    expect(reviewedField).toMatchObject({ sensitive: true, truncated: true });
    expect(reviewedField?.value).not.toBe(password);

    const reports = new ReportStore<typeof report>();
    const active = reports.activate(report);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const broker = new ClipboardBroker({
      reports,
      getWorkGeneration: () => 1,
      isLocked: () => false,
      onStatus: vi.fn(),
    });

    broker.copy({ isTrusted: true } as MouseEvent, active, reviewedField!);

    expect(writeText).toHaveBeenCalledExactlyOnceWith(password);
  });

  it("keeps the runtime busy until a trusted write settles", async () => {
    let resolve!: () => void;
    const write = new Promise<void>((done) => {
      resolve = done;
    });
    const writeText = vi.fn(() => write);
    const { active, broker, field, onStatus } = setup(writeText);

    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    expect(broker.busy).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("\u202Ereviewed value");
    resolve();
    await write;
    await Promise.resolve();

    expect(broker.busy).toBe(false);
    expect(onStatus).toHaveBeenCalledWith("copied");
  });

  it("ignores a stale settlement after invalidation", async () => {
    let resolve!: () => void;
    const write = new Promise<void>((done) => {
      resolve = done;
    });
    const { active, broker, field, onStatus } = setup(() => write);

    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    broker.invalidate();
    resolve();
    await write;
    await Promise.resolve();

    expect(broker.busy).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("maps a synchronous clipboard exception to failure", () => {
    const { active, broker, field, onStatus } = setup(() => {
      throw new DOMException("denied", "NotAllowedError");
    });

    broker.copy({ isTrusted: true } as MouseEvent, active, field);

    expect(broker.busy).toBe(false);
    expect(onStatus).toHaveBeenCalledWith("failed");
  });

  it("ignores settlement after the reviewed report is replaced", async () => {
    const write = deferred();
    const { active, broker, field, onStatus, reports } = setup(() => write.promise);

    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    reports.activate({
      actionPolicy: "inspect-only",
      displayFields: Object.freeze([field]),
    });
    write.resolve();
    await flushPromiseHandlers(write.promise);

    expect(broker.busy).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("allows only the newest of two pending copies to report status", async () => {
    const first = deferred();
    const second = deferred();
    const writeText = vi
      .fn<(value: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { active, broker, field, onStatus } = setup(writeText);

    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    expect(broker.busy).toBe(true);

    second.resolve();
    await flushPromiseHandlers(second.promise);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith("copied");
    expect(broker.busy).toBe(true);

    first.resolve();
    await flushPromiseHandlers(first.promise);
    expect(broker.busy).toBe(false);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("suppresses a late rejection after pagehide-style invalidation", async () => {
    const write = deferred();
    const { active, broker, field, onStatus, reports, advanceWork } = setup(
      () => write.promise,
    );

    broker.copy({ isTrusted: true } as MouseEvent, active, field);
    advanceWork();
    broker.invalidate();
    reports.drop();
    write.reject(new DOMException("page hidden", "AbortError"));
    await flushPromiseHandlers(write.promise);

    expect(broker.busy).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("rejects a structurally identical field that is not in the live report", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, field, onStatus } = setup(writeText);
    const forged = { ...field };

    broker.copy({ isTrusted: true } as MouseEvent, active, forged);

    expect(writeText).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("fails closed if the app locks after render but before the copy handler runs", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { active, broker, field, onStatus, setLocked } = setup(writeText);
    setLocked(true);

    broker.copy({ isTrusted: true } as MouseEvent, active, field);

    expect(writeText).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledExactlyOnceWith("failed");
    expect(broker.busy).toBe(false);
  });
});
