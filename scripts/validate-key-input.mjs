import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [kind, inputPath] = process.argv.slice(2);
if (!(["transition", "recovery"].includes(kind)) || !inputPath) {
  throw new Error("usage: node scripts/validate-key-input.mjs transition|recovery <input.json>");
}

const input = JSON.parse(await readFile(inputPath, "utf8"));
const commonKeys = [
  "project",
  "canonical-domain",
  "fingerprint-scheme",
  "successor-key-sha256",
  "successor-minisign-public-key",
  "dns-owner"
];
const kindKeys = kind === "transition"
  ? ["effective-tag", "previous-key-sha256"]
  : ["recovery-tag", "compromised-key-sha256", "last-trusted-tag", "last-trusted-commit", "incident-url"];
const expectedKeys = [...commonKeys, ...kindKeys].sort();
const actualKeys = Object.keys(input).sort();
const errors = [];

if (expectedKeys.join("\0") !== actualKeys.join("\0")) {
  errors.push(`input keys must be exactly: ${expectedKeys.join(", ")}`);
}
if (input.project !== "qrwarden") errors.push("project must be qrwarden");
if (input["fingerprint-scheme"] !== "sha256-minisign-decoded-key-blob") {
  errors.push("fingerprint-scheme must be sha256-minisign-decoded-key-blob");
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const tagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const domain = input["canonical-domain"];
if (!domainPattern.test(domain)) errors.push("canonical-domain is not a canonical lowercase hostname");
if (input["dns-owner"] !== `_qrwarden-release-key.${domain}.`) {
  errors.push("dns-owner must exactly match _qrwarden-release-key.<canonical-domain>.");
}
for (const key of kind === "transition"
  ? ["previous-key-sha256", "successor-key-sha256"]
  : ["compromised-key-sha256", "successor-key-sha256"]) {
  if (!hashPattern.test(input[key])) errors.push(`${key} must be 64 lowercase hexadecimal characters`);
}
if (!tagPattern.test(input[kind === "transition" ? "effective-tag" : "recovery-tag"])) {
  errors.push(`${kind === "transition" ? "effective-tag" : "recovery-tag"} must be a stable vX.Y.Z tag`);
}

const keyLine = input["successor-minisign-public-key"];
if (typeof keyLine !== "string" || !/^[A-Za-z0-9+/]{56}$/.test(keyLine)) {
  errors.push("successor-minisign-public-key must be one canonical base64 key line");
} else {
  const keyBlob = Buffer.from(keyLine, "base64");
  if (keyBlob.length !== 42 || keyBlob.subarray(0, 2).toString("ascii") !== "Ed" || keyBlob.toString("base64") !== keyLine) {
    errors.push("successor-minisign-public-key must decode canonically to a 42-byte Ed25519 Minisign key blob");
  } else if (createHash("sha256").update(keyBlob).digest("hex") !== input["successor-key-sha256"]) {
    errors.push("successor-key-sha256 does not match the decoded successor key blob");
  }
}

if (kind === "transition" && input["previous-key-sha256"] === input["successor-key-sha256"]) {
  errors.push("previous and successor key fingerprints must differ");
}
if (kind === "recovery") {
  if (input["compromised-key-sha256"] === input["successor-key-sha256"]) {
    errors.push("compromised and successor key fingerprints must differ");
  }
  const tagIsNone = input["last-trusted-tag"] === "none";
  const commitIsNone = input["last-trusted-commit"] === "none";
  if (tagIsNone !== commitIsNone) errors.push("last-trusted-tag and last-trusted-commit must both be none or both be immutable values");
  if (!tagIsNone && !tagPattern.test(input["last-trusted-tag"])) errors.push("last-trusted-tag is invalid");
  if (!commitIsNone && !/^[a-f0-9]{40}$/.test(input["last-trusted-commit"])) errors.push("last-trusted-commit is invalid");
  try {
    const incident = new URL(input["incident-url"]);
    if (incident.protocol !== "https:" || incident.username || incident.password || incident.hash) {
      errors.push("incident-url must be a permanent HTTPS URL without credentials or a fragment");
    }
  } catch {
    errors.push("incident-url must be a valid permanent HTTPS URL");
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`key ${kind} input: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`key ${kind} input is valid\n`);
}
