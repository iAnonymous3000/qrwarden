import { describe, expect, it } from "vitest";

import {
  UNICODE_DATA_METADATA,
  bidiClass,
  bidiMirror,
  canonicalCombiningClass,
  canonicalComposition,
  canonicalDecomposition,
  confusablePrototype,
  idnaEntry,
  isDefaultIgnorable,
  isIdentifierAllowed,
  isMark,
  joiningType,
  pairedBracket,
  scriptExtensions,
} from "../../src/analyzer/unicodeData";

describe("packed Unicode 17 accessors", () => {
  it("publishes immutable source-set metadata", () => {
    expect(UNICODE_DATA_METADATA).toEqual({
      unicodeVersion: "17.0.0",
      uts39Revision: 32,
      uts46Revision: 35,
      captured: "2026-07-15",
      sourceSetSha256:
        "0b98ba743b2ad8b628ca0366802653154ecd7f528125641dadec73f6b0b4aa35",
      completeness: "complete",
    });
    expect(Object.isFrozen(UNICODE_DATA_METADATA)).toBe(true);
  });

  it("looks up UTS 46 status and mappings, including empty deviations", () => {
    expect(idnaEntry(0x0041)).toEqual({ status: "mapped", mapping: [0x0061] });
    expect(idnaEntry(0x00ad)).toEqual({ status: "ignored", mapping: [] });
    expect(idnaEntry(0x00df)).toEqual({
      status: "deviation",
      mapping: [0x0073, 0x0073],
    });
    expect(idnaEntry(0x200c)).toEqual({ status: "deviation", mapping: [] });
  });

  it("looks up canonical normalization data", () => {
    expect(canonicalCombiningClass(0x0301)).toBe(230);
    expect(canonicalCombiningClass(0x0041)).toBe(0);
    expect(canonicalDecomposition(0x00e9)).toEqual([0x0065, 0x0301]);
    expect(canonicalDecomposition(0x0041)).toBeNull();
    expect(canonicalComposition(0x0065, 0x0301)).toBe(0x00e9);
    expect(canonicalComposition(0x0065, 0x0300)).toBe(0x00e8);
    expect(canonicalComposition(0x0065, 0x0041)).toBeNull();
  });

  it("looks up profile properties and unified Script_Extensions", () => {
    expect(isMark(0x0301)).toBe(true);
    expect(isMark(0x0041)).toBe(false);
    expect(isDefaultIgnorable(0x200b)).toBe(true);
    expect(isDefaultIgnorable(0x0041)).toBe(false);
    expect(isIdentifierAllowed(0x0041)).toBe(true);
    expect(isIdentifierAllowed(0x1f600)).toBe(false);
    expect(scriptExtensions(0x0041)).toEqual(["Latn"]);
    expect(scriptExtensions(0x3105)).toEqual(["Bopo"]);
    expect(scriptExtensions(0x0378)).toEqual(["Zzzz"]);
  });

  it("looks up bidi, joining, bracket, and confusable data", () => {
    expect(bidiClass(0x0041)).toBe("L");
    expect(bidiClass(0x05d0)).toBe("R");
    expect(bidiClass(0x0628)).toBe("AL");
    expect(joiningType(0x0041)).toBe("U");
    expect(joiningType(0x0628)).toBe("D");
    expect(bidiMirror(0x0028)).toBe(0x0029);
    expect(bidiMirror(0x0041)).toBeNull();
    expect(pairedBracket(0x0028)).toEqual({ codePoint: 0x0029, type: "open" });
    expect(pairedBracket(0x0029)).toEqual({ codePoint: 0x0028, type: "close" });
    expect(confusablePrototype(0x0430)).toEqual([0x0061]);
    expect(confusablePrototype(0x0041)).toBeNull();
  });

  it.each([-1, 0xd800, 0x110000, 1.5, Number.NaN])(
    "rejects non-scalar lookup input %s",
    (codePoint) => {
      expect(() => idnaEntry(codePoint)).toThrow(RangeError);
      expect(() => scriptExtensions(codePoint)).toThrow(RangeError);
    },
  );
});
