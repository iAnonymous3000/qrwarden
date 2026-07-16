import { describe, expect, it, vi } from "vitest";

import { ClipboardBroker } from "../../src/action/clipboard";
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
  const reports = new ReportStore<{ readonly actionPolicy: "inspect-only" }>();
  const active = reports.activate({ actionPolicy: "inspect-only" });
  const onStatus = vi.fn();
  let workGeneration = 1;
  const broker = new ClipboardBroker({
    reports,
    getWorkGeneration: () => workGeneration,
    onStatus,
  });
  return {
    active,
    broker,
    onStatus,
    reports,
    advanceWork: () => {
      workGeneration += 1;
    },
  };
}

describe("clipboard action lifetime", () => {
  it("keeps the runtime busy until a trusted write settles", async () => {
    let resolve!: () => void;
    const write = new Promise<void>((done) => {
      resolve = done;
    });
    const { active, broker, onStatus } = setup(() => write);

    broker.copy({ isTrusted: true } as MouseEvent, active, "reviewed value");
    expect(broker.busy).toBe(true);
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
    const { active, broker, onStatus } = setup(() => write);

    broker.copy({ isTrusted: true } as MouseEvent, active, "reviewed value");
    broker.invalidate();
    resolve();
    await write;
    await Promise.resolve();

    expect(broker.busy).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("maps a synchronous clipboard exception to failure", () => {
    const { active, broker, onStatus } = setup(() => {
      throw new DOMException("denied", "NotAllowedError");
    });

    broker.copy({ isTrusted: true } as MouseEvent, active, "reviewed value");

    expect(broker.busy).toBe(false);
    expect(onStatus).toHaveBeenCalledWith("failed");
  });

  it("ignores settlement after the reviewed report is replaced", async () => {
    const write = deferred();
    const { active, broker, onStatus, reports } = setup(() => write.promise);

    broker.copy({ isTrusted: true } as MouseEvent, active, "reviewed value");
    reports.activate({ actionPolicy: "inspect-only" });
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
    const { active, broker, onStatus } = setup(writeText);

    broker.copy({ isTrusted: true } as MouseEvent, active, "first value");
    broker.copy({ isTrusted: true } as MouseEvent, active, "second value");
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
    const { active, broker, onStatus, reports, advanceWork } = setup(
      () => write.promise,
    );

    broker.copy({ isTrusted: true } as MouseEvent, active, "reviewed value");
    advanceWork();
    broker.invalidate();
    reports.drop();
    write.reject(new DOMException("page hidden", "AbortError"));
    await flushPromiseHandlers(write.promise);

    expect(broker.busy).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });
});
