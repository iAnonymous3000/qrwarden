import { describe, expect, it } from "vitest";

import {
  escapeForbiddenForDisplay,
  forbiddenCharacters,
  isForbiddenCharacter,
} from "../../src/analyzer/characters";
import { isDefaultIgnorable } from "../../src/analyzer/unicodeData";

describe("hidden and control character policy", () => {
  it.each([
    ["soft hyphen", "\u00ad", "U+00AD"],
    ["Hangul choseong filler", "\u115f", "U+115F"],
    ["invisible function application", "\u2061", "U+2061"],
    ["invisible plus", "\u2064", "U+2064"],
    ["nominal digit shapes", "\u206f", "U+206F"],
    ["Hangul filler", "\u3164", "U+3164"],
    ["variation selector-16", "\ufe0f", "U+FE0F"],
    ["halfwidth Hangul filler", "\uffa0", "U+FFA0"],
    ["interlinear annotation anchor", "\ufff9", "U+FFF9"],
    ["interlinear annotation terminator", "\ufffb", "U+FFFB"],
    ["reserved tag base", "\u{e0000}", "U+E0000"],
    ["tag space", "\u{e0020}", "U+E0020"],
    ["cancel tag", "\u{e007f}", "U+E007F"],
    ["variation selector-17", "\u{e0100}", "U+E0100"],
    ["variation selector-256", "\u{e01ef}", "U+E01EF"],
  ] as const)("escapes the %s hidden or control character", (_name, character, code) => {
    expect(isForbiddenCharacter(character)).toBe(true);
    expect(forbiddenCharacters(`before${character}after`)).toEqual([character]);
    expect(escapeForbiddenForDisplay(`before${character}after`)).toBe(
      `before[${code}]after`,
    );
  });

  it("covers every default-ignorable scalar in the pinned Unicode snapshot", () => {
    const missed: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      if (
        isDefaultIgnorable(point) &&
        !isForbiddenCharacter(String.fromCodePoint(point))
      ) {
        missed.push(`U+${point.toString(16).toUpperCase()}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it.each([
    ["ordinary space", " "],
    ["combining acute accent", "\u0301"],
    ["Arabic number sign", "\u0600"],
    ["private-use character", "\ue000"],
    ["Egyptian hieroglyph vertical joiner", "\u{13430}"],
    ["emoji", "😀"],
  ] as const)("preserves legitimate %s text", (_name, character) => {
    expect(isForbiddenCharacter(character)).toBe(false);
    expect(forbiddenCharacters(`before${character}after`)).toEqual([]);
    expect(escapeForbiddenForDisplay(`before${character}after`)).toBe(
      `before${character}after`,
    );
  });

  it("retains the existing C0, C1, and line-separator controls", () => {
    expect(escapeForbiddenForDisplay("tab\tdelete\u007fline\u2028end")).toBe(
      "tab[U+0009]delete[U+007F]line[U+2028]end",
    );
  });

  it("escapes ill-formed UTF-16 without throwing", () => {
    expect(escapeForbiddenForDisplay("before\ud800after")).toBe(
      "before[U+D800]after",
    );
  });
});
