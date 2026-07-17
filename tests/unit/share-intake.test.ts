import { describe, expect, it } from "vitest";

import {
  bufferShareIntake,
  canConsumeShare,
  SHARE_INTAKE_MAX_BUFFERED,
  shareRejectionProblem,
  shareRejectionReason,
  type ShareIntakeEntry,
} from "../../src/app/shareIntake";

function imageEntry(name: string): ShareIntakeEntry {
  return {
    kind: "image",
    file: new File([new Uint8Array([1])], name, { type: "image/png" }),
  };
}

describe("share intake buffering", () => {
  it("appends in arrival order and refuses entries beyond the bound", () => {
    let entries: readonly ShareIntakeEntry[] = [];
    for (let index = 0; index < SHARE_INTAKE_MAX_BUFFERED + 2; index += 1) {
      entries = bufferShareIntake(entries, imageEntry(`share-${index}.png`));
    }

    expect(entries).toHaveLength(SHARE_INTAKE_MAX_BUFFERED);
    // Fail closed: the newest entry is refused, never an older one replaced.
    expect(entries.map((entry) => entry.kind === "image" ? entry.file.name : "")).toEqual([
      "share-0.png",
      "share-1.png",
      "share-2.png",
      "share-3.png",
    ]);
  });

  it("buffers rejections through the same bounded queue", () => {
    const entries = bufferShareIntake([], {
      kind: "rejected",
      reason: "too-large",
    });
    expect(entries).toEqual([{ kind: "rejected", reason: "too-large" }]);
  });
});

describe("share rejection reasons", () => {
  it("coerces unknown worker-message reasons to unreadable", () => {
    expect(shareRejectionReason("too-large")).toBe("too-large");
    expect(shareRejectionReason("multiple-files")).toBe("multiple-files");
    expect(shareRejectionReason("unsupported-type")).toBe("unsupported-type");
    expect(shareRejectionReason("unreadable")).toBe("unreadable");
    expect(shareRejectionReason("surprising")).toBe("unreadable");
    expect(shareRejectionReason(undefined)).toBe("unreadable");
    expect(shareRejectionReason(42)).toBe("unreadable");
  });

  it("maps every reason onto existing localized intake problems", () => {
    expect(shareRejectionProblem("multiple-files")).toBe("choose-one-image");
    expect(shareRejectionProblem("too-large")).toBe("image-too-large");
    expect(shareRejectionProblem("unsupported-type")).toBe(
      "unsupported-image-type",
    );
    expect(shareRejectionProblem("unreadable")).toBe("image-unreadable");
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
