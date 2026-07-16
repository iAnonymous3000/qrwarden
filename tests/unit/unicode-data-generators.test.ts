import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildUnicodeSnapshot,
  packRangeRows,
  parseCodePointRange,
  parseConfusables,
  parseDataFields,
} from "../../scripts/build-data/unicode.mjs";

describe("Unicode 17 data generation", () => {
  it("verifies the hash-pinned sources and byte-identical generated snapshot", async () => {
    const output = new URL(
      "../../src/data/unicodeSnapshot.ts",
      import.meta.url,
    );
    const before = await readFile(output);
    const generated = await buildUnicodeSnapshot({ check: true });

    expect(generated).toMatchObject({
      idnaRanges: 9_262,
      confusables: 6_565,
      packedByteLength: 149_508,
      generatedByteLength: 203_971,
      sourceSetSha256:
        "0b98ba743b2ad8b628ca0366802653154ecd7f528125641dadec73f6b0b4aa35",
    });
    await expect(readFile(output)).resolves.toEqual(before);
  });

  it("strictly parses code-point syntax and source line endings", () => {
    expect(parseCodePointRange("0041..005A", "fixture")).toEqual({
      start: 0x0041,
      end: 0x005a,
    });
    expect(() => parseCodePointRange("005A..0041", "fixture")).toThrow(
      "reversed",
    );
    expect(() => parseCodePointRange("41", "fixture")).toThrow(
      "uppercase hexadecimal",
    );
    expect(() => parseDataFields("0041 ; L\r\n", "fixture")).toThrow(
      "carriage return",
    );
    expect(() => parseDataFields("0041\u0000 ; L\n", "fixture")).toThrow(
      "invalid",
    );
  });

  it("rejects malformed confusable sources and overlapping packed ranges", () => {
    expect(() => parseConfusables("0041 0042 ; 0061 ; MA\n")).toThrow(
      "source must be one scalar",
    );
    expect(() =>
      packRangeRows(
        [
          { start: 0x0041, end: 0x005a },
          { start: 0x005a, end: 0x0061 },
        ],
        0,
        "fixture",
      ),
    ).toThrow("not ordered");
  });
});
