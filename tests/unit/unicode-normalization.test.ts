import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeNfc,
  normalizeNfd,
} from "../../src/analyzer/unicodeNormalize";

interface NormalizationCase {
  readonly line: number;
  readonly values: readonly [string, string, string, string, string];
}

function fromCodePoints(field: string, line: number): string {
  if (field.trim() === "") return "";
  const points = field.trim().split(/\s+/u).map((value) => {
    if (!/^[0-9A-F]{4,6}$/u.test(value)) {
      throw new Error(`NormalizationTest line ${line} has an invalid code point`);
    }
    return Number.parseInt(value, 16);
  });
  return String.fromCodePoint(...points);
}

function normalizationCases(): readonly NormalizationCase[] {
  const source = readFileSync(
    new URL("../../data-src/unicode/NormalizationTest.txt", import.meta.url),
    "utf8",
  );
  const cases: NormalizationCase[] = [];
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = index + 1;
    const content = rawLine.split("#", 1)[0]!.trim();
    if (content === "" || content.startsWith("@")) continue;
    const fields = content.split(";").map((field) => field.trim());
    if (fields.length < 5) {
      throw new Error(`NormalizationTest line ${line} has fewer than five columns`);
    }
    cases.push({
      line,
      values: [
        fromCodePoints(fields[0]!, line),
        fromCodePoints(fields[1]!, line),
        fromCodePoints(fields[2]!, line),
        fromCodePoints(fields[3]!, line),
        fromCodePoints(fields[4]!, line),
      ],
    });
  }
  if (cases.length === 0) throw new Error("NormalizationTest contains no cases");
  return cases;
}

const NORMALIZATION_CASES = normalizationCases();
const BATCH_SIZE = 750;
const NORMALIZATION_BATCHES = Array.from(
  { length: Math.ceil(NORMALIZATION_CASES.length / BATCH_SIZE) },
  (_, index) => NORMALIZATION_CASES.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
);

describe("Unicode 17 normalization", () => {
  it("loads every pinned official NormalizationTest vector", () => {
    expect(NORMALIZATION_CASES).toHaveLength(20_034);
  });

  it("handles algorithmic Hangul decomposition and composition", () => {
    expect(normalizeNfd("\uAC01")).toBe("\u1100\u1161\u11A8");
    expect(normalizeNfc("\u1100\u1161\u11A8")).toBe("\uAC01");
  });

  it("rejects ill-formed UTF-16 rather than consulting host Unicode behavior", () => {
    expect(() => normalizeNfc("\uD800")).toThrow(RangeError);
    expect(() => normalizeNfd("\uDC00")).toThrow(RangeError);
  });

  it.each(NORMALIZATION_BATCHES.map((batch) => [batch] as const))(
    "passes official NormalizationTest batch %#",
    (batch) => {
      for (const { line, values: [source, nfc, nfd, nfkc, nfkd] } of batch) {
        const context = `NormalizationTest line ${line}`;
        expect(normalizeNfc(source), context).toBe(nfc);
        expect(normalizeNfc(nfc), context).toBe(nfc);
        expect(normalizeNfc(nfd), context).toBe(nfc);
        expect(normalizeNfc(nfkc), context).toBe(nfkc);
        expect(normalizeNfc(nfkd), context).toBe(nfkc);

        expect(normalizeNfd(source), context).toBe(nfd);
        expect(normalizeNfd(nfc), context).toBe(nfd);
        expect(normalizeNfd(nfd), context).toBe(nfd);
        expect(normalizeNfd(nfkc), context).toBe(nfkd);
        expect(normalizeNfd(nfkd), context).toBe(nfkd);
      }
    },
  );
});
