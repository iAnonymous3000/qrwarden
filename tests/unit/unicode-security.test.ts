import { describe, expect, it } from "vitest";
import {
  confusableSkeleton,
  hasAsciiConfusableLabel,
  hasMixedScripts,
} from "../../src/analyzer/characters";

describe("UTS 39 Highly Restrictive hostname checks", () => {
  it.each([
    ["Circle", false],
    ["СігсӀе", false],
    ["Сirсlе", true],
    ["Circ1e", false],
    ["〆切", false],
    ["ねガ", false],
  ])("matches the UTS 39 mixed-script example %s", (value, expected) => {
    expect(hasMixedScripts(value)).toBe(expected);
  });

  it("evaluates the complete host rather than each label independently", () => {
    expect(hasMixedScripts("пример.example")).toBe(true);
    expect(hasMixedScripts("bücher.example")).toBe(false);
  });

  it.each([
    "example.例え",
    "example.中文・",
    "example.한국漢字",
  ])("accepts the Highly Restrictive CJK cover for %s", (hostname) => {
    expect(hasMixedScripts(hostname)).toBe(false);
  });

  it("applies the General Security Profile before script coverage", () => {
    expect(hasMixedScripts("𝘊ircle.example")).toBe(true);
  });

  it("applies the General Security Profile under canonical equivalence", () => {
    expect(hasMixedScripts("ĕ.example")).toBe(false);
    expect(hasMixedScripts("ḓ.example")).toBe(false);
  });
});

describe("UTS 39 revision 32 confusable skeletons", () => {
  it("matches both normative bidiSkeleton examples", () => {
    const expected = "Al<ש\u0307";
    expect(confusableSkeleton("A1<ש\u05C2")).toBe(expected);
    expect(confusableSkeleton("Αש\u05BA>1")).toBe(expected);
  });

  it("uses pinned NFD without case conversion", () => {
    expect(confusableSkeleton("A")).toBe("A");
    expect(confusableSkeleton("é")).toBe("e\u0301");
  });

  it("removes default-ignorable code points", () => {
    expect(confusableSkeleton("a\u200Db")).toBe("ab");
  });

  it("applies each prototype once before the final NFD pass", () => {
    expect(confusableSkeleton("ǆ")).toBe("dz\u030C");
  });

  it("detects familiar mixed-script ASCII skeletons", () => {
    expect(confusableSkeleton("раypal")).toBe("paypal");
    expect(hasAsciiConfusableLabel("раypal.example")).toBe(true);
    expect(hasAsciiConfusableLabel("bücher.example")).toBe(false);
  });

  it("accepts any ASCII skeleton rather than only letters, digits, and hyphen", () => {
    expect(confusableSkeleton("٠")).toBe(".");
    expect(hasAsciiConfusableLabel("٠.example")).toBe(true);
  });
});
