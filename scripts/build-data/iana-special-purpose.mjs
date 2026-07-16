import { createHash } from "node:crypto";

import {
  assertExactKeys,
  invariant,
  isDirectExecution,
  readJsonFile,
  readVerifiedUtf8,
  writeGeneratedFile,
} from "./shared.mjs";

const SOURCE_DIRECTORY = new URL("../../data-src/iana/", import.meta.url);
const PROVENANCE_URL = new URL("provenance.json", SOURCE_DIRECTORY);
const OUTPUT_URL = new URL("../../src/data/ianaSpecialPurposeSnapshot.ts", import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SET_DOMAIN = "QRWARDEN-IANA-SOURCE-SET-1\0";
const SPECIAL_HEADER = Object.freeze([
  "Address Block",
  "Name",
  "RFC",
  "Allocation Date",
  "Termination Date",
  "Source",
  "Destination",
  "Forwardable",
  "Globally Reachable",
  "Reserved-by-Protocol",
]);
const EXPECTED_FILES = Object.freeze({
  "ipv4-special-csv": "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv",
  "ipv4-special-xml": "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xml",
  "ipv6-special-csv": "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv",
  "ipv6-special-xml": "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xml",
  "ipv4-address-space-csv": "https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv",
  "ipv4-address-space-xml": "https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.xml",
  "ipv6-address-space-csv": "https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space-1.csv",
  "ipv6-address-space-xml": "https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xml",
});

export function parseCsv(text) {
  invariant(typeof text === "string" && text.length > 0, "CSV source must be nonempty text");
  invariant(!text.startsWith("\ufeff"), "CSV source must not contain a BOM");
  invariant(!text.includes("\u0000"), "CSV source contains NUL");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;

  const pushField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const pushRow = () => {
    pushField();
    invariant(row.some((value) => value !== ""), `CSV contains a blank row at ${rows.length + 1}`);
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else if (character === "\r") {
        invariant(text[index + 1] === "\n", "CSV contains a bare carriage return");
        field += "\n";
        index += 1;
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote) {
      invariant(
        character === "," || character === "\r" || character === "\n",
        "CSV has characters after a closing quote",
      );
    }
    if (character === '"') {
      invariant(field.length === 0 && !closedQuote, "CSV has a quote in an unquoted field");
      inQuotes = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r") {
      invariant(text[index + 1] === "\n", "CSV contains a bare carriage return");
      pushRow();
      index += 1;
    } else if (character === "\n") {
      pushRow();
    } else {
      invariant(!closedQuote, "CSV has characters after a closing quote");
      field += character;
    }
  }
  invariant(!inQuotes, "CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) pushRow();
  invariant(rows.length >= 2, "CSV must contain a header and at least one record");
  const width = rows[0].length;
  for (let index = 1; index < rows.length; index += 1) {
    invariant(rows[index].length === width, `CSV row ${index + 1} has ${rows[index].length} fields; expected ${width}`);
  }
  return rows;
}

function stripFootnotes(value) {
  return value.replace(/(?:\s*\[\d+\])+\s*$/u, "").trim();
}

function parseRegistryBoolean(value, allowBlank, label) {
  const normalized = stripFootnotes(value);
  if (normalized === "True") return true;
  if (normalized === "False" || normalized === "N/A") return false;
  if (normalized === "" && allowBlank) return false;
  throw new Error(`${label} has invalid boolean value ${JSON.stringify(value)}`);
}

function parseIpv4Address(value, label) {
  const parts = value.split(".");
  invariant(parts.length === 4, `${label} is not an IPv4 address`);
  let numeric = 0;
  for (const part of parts) {
    invariant(/^(?:0|[1-9]\d{0,2})$/.test(part), `${label} has an invalid IPv4 octet`);
    const octet = Number(part);
    invariant(octet <= 255, `${label} has an out-of-range IPv4 octet`);
    numeric = numeric * 256 + octet;
  }
  return numeric >>> 0;
}

function ipv4Text(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function parseIpv4Prefix(value, label) {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(value);
  invariant(match !== null, `${label} is not an IPv4 prefix`);
  const bits = Number(match[2]);
  invariant(bits >= 0 && bits <= 32, `${label} has an invalid prefix length`);
  const numeric = parseIpv4Address(match[1], label);
  const hostBits = 32 - bits;
  const network = hostBits === 32 ? 0 : Number((BigInt(numeric) >> BigInt(hostBits)) << BigInt(hostBits));
  invariant(network === numeric, `${label} is not network-aligned`);
  return { prefix: ipv4Text(numeric), bits, numeric: BigInt(numeric) };
}

function parseIpv6Address(value, label) {
  const normalized = value.toLowerCase();
  invariant(!normalized.includes(".") && !normalized.includes("%"), `${label} has unsupported IPv6 syntax`);
  const halves = normalized.split("::");
  invariant(halves.length <= 2, `${label} has more than one IPv6 compression marker`);
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  invariant(
    halves.length === 1 ? left.length === 8 : left.length + right.length < 8,
    `${label} has the wrong number of IPv6 groups`,
  );
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  invariant(groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)), `${label} has an invalid IPv6 group`);
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6Text(value) {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; start += 1) {
    if (groups[start] !== "0") continue;
    let end = start;
    while (end < groups.length && groups[end] === "0") end += 1;
    const length = end - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
    start = end - 1;
  }
  if (bestStart < 0) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function parseIpv6Prefix(value, label) {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
  invariant(match !== null, `${label} is not an IPv6 prefix`);
  const bits = Number(match[2]);
  invariant(bits >= 0 && bits <= 128, `${label} has an invalid prefix length`);
  const numeric = parseIpv6Address(match[1], label);
  const hostBits = 128 - bits;
  const network = hostBits === 128 ? 0n : (numeric >> BigInt(hostBits)) << BigInt(hostBits);
  invariant(network === numeric, `${label} is not network-aligned`);
  return { prefix: ipv6Text(numeric), bits, numeric };
}

function normalizedCategory(value, label) {
  const normalized = value.normalize("NFC").trim();
  invariant(normalized.length > 0 && normalized.length <= 160, `${label} has an invalid name`);
  invariant(!/[\u0000-\u001f\u007f]/u.test(normalized), `${label} name contains a control character`);
  return normalized;
}

export function parseSpecialPurposeRegistry(text, version) {
  invariant(version === 4 || version === 6, "IP registry version must be 4 or 6");
  const rows = parseCsv(text);
  invariant(JSON.stringify(rows[0]) === JSON.stringify(SPECIAL_HEADER), `IPv${version} special-purpose CSV header is invalid`);
  const entries = [];
  const seen = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const label = `IPv${version} special-purpose row ${index + 1}`;
    const termination = row[4].trim();
    invariant(termination === "N/A" || /^\d{4}-\d{2}$/.test(termination), `${label} has an invalid termination date`);
    const allowBlank = termination !== "N/A";
    for (const column of [5, 6, 7, 8, 9]) {
      parseRegistryBoolean(row[column], allowBlank, `${label} column ${SPECIAL_HEADER[column]}`);
    }
    const globallyReachable = parseRegistryBoolean(row[8], allowBlank, `${label} globally reachable`);
    const category = normalizedCategory(row[1], label);
    const addresses = stripFootnotes(row[0]).split(",").map((address) => address.trim());
    invariant(addresses.length > 0 && addresses.every(Boolean), `${label} has no address blocks`);
    for (const address of addresses) {
      const parsed = version === 4
        ? parseIpv4Prefix(address, label)
        : parseIpv6Prefix(address, label);
      const key = `${parsed.prefix}/${parsed.bits}`;
      invariant(!seen.has(key), `${label} duplicates ${key}`);
      seen.add(key);
      entries.push({ ...parsed, category, globallyReachable });
    }
  }
  entries.sort((left, right) =>
    left.numeric < right.numeric
      ? -1
      : left.numeric > right.numeric
        ? 1
        : right.bits - left.bits,
  );
  return entries;
}

export function parseRegistryUpdated(xml, label) {
  invariant(typeof xml === "string" && !xml.includes("\u0000"), `${label} XML is invalid`);
  const matches = [...xml.matchAll(/<updated>(\d{4}-\d{2}-\d{2})<\/updated>/g)];
  invariant(matches.length === 1, `${label} XML must contain exactly one updated date`);
  return matches[0][1];
}

function ipv4MulticastSupplement(text) {
  const rows = parseCsv(text);
  const header = ["Prefix", "Designation", "Date", "WHOIS", "RDAP", "Status [1]", "Note"];
  invariant(JSON.stringify(rows[0]) === JSON.stringify(header), "IPv4 address-space CSV header is invalid");
  const multicast = rows.slice(1).filter((row) => {
    const match = /^(\d{3})\/8$/.exec(row[0]);
    return match !== null && Number(match[1]) >= 224 && Number(match[1]) <= 239;
  });
  invariant(multicast.length === 16, "IPv4 address-space registry lacks the complete multicast block");
  for (let index = 0; index < multicast.length; index += 1) {
    invariant(multicast[index][0] === `${224 + index}/8`, "IPv4 multicast rows are not contiguous");
    invariant(multicast[index][1] === "Multicast" && multicast[index][5] === "RESERVED", "IPv4 multicast row is malformed");
  }
  return { ...parseIpv4Prefix("224.0.0.0/4", "IPv4 multicast supplement"), category: "Multicast", globallyReachable: false };
}

function ipv6MulticastSupplement(text) {
  const rows = parseCsv(text);
  const header = ["IPv6 Prefix", "Allocation", "Reference", "Notes"];
  invariant(JSON.stringify(rows[0]) === JSON.stringify(header), "IPv6 address-space CSV header is invalid");
  const multicast = rows.slice(1).filter((row) => row[0].toLowerCase() === "ff00::/8");
  invariant(multicast.length === 1 && multicast[0][1] === "Multicast", "IPv6 address-space registry lacks ff00::/8 Multicast");
  return { ...parseIpv6Prefix("ff00::/8", "IPv6 multicast supplement"), category: "Multicast", globallyReachable: false };
}

function renderRanges(entries) {
  return `Object.freeze([\n${entries
    .map(
      (entry) =>
        `    [${JSON.stringify(entry.prefix)}, ${entry.bits}, ${JSON.stringify(entry.category)}, ${entry.globallyReachable}],`,
    )
    .join("\n")}\n  ] as const)`;
}

export function renderIanaSnapshot(ipv4, ipv6, provenance, files) {
  const v4Special = files.get("ipv4-special-csv");
  const v6Special = files.get("ipv6-special-csv");
  const v4Address = files.get("ipv4-address-space-csv");
  const v6Address = files.get("ipv6-address-space-csv");
  return `export interface Ipv4SpecialRange {\n  readonly prefix: string;\n  readonly bits: number;\n  readonly category: string;\n  readonly globallyReachable: boolean;\n}\n\nexport interface Ipv6SpecialRange {\n  readonly prefix: string;\n  readonly bits: number;\n  readonly category: string;\n  readonly globallyReachable: boolean;\n}\n\n/**\n * Generated from IANA protocol registry data made available under CC0-1.0.\n * See data-src/iana/provenance.json. Do not edit manually.\n */\nexport const IANA_SPECIAL_PURPOSE_SNAPSHOT = Object.freeze({\n  sourceV4: ${JSON.stringify(v4Special.sourceUrl)},\n  sourceV6: ${JSON.stringify(v6Special.sourceUrl)},\n  supplementalSourceV4: ${JSON.stringify(v4Address.sourceUrl)},\n  supplementalSourceV6: ${JSON.stringify(v6Address.sourceUrl)},\n  sourceVersionV4: ${JSON.stringify(v4Special.sourceVersion)},\n  sourceVersionV6: ${JSON.stringify(v6Special.sourceVersion)},\n  sourceSha256V4: ${JSON.stringify(v4Special.sha256)},\n  sourceSha256V6: ${JSON.stringify(v6Special.sha256)},\n  sourceSetSha256: ${JSON.stringify(provenance.sourceSetSha256)},\n  captured: ${JSON.stringify(provenance.captured)},\n  completeness: "complete" as const,\n  ipv4: ${renderRanges(ipv4)},\n  ipv6: ${renderRanges(ipv6)},\n});\n`;
}

function validateProvenance(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "dataset", "captured", "sourceSetSha256", "license", "files"],
    "IANA provenance",
  );
  invariant(value.schemaVersion === 1, "IANA provenance schemaVersion must be 1");
  invariant(value.dataset === "IANA IP registries used by QRWarden", "IANA provenance dataset is invalid");
  invariant(DATE.test(value.captured), "IANA provenance capture date is invalid");
  invariant(SHA256.test(value.sourceSetSha256), "IANA source-set SHA-256 is invalid");
  assertExactKeys(
    value.license,
    ["expression", "termsUrl", "textUrl", "file", "byteLength", "sha256"],
    "IANA license provenance",
  );
  invariant(value.license.expression === "CC0-1.0", "IANA license expression is invalid");
  invariant(value.license.termsUrl === "https://www.iana.org/help/licensing-terms", "IANA license terms URL is invalid");
  invariant(
    value.license.textUrl === "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
    "IANA license text URL is invalid",
  );
  invariant(value.license.file === "CC0-1.0.txt", "IANA license file is invalid");
  invariant(Array.isArray(value.files) && value.files.length === Object.keys(EXPECTED_FILES).length, "IANA provenance file inventory is incomplete");
  const files = new Map();
  for (const [index, entry] of value.files.entries()) {
    assertExactKeys(entry, ["role", "sourceUrl", "sourceVersion", "file", "byteLength", "sha256"], `IANA provenance file ${index + 1}`);
    invariant(Object.hasOwn(EXPECTED_FILES, entry.role), `IANA provenance role ${entry.role} is unknown`);
    invariant(!files.has(entry.role), `IANA provenance role ${entry.role} is duplicated`);
    invariant(entry.sourceUrl === EXPECTED_FILES[entry.role], `IANA provenance URL for ${entry.role} is invalid`);
    invariant(DATE.test(entry.sourceVersion), `IANA source version for ${entry.role} is invalid`);
    invariant(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, `IANA byte length for ${entry.role} is invalid`);
    invariant(SHA256.test(entry.sha256), `IANA SHA-256 for ${entry.role} is invalid`);
    files.set(entry.role, entry);
  }
  invariant(
    JSON.stringify([...files.keys()]) === JSON.stringify(Object.keys(EXPECTED_FILES)),
    "IANA provenance roles are not in canonical order",
  );
  return { provenance: value, files };
}

export async function buildIanaSpecialPurposeSnapshot({ check = false } = {}) {
  const validated = validateProvenance(await readJsonFile(PROVENANCE_URL, "IANA provenance"));
  const sources = new Map();
  const sourceSet = createHash("sha256").update(SOURCE_SET_DOMAIN);
  for (const [role, entry] of validated.files) {
    const text = await readVerifiedUtf8(SOURCE_DIRECTORY, entry, `IANA ${role}`);
    const bytes = Buffer.from(text, "utf8");
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
    "IANA aggregate source-set SHA-256 does not match provenance",
  );
  const license = await readVerifiedUtf8(SOURCE_DIRECTORY, validated.provenance.license, "IANA license");
  invariant(license.startsWith("Creative Commons Legal Code\n\nCC0 1.0 Universal\n"), "IANA CC0 text is invalid");
  for (const pair of [
    ["ipv4-special-csv", "ipv4-special-xml"],
    ["ipv6-special-csv", "ipv6-special-xml"],
    ["ipv4-address-space-csv", "ipv4-address-space-xml"],
    ["ipv6-address-space-csv", "ipv6-address-space-xml"],
  ]) {
    const csvEntry = validated.files.get(pair[0]);
    const xmlEntry = validated.files.get(pair[1]);
    invariant(csvEntry.sourceVersion === xmlEntry.sourceVersion, `IANA versions disagree for ${pair[0]}`);
    invariant(parseRegistryUpdated(sources.get(pair[1]), pair[1]) === xmlEntry.sourceVersion, `IANA XML version disagrees for ${pair[1]}`);
  }

  const ipv4 = parseSpecialPurposeRegistry(sources.get("ipv4-special-csv"), 4);
  const ipv6 = parseSpecialPurposeRegistry(sources.get("ipv6-special-csv"), 6);
  ipv4.push(ipv4MulticastSupplement(sources.get("ipv4-address-space-csv")));
  ipv6.push(ipv6MulticastSupplement(sources.get("ipv6-address-space-csv")));
  for (const entries of [ipv4, ipv6]) {
    entries.sort((left, right) =>
      left.numeric < right.numeric
        ? -1
        : left.numeric > right.numeric
          ? 1
          : right.bits - left.bits,
    );
    const keys = entries.map((entry) => `${entry.prefix}/${entry.bits}`);
    invariant(new Set(keys).size === keys.length, "IANA generated ranges contain a duplicate prefix");
  }
  invariant(ipv4.length >= 25, "IANA IPv4 special-purpose registry is unexpectedly small");
  invariant(ipv6.length >= 25, "IANA IPv6 special-purpose registry is unexpectedly small");
  await writeGeneratedFile(
    OUTPUT_URL,
    renderIanaSnapshot(ipv4, ipv6, validated.provenance, validated.files),
    check,
  );
  return { ipv4, ipv6, provenance: validated.provenance, files: validated.files };
}

if (isDirectExecution(import.meta.url)) {
  const generated = await buildIanaSpecialPurposeSnapshot();
  process.stdout.write(
    `generated IANA snapshot (${generated.ipv4.length} IPv4 and ${generated.ipv6.length} IPv6 ranges)\n`,
  );
}
