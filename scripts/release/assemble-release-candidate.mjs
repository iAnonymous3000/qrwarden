import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ordinaryArtifactNames } from "./generate-archive-manifest.mjs";
import {
  assertCommit,
  assertEpoch,
  assertReleaseVersion,
  collectRegularFiles,
  optionsFromArgs,
} from "./release-contract.mjs";

const execFileAsync = promisify(execFile);

export function releaseCandidateNames(version) {
  return [...ordinaryArtifactNames(assertReleaseVersion(version)), `qrwarden-${version}-archive.sha256`].sort();
}

export function assertReleaseOutputDirectory(root, outputDirectory) {
  const expected = path.join(path.resolve(root), "release-output");
  const actual = path.resolve(outputDirectory);
  if (actual !== expected) {
    throw new Error("release candidate output must be the repository release-output directory");
  }
  return actual;
}

async function run(root, environment, script, args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (stderr !== "") process.stderr.write(stderr);
  if (stdout !== "") process.stdout.write(stdout);
}

export async function assembleReleaseCandidate({ root, version, commit, epoch, outputDirectory }) {
  assertReleaseVersion(version);
  assertCommit(commit);
  const normalizedEpoch = assertEpoch(epoch);
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (metadata.version !== version) throw new Error("release version differs from package.json");
  if (process.umask() !== 0o22) throw new Error("release candidate assembly requires umask 022");

  outputDirectory = assertReleaseOutputDirectory(root, outputDirectory);

  await rm(outputDirectory, { recursive: true, force: true });
  const environment = {
    ...process.env,
    SOURCE_DATE_EPOCH: String(normalizedEpoch),
    TZ: "UTC",
    LC_ALL: "C",
    LANG: "C",
  };
  const common = ["--commit", commit];
  await run(root, environment, "scripts/release/generate-version-changelog.mjs", [
    "--version", version,
    "--output", path.relative(root, path.join(outputDirectory, `qrwarden-${version}-changelog.md`)),
  ]);
  await run(root, environment, "scripts/release/generate-dist-files-manifest.mjs", [
    "--output", path.relative(root, path.join(outputDirectory, `qrwarden-${version}-dist-files.sha256`)),
  ]);
  await run(root, environment, "scripts/release/generate-sbom.mjs", [
    ...common,
    "--epoch", String(normalizedEpoch),
    "--output", path.relative(root, path.join(outputDirectory, `qrwarden-${version}-sbom.cdx.json`)),
  ]);
  await run(root, environment, "scripts/release/generate-license-report.mjs", [
    ...common,
    "--output", path.relative(root, path.join(outputDirectory, `qrwarden-${version}-licenses.txt`)),
  ]);
  await run(root, environment, "scripts/release/generate-archives.mjs", [
    ...common,
    "--epoch", String(normalizedEpoch),
    "--version", version,
    "--output", path.relative(root, outputDirectory),
  ]);
  await run(root, environment, "scripts/release/generate-archive-manifest.mjs", [
    "--version", version,
    "--artifacts", path.relative(root, outputDirectory),
    "--output", path.relative(root, path.join(outputDirectory, `qrwarden-${version}-archive.sha256`)),
  ]);

  const files = await collectRegularFiles(outputDirectory);
  const actual = files.map(({ relative }) => relative).sort();
  const expected = releaseCandidateNames(version);
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`release candidate file set differs from the locked contract: ${actual.join(", ")}`);
  }
  return actual;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--version", "--commit", "--epoch", "--output"]),
  );
  const version = assertReleaseVersion(options["--version"] ?? metadata.version);
  const commit = assertCommit(options["--commit"] ?? process.env.QRWARDEN_COMMIT ?? "");
  const epoch = assertEpoch(options["--epoch"] ?? process.env.SOURCE_DATE_EPOCH ?? "");
  const outputDirectory = path.resolve(root, options["--output"] ?? "release-output");
  const names = await assembleReleaseCandidate({ root, version, commit, epoch, outputDirectory });
  process.stdout.write(`release candidate contains ${names.length} locked files\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
