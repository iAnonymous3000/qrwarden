import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { extractVersionChangelog } from "./release/generate-version-changelog.mjs";

const errors = [];
const readJson = async (relative) =>
  JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), "utf8"));
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

let head = null;
try {
  head = git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(head)) errors.push("HEAD is not a full Git commit");
  if (git("branch", "--show-current") !== "main") errors.push("release must run on main");
  if (git("status", "--porcelain=v1", "--untracked-files=all") !== "") {
    errors.push("release worktree must be clean");
  }
} catch {
  errors.push("Git release context is unavailable");
}

if (head !== null && process.env.QRWARDEN_COMMIT !== head) {
  errors.push("QRWARDEN_COMMIT must equal the exact release HEAD");
}
if (process.env.QRWARDEN_COMMIT === "0000000000000000000000000000000000000000") {
  errors.push("the development all-zero commit is forbidden for release");
}

if (head !== null) {
  try {
    const committerEpoch = git("show", "-s", "--format=%ct", head);
    if (process.env.SOURCE_DATE_EPOCH !== committerEpoch) {
      errors.push("SOURCE_DATE_EPOCH must equal the release commit timestamp");
    }
  } catch {
    errors.push("cannot read release commit timestamp");
  }
}
for (const [name, expected] of [
  ["TZ", "UTC"],
  ["LC_ALL", "C"],
  ["LANG", "C"],
]) {
  if (process.env[name] !== expected) errors.push(`${name} must be exactly ${expected}`);
}
if (process.umask() !== 0o22) errors.push("release umask must be exactly 022");

const packageMetadata = await readJson("package.json");
const manifest = await readJson("public/app.webmanifest");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
if (manifest.version !== packageMetadata.version) {
  errors.push("manifest version must equal package.json version");
}
try {
  extractVersionChangelog(changelog, packageMetadata.version);
} catch (error) {
  errors.push(error instanceof Error ? error.message : "changelog release section is invalid");
}

const data = await readJson("release/data-status.json");
if (data.releaseReady !== true) errors.push("analyzer data status is not release-ready");
const today = Date.now();
for (const [label, captured] of [
  ["Public Suffix List", data.publicSuffix?.captured],
  ["IANA special-purpose registries", data.ianaSpecialPurpose?.captured],
  ["Unicode security data", data.unicodeSecurity?.captured],
]) {
  if (typeof captured !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(captured)) {
    errors.push(`${label} capture date is missing or invalid`);
    continue;
  }
  const ageDays = (today - Date.parse(`${captured}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 90) {
    errors.push(`${label} capture date is outside the 90-day release window`);
  }
}
if (
  data.publicSuffix?.completeness !== "complete" ||
  !/^[0-9a-f]{40}$/.test(data.publicSuffix?.sourceCommit ?? "")
) {
  errors.push("Public Suffix List provenance is incomplete");
}
if (
  data.ianaSpecialPurpose?.completeness !== "complete" ||
  typeof data.ianaSpecialPurpose?.sourceVersion !== "string" ||
  data.ianaSpecialPurpose.sourceVersion.length === 0
) {
  errors.push("IANA registry provenance is incomplete");
}
if (
  data.unicodeSecurity?.completeness !== "complete" ||
  !/^[0-9a-f]{64}$/.test(data.unicodeSecurity?.sourceSha256 ?? "")
) {
  errors.push("Unicode security provenance is incomplete");
}

const constants = await readJson("release/constants.json");
const publicKey = await readFile(
  new URL("../public/.well-known/qrwarden-release-key.pub", import.meta.url),
  "utf8",
);
const expectedPublicKey = `${constants.signing.minisignPublicKey.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`;
if (publicKey !== expectedPublicKey) {
  errors.push("well-known public key must byte-match release constants");
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`release readiness: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("release context and internal readiness gates are valid\n");
}
