import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertReleaseVersion,
  optionsFromArgs,
  renderHashManifest,
  sha256File,
} from "./release-contract.mjs";

export function ordinaryArtifactNames(version) {
  assertReleaseVersion(version);
  const base = `qrwarden-${version}`;
  return [
    `${base}-source.tar.gz`,
    `${base}-dist.tar.gz`,
    `${base}-dist-files.sha256`,
    `${base}-sbom.cdx.json`,
    `${base}-licenses.txt`,
    `${base}-changelog.md`,
  ];
}
export async function generateArchiveManifest({ artifactDirectory, version }) {
  const entries = [];
  for (const name of ordinaryArtifactNames(version)) {
    const absolute = path.join(artifactDirectory, name);
    const status = await lstat(absolute);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`archive-manifest input must be one regular file: ${name}`);
    }
    entries.push({ name, digest: await sha256File(absolute) });
  }
  return renderHashManifest(entries);
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--artifacts", "--version", "--output"]),
  );
  const version = assertReleaseVersion(options["--version"] ?? packageMetadata.version);
  const artifactDirectory = path.resolve(root, options["--artifacts"] ?? "release-output");
  const outputFile = path.resolve(
    root,
    options["--output"] ?? `release-output/qrwarden-${version}-archive.sha256`,
  );
  const manifest = await generateArchiveManifest({ artifactDirectory, version });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, manifest, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${path.relative(root, outputFile)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
