import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { compareBytes, normalizeUtf8Text, sha256 } from "./release-contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_PURL = /^pkg:generic\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/;
const LICENSE_KEYS = ["expression", "termsUrl", "textUrl", "file", "byteLength", "sha256"];
const COMPONENT_KEYS = [
  "purl",
  "name",
  "version",
  "captured",
  "contentSha256",
  "sourceUrls",
  "licenseExpression",
  "licenseFile",
  "licenseTextSha256",
  "licenseTermsUrl",
];
const SOURCE_SET_DOMAINS = Object.freeze({
  iana: "QRWARDEN-IANA-SOURCE-SET-1\0",
  unicode: "QRWARDEN-UNICODE-SOURCE-SET-1\0",
});
const IANA_ROLES = Object.freeze([
  "ipv4-special-csv",
  "ipv4-special-xml",
  "ipv6-special-csv",
  "ipv6-special-xml",
  "ipv4-address-space-csv",
  "ipv4-address-space-xml",
  "ipv6-address-space-csv",
  "ipv6-address-space-xml",
]);
const UNICODE_ROLES = Object.freeze([
  "bidi-brackets",
  "bidi-character-test",
  "bidi-class",
  "bidi-mirroring",
  "bidi-test",
  "confusables",
  "core-properties",
  "identifier-status",
  "idna-mapping",
  "idna-test",
  "joining-type",
  "license",
  "normalization-properties",
  "normalization-test",
  "property-value-aliases",
  "script-extensions",
  "scripts",
  "unicode-data",
]);
const ANALYZER_IDENTITIES = new Map([
  [
    "Public Suffix List",
    {
      purlName: "public-suffix-list",
      licenseExpression: "MPL-2.0",
      licenseFile: "data-src/psl/LICENSE",
      licenseTermsUrl: "https://mozilla.org/MPL/2.0/",
    },
  ],
  [
    "IANA IP Registries",
    {
      purlName: "iana-ip-registries",
      licenseExpression: "CC0-1.0",
      licenseFile: "data-src/iana/CC0-1.0.txt",
      licenseTermsUrl: "https://www.iana.org/help/licensing-terms",
    },
  ],
  [
    "Unicode Data Files",
    {
      purlName: "unicode-data",
      licenseExpression: "Unicode-3.0",
      licenseFile: "data-src/unicode/license.txt",
      licenseTermsUrl: "https://www.unicode.org/license.txt",
    },
  ],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  assert(actual.join("\0") === wanted.join("\0"), `${label} keys must be exactly: ${wanted.join(", ")}`);
}

async function readJson(root, relative, label) {
  const file = path.join(root, relative);
  const metadata = await lstat(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = await readFile(file);
  const text = normalizeUtf8Text(bytes, label);
  assert(Buffer.from(text, "utf8").equals(bytes), `${label} must be canonical LF UTF-8`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function canonicalHttpsUrl(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a nonempty URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  assert(
    parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      parsed.href === value,
    `${label} must be a canonical HTTPS URL`,
  );
  return value;
}

export function assertCanonicalGenericPurl(purl, label = "generic purl") {
  assert(typeof purl === "string", `${label} purl must be a string`);
  const match = GENERIC_PURL.exec(purl);
  assert(match !== null, `${label} purl must be a canonical generic purl`);
  return { name: match[1], version: match[2] };
}

function canonicalGenericPurl(purl, name, version, label) {
  const match = assertCanonicalGenericPurl(purl, label);
  assert(match.name === name && match.version === version, `${label} purl identity is invalid`);
  return purl;
}

async function verifiedFile(root, directory, entry, label) {
  assert(path.basename(entry.file) === entry.file, `${label} filename is invalid`);
  assert(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, `${label} byte length is invalid`);
  assert(SHA256.test(entry.sha256), `${label} SHA-256 is invalid`);
  const relative = path.posix.join("data-src", directory, entry.file);
  const absolute = path.resolve(root, relative);
  assert(absolute.startsWith(`${path.resolve(root)}${path.sep}`), `${label} path escapes the repository`);
  const metadata = await lstat(absolute);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = await readFile(absolute);
  assert(bytes.byteLength === entry.byteLength, `${label} byte length differs from provenance`);
  assert(sha256(bytes) === entry.sha256, `${label} SHA-256 differs from provenance`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
  return { bytes, relative };
}

async function verifiedSourceSet(root, directory, entries, domain, expectedDigest, label) {
  const aggregate = createHash("sha256").update(domain);
  for (const entry of entries) {
    const { bytes } = await verifiedFile(root, directory, entry, `${label} ${entry.role}`);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    aggregate.update(entry.role);
    aggregate.update("\0");
    aggregate.update(length);
    aggregate.update(bytes);
  }
  assert(aggregate.digest("hex") === expectedDigest, `${label} aggregate SHA-256 differs from provenance`);
}

async function verifiedLicense(root, directory, value, expected, label) {
  assertExactKeys(value, LICENSE_KEYS, `${label} license provenance`);
  assert(value.expression === expected.expression, `${label} license expression is invalid`);
  assert(value.termsUrl === expected.termsUrl, `${label} license terms URL is invalid`);
  assert(value.textUrl === expected.textUrl, `${label} license text URL is invalid`);
  assert(value.file === expected.file, `${label} license filename is invalid`);
  const { bytes, relative } = await verifiedFile(root, directory, value, `${label} license`);
  const normalized = normalizeUtf8Text(bytes, `${label} license`);
  assert(Buffer.from(normalized, "utf8").equals(bytes), `${label} license must be canonical LF UTF-8`);
  return {
    licenseExpression: value.expression,
    licenseFile: relative,
    licenseTextSha256: value.sha256,
    licenseTermsUrl: value.termsUrl,
  };
}

function assertBase(provenance, dataset, label) {
  assert(provenance.schemaVersion === 1, `${label} provenance schema version is invalid`);
  assert(provenance.dataset === dataset, `${label} dataset identity is invalid`);
  assert(DATE.test(provenance.captured), `${label} capture date is invalid`);
}

async function publicSuffix(root) {
  const provenance = await readJson(root, "data-src/psl/provenance.json", "PSL provenance");
  assertExactKeys(
    provenance,
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
  assertBase(provenance, "Public Suffix List", "PSL");
  assert(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC$/.test(provenance.sourceVersion), "PSL version is invalid");
  assert(/^[0-9a-f]{40}$/.test(provenance.sourceCommit), "PSL source commit is invalid");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(provenance.sourceCommitDate), "PSL source commit date is invalid");
  assert(provenance.sourceUrl === "https://publicsuffix.org/list/public_suffix_list.dat", "PSL source URL is invalid");
  assert(provenance.sourceRepository === "https://github.com/publicsuffix/list", "PSL repository URL is invalid");
  assert(provenance.file === "public_suffix_list.dat", "PSL source filename is invalid");
  assert(Number.isSafeInteger(provenance.byteLength) && provenance.byteLength > 0, "PSL source byte length is invalid");
  assert(SHA256.test(provenance.sha256), "PSL source SHA-256 is invalid");
  await verifiedFile(root, "psl", provenance, "PSL source");
  const license = await verifiedLicense(
    root,
    "psl",
    provenance.license,
    {
      expression: "MPL-2.0",
      termsUrl: "https://mozilla.org/MPL/2.0/",
      textUrl: `https://raw.githubusercontent.com/publicsuffix/list/${provenance.sourceCommit}/LICENSE`,
      file: "LICENSE",
    },
    "PSL",
  );
  return {
    purl: `pkg:generic/public-suffix-list@${provenance.sourceVersion}`,
    name: "Public Suffix List",
    version: provenance.sourceVersion,
    captured: provenance.captured,
    contentSha256: provenance.sha256,
    sourceUrls: [
      provenance.sourceUrl,
      `${provenance.sourceRepository}/tree/${provenance.sourceCommit}`,
    ],
    ...license,
  };
}

async function iana(root) {
  const provenance = await readJson(root, "data-src/iana/provenance.json", "IANA provenance");
  assertExactKeys(
    provenance,
    ["schemaVersion", "dataset", "captured", "sourceSetSha256", "license", "files"],
    "IANA provenance",
  );
  assertBase(provenance, "IANA IP registries used by QRWarden", "IANA");
  assert(SHA256.test(provenance.sourceSetSha256), "IANA source-set SHA-256 is invalid");
  assert(
    Array.isArray(provenance.files) && provenance.files.length === IANA_ROLES.length,
    "IANA source inventory is incomplete",
  );
  const roles = new Set();
  const sourceUrls = [];
  for (const [index, entry] of provenance.files.entries()) {
    assertExactKeys(
      entry,
      ["role", "sourceUrl", "sourceVersion", "file", "byteLength", "sha256"],
      `IANA source ${index + 1}`,
    );
    assert(
      entry.role === IANA_ROLES[index] && !roles.has(entry.role),
      `IANA source role ${entry.role} is invalid, out of order, or duplicated`,
    );
    assert(entry.sourceUrl.startsWith("https://www.iana.org/assignments/"), `IANA source URL for ${entry.role} is invalid`);
    canonicalHttpsUrl(entry.sourceUrl, `IANA source URL for ${entry.role}`);
    assert(DATE.test(entry.sourceVersion), `IANA source version for ${entry.role} is invalid`);
    assert(path.posix.basename(new URL(entry.sourceUrl).pathname) === entry.file, `IANA source file for ${entry.role} differs from its URL`);
    assert(path.basename(entry.file) === entry.file, `IANA source filename for ${entry.role} is invalid`);
    assert(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, `IANA source byte length for ${entry.role} is invalid`);
    assert(SHA256.test(entry.sha256), `IANA source SHA-256 for ${entry.role} is invalid`);
    roles.add(entry.role);
    sourceUrls.push(entry.sourceUrl);
  }
  await verifiedSourceSet(
    root,
    "iana",
    provenance.files,
    SOURCE_SET_DOMAINS.iana,
    provenance.sourceSetSha256,
    "IANA source set",
  );
  const license = await verifiedLicense(
    root,
    "iana",
    provenance.license,
    {
      expression: "CC0-1.0",
      termsUrl: "https://www.iana.org/help/licensing-terms",
      textUrl: "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
      file: "CC0-1.0.txt",
    },
    "IANA",
  );
  return {
    purl: `pkg:generic/iana-ip-registries@${provenance.captured}`,
    name: "IANA IP Registries",
    version: provenance.captured,
    captured: provenance.captured,
    contentSha256: provenance.sourceSetSha256,
    sourceUrls,
    ...license,
  };
}

async function unicode(root) {
  const provenance = await readJson(root, "data-src/unicode/provenance.json", "Unicode provenance");
  assertExactKeys(
    provenance,
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
  assertBase(provenance, "Unicode 17 IDNA and security data used by QRWarden", "Unicode");
  assert(provenance.unicodeVersion === "17.0.0", "Unicode version is invalid");
  assert(provenance.uts39Revision === 32, "Unicode UTS 39 revision is invalid");
  assert(provenance.uts46Revision === 35, "Unicode UTS 46 revision is invalid");
  assert(SHA256.test(provenance.sourceSetSha256), "Unicode source-set SHA-256 is invalid");
  assert(
    Array.isArray(provenance.files) && provenance.files.length === UNICODE_ROLES.length,
    "Unicode source inventory is incomplete",
  );
  const roles = new Set();
  for (const [index, entry] of provenance.files.entries()) {
    assertExactKeys(
      entry,
      ["role", "sourceUrl", "file", "byteLength", "sha256"],
      `Unicode source ${index + 1}`,
    );
    assert(
      entry.role === UNICODE_ROLES[index] && !roles.has(entry.role),
      `Unicode source role ${entry.role} is invalid, out of order, or duplicated`,
    );
    canonicalHttpsUrl(entry.sourceUrl, `Unicode source URL for ${entry.role}`);
    assert(
      entry.role === "license"
        ? entry.sourceUrl === "https://www.unicode.org/license.txt"
        : entry.sourceUrl.startsWith(`https://www.unicode.org/Public/${provenance.unicodeVersion}/`),
      `Unicode source URL for ${entry.role} is invalid`,
    );
    assert(
      path.posix.basename(new URL(entry.sourceUrl).pathname) === entry.file,
      `Unicode source file for ${entry.role} differs from its URL`,
    );
    assert(path.basename(entry.file) === entry.file, `Unicode source filename for ${entry.role} is invalid`);
    assert(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, `Unicode source byte length for ${entry.role} is invalid`);
    assert(SHA256.test(entry.sha256), `Unicode source SHA-256 for ${entry.role} is invalid`);
    roles.add(entry.role);
  }
  await verifiedSourceSet(
    root,
    "unicode",
    provenance.files,
    SOURCE_SET_DOMAINS.unicode,
    provenance.sourceSetSha256,
    "Unicode source set",
  );
  const licenseEntry = provenance.files.find((entry) => entry?.role === "license");
  assert(
    licenseEntry?.file === provenance.license.file &&
      licenseEntry.byteLength === provenance.license.byteLength &&
      licenseEntry.sha256 === provenance.license.sha256,
    "Unicode license entries disagree",
  );
  const license = await verifiedLicense(
    root,
    "unicode",
    provenance.license,
    {
      expression: "Unicode-3.0",
      termsUrl: "https://www.unicode.org/license.txt",
      textUrl: "https://www.unicode.org/license.txt",
      file: "license.txt",
    },
    "Unicode",
  );
  const sourceUrls = provenance.files
    .filter((entry) => entry.role !== "license")
    .map((entry) => entry.sourceUrl);
  return {
    purl: `pkg:generic/unicode-data@${provenance.unicodeVersion}`,
    name: "Unicode Data Files",
    version: provenance.unicodeVersion,
    captured: provenance.captured,
    contentSha256: provenance.sourceSetSha256,
    sourceUrls,
    ...license,
  };
}

export function normalizeAnalyzerDataComponents(components) {
  assert(Array.isArray(components), "analyzer data components must be an array");
  const normalized = components.map((component, index) => {
    const label = `analyzer data component ${index + 1}`;
    assertExactKeys(component, COMPONENT_KEYS, label);
    const identity = ANALYZER_IDENTITIES.get(component.name);
    assert(identity !== undefined, `${label} name is invalid`);
    assert(typeof component.version === "string" && component.version.length > 0, `${label} version is invalid`);
    canonicalGenericPurl(component.purl, identity.purlName, component.version, label);
    assert(DATE.test(component.captured), `${label} capture date is invalid`);
    assert(SHA256.test(component.contentSha256), `${label} content SHA-256 is invalid`);
    assert(component.licenseExpression === identity.licenseExpression, `${label} license expression is invalid`);
    assert(component.licenseFile === identity.licenseFile, `${label} license path is invalid`);
    assert(SHA256.test(component.licenseTextSha256), `${label} license text SHA-256 is invalid`);
    assert(component.licenseTermsUrl === identity.licenseTermsUrl, `${label} license terms URL is invalid`);
    canonicalHttpsUrl(component.licenseTermsUrl, `${label} license terms URL`);
    assert(Array.isArray(component.sourceUrls) && component.sourceUrls.length > 0, `${label} source URLs are invalid`);
    const sourceUrls = [...new Set(
      component.sourceUrls.map((url, urlIndex) => canonicalHttpsUrl(url, `${label} source URL ${urlIndex + 1}`)),
    )].sort(compareBytes);
    return { ...component, sourceUrls };
  });
  normalized.sort((left, right) => compareBytes(left.purl, right.purl));
  assert(
    new Set(normalized.map(({ purl }) => purl)).size === normalized.length,
    "analyzer data purls must be unique",
  );
  return normalized;
}

export async function loadAnalyzerDataComponents(projectRoot) {
  const root = path.resolve(projectRoot);
  const components = await Promise.all([publicSuffix(root), iana(root), unicode(root)]);
  return normalizeAnalyzerDataComponents(components);
}
