import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertExactKeys,
  invariant,
  isDirectExecution,
  readJsonFile,
  sha256,
  writeGeneratedFile,
} from "./shared.mjs";

const SOURCE_DIRECTORY = new URL("../../data-src/unicode/", import.meta.url);
const PROVENANCE_URL = new URL("provenance.json", SOURCE_DIRECTORY);
const OUTPUT_URL = new URL(
  "../../src/data/unicodeSnapshot.ts",
  import.meta.url,
);
const UNICODE_VERSION = "17.0.0";
const MAX_CODE_POINT = 0x10ffff;
const SOURCE_SET_DOMAIN = "QRWARDEN-UNICODE-SOURCE-SET-1\0";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const EXPECTED_FILES = Object.freeze({
  "bidi-brackets": Object.freeze({
    file: "BidiBrackets.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/BidiBrackets.txt",
  }),
  "bidi-character-test": Object.freeze({
    file: "BidiCharacterTest.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/BidiCharacterTest.txt",
  }),
  "bidi-class": Object.freeze({
    file: "DerivedBidiClass.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedBidiClass.txt",
  }),
  "bidi-mirroring": Object.freeze({
    file: "BidiMirroring.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/BidiMirroring.txt",
  }),
  "bidi-test": Object.freeze({
    file: "BidiTest.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/BidiTest.txt",
  }),
  confusables: Object.freeze({
    file: "confusables.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/security/confusables.txt",
  }),
  "core-properties": Object.freeze({
    file: "DerivedCoreProperties.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt",
  }),
  "identifier-status": Object.freeze({
    file: "IdentifierStatus.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/security/IdentifierStatus.txt",
  }),
  "idna-mapping": Object.freeze({
    file: "IdnaMappingTable.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/idna/IdnaMappingTable.txt",
  }),
  "idna-test": Object.freeze({
    file: "IdnaTestV2.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/idna/IdnaTestV2.txt",
  }),
  "joining-type": Object.freeze({
    file: "DerivedJoiningType.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedJoiningType.txt",
  }),
  license: Object.freeze({
    file: "license.txt",
    sourceUrl: "https://www.unicode.org/license.txt",
  }),
  "normalization-properties": Object.freeze({
    file: "DerivedNormalizationProps.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/DerivedNormalizationProps.txt",
  }),
  "normalization-test": Object.freeze({
    file: "NormalizationTest.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt",
  }),
  "property-value-aliases": Object.freeze({
    file: "PropertyValueAliases.txt",
    sourceUrl:
      "https://www.unicode.org/Public/17.0.0/ucd/PropertyValueAliases.txt",
  }),
  "script-extensions": Object.freeze({
    file: "ScriptExtensions.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/ScriptExtensions.txt",
  }),
  scripts: Object.freeze({
    file: "Scripts.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/Scripts.txt",
  }),
  "unicode-data": Object.freeze({
    file: "UnicodeData.txt",
    sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt",
  }),
});

export const IDNA_STATUSES = Object.freeze([
  "valid",
  "mapped",
  "ignored",
  "deviation",
  "disallowed",
]);

export const BIDI_CLASSES = Object.freeze([
  "L",
  "R",
  "AL",
  "EN",
  "ES",
  "ET",
  "AN",
  "CS",
  "NSM",
  "BN",
  "B",
  "S",
  "WS",
  "ON",
  "LRE",
  "LRO",
  "RLE",
  "RLO",
  "PDF",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
]);

export const JOINING_TYPES = Object.freeze(["U", "R", "D", "C", "L", "T"]);

function compareBytes(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function looseAlias(value) {
  return value.replace(/[\s_-]/g, "").toLowerCase();
}

function sourceLines(text, label) {
  invariant(
    typeof text === "string" && !text.includes("\u0000"),
    `${label} is invalid`,
  );
  invariant(!text.includes("\r"), `${label} contains a carriage return`);
  return text.split("\n");
}

export function parseDataFields(text, label) {
  const output = [];
  for (const [index, raw] of sourceLines(text, label).entries()) {
    const content = raw.split("#", 1)[0].trim();
    if (content === "") continue;
    output.push({
      line: index + 1,
      fields: content.split(";").map((field) => field.trim()),
    });
  }
  return output;
}

function parseCodePoint(value, label, { scalar = false } = {}) {
  invariant(
    /^[0-9A-F]{4,6}$/.test(value),
    `${label} is not an uppercase hexadecimal code point`,
  );
  const codePoint = Number.parseInt(value, 16);
  invariant(codePoint <= MAX_CODE_POINT, `${label} is outside Unicode`);
  if (scalar) {
    invariant(
      codePoint < 0xd800 || codePoint > 0xdfff,
      `${label} is not a Unicode scalar value`,
    );
  }
  return codePoint;
}

export function parseCodePointRange(value, label = "code point range") {
  const parts = value.split("..");
  invariant(
    parts.length === 1 || parts.length === 2,
    `${label} has invalid range syntax`,
  );
  const start = parseCodePoint(parts[0], `${label} start`);
  const end = parseCodePoint(parts.at(-1), `${label} end`);
  invariant(start <= end, `${label} is reversed`);
  return { start, end };
}

function parseCodePointSequence(value, label, { allowEmpty = false } = {}) {
  if (value === "") {
    invariant(allowEmpty, `${label} must not be empty`);
    return [];
  }
  invariant(
    value === value.trim() && !/\s{2,}/.test(value),
    `${label} spacing is invalid`,
  );
  return value
    .split(" ")
    .map((item, index) =>
      parseCodePoint(item, `${label} item ${index + 1}`, { scalar: true }),
    );
}

function assertRangeOrder(rows, label, { contiguous = false } = {}) {
  let previousEnd = -1;
  for (const [index, row] of rows.entries()) {
    invariant(
      Number.isInteger(row.start) &&
        Number.isInteger(row.end) &&
        row.start <= row.end,
      `${label} row ${index + 1} is invalid`,
    );
    invariant(
      row.start > previousEnd,
      `${label} overlaps or is not sorted at row ${index + 1}`,
    );
    if (contiguous) {
      invariant(
        row.start === previousEnd + 1,
        `${label} has a gap before row ${index + 1}`,
      );
    }
    previousEnd = row.end;
  }
  if (contiguous)
    invariant(
      previousEnd === MAX_CODE_POINT,
      `${label} does not cover Unicode`,
    );
}

function mergeRanges(rows, valueKey = "value") {
  const output = [];
  for (const row of rows) {
    const previous = output.at(-1);
    if (
      previous !== undefined &&
      previous.end + 1 === row.start &&
      previous[valueKey] === row[valueKey]
    ) {
      previous.end = row.end;
    } else {
      output.push({ ...row });
    }
  }
  return output;
}

function assertVersion(text, label) {
  invariant(
    text.includes(`Version: ${UNICODE_VERSION}`) ||
      text.includes(`-${UNICODE_VERSION}.txt`),
    `${label} does not identify Unicode ${UNICODE_VERSION}`,
  );
}

export function parseIdnaMappingTable(text) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "IDNA mapping table")) {
    invariant(
      fields.length >= 2 && fields.length <= 4,
      `IDNA row ${line} has invalid fields`,
    );
    const range = parseCodePointRange(fields[0], `IDNA row ${line}`);
    const status = fields[1];
    invariant(
      IDNA_STATUSES.includes(status),
      `IDNA row ${line} has unknown status ${status}`,
    );
    const mapping = parseCodePointSequence(
      fields[2] ?? "",
      `IDNA row ${line} mapping`,
      {
        allowEmpty: true,
      },
    );
    if (status === "mapped") {
      invariant(mapping.length > 0, `IDNA row ${line} requires a mapping`);
    } else if (status !== "deviation") {
      invariant(
        mapping.length === 0,
        `IDNA row ${line} must not have a mapping`,
      );
    }
    rows.push({ ...range, status, mapping });
  }
  invariant(rows.length > 9_000, "IDNA mapping table is unexpectedly small");
  assertRangeOrder(rows, "IDNA mapping table", { contiguous: true });
  return rows;
}

export function parseConfusables(text) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "confusables")) {
    invariant(
      fields.length === 3,
      `confusables row ${line} must have three fields`,
    );
    const source = parseCodePointSequence(
      fields[0],
      `confusables row ${line} source`,
    );
    invariant(
      source.length === 1,
      `confusables row ${line} source must be one scalar`,
    );
    const prototype = parseCodePointSequence(
      fields[1],
      `confusables row ${line} prototype`,
    );
    invariant(
      fields[2] === "MA",
      `confusables row ${line} mapping type must be MA`,
    );
    rows.push({ start: source[0], end: source[0], prototype });
  }
  rows.sort((left, right) => left.start - right.start);
  invariant(rows.length > 6_000, "confusables data is unexpectedly small");
  assertRangeOrder(rows, "confusables");
  return rows;
}

function aliasMapForProperty(text, property, label) {
  const aliases = new Map();
  const shortNames = new Set();
  for (const { fields, line } of parseDataFields(
    text,
    "property value aliases",
  )) {
    if (fields[0] !== property) continue;
    invariant(
      fields.length >= 3,
      `${label} alias row ${line} has too few fields`,
    );
    const short = fields[1];
    invariant(
      /^[A-Za-z0-9_]+$/.test(short),
      `${label} alias row ${line} has invalid short name`,
    );
    shortNames.add(short);
    for (const alias of fields.slice(1)) {
      if (alias === "") continue;
      const key = looseAlias(alias);
      const previous = aliases.get(key);
      invariant(
        previous === undefined || previous === short,
        `${label} alias ${alias} is ambiguous`,
      );
      aliases.set(key, short);
    }
  }
  invariant(aliases.size > 0, `${label} aliases are missing`);
  return { aliases, shortNames };
}

function translateAlias(value, aliases, label) {
  const translated = aliases.get(looseAlias(value));
  invariant(
    translated !== undefined,
    `${label} uses unknown property value ${value}`,
  );
  return translated;
}

export function parseScripts(text, scriptAliases) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "Scripts")) {
    invariant(fields.length === 2, `Scripts row ${line} must have two fields`);
    rows.push({
      ...parseCodePointRange(fields[0], `Scripts row ${line}`),
      script: translateAlias(fields[1], scriptAliases, `Scripts row ${line}`),
    });
  }
  rows.sort((left, right) => left.start - right.start || left.end - right.end);
  invariant(rows.length > 2_000, "Scripts data is unexpectedly small");
  assertRangeOrder(rows, "Scripts");
  return rows;
}

export function parseScriptExtensions(text, scriptAliases) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "ScriptExtensions")) {
    invariant(
      fields.length === 2,
      `ScriptExtensions row ${line} must have two fields`,
    );
    const scripts = fields[1]
      .split(" ")
      .map((value) =>
        translateAlias(value, scriptAliases, `ScriptExtensions row ${line}`),
      );
    invariant(scripts.length > 0, `ScriptExtensions row ${line} is empty`);
    invariant(
      new Set(scripts).size === scripts.length,
      `ScriptExtensions row ${line} duplicates a script`,
    );
    const sorted = [...scripts].sort(compareBytes);
    invariant(
      JSON.stringify(scripts) === JSON.stringify(sorted),
      `ScriptExtensions row ${line} is not bytewise sorted`,
    );
    rows.push({
      ...parseCodePointRange(fields[0], `ScriptExtensions row ${line}`),
      scripts,
    });
  }
  invariant(rows.length > 150, "ScriptExtensions data is unexpectedly small");
  assertRangeOrder(rows, "ScriptExtensions");
  return rows;
}

function parsePropertyRanges(text, property, label) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, label)) {
    invariant(fields.length >= 2, `${label} row ${line} has too few fields`);
    if (fields[1] !== property) continue;
    rows.push(parseCodePointRange(fields[0], `${label} row ${line}`));
  }
  invariant(rows.length > 0, `${label} has no ${property} rows`);
  assertRangeOrder(rows, `${label} ${property}`);
  return rows;
}

export function parseIdentifierAllowed(text) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "IdentifierStatus")) {
    invariant(
      fields.length === 2,
      `IdentifierStatus row ${line} must have two fields`,
    );
    invariant(
      fields[1] === "Allowed" || fields[1] === "Restricted",
      `IdentifierStatus row ${line} has unknown status`,
    );
    if (fields[1] === "Allowed") {
      rows.push(parseCodePointRange(fields[0], `IdentifierStatus row ${line}`));
    }
  }
  invariant(
    rows.length > 500,
    "IdentifierStatus Allowed data is unexpectedly small",
  );
  assertRangeOrder(rows, "IdentifierStatus Allowed");
  return rows;
}

function parseUnicodeDataLine(raw, line) {
  const fields = raw.split(";");
  invariant(
    fields.length === 15,
    `UnicodeData row ${line} must have fifteen fields`,
  );
  const codePoint = parseCodePoint(
    fields[0],
    `UnicodeData row ${line} code point`,
  );
  invariant(fields[1] !== "", `UnicodeData row ${line} has no name`);
  invariant(
    /^[A-Z][a-z]$/.test(fields[2]),
    `UnicodeData row ${line} has invalid category`,
  );
  invariant(
    /^(?:0|[1-9]\d{0,2})$/.test(fields[3]),
    `UnicodeData row ${line} has invalid combining class`,
  );
  const combiningClass = Number(fields[3]);
  invariant(
    combiningClass <= 255,
    `UnicodeData row ${line} combining class is too large`,
  );
  return { fields, codePoint, combiningClass, line };
}

export function parseUnicodeData(text) {
  const records = [];
  let pending = null;
  let previousCodePoint = -1;
  for (const [index, raw] of sourceLines(text, "UnicodeData").entries()) {
    if (raw === "") continue;
    const row = parseUnicodeDataLine(raw, index + 1);
    invariant(
      row.codePoint > previousCodePoint,
      `UnicodeData row ${row.line} is not sorted`,
    );
    previousCodePoint = row.codePoint;
    const name = row.fields[1];
    if (name.endsWith(", First>")) {
      invariant(
        pending === null,
        `UnicodeData row ${row.line} starts a nested range`,
      );
      pending = row;
      continue;
    }
    if (name.endsWith(", Last>")) {
      invariant(pending !== null, `UnicodeData row ${row.line} ends no range`);
      const firstStem = pending.fields[1].slice(0, -", First>".length);
      const lastStem = name.slice(0, -", Last>".length);
      invariant(
        firstStem === lastStem,
        `UnicodeData row ${row.line} closes the wrong range`,
      );
      invariant(
        row.codePoint > pending.codePoint,
        `UnicodeData row ${row.line} has an empty range`,
      );
      invariant(
        pending.fields.slice(2).join(";") === row.fields.slice(2).join(";"),
        `UnicodeData row ${row.line} range properties disagree`,
      );
      records.push({
        start: pending.codePoint,
        end: row.codePoint,
        fields: pending.fields,
      });
      pending = null;
      continue;
    }
    invariant(
      pending === null,
      `UnicodeData row ${row.line} interrupts a range`,
    );
    records.push({
      start: row.codePoint,
      end: row.codePoint,
      fields: row.fields,
    });
  }
  invariant(pending === null, "UnicodeData ends inside a range");
  invariant(records.length > 40_000, "UnicodeData is unexpectedly small");

  const combiningClasses = [];
  const markRanges = [];
  const decompositions = [];
  for (const record of records) {
    const combiningClass = Number(record.fields[3]);
    if (combiningClass !== 0) {
      combiningClasses.push({ ...record, value: combiningClass });
    }
    if (record.fields[2].startsWith("M")) markRanges.push({ ...record });
    const decomposition = record.fields[5];
    if (decomposition !== "" && !decomposition.startsWith("<")) {
      invariant(
        record.start === record.end,
        "canonical decomposition cannot cover a range",
      );
      decompositions.push({
        start: record.start,
        end: record.end,
        mapping: parseCodePointSequence(
          decomposition,
          `UnicodeData U+${record.start.toString(16).toUpperCase()} decomposition`,
        ),
      });
    }
  }
  return {
    combiningClasses: mergeRanges(combiningClasses),
    markRanges: mergeRanges(markRanges, "fields"),
    decompositions,
  };
}

function inRanges(value, ranges) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = ranges[middle];
    if (value < row.start) high = middle;
    else if (value > row.end) low = middle + 1;
    else return true;
  }
  return false;
}

function canonicalCompositions(decompositions, exclusions) {
  const compositions = [];
  const seen = new Set();
  for (const row of decompositions) {
    if (row.mapping.length !== 2 || inRanges(row.start, exclusions)) continue;
    const key = `${row.mapping[0]},${row.mapping[1]}`;
    invariant(
      !seen.has(key),
      `canonical composition pair ${key} is duplicated`,
    );
    seen.add(key);
    compositions.push([row.mapping[0], row.mapping[1], row.start]);
  }
  compositions.sort(
    (left, right) =>
      left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
  );
  invariant(
    compositions.length > 900,
    "canonical composition table is unexpectedly small",
  );
  return compositions;
}

function parseJoiningTypes(text) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "DerivedJoiningType")) {
    invariant(
      fields.length === 2,
      `DerivedJoiningType row ${line} must have two fields`,
    );
    invariant(
      JOINING_TYPES.includes(fields[1]),
      `DerivedJoiningType row ${line} is unknown`,
    );
    invariant(
      fields[1] !== "U",
      `DerivedJoiningType row ${line} redundantly lists the default`,
    );
    rows.push({
      ...parseCodePointRange(fields[0], `DerivedJoiningType row ${line}`),
      value: JOINING_TYPES.indexOf(fields[1]),
    });
  }
  rows.sort((left, right) => left.start - right.start || left.end - right.end);
  invariant(rows.length > 400, "DerivedJoiningType is unexpectedly small");
  assertRangeOrder(rows, "DerivedJoiningType");
  return rows;
}

function missingBidiRows(text, aliases) {
  const rows = [];
  for (const [index, raw] of sourceLines(text, "DerivedBidiClass").entries()) {
    const match = /^#\s*@missing:\s*([0-9A-F.]+)\s*;\s*([A-Za-z_]+)\s*$/.exec(
      raw,
    );
    if (match === null) continue;
    rows.push({
      ...parseCodePointRange(
        match[1],
        `DerivedBidiClass @missing row ${index + 1}`,
      ),
      bidiClass: translateAlias(
        match[2],
        aliases,
        `DerivedBidiClass @missing row ${index + 1}`,
      ),
    });
  }
  invariant(
    rows.some(
      (row) =>
        row.start === 0 && row.end === MAX_CODE_POINT && row.bidiClass === "L",
    ),
    "DerivedBidiClass lacks the full default",
  );
  return rows;
}

function parseBidiClasses(text, aliases) {
  const dense = new Uint8Array(MAX_CODE_POINT + 1);
  for (const row of missingBidiRows(text, aliases)) {
    const value = BIDI_CLASSES.indexOf(row.bidiClass);
    invariant(value >= 0, `unknown Bidi_Class ${row.bidiClass}`);
    dense.fill(value, row.start, row.end + 1);
  }

  const explicit = [];
  for (const { fields, line } of parseDataFields(text, "DerivedBidiClass")) {
    invariant(
      fields.length === 2,
      `DerivedBidiClass row ${line} must have two fields`,
    );
    const bidiClass = translateAlias(
      fields[1],
      aliases,
      `DerivedBidiClass row ${line}`,
    );
    const value = BIDI_CLASSES.indexOf(bidiClass);
    invariant(value >= 0, `DerivedBidiClass row ${line} has unsupported value`);
    explicit.push({
      ...parseCodePointRange(fields[0], `DerivedBidiClass row ${line}`),
      value,
    });
  }
  explicit.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  invariant(explicit.length > 2_000, "DerivedBidiClass is unexpectedly small");
  assertRangeOrder(explicit, "DerivedBidiClass explicit rows");
  for (const row of explicit) dense.fill(row.value, row.start, row.end + 1);

  const rows = [];
  let start = 0;
  for (let codePoint = 1; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    if (dense[codePoint] !== dense[start]) {
      rows.push({ start, end: codePoint - 1, value: dense[start] });
      start = codePoint;
    }
  }
  rows.push({ start, end: MAX_CODE_POINT, value: dense[start] });
  assertRangeOrder(rows, "generated Bidi_Class", { contiguous: true });
  return rows;
}

function parsePointMappings(text, label) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, label)) {
    invariant(fields.length === 2, `${label} row ${line} must have two fields`);
    const start = parseCodePoint(fields[0], `${label} row ${line} source`, {
      scalar: true,
    });
    const target = parseCodePoint(fields[1], `${label} row ${line} target`, {
      scalar: true,
    });
    rows.push({ start, end: start, value: target });
  }
  rows.sort((left, right) => left.start - right.start);
  assertRangeOrder(rows, label);
  return rows;
}

function parsePairedBrackets(text) {
  const rows = [];
  for (const { fields, line } of parseDataFields(text, "BidiBrackets")) {
    invariant(
      fields.length === 3,
      `BidiBrackets row ${line} must have three fields`,
    );
    const start = parseCodePoint(fields[0], `BidiBrackets row ${line} source`, {
      scalar: true,
    });
    const pair = parseCodePoint(fields[1], `BidiBrackets row ${line} pair`, {
      scalar: true,
    });
    invariant(
      fields[2] === "o" || fields[2] === "c",
      `BidiBrackets row ${line} has invalid type`,
    );
    rows.push({ start, end: start, values: [pair, fields[2] === "o" ? 1 : 2] });
  }
  rows.sort((left, right) => left.start - right.start);
  assertRangeOrder(rows, "BidiBrackets");
  const byCodePoint = new Map(rows.map((row) => [row.start, row]));
  for (const row of rows) {
    const pair = byCodePoint.get(row.values[0]);
    invariant(
      pair?.values[0] === row.start,
      "BidiBrackets pair is not reciprocal",
    );
    invariant(
      pair.values[1] !== row.values[1],
      "BidiBrackets pair types agree",
    );
  }
  return rows;
}

function validateProvenance(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "dataset",
      "captured",
      "unicodeVersion",
      "uts39Revision",
      "uts46Revision",
      "sourceSetSha256",
      "license",
      "files",
    ],
    "Unicode provenance",
  );
  invariant(
    value.schemaVersion === 1,
    "Unicode provenance schemaVersion must be 1",
  );
  invariant(
    value.dataset === "Unicode 17 IDNA and security data used by QRWarden",
    "Unicode provenance dataset is invalid",
  );
  invariant(
    DATE.test(value.captured),
    "Unicode provenance capture date is invalid",
  );
  invariant(
    value.unicodeVersion === UNICODE_VERSION,
    "Unicode provenance version is invalid",
  );
  invariant(
    value.uts39Revision === 32,
    "Unicode provenance UTS 39 revision is invalid",
  );
  invariant(
    value.uts46Revision === 35,
    "Unicode provenance UTS 46 revision is invalid",
  );
  invariant(
    SHA256.test(value.sourceSetSha256),
    "Unicode provenance source-set hash is invalid",
  );
  assertExactKeys(
    value.license,
    ["expression", "termsUrl", "textUrl", "file", "byteLength", "sha256"],
    "Unicode license provenance",
  );
  invariant(value.license.expression === "Unicode-3.0", "Unicode license expression is invalid");
  invariant(value.license.termsUrl === "https://www.unicode.org/license.txt", "Unicode license terms URL is invalid");
  invariant(value.license.textUrl === "https://www.unicode.org/license.txt", "Unicode license text URL is invalid");
  invariant(value.license.file === "license.txt", "Unicode license file is invalid");
  const expectedRoles = Object.keys(EXPECTED_FILES);
  invariant(
    Array.isArray(value.files) && value.files.length === expectedRoles.length,
    "Unicode provenance file inventory is incomplete",
  );
  const files = new Map();
  for (const [index, entry] of value.files.entries()) {
    assertExactKeys(
      entry,
      ["role", "sourceUrl", "file", "byteLength", "sha256"],
      `Unicode provenance file ${index + 1}`,
    );
    const expected = EXPECTED_FILES[entry.role];
    invariant(
      expected !== undefined,
      `Unicode provenance role ${entry.role} is unknown`,
    );
    invariant(
      !files.has(entry.role),
      `Unicode provenance role ${entry.role} is duplicated`,
    );
    invariant(
      entry.file === expected.file,
      `Unicode provenance file for ${entry.role} is invalid`,
    );
    invariant(
      entry.sourceUrl === expected.sourceUrl,
      `Unicode provenance URL for ${entry.role} is invalid`,
    );
    invariant(
      Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0,
      `Unicode provenance byte length for ${entry.role} is invalid`,
    );
    invariant(
      SHA256.test(entry.sha256),
      `Unicode provenance SHA-256 for ${entry.role} is invalid`,
    );
    files.set(entry.role, entry);
  }
  invariant(
    JSON.stringify([...files.keys()]) === JSON.stringify(expectedRoles),
    "Unicode provenance roles are not in bytewise canonical order",
  );
  const licenseEntry = files.get("license");
  invariant(
    licenseEntry.byteLength === value.license.byteLength && licenseEntry.sha256 === value.license.sha256,
    "Unicode top-level license provenance differs from its file entry",
  );
  return { provenance: value, files };
}

async function readSources(validated) {
  const sources = new Map();
  const sourceSet = createHash("sha256");
  sourceSet.update(SOURCE_SET_DOMAIN);
  for (const [role, entry] of validated.files) {
    invariant(
      path.basename(entry.file) === entry.file,
      `${role} file must be a basename`,
    );
    const url = new URL(entry.file, SOURCE_DIRECTORY);
    const metadata = await lstat(url);
    invariant(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `${role} must be a regular file`,
    );
    const bytes = await readFile(url);
    invariant(
      bytes.byteLength === entry.byteLength,
      `${role} byte length does not match provenance`,
    );
    invariant(
      sha256(bytes) === entry.sha256,
      `${role} SHA-256 does not match provenance`,
    );
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${role} is not valid UTF-8`, { cause: error });
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    sourceSet.update(role);
    sourceSet.update("\0");
    sourceSet.update(length);
    sourceSet.update(bytes);
    sources.set(role, text);
  }
  invariant(
    sourceSet.digest("hex") === validated.provenance.sourceSetSha256,
    "Unicode aggregate source-set SHA-256 does not match provenance",
  );
  return sources;
}

function encodeUnsigned(value, output) {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    "packed integer is invalid",
  );
  let remaining = value;
  while (remaining >= 0x80) {
    output.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  output.push(remaining);
}

function packedBytes(output) {
  return Buffer.from(Uint8Array.from(output)).toString("base64");
}

export function packRangeRows(rows, valueColumns, label) {
  const output = [];
  let previousEnd = -1;
  for (const [index, row] of rows.entries()) {
    invariant(
      row.start > previousEnd,
      `${label} row ${index + 1} is not ordered`,
    );
    invariant(
      row.end >= row.start && row.end <= MAX_CODE_POINT,
      `${label} row ${index + 1} is invalid`,
    );
    const values = row.values ?? (valueColumns === 0 ? [] : [row.value]);
    invariant(
      values.length === valueColumns,
      `${label} row ${index + 1} has wrong value width`,
    );
    encodeUnsigned(row.start - previousEnd - 1, output);
    encodeUnsigned(row.end - row.start, output);
    for (const value of values) encodeUnsigned(value, output);
    previousEnd = row.end;
  }
  return Object.freeze({
    rowCount: rows.length,
    valueColumns,
    encoding: "delta-uleb128-v1",
    base64: packedBytes(output),
    byteLength: output.length,
  });
}

function sequenceCompare(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function makeSequencePool(sequences, label) {
  const uniqueByKey = new Map();
  for (const sequence of sequences) {
    invariant(sequence.length > 0, `${label} contains an empty sequence`);
    uniqueByKey.set(sequence.join(","), sequence);
  }
  const unique = [...uniqueByKey.values()].sort(sequenceCompare);
  const ids = new Map(
    unique.map((sequence, index) => [sequence.join(","), index + 1]),
  );
  const output = [];
  for (const sequence of unique) {
    encodeUnsigned(sequence.length, output);
    for (const value of sequence) encodeUnsigned(value, output);
  }
  return {
    ids,
    packed: Object.freeze({
      sequenceCount: unique.length,
      encoding: "length-uleb128-v1",
      base64: packedBytes(output),
      byteLength: output.length,
    }),
  };
}

function packTuples(tuples, valueColumns, label) {
  const output = [];
  for (const [index, tuple] of tuples.entries()) {
    invariant(
      tuple.length === valueColumns,
      `${label} tuple ${index + 1} has wrong width`,
    );
    for (const value of tuple) encodeUnsigned(value, output);
  }
  return Object.freeze({
    rowCount: tuples.length,
    valueColumns,
    encoding: "uleb128-tuples-v1",
    base64: packedBytes(output),
    byteLength: output.length,
  });
}

function tableLiteral(table) {
  const countKey = Object.hasOwn(table, "rowCount")
    ? "rowCount"
    : "sequenceCount";
  return `Object.freeze({ ${countKey}: ${table[countKey]}, ${
    countKey === "rowCount" ? `valueColumns: ${table.valueColumns}, ` : ""
  }encoding: ${JSON.stringify(table.encoding)} as const, base64: ${JSON.stringify(table.base64)} })`;
}

function renderSnapshot(snapshot) {
  const tables = Object.entries(snapshot.tables)
    .map(([name, table]) => `    ${name}: ${tableLiteral(table)},`)
    .join("\n");
  return `export interface PackedUnicodeRows {\n  readonly rowCount: number;\n  readonly valueColumns: number;\n  readonly encoding: "delta-uleb128-v1" | "uleb128-tuples-v1";\n  readonly base64: string;\n}\n\nexport interface PackedUnicodeSequences {\n  readonly sequenceCount: number;\n  readonly encoding: "length-uleb128-v1";\n  readonly base64: string;\n}\n\n/**\n * Generated from hash-verified Unicode 17 sources under the Unicode License v3.\n * See data-src/unicode/provenance.json. Do not edit manually.\n */\nexport const UNICODE_SNAPSHOT = Object.freeze({\n  unicodeVersion: ${JSON.stringify(snapshot.metadata.unicodeVersion)},\n  uts39Revision: ${snapshot.metadata.uts39Revision},\n  uts46Revision: ${snapshot.metadata.uts46Revision},\n  captured: ${JSON.stringify(snapshot.metadata.captured)},\n  sourceSetSha256: ${JSON.stringify(snapshot.metadata.sourceSetSha256)},\n  completeness: "complete" as const,\n  idnaStatuses: Object.freeze(${JSON.stringify(snapshot.idnaStatuses)} as const),\n  bidiClasses: Object.freeze(${JSON.stringify(snapshot.bidiClasses)} as const),\n  joiningTypes: Object.freeze(${JSON.stringify(snapshot.joiningTypes)} as const),\n  scriptNames: Object.freeze(${JSON.stringify(snapshot.scriptNames)} as const),\n  tables: Object.freeze({\n${tables}\n  }),\n});\n`;
}

function buildPackedSnapshot(sources, provenance) {
  for (const [role, text] of sources) {
    // UnicodeData.txt deliberately has no self-identifying header; its
    // version is anchored by the versioned source URL and exact hash.
    if (role !== "license" && role !== "unicode-data")
      assertVersion(text, role);
  }
  invariant(
    sources.get("license").startsWith("UNICODE LICENSE V3\n"),
    "Unicode license is invalid",
  );

  const aliasesText = sources.get("property-value-aliases");
  const scriptsAliasData = aliasMapForProperty(aliasesText, "sc", "Script");
  const bidiAliasData = aliasMapForProperty(aliasesText, "bc", "Bidi_Class");
  const idna = parseIdnaMappingTable(sources.get("idna-mapping"));
  const confusables = parseConfusables(sources.get("confusables"));
  const scripts = parseScripts(
    sources.get("scripts"),
    scriptsAliasData.aliases,
  );
  const scriptExtensions = parseScriptExtensions(
    sources.get("script-extensions"),
    scriptsAliasData.aliases,
  );
  const scriptNames = [...scriptsAliasData.shortNames].sort(compareBytes);
  invariant(scriptNames.includes("Zzzz"), "Script aliases lack Unknown");
  const scriptIds = new Map(scriptNames.map((name, index) => [name, index]));
  const unicodeData = parseUnicodeData(sources.get("unicode-data"));
  const compositionExclusions = parsePropertyRanges(
    sources.get("normalization-properties"),
    "Full_Composition_Exclusion",
    "DerivedNormalizationProps",
  );
  const compositions = canonicalCompositions(
    unicodeData.decompositions,
    compositionExclusions,
  );
  const defaultIgnorables = parsePropertyRanges(
    sources.get("core-properties"),
    "Default_Ignorable_Code_Point",
    "DerivedCoreProperties",
  );
  const identifierAllowed = parseIdentifierAllowed(
    sources.get("identifier-status"),
  );
  const bidiClasses = parseBidiClasses(
    sources.get("bidi-class"),
    bidiAliasData.aliases,
  );
  const joiningTypes = parseJoiningTypes(sources.get("joining-type"));
  const bidiMirrors = parsePointMappings(
    sources.get("bidi-mirroring"),
    "BidiMirroring",
  );
  const pairedBrackets = parsePairedBrackets(sources.get("bidi-brackets"));

  const idnaMappings = makeSequencePool(
    idna.filter((row) => row.mapping.length > 0).map((row) => row.mapping),
    "IDNA mappings",
  );
  const decompositionPool = makeSequencePool(
    unicodeData.decompositions.map((row) => row.mapping),
    "canonical decompositions",
  );
  const scriptSetPool = makeSequencePool(
    scriptExtensions.map((row) =>
      row.scripts.map((script) => {
        const id = scriptIds.get(script);
        invariant(
          id !== undefined,
          `Script_Extensions references unknown script ${script}`,
        );
        return id;
      }),
    ),
    "Script_Extensions sets",
  );
  const confusablePool = makeSequencePool(
    confusables.map((row) => row.prototype),
    "confusable prototypes",
  );

  const tables = {
    idnaRanges: packRangeRows(
      idna.map((row) => ({
        start: row.start,
        end: row.end,
        values: [
          IDNA_STATUSES.indexOf(row.status),
          idnaMappings.ids.get(row.mapping.join(",")) ?? 0,
        ],
      })),
      2,
      "IDNA ranges",
    ),
    idnaMappings: idnaMappings.packed,
    combiningClassRanges: packRangeRows(
      unicodeData.combiningClasses,
      1,
      "combining classes",
    ),
    canonicalDecompositions: packRangeRows(
      unicodeData.decompositions.map((row) => ({
        start: row.start,
        end: row.end,
        value: decompositionPool.ids.get(row.mapping.join(",")),
      })),
      1,
      "canonical decompositions",
    ),
    canonicalDecompositionPool: decompositionPool.packed,
    canonicalCompositions: packTuples(
      compositions,
      3,
      "canonical compositions",
    ),
    markRanges: packRangeRows(unicodeData.markRanges, 0, "Mark ranges"),
    defaultIgnorableRanges: packRangeRows(
      defaultIgnorables,
      0,
      "Default_Ignorable ranges",
    ),
    identifierAllowedRanges: packRangeRows(
      identifierAllowed,
      0,
      "IdentifierStatus Allowed ranges",
    ),
    scriptRanges: packRangeRows(
      scripts.map((row) => ({
        start: row.start,
        end: row.end,
        value: scriptIds.get(row.script),
      })),
      1,
      "Script ranges",
    ),
    scriptExtensionRanges: packRangeRows(
      scriptExtensions.map((row) => ({
        start: row.start,
        end: row.end,
        value: scriptSetPool.ids.get(
          row.scripts.map((script) => scriptIds.get(script)).join(","),
        ),
      })),
      1,
      "Script_Extensions ranges",
    ),
    scriptSets: scriptSetPool.packed,
    bidiClassRanges: packRangeRows(bidiClasses, 1, "Bidi_Class ranges"),
    joiningTypeRanges: packRangeRows(joiningTypes, 1, "Joining_Type ranges"),
    bidiMirrors: packRangeRows(bidiMirrors, 1, "Bidi_Mirroring pairs"),
    pairedBrackets: packRangeRows(pairedBrackets, 2, "Bidi paired brackets"),
    confusables: packRangeRows(
      confusables.map((row) => ({
        start: row.start,
        end: row.end,
        value: confusablePool.ids.get(row.prototype.join(",")),
      })),
      1,
      "confusables",
    ),
    confusablePrototypes: confusablePool.packed,
  };

  return {
    metadata: {
      unicodeVersion: provenance.unicodeVersion,
      uts39Revision: provenance.uts39Revision,
      uts46Revision: provenance.uts46Revision,
      captured: provenance.captured,
      sourceSetSha256: provenance.sourceSetSha256,
    },
    idnaStatuses: IDNA_STATUSES,
    bidiClasses: BIDI_CLASSES,
    joiningTypes: JOINING_TYPES,
    scriptNames,
    tables,
    counts: {
      idnaRanges: idna.length,
      confusables: confusables.length,
      scripts: scripts.length,
      scriptExtensions: scriptExtensions.length,
      decompositions: unicodeData.decompositions.length,
      compositions: compositions.length,
    },
  };
}

export async function buildUnicodeSnapshot({ check = false } = {}) {
  const validated = validateProvenance(
    await readJsonFile(PROVENANCE_URL, "Unicode provenance"),
  );
  const sources = await readSources(validated);
  const snapshot = buildPackedSnapshot(sources, validated.provenance);
  const rendered = renderSnapshot(snapshot);
  await writeGeneratedFile(OUTPUT_URL, rendered, check);
  const packedByteLength = Object.values(snapshot.tables).reduce(
    (total, table) => total + table.byteLength,
    0,
  );
  return {
    ...snapshot.counts,
    packedByteLength,
    generatedByteLength: Buffer.byteLength(rendered),
    sourceSetSha256: validated.provenance.sourceSetSha256,
  };
}

if (isDirectExecution(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.some((argument) => argument !== "--check") ||
    arguments_.length > 1
  ) {
    throw new Error("usage: node scripts/build-data/unicode.mjs [--check]");
  }
  const check = arguments_[0] === "--check";
  const generated = await buildUnicodeSnapshot({ check });
  process.stdout.write(
    `${check ? "verified" : "generated"} Unicode ${UNICODE_VERSION} snapshot (${generated.packedByteLength} packed bytes; ${generated.generatedByteLength} TypeScript bytes)\n`,
  );
}
