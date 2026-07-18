import { describe, expect, it } from "vitest";

import {
  bufferShareIntake,
  canConsumeShare,
  SHARE_INTAKE_MAX_BUFFERED,
  SHARE_INTAKE_MAX_DELIVERIES,
  shareRejectionProblem,
  type ShareIntakeEntry,
} from "../../src/app/shareIntake";
import {
  shareAdmissionBusyLocation,
  shareAdmissionRejectionFromUrl,
} from "../../src/sw/shareToken";

function imageEntry(name: string): ShareIntakeEntry {
  return {
    kind: "image",
    file: new File([new Uint8Array([1])], name, { type: "image/png" }),
  };
}

describe("share intake buffering", () => {
  it("retains four arrivals in order and represents later overflow visibly", () => {
    let entries: readonly ShareIntakeEntry[] = [];
    for (let index = 0; index < SHARE_INTAKE_MAX_DELIVERIES + 2; index += 1) {
      entries = bufferShareIntake(entries, imageEntry(`share-${index}.png`));
    }

    expect(entries).toHaveLength(SHARE_INTAKE_MAX_BUFFERED);
    expect(
      entries
        .slice(0, SHARE_INTAKE_MAX_DELIVERIES)
        .map((entry) => entry.kind === "image" ? entry.file.name : ""),
    ).toEqual(["share-0.png", "share-1.png", "share-2.png", "share-3.png"]);
    expect(entries.at(-1)).toEqual({ kind: "rejected", reason: "busy" });
  });

  it("buffers rejections through the same bounded queue", () => {
    const entries = bufferShareIntake([], {
      kind: "rejected",
      reason: "too-large",
    });
    expect(entries).toEqual([{ kind: "rejected", reason: "too-large" }]);
  });

  it("coalesces busy at every occupancy and refills a consumed delivery slot", () => {
    const busy = { kind: "rejected", reason: "busy" } as const;
    expect(bufferShareIntake([], busy)).toEqual([busy]);
    expect(bufferShareIntake([busy], busy)).toEqual([busy]);
    expect(bufferShareIntake([imageEntry("one.png"), busy], busy)).toEqual([
      imageEntry("one.png"),
      busy,
    ]);

    let full: readonly ShareIntakeEntry[] = [];
    for (let index = 0; index < SHARE_INTAKE_MAX_DELIVERIES + 1; index += 1) {
      full = bufferShareIntake(full, imageEntry(`share-${index}.png`));
    }
    const refilled = bufferShareIntake(
      full.slice(1),
      imageEntry("refill.png"),
    );
    expect(
      refilled
        .filter((entry) => entry.kind === "image")
        .map((entry) => entry.file.name),
    ).toEqual(["share-1.png", "share-2.png", "share-3.png", "refill.png"]);
    expect(refilled.at(-1)).toEqual(busy);
    expect(refilled).toHaveLength(SHARE_INTAKE_MAX_BUFFERED);
  });
});

describe("share rejection reasons", () => {
  it("maps every reason onto dedicated share recovery problems", () => {
    expect(shareRejectionProblem("busy")).toBe("share-busy");
    expect(shareRejectionProblem("multiple-files")).toBe("share-multiple-files");
    expect(shareRejectionProblem("too-large")).toBe("share-too-large");
    expect(shareRejectionProblem("unsupported-type")).toBe(
      "share-unsupported-type",
    );
    expect(shareRejectionProblem("unreadable")).toBe("share-unreadable");
  });
});

describe("share admission redirect", () => {
  it("accepts only the exact worker-issued busy marker", () => {
    expect(shareAdmissionBusyLocation()).toBe("/?share-rejected=busy");
    expect(
      shareAdmissionRejectionFromUrl(
        new URL("https://qrwarden.test/?share-rejected=busy"),
      ),
    ).toBe("busy");
    for (const url of [
      "https://qrwarden.test/?share-rejected",
      "https://qrwarden.test/?share-rejected=BUSY",
      "https://qrwarden.test/?share-rejected=busy&extra=1",
      "https://qrwarden.test/?share-rejected=busy&share-rejected=busy",
    ]) {
      expect(shareAdmissionRejectionFromUrl(new URL(url))).toBeNull();
    }
  });
});

describe("share consumption gating", () => {
  it("only consumes on an unlocked, shown home view", () => {
    expect(canConsumeShare(false, "home", "visible")).toBe(true);
    expect(canConsumeShare(true, "home", "visible")).toBe(false);
    expect(canConsumeShare(false, "result", "visible")).toBe(false);
    // A hidden document must not resume decoding a shared image.
    expect(canConsumeShare(false, "home", "hidden")).toBe(false);
  });
});
