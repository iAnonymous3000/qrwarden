import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ordinaryArtifactNames } from "./generate-archive-manifest.mjs";
import { parseHashManifest } from "./release-contract.mjs";

const execFileAsync = promisify(execFile);

// SIGNING.md signs the source archive, the dist archive, the dist-files
// manifest, and the archive manifest. Everything else in the candidate is
// covered transitively by one of those manifests.
export function signedArtifactNames(version) {
  const base = `qrwarden-${version}`;
  return [
    `${base}-source.tar.gz`,
    `${base}-dist.tar.gz`,
    `${base}-dist-files.sha256`,
    `${base}-archive.sha256`,
  ];
}

export const TRUSTED_COMMENT =
  /^QRWarden v(?<version>\d+\.\d+\.\d+) commit (?<commit>[0-9a-f]{40}) file (?<file>[A-Za-z0-9._-]+) sha256 (?<digest>[0-9a-f]{64})$/u;

export const UNTRUSTED_COMMENT = "QRWarden release signature";

/**
 * A minisign signature file is four lines: an untrusted comment, the artifact
 * signature, a trusted comment, and a global signature that covers the
 * artifact signature and the trusted comment together. Only the trusted
 * comment is cryptographically bound, so it is the only comment whose contents
 * may be believed after verification succeeds.
 */
export function parseSignature(text, label) {
  const errors = [];
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines.length !== 4) {
    errors.push(`${label}: expected exactly four lines, found ${lines.length}`);
    return { errors, trusted: null };
  }
  const [untrusted, , trusted] = lines;
  if (untrusted !== `untrusted comment: ${UNTRUSTED_COMMENT}`) {
    errors.push(`${label}: untrusted comment must be exactly "${UNTRUSTED_COMMENT}"`);
  }
  if (!trusted.startsWith("trusted comment: ")) {
    errors.push(`${label}: missing trusted comment`);
    return { errors, trusted: null };
  }
  const value = trusted.slice("trusted comment: ".length);
  const match = TRUSTED_COMMENT.exec(value);
  if (match === null) {
    errors.push(`${label}: trusted comment does not match the signature contract: ${value}`);
    return { errors, trusted: null };
  }
  return { errors, trusted: match.groups };
}

async function minisignAvailable() {
  try {
    await execFileAsync("minisign", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `minisign -P` takes the bare base64 key, but release/constants.json holds the
 * public-key FILE body: validate-release-constants.mjs explicitly tolerates an
 * "untrusted comment:" line, and validate-release-readiness.mjs byte-matches
 * the whole constant against .well-known/qrwarden-release-key.pub, which always
 * carries one. Passing the comment line through made every signature check fail
 * at the ceremony, where there is no automated coverage to catch it.
 */
export function bareMinisignKey(publicKey) {
  const line = publicKey
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.startsWith("untrusted comment:"))
    .at(-1);
  return line ?? publicKey.trim();
}

export async function verifySignedSet({
  directory,
  version,
  commit,
  publicKey,
  verifySignatures = true,
}) {
  const errors = [];
  const required = signedArtifactNames(version);
  const present = (await readdir(directory)).filter((name) => name.endsWith(".minisig")).sort();
  const expected = required.map((name) => `${name}.minisig`).sort();

  // Set membership is checked in both directions: a missing signature leaves an
  // artifact unsigned, and an unexpected one is an artifact nobody reviewed.
  for (const name of expected) {
    if (!present.includes(name)) errors.push(`missing signature: ${name}`);
  }
  for (const name of present) {
    if (!expected.includes(name)) errors.push(`unexpected signature not in the signed set: ${name}`);
  }

  // Every ordinary artifact must exist even when it is not itself signed, so a
  // set that verifies cannot also be silently incomplete.
  for (const name of [...ordinaryArtifactNames(version), `qrwarden-${version}-archive.sha256`]) {
    try {
      await readFile(path.join(directory, name));
    } catch {
      errors.push(`missing release artifact: ${name}`);
    }
  }

  const canVerify = verifySignatures ? await minisignAvailable() : false;
  if (verifySignatures && !canVerify) {
    errors.push(
      "minisign is not available on PATH, so signatures cannot be cryptographically verified; install the pinned minisign from SIGNING.md",
    );
  }

  for (const name of required) {
    const signatureName = `${name}.minisig`;
    if (!present.includes(signatureName)) continue;
    const artifactPath = path.join(directory, name);
    const signaturePath = path.join(directory, signatureName);

    let bytes;
    try {
      bytes = await readFile(artifactPath);
    } catch {
      errors.push(`${signatureName}: signs an artifact that is not present`);
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");

    const { errors: parseErrors, trusted } = parseSignature(
      await readFile(signaturePath, "utf8"),
      signatureName,
    );
    errors.push(...parseErrors);
    if (trusted === null) continue;

    if (trusted.version !== version) {
      errors.push(`${signatureName}: trusted comment names version ${trusted.version}, expected ${version}`);
    }
    if (trusted.commit !== commit) {
      errors.push(`${signatureName}: trusted comment names commit ${trusted.commit}, expected ${commit}`);
    }
    if (trusted.file !== name) {
      errors.push(`${signatureName}: trusted comment names file ${trusted.file}, expected ${name}`);
    }
    // The digest is what ties the signed statement to these exact bytes; a
    // trusted comment naming the right file with the wrong digest is precisely
    // what a swapped artifact looks like.
    if (trusted.digest !== digest) {
      errors.push(
        `${signatureName}: trusted comment digest ${trusted.digest} does not match the artifact's sha256 ${digest}`,
      );
    }

    if (canVerify) {
      try {
        await execFileAsync("minisign", [
          "-V",
          "-P",
          bareMinisignKey(publicKey),
          "-x",
          signaturePath,
          "-m",
          artifactPath,
        ]);
      } catch (error) {
        errors.push(`${signatureName}: minisign verification failed: ${String(error.stderr ?? error).trim()}`);
      }
    }
  }

  // Only four artifacts are signed directly. The SBOM, the license report and
  // the changelog carry no signature of their own and are covered solely by
  // the digests inside the signed archive manifest, so verifying that
  // manifest's own bytes is not enough: its contents must be checked against
  // the artifacts it claims to describe, or those three could be replaced
  // wholesale and the set would still verify.
  const manifestName = `qrwarden-${version}-archive.sha256`;
  try {
    const manifest = parseHashManifest(await readFile(path.join(directory, manifestName), "utf8"));
    const listed = new Set(manifest.map((entry) => entry.name));
    for (const name of ordinaryArtifactNames(version)) {
      if (!listed.has(name)) {
        errors.push(`${manifestName}: does not cover required artifact ${name}`);
      }
    }
    for (const entry of manifest) {
      let bytes;
      try {
        bytes = await readFile(path.join(directory, entry.name));
      } catch {
        errors.push(`${manifestName}: lists ${entry.name}, which is not present`);
        continue;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.digest) {
        errors.push(
          `${manifestName}: lists ${entry.name} as ${entry.digest}, but its actual sha256 is ${digest}`,
        );
      }
    }
  } catch (error) {
    errors.push(`${manifestName}: ${error instanceof Error ? error.message : "cannot be parsed"}`);
  }

  return errors;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const [directory, commit] = process.argv.slice(2);
  if (directory === undefined || commit === undefined) {
    process.stderr.write(
      "usage: node scripts/release/verify-signed-set.mjs <signed-artifact-directory> <release-commit-sha>\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    process.stderr.write("signed-set verification: release commit must be 40 lowercase hex characters\n");
    process.exitCode = 2;
    return;
  }

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const constants = JSON.parse(await readFile(path.join(root, "release/constants.json"), "utf8"));
  const publicKey = constants.signing?.minisignPublicKey;
  if (typeof publicKey !== "string" || publicKey.length === 0 || /[<>]/u.test(publicKey)) {
    process.stderr.write(
      "signed-set verification: release/constants.json still holds a placeholder Minisign public key\n",
    );
    process.exitCode = 1;
    return;
  }

  const errors = await verifySignedSet({
    directory,
    version: packageJson.version,
    commit,
    publicKey,
  });
  if (errors.length > 0) {
    errors.forEach((error) => process.stderr.write(`signed-set verification: ${error}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `verified the complete signed set for v${packageJson.version} at commit ${commit}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
