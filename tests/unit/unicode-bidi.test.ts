import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reorderUts46LabelForLtrSkeleton } from "../../src/analyzer/unicodeBidi";
import { bidiClass, bidiMirror } from "../../src/analyzer/unicodeData";

const OUTSIDE_PROCESSED_LABEL_PROFILE = new Set([
  "B",
  "S",
  "WS",
  "LRE",
  "RLE",
  "LRO",
  "RLO",
  "PDF",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
]);

interface OfficialProfileVector {
  readonly line: number;
  readonly input: string;
  readonly expected: string;
}

const BIDI_TEST_REPRESENTATIVE = Object.freeze({
  L: 0x0061,
  R: 0x05d0,
  AL: 0x0627,
  EN: 0x0031,
  ES: 0x002b,
  ET: 0x0024,
  AN: 0x0661,
  CS: 0x002c,
  NSM: 0x0300,
  BN: 0x200d,
  ON: 0x0021,
} as const);

type ProfileBidiType = keyof typeof BIDI_TEST_REPRESENTATIVE;

function applyL3ToOfficialOrder(
  order: number[],
  types: readonly string[],
  levels: readonly string[],
): void {
  let position = 0;
  while (position < order.length) {
    if (types[order[position]!] !== "NSM") {
      position += 1;
      continue;
    }
    const start = position;
    while (position < order.length && types[order[position]!] === "NSM") {
      position += 1;
    }
    const baseIndex = order[position];
    if (
      baseIndex !== undefined &&
      Number.parseInt(levels[baseIndex]!, 10) % 2 === 1
    ) {
      const reversed = order.slice(start, position + 1).reverse();
      order.splice(start, reversed.length, ...reversed);
      position += 1;
    }
  }
}

function officialPropertyProfileVectors(): readonly OfficialProfileVector[] {
  const source = readFileSync(
    new URL("../../data-src/unicode/BidiTest.txt", import.meta.url),
    "utf8",
  );
  const vectors: OfficialProfileVector[] = [];
  let levels: readonly string[] = [];
  let reorder: readonly number[] = [];

  for (const [index, raw] of source.split("\n").entries()) {
    const content = raw.split("#", 1)[0]!.trim();
    if (content === "") continue;
    if (content.startsWith("@Levels:")) {
      levels = content
        .slice("@Levels:".length)
        .trim()
        .split(/\s+/)
        .filter((value) => value !== "");
      continue;
    }
    if (content.startsWith("@Reorder:")) {
      reorder = content
        .slice("@Reorder:".length)
        .trim()
        .split(/\s+/)
        .filter((value) => value !== "")
        .map((value) => Number.parseInt(value, 10));
      continue;
    }
    if (content.startsWith("@")) continue;

    const fields = content.split(";").map((field) => field.trim());
    if (fields.length !== 2 || (Number.parseInt(fields[1]!, 16) & 0x2) === 0) {
      continue;
    }
    const rawTypes = fields[0]!.split(/\s+/);
    if (!rawTypes.every((type) => type in BIDI_TEST_REPRESENTATIVE)) continue;
    const types = rawTypes as ProfileBidiType[];
    const points = types.map((type) => BIDI_TEST_REPRESENTATIVE[type]);
    const visualOrder = [...reorder];
    applyL3ToOfficialOrder(visualOrder, types, levels);

    vectors.push({
      line: index + 1,
      input: String.fromCodePoint(...points),
      expected: visualOrder
        .map((logicalIndex) => String.fromCodePoint(points[logicalIndex]!))
        .join(""),
    });
  }
  return vectors;
}

function officialProfileVectors(): readonly OfficialProfileVector[] {
  const source = readFileSync(
    new URL("../../data-src/unicode/BidiCharacterTest.txt", import.meta.url),
    "utf8",
  );
  const vectors: OfficialProfileVector[] = [];
  for (const [index, raw] of source.split("\n").entries()) {
    const content = raw.split("#", 1)[0]!.trim();
    if (content === "") continue;
    const fields = content.split(";").map((field) => field.trim());
    if (fields.length !== 5 || fields[1] !== "0" || fields[2] !== "0") continue;
    const points = fields[0]!.split(" ").map((value) => Number.parseInt(value, 16));
    if (points.some((point) => point >= 0xd800 && point <= 0xdfff)) continue;
    const types = points.map(bidiClass);
    const compatible = types.every(
      (type) => !OUTSIDE_PROCESSED_LABEL_PROFILE.has(type),
    );
    if (!compatible) continue;

    const input = String.fromCodePoint(...points);
    const levels = fields[3]!.split(" ");
    const visualOrder = fields[4]!
      .split(" ")
      .filter((value) => value !== "")
      .map((value) => Number.parseInt(value, 10));
    applyL3ToOfficialOrder(visualOrder, types, levels);
    const expected = visualOrder
      .map((logicalIndex) => {
        const point = points[logicalIndex]!;
        const level = Number.parseInt(levels[logicalIndex]!, 10);
        return String.fromCodePoint(
          level % 2 === 1 ? (bidiMirror(point) ?? point) : point,
        );
      })
      .join("");
    vectors.push({ line: index + 1, input, expected });
  }
  return vectors;
}

describe("UTS 39 LTR bidi skeleton reordering", () => {
  it("matches the two UTS 39 revision 32 bidiSkeleton examples", () => {
    expect(reorderUts46LabelForLtrSkeleton("A1<ש\u05C2")).toBe("A1<ש\u05C2");
    expect(reorderUts46LabelForLtrSkeleton("Αש\u05BA>1")).toBe("Α1<ש\u05BA");
  });

  it("keeps left-to-right spans and reverses right-to-left spans", () => {
    expect(reorderUts46LabelForLtrSkeleton("abcאבג")).toBe("abcגבא");
    expect(reorderUts46LabelForLtrSkeleton("ا12ب")).toBe("ب12ا");
  });

  it("resolves paired brackets using their enclosed and preceding context", () => {
    expect(reorderUts46LabelForLtrSkeleton("(אב)")).toBe("(בא)");
    expect(reorderUts46LabelForLtrSkeleton("אב(גד)")).toBe("(דג)בא");
  });

  it("moves right-to-left combining marks back after their base", () => {
    expect(reorderUts46LabelForLtrSkeleton("Aש\u05C2")).toBe("Aש\u05C2");
  });

  it("applies X9 to boundary neutrals retained by UTS 46", () => {
    expect(reorderUts46LabelForLtrSkeleton("a\u200Db")).toBe("ab");
  });

  it("rejects bidi input outside the processed-label subset", () => {
    expect(() => reorderUts46LabelForLtrSkeleton("a\u202Eb")).toThrow(RangeError);
    expect(() => reorderUts46LabelForLtrSkeleton("a\u2067b\u2069")).toThrow(
      RangeError,
    );
  });

  it("matches every compatible Unicode 17 BidiCharacterTest vector", () => {
    const vectors = officialProfileVectors();
    expect(vectors).toHaveLength(45_785);
    for (const vector of vectors) {
      expect(
        reorderUts46LabelForLtrSkeleton(vector.input),
        `BidiCharacterTest.txt:${vector.line}`,
      ).toBe(vector.expected);
    }
  });

  it("matches every compatible Unicode 17 BidiTest property vector", () => {
    const vectors = officialPropertyProfileVectors();
    expect(vectors).toHaveLength(16_106);
    for (const vector of vectors) {
      expect(
        reorderUts46LabelForLtrSkeleton(vector.input),
        `BidiTest.txt:${vector.line}`,
      ).toBe(vector.expected);
    }
  });
});
