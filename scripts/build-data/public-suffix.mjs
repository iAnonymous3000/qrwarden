import { domainToASCII } from "node:url";

import {
  assertExactKeys,
  invariant,
  isDirectExecution,
  readJsonFile,
  readVerifiedUtf8,
  writeGeneratedFile,
} from "./shared.mjs";

const SOURCE_DIRECTORY = new URL("../../data-src/psl/", import.meta.url);
const PROVENANCE_URL = new URL("provenance.json", SOURCE_DIRECTORY);
const OUTPUT_URL = new URL("../../src/data/publicSuffixSnapshot.ts", import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC$/;
const MPL_NOTICE = [
  "// This Source Code Form is subject to the terms of the Mozilla Public",
  "// License, v. 2.0. If a copy of the MPL was not distributed with this",
  "// file, You can obtain one at https://mozilla.org/MPL/2.0/.",
  "",
].join("\n");

const MARKERS = Object.freeze({
  beginIcann: "// ===BEGIN ICANN DOMAINS===",
  endIcann: "// ===END ICANN DOMAINS===",
  beginPrivate: "// ===BEGIN PRIVATE DOMAINS===",
  endPrivate: "// ===END PRIVATE DOMAINS===",
});

function canonicalRule(rawRule, lineNumber) {
  const prefix = rawRule.startsWith("!") ? "!" : rawRule.startsWith("*.") ? "*." : "";
  const domain = rawRule.slice(prefix.length);
  invariant(domain.length > 0, `PSL line ${lineNumber} has an empty rule`);
  invariant(!/[!*/\s]/u.test(domain), `PSL line ${lineNumber} has invalid rule syntax`);
  invariant(!domain.startsWith(".") && !domain.endsWith("."), `PSL line ${lineNumber} has an empty label`);
  const ascii = domainToASCII(domain.normalize("NFC")).toLowerCase();
  invariant(ascii.length > 0, `PSL line ${lineNumber} is not a valid IDNA domain`);
  invariant(
    ascii
      .split(".")
      .every(
        (label) =>
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      ),
    `PSL line ${lineNumber} has an invalid label`,
  );
  invariant(ascii.length <= 253, `PSL line ${lineNumber} exceeds the DNS name limit`);
  return `${prefix}${ascii}`;
}

function addRule(collection, seen, rule, lineNumber) {
  invariant(!seen.has(rule), `PSL line ${lineNumber} duplicates ${rule}`);
  seen.add(rule);
  collection.push(rule);
}

export function parsePublicSuffixList(text, expectedMetadata = null) {
  invariant(typeof text === "string" && text.length > 0, "PSL source must be nonempty text");
  invariant(!text.includes("\u0000"), "PSL source contains NUL");
  invariant(!text.startsWith("\ufeff"), "PSL source must not contain a BOM");
  const normalized = text.replace(/\r\n/g, "\n");
  invariant(!normalized.includes("\r"), "PSL source contains a bare carriage return");
  const lines = normalized.split("\n");
  const versionLines = lines.filter((line) => line.startsWith("// VERSION: "));
  const commitLines = lines.filter((line) => line.startsWith("// COMMIT: "));
  invariant(versionLines.length === 1, "PSL source must contain exactly one VERSION line");
  invariant(commitLines.length === 1, "PSL source must contain exactly one COMMIT line");
  const sourceVersion = versionLines[0].slice("// VERSION: ".length);
  const sourceCommit = commitLines[0].slice("// COMMIT: ".length);
  invariant(VERSION.test(sourceVersion), "PSL VERSION line is malformed");
  invariant(COMMIT.test(sourceCommit), "PSL COMMIT line is malformed");
  if (expectedMetadata !== null) {
    invariant(sourceVersion === expectedMetadata.sourceVersion, "PSL VERSION does not match provenance");
    invariant(sourceCommit === expectedMetadata.sourceCommit, "PSL COMMIT does not match provenance");
  }

  const result = {
    sourceVersion,
    sourceCommit,
    icannRules: [],
    privateRules: [],
    wildcardRules: [],
    privateWildcardRules: [],
    exceptionRules: [],
    privateExceptionRules: [],
  };
  const seen = new Set();
  let state = "before";
  const transitions = {
    before: [MARKERS.beginIcann, "icann"],
    icann: [MARKERS.endIcann, "between"],
    between: [MARKERS.beginPrivate, "private"],
    private: [MARKERS.endPrivate, "after"],
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const sourceLine = lines[index];
    const line = sourceLine.trim();
    const transition = transitions[state];
    if (transition !== undefined && line === transition[0]) {
      invariant(sourceLine === line, `PSL line ${lineNumber} has surrounding whitespace`);
      state = transition[1];
      continue;
    }
    invariant(
      !Object.values(MARKERS).includes(line),
      `PSL line ${lineNumber} has an out-of-order section marker`,
    );
    if (line === "" || line.startsWith("//")) continue;
    invariant(sourceLine === line, `PSL line ${lineNumber} has surrounding whitespace`);
    invariant(state === "icann" || state === "private", `PSL line ${lineNumber} is outside a domain section`);
    const rule = canonicalRule(line, lineNumber);
    const isPrivate = state === "private";
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      addRule(
        isPrivate ? result.privateWildcardRules : result.wildcardRules,
        seen,
        `*.${base}`,
        lineNumber,
      );
    } else if (rule.startsWith("!")) {
      const base = rule.slice(1);
      addRule(
        isPrivate ? result.privateExceptionRules : result.exceptionRules,
        seen,
        `!${base}`,
        lineNumber,
      );
    } else {
      addRule(isPrivate ? result.privateRules : result.icannRules, seen, rule, lineNumber);
    }
  }
  invariant(state === "after", "PSL source is missing or truncates a required section");

  for (const [exceptionKey, wildcardKey] of [
    ["exceptionRules", "wildcardRules"],
    ["privateExceptionRules", "privateWildcardRules"],
  ]) {
    const wildcardBases = new Set(result[wildcardKey].map((rule) => rule.slice(2)));
    for (const exception of result[exceptionKey]) {
      const parent = exception.slice(1).split(".").slice(1).join(".");
      invariant(
        parent.length > 0 && wildcardBases.has(parent),
        `PSL exception ${exception} has no matching wildcard rule`,
      );
    }
  }

  for (const key of [
    "icannRules",
    "privateRules",
    "wildcardRules",
    "privateWildcardRules",
    "exceptionRules",
    "privateExceptionRules",
  ]) {
    result[key].sort();
  }
  return result;
}

function renderArray(values) {
  if (values.length === 0) return "Object.freeze<string[]>([])";
  return `Object.freeze<string[]>([\n${values.map((value) => `    ${JSON.stringify(value)},`).join("\n")}\n  ])`;
}

export function renderPublicSuffixSnapshot(parsed, provenance) {
  return `/**\n * This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. If a copy of the MPL was not distributed with this\n * file, You can obtain one at https://mozilla.org/MPL/2.0/.\n *\n * Generated by scripts/build-data/public-suffix.mjs. Do not edit manually.\n */\nexport const PUBLIC_SUFFIX_SNAPSHOT = Object.freeze({\n  source: ${JSON.stringify(provenance.sourceUrl)},\n  sourceVersion: ${JSON.stringify(provenance.sourceVersion)},\n  sourceCommit: ${JSON.stringify(provenance.sourceCommit)},\n  sourceSha256: ${JSON.stringify(provenance.sha256)},\n  captured: ${JSON.stringify(provenance.captured)},\n  completeness: "complete" as const,\n  icannRules: ${renderArray(parsed.icannRules)},\n  privateRules: ${renderArray(parsed.privateRules)},\n  wildcardRules: ${renderArray(parsed.wildcardRules.map((rule) => rule.slice(2)))},\n  privateWildcardRules: ${renderArray(parsed.privateWildcardRules.map((rule) => rule.slice(2)))},\n  exceptionRules: ${renderArray(parsed.exceptionRules.map((rule) => rule.slice(1)))},\n  privateExceptionRules: ${renderArray(parsed.privateExceptionRules.map((rule) => rule.slice(1)))},\n});\n`;
}

function validateProvenance(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "dataset",
      "captured",
      "license",
      "sourceUrl",
      "sourceRepository",
      "sourceVersion",
      "sourceCommit",
      "sourceCommitDate",
      "file",
      "byteLength",
      "sha256",
    ],
    "PSL provenance",
  );
  invariant(value.schemaVersion === 1, "PSL provenance schemaVersion must be 1");
  invariant(value.dataset === "Public Suffix List", "PSL provenance dataset is invalid");
  invariant(DATE.test(value.captured), "PSL provenance capture date is invalid");
  assertExactKeys(
    value.license,
    ["expression", "termsUrl", "textUrl", "file", "byteLength", "sha256"],
    "PSL license provenance",
  );
  invariant(value.license.expression === "MPL-2.0", "PSL license expression is invalid");
  invariant(value.license.termsUrl === "https://mozilla.org/MPL/2.0/", "PSL license terms URL is invalid");
  invariant(
    value.license.textUrl === `https://raw.githubusercontent.com/publicsuffix/list/${value.sourceCommit}/LICENSE`,
    "PSL license text URL is not pinned to the source commit",
  );
  invariant(value.license.file === "LICENSE", "PSL license file is invalid");
  invariant(value.sourceUrl === "https://publicsuffix.org/list/public_suffix_list.dat", "PSL source URL is not canonical");
  invariant(value.sourceRepository === "https://github.com/publicsuffix/list", "PSL repository URL is invalid");
  invariant(VERSION.test(value.sourceVersion), "PSL provenance sourceVersion is invalid");
  invariant(COMMIT.test(value.sourceCommit), "PSL provenance sourceCommit is invalid");
  invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.sourceCommitDate), "PSL provenance commit date is invalid");
  return value;
}

export async function buildPublicSuffixSnapshot({ check = false } = {}) {
  const provenance = validateProvenance(await readJsonFile(PROVENANCE_URL, "PSL provenance"));
  const [source, license] = await Promise.all([
    readVerifiedUtf8(SOURCE_DIRECTORY, provenance, "PSL source"),
    readVerifiedUtf8(SOURCE_DIRECTORY, provenance.license, "PSL license"),
  ]);
  invariant(source.startsWith(MPL_NOTICE), "PSL source is missing the MPL-2.0 notice");
  invariant(license.startsWith("Mozilla Public License Version 2.0\n"), "PSL license text is invalid");
  const parsed = parsePublicSuffixList(source, provenance);
  invariant(parsed.icannRules.length > 5_000, "PSL ICANN section is unexpectedly small");
  invariant(parsed.privateRules.length > 2_000, "PSL PRIVATE section is unexpectedly small");
  invariant(parsed.wildcardRules.length > 0, "PSL ICANN wildcard rules are missing");
  invariant(parsed.privateWildcardRules.length > 0, "PSL PRIVATE wildcard rules are missing");
  invariant(parsed.exceptionRules.length > 0, "PSL exception rules are missing");
  await writeGeneratedFile(OUTPUT_URL, renderPublicSuffixSnapshot(parsed, provenance), check);
  return { ...parsed, provenance };
}

if (isDirectExecution(import.meta.url)) {
  const parsed = await buildPublicSuffixSnapshot();
  process.stdout.write(
    `generated PSL snapshot (${parsed.icannRules.length} ICANN, ${parsed.privateRules.length} PRIVATE, ${parsed.wildcardRules.length + parsed.privateWildcardRules.length} wildcard, ${parsed.exceptionRules.length + parsed.privateExceptionRules.length} exception rules)\n`,
  );
}
