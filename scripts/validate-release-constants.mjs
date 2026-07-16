import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { domainToASCII } from "node:url";

const mode = process.argv[2];
if (mode !== "--development" && mode !== "--release") {
  throw new Error("usage: node scripts/validate-release-constants.mjs --development|--release");
}

const releaseMode = mode === "--release";
const path = new URL("../release/constants.json", import.meta.url);
const constants = JSON.parse(await readFile(path, "utf8"));
const errors = [];

function checkClosedObject(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    errors.push(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function isPlaceholder(value) {
  return (
    typeof value !== "string" ||
    value.length === 0 ||
    /[<>]/.test(value) ||
    /(?:CHANGE_ME|SET_BEFORE_RELEASE|\bTODO\b)/i.test(value) ||
    /^\$\{[^}]+\}$/.test(value) ||
    /^__[^_]+__$/.test(value)
  );
}

function checkString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    errors.push(`${label} must be a non-empty string with no surrounding whitespace`);
    return false;
  }
  if (releaseMode && isPlaceholder(value)) {
    errors.push(`${label} still contains a release placeholder`);
    return false;
  }
  return true;
}

function checkHostname(value, label, suffix) {
  if (!checkString(value, label) || (!releaseMode && isPlaceholder(value))) return;
  if (
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    value.includes(":") ||
    domainToASCII(value) !== value ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(value)
  ) {
    errors.push(`${label} must be a canonical lowercase ASCII hostname without a trailing dot`);
  }
  if (suffix && !value.endsWith(suffix)) {
    errors.push(`${label} must end in ${suffix}`);
  }
  if (/(?:^|\.)example(?:\.|$)|\.invalid$|\.test$|\.localhost$/.test(value)) {
    errors.push(`${label} must not use a reserved placeholder domain`);
  }
}

checkClosedObject(constants, "constants", [
  "schemaVersion",
  "product",
  "production",
  "cloudflare",
  "github",
  "maintainers",
  "signing"
]);
checkClosedObject(constants.product, "product", ["workingName", "workerName"]);
checkClosedObject(constants.production, "production", ["canonicalDomain", "dnsReleaseKeyOwner"]);
checkClosedObject(constants.cloudflare, "cloudflare", ["accountId"]);
checkClosedObject(constants.github, "github", ["owner", "repository"]);
checkClosedObject(constants.signing, "signing", ["minisignPublicKey", "sha256Fingerprint"]);

if (constants.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (constants.product?.workingName !== "QRWarden") errors.push("product.workingName must be QRWarden until clearance changes it in review");
if (constants.product?.workerName !== "qrwarden") errors.push("product.workerName must be qrwarden");

for (const [label, value] of [
  ["production.canonicalDomain", constants.production?.canonicalDomain],
  ["production.dnsReleaseKeyOwner", constants.production?.dnsReleaseKeyOwner],
  ["cloudflare.accountId", constants.cloudflare?.accountId],
  ["github.owner", constants.github?.owner],
  ["github.repository", constants.github?.repository],
  ["signing.minisignPublicKey", constants.signing?.minisignPublicKey],
  ["signing.sha256Fingerprint", constants.signing?.sha256Fingerprint]
]) {
  checkString(value, label);
}

if (!Array.isArray(constants.maintainers) || constants.maintainers.length < 2) {
  errors.push("maintainers must contain at least two named identities");
} else {
  constants.maintainers.forEach((maintainer, index) => {
    checkClosedObject(maintainer, `maintainers[${index}]`, ["name", "email"]);
    checkString(maintainer?.name, `maintainers[${index}].name`);
    checkString(maintainer?.email, `maintainers[${index}].email`);
  });
}

if (releaseMode) {
  const canonicalDomain = constants.production.canonicalDomain;
  checkHostname(canonicalDomain, "production.canonicalDomain");

  if (constants.production.dnsReleaseKeyOwner !== `_qrwarden-release-key.${canonicalDomain}`) {
    errors.push("production.dnsReleaseKeyOwner must exactly match _qrwarden-release-key.<canonicalDomain>");
  }
  if (!/^[a-f0-9]{32}$/.test(constants.cloudflare.accountId)) {
    errors.push("cloudflare.accountId must be exactly 32 lowercase hexadecimal characters");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(constants.github.owner)) {
    errors.push("github.owner is not a valid GitHub owner literal");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(constants.github.repository)) {
    errors.push("github.repository is not a valid repository-name literal");
  }

  const names = constants.maintainers.map(({ name }) => name.toLocaleLowerCase("en-US"));
  const emails = constants.maintainers.map(({ email }) => email);
  if (new Set(names).size !== names.length) errors.push("maintainer names must be unique");
  if (new Set(emails).size !== emails.length) errors.push("maintainer emails must be unique");
  for (const email of emails) {
    if (email !== email.toLowerCase() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push(`maintainer email is not canonical: ${email}`);
    }
  }

  const publicKey = constants.signing.minisignPublicKey;
  if (publicKey.includes("\r")) errors.push("signing.minisignPublicKey must use LF line endings");
  const allKeyLines = publicKey.split("\n");
  if (allKeyLines.at(-1) === "") allKeyLines.pop();
  if (allKeyLines.some((line) => line.length === 0 || line.trim() !== line)) {
    errors.push("signing.minisignPublicKey must not contain blank lines or surrounding whitespace");
  }
  const keyLines = allKeyLines.filter((line) => !line.startsWith("untrusted comment:"));
  if (keyLines.length !== 1 || /\s/.test(keyLines[0] ?? "")) {
    errors.push("signing.minisignPublicKey must contain exactly one canonical noncomment base64 line");
  } else {
    const keyLine = keyLines[0];
    try {
      const decoded = Buffer.from(keyLine, "base64");
      if (decoded.length !== 42 || decoded.subarray(0, 2).toString("ascii") !== "Ed") {
        errors.push("signing.minisignPublicKey is not a 42-byte Ed25519 Minisign public-key blob");
      }
      if (decoded.toString("base64") !== keyLine) {
        errors.push("signing.minisignPublicKey base64 is not canonical RFC 4648 encoding");
      }
      const fingerprint = createHash("sha256").update(decoded).digest("hex");
      if (fingerprint !== constants.signing.sha256Fingerprint) {
        errors.push("signing.sha256Fingerprint does not match the decoded Minisign key blob");
      }
    } catch {
      errors.push("signing.minisignPublicKey is not valid base64");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(constants.signing.sha256Fingerprint)) {
    errors.push("signing.sha256Fingerprint must be 64 lowercase hexadecimal characters");
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`release constants: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`release constants are valid for ${releaseMode ? "release" : "development"}\n`);
}
