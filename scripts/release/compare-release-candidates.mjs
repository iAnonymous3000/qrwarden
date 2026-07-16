import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { generateArchiveManifest, ordinaryArtifactNames } from "./generate-archive-manifest.mjs";
import { releaseCandidateNames } from "./assemble-release-candidate.mjs";
import {
  assertCommit,
  assertReleaseVersion,
  collectRegularFiles,
  optionsFromArgs,
  parseHashManifest,
  sha256,
} from "./release-contract.mjs";

function assertSeparate(first, second, output) {
  const values = [first, second, output].map((value) => path.resolve(value));
  if (new Set(values).size !== values.length) throw new Error("candidate and approved directories must be distinct");
  for (const parent of values) {
    for (const child of values) {
      if (parent !== child && child.startsWith(`${parent}${path.sep}`)) {
        throw new Error("candidate and approved directories must not contain one another");
      }
    }
  }
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`approved output already exists: ${target}`);
}

async function verifyCandidate(directory, version, commit) {
  const files = await collectRegularFiles(directory);
  const actual = files.map(({ relative }) => relative);
  const expected = releaseCandidateNames(version);
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`candidate file set differs from locked contract: ${actual.join(", ")}`);
  }
  const archiveName = `qrwarden-${version}-archive.sha256`;
  const archiveBytes = await readFile(path.join(directory, archiveName));
  const regenerated = await generateArchiveManifest({ artifactDirectory: directory, version });
  if (!archiveBytes.equals(Buffer.from(regenerated, "utf8"))) {
    throw new Error("archive manifest does not authenticate the exact unsigned base set");
  }
  const archiveEntries = parseHashManifest(archiveBytes.toString("utf8"));
  const ordinary = [...ordinaryArtifactNames(version)].sort();
  if (archiveEntries.map(({ name }) => name).join("\0") !== ordinary.join("\0")) {
    throw new Error("archive manifest membership differs from the locked unsigned base set");
  }
  for (const { name, digest } of archiveEntries) {
    if (sha256(await readFile(path.join(directory, name))) !== digest) {
      throw new Error(`archive manifest digest mismatch: ${name}`);
    }
  }
  const distEntries = parseHashManifest(
    await readFile(path.join(directory, `qrwarden-${version}-dist-files.sha256`), "utf8"),
    "dist",
  );
  const distNames = new Set(distEntries.map(({ name }) => name));
  if (!distNames.has("dist/index.html") || !distNames.has("dist/_headers")) {
    throw new Error("dist manifest lacks the canonical document or deployment headers");
  }
  const sbom = JSON.parse(await readFile(path.join(directory, `qrwarden-${version}-sbom.cdx.json`), "utf8"));
  if (sbom?.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.metadata?.component?.version !== version) {
    throw new Error("SBOM identity differs from the release candidate");
  }
  const licenses = await readFile(path.join(directory, `qrwarden-${version}-licenses.txt`), "utf8");
  if (!licenses.startsWith(`QRWARDEN-LICENSE-REPORT-1\nrelease: v${version}\ncommit: ${commit}\n`)) {
    throw new Error("license report identity differs from the release candidate");
  }
  const changelog = await readFile(path.join(directory, `qrwarden-${version}-changelog.md`), "utf8");
  if (!changelog.startsWith(`## [${version}] - `)) throw new Error("version changelog identity mismatch");
  return new Map(files.map(({ relative, absolute }) => [relative, absolute]));
}

export async function compareReleaseCandidates({ first, second, output, version, commit }) {
  assertReleaseVersion(version);
  assertCommit(commit);
  assertSeparate(first, second, output);
  await assertAbsent(output);
  const [firstFiles, secondFiles] = await Promise.all([
    verifyCandidate(first, version, commit),
    verifyCandidate(second, version, commit),
  ]);
  for (const name of releaseCandidateNames(version)) {
    const [left, right] = await Promise.all([
      readFile(firstFiles.get(name)),
      readFile(secondFiles.get(name)),
    ]);
    if (!left.equals(right)) throw new Error(`independent release candidates differ: ${name}`);
  }

  const temporary = `${output}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o755 });
  try {
    for (const name of releaseCandidateNames(version)) {
      await copyFile(firstFiles.get(name), path.join(temporary, name));
    }
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return releaseCandidateNames(version);
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--first", "--second", "--output", "--version", "--commit"]),
  );
  for (const required of ["--first", "--second", "--output", "--version", "--commit"]) {
    if (options[required] === undefined) throw new Error(`missing required option: ${required}`);
  }
  const names = await compareReleaseCandidates({
    first: path.resolve(root, options["--first"]),
    second: path.resolve(root, options["--second"]),
    output: path.resolve(root, options["--output"]),
    version: options["--version"],
    commit: options["--commit"],
  });
  process.stdout.write(`approved ${names.length} byte-identical unsigned release files\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
