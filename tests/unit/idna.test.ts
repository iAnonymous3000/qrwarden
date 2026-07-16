import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  toAsciiDomain,
  toUnicodeDomain,
  uts46ToAscii,
  uts46ToUnicode,
} from "../../src/analyzer/idna";
import {
  decodePunycodeLabel,
  encodePunycodeLabel,
} from "../../src/analyzer/punycode";

interface IdnaCase {
  readonly line: number;
  readonly source: string;
  readonly unicode: string;
  readonly unicodeStatus: ReadonlySet<string>;
  readonly ascii: string;
  readonly asciiStatus: ReadonlySet<string>;
  readonly illFormed: boolean;
}

function decodeEscapes(field: string): string {
  if (field === '""') return "";
  return field.replace(
    /\\u([0-9A-Fa-f]{4})|\\x\{([0-9A-Fa-f]{1,6})\}/gu,
    (_match, short: string | undefined, long: string | undefined) =>
      short === undefined
        ? String.fromCodePoint(Number.parseInt(long!, 16))
        : String.fromCharCode(Number.parseInt(short, 16)),
  );
}

function status(field: string, fallback: ReadonlySet<string>): ReadonlySet<string> {
  if (field === "") return fallback;
  if (field === "[]") return new Set();
  if (!/^\[[A-Z0-9_, ]+\]$/u.test(field)) {
    throw new Error(`Invalid IdnaTestV2 status field: ${field}`);
  }
  return new Set(
    field
      .slice(1, -1)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function idnaCases(): readonly IdnaCase[] {
  const source = readFileSync(
    new URL("../../data-src/unicode/IdnaTestV2.txt", import.meta.url),
    "utf8",
  );
  const cases: IdnaCase[] = [];
  const emptyStatus: ReadonlySet<string> = new Set();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = index + 1;
    const content = rawLine.split("#", 1)[0]!.trim();
    if (content === "") continue;
    const fields = content.split(";").map((field) => field.trim());
    if (fields.length !== 7) {
      throw new Error(`IdnaTestV2 line ${line} does not have seven columns`);
    }

    const input = decodeEscapes(fields[0]!);
    const unicode = fields[1] === "" ? input : decodeEscapes(fields[1]!);
    const unicodeStatus = status(fields[2]!, emptyStatus);
    const ascii = fields[3] === "" ? unicode : decodeEscapes(fields[3]!);
    const asciiStatus = status(fields[4]!, unicodeStatus);
    cases.push({
      line,
      source: input,
      unicode,
      unicodeStatus,
      ascii,
      asciiStatus,
      illFormed: containsUnpairedSurrogate(input),
    });
  }
  if (cases.length === 0) throw new Error("IdnaTestV2 contains no cases");
  return cases;
}

function acceptsTrailingRootDot(value: string): boolean {
  if (!value.endsWith(".")) return false;
  const nonRoot = value.slice(0, -1);
  return nonRoot.length > 0 && !nonRoot.startsWith(".") && !nonRoot.includes("..");
}

function expectedUnicodeError(test: IdnaCase): boolean {
  const statuses = new Set(test.unicodeStatus);
  if (acceptsTrailingRootDot(test.unicode)) statuses.delete("X4_2");
  return statuses.size > 0;
}

function expectedAsciiError(test: IdnaCase): boolean {
  const statuses = new Set(test.asciiStatus);
  if (acceptsTrailingRootDot(test.unicode)) {
    statuses.delete("X4_2");
    const nonRootAscii = test.ascii.endsWith(".")
      ? test.ascii.slice(0, -1)
      : test.ascii;
    const hasOtherInvalidLabel = nonRootAscii
      .split(".")
      .some((label) => label.length < 1 || label.length > 63);
    if (!hasOtherInvalidLabel) statuses.delete("A4_2");
  }
  return statuses.size > 0;
}

const IDNA_CASES = idnaCases();
const BATCH_SIZE = 400;
const IDNA_BATCHES = Array.from(
  { length: Math.ceil(IDNA_CASES.length / BATCH_SIZE) },
  (_, index) => IDNA_CASES.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
);

describe("Punycode", () => {
  it.each([
    ["bücher", "bcher-kva"],
    ["mañana", "maana-pta"],
    ["日本語", "wgv71a119e"],
    [String.fromCodePoint(0x10ffff), "dn32g"],
  ])("round-trips %s", (unicode, encoded) => {
    expect(encodePunycodeLabel(unicode)).toBe(encoded);
    expect(decodePunycodeLabel(encoded)).toBe(unicode);
  });

  it("rejects malformed and overflowing encodings", () => {
    expect(encodePunycodeLabel("abc")).toBe("abc-");
    expect(decodePunycodeLabel("abc-")).toBe("abc");
    expect(decodePunycodeLabel("-")).toBeNull();
    expect(decodePunycodeLabel("a$")).toBeNull();
    expect(decodePunycodeLabel("z".repeat(10_000))).toBeNull();
    expect(encodePunycodeLabel("\uD800")).toBeNull();
  });
});

describe("strict Unicode 17 UTS 46", () => {
  it("loads every pinned official IdnaTestV2 vector", () => {
    expect(IDNA_CASES).toHaveLength(6_391);
  });

  it("maps, normalizes, and round-trips benign nontransitional IDNs", () => {
    expect(toAsciiDomain("BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(toUnicodeDomain("xn--bcher-kva.example")).toBe("bücher.example");
    expect(toAsciiDomain("faß.de")).toBe("xn--fa-hia.de");
    expect(toAsciiDomain("日本語。ＪＰ")).toBe("xn--wgv71a119e.jp");
  });

  it("preserves one DNS root dot while validating only the non-root domain", () => {
    expect(toAsciiDomain("BÜCHER.example.")).toBe("xn--bcher-kva.example.");
    expect(toUnicodeDomain("xn--bcher-kva.example.")).toBe("bücher.example.");
    expect(toAsciiDomain("example..com.")).toBeNull();
    expect(toAsciiDomain(".")).toBeNull();
  });

  it("enforces STD3, hyphen, initial-mark, and A-label validity", () => {
    for (const domain of ["under_score.example", "-a.example", "a-.example", "ab--cd.example"]) {
      expect(toAsciiDomain(domain), domain).toBeNull();
    }
    expect(toAsciiDomain("\u0308.example")).toBeNull();
    expect(toUnicodeDomain("xn--u-ccb.example")).toBeNull();
    expect(toUnicodeDomain("xn--0.example")).toBeNull();
  });

  it("enforces ContextJ and RFC 5893 Bidi rules", () => {
    expect(toAsciiDomain("a\u094D\u200Db.example")).not.toBeNull();
    expect(toAsciiDomain("a\u200Db.example")).toBeNull();
    expect(toAsciiDomain("مثال.example")).not.toBeNull();
    expect(toAsciiDomain("àא.example")).toBeNull();
    expect(toAsciiDomain("א0٠א.example")).toBeNull();
  });

  it("enforces DNS label and domain lengths after Punycode conversion", () => {
    const maximum = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(maximum).toHaveLength(253);
    expect(toAsciiDomain(maximum)).toBe(maximum);
    expect(toAsciiDomain("a".repeat(64))).toBeNull();
    expect(toAsciiDomain(["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63)].join("."))).toBeNull();
  });

  it.each(IDNA_BATCHES.map((batch) => [batch] as const))(
    "passes every nontransitional IdnaTestV2 row in batch %#",
    (batch) => {
      for (const test of batch) {
        const unicode = uts46ToUnicode(test.source);
        const ascii = uts46ToAscii(test.source);
        const context = `IdnaTestV2 line ${test.line}`;

        expect(unicode.valid, `${context} ToUnicode status`).toBe(
          !expectedUnicodeError(test),
        );
        expect(ascii.valid, `${context} ToASCII status`).toBe(
          !expectedAsciiError(test),
        );

        // UTS 46 explicitly permits implementations that cannot preserve
        // ill-formed UTF-16 to skip their output-string comparison.
        if (!test.illFormed) {
          expect(unicode.value, `${context} ToUnicode output`).toBe(test.unicode);
          expect(ascii.value, `${context} ToASCII output`).toBe(test.ascii);
        }
      }
    },
  );
});
