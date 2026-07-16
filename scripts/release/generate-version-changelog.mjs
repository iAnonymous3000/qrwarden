import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertReleaseVersion, optionsFromArgs } from "./release-contract.mjs";

export function extractVersionChangelog(markdown, version) {
  assertReleaseVersion(version);
  if (typeof markdown !== "string" || markdown.charCodeAt(0) === 0xfeff || markdown.includes("\r")) {
    throw new Error("CHANGELOG.md must be BOM-free UTF-8 text with LF line endings");
  }
  const heading = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "gmu");
  const matches = [...markdown.matchAll(heading)];
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated heading for ${version}`);
  }
  const date = matches[0][1];
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`CHANGELOG.md has an invalid release date for ${version}`);
  }
  const start = matches[0].index;
  const nextHeading = markdown.indexOf("\n## [", start + matches[0][0].length);
  const section = markdown.slice(start, nextHeading < 0 ? undefined : nextHeading + 1).replace(/\n*$/u, "\n");
  if (!section.includes("\n### ")) {
    throw new Error(`CHANGELOG.md release section for ${version} has no categorized entries`);
  }
  return section;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--version", "--input", "--output"]),
  );
  const version = assertReleaseVersion(options["--version"] ?? metadata.version);
  if (metadata.version !== version) throw new Error("requested release version differs from package.json");
  const input = path.resolve(root, options["--input"] ?? "CHANGELOG.md");
  const output = path.resolve(
    root,
    options["--output"] ?? `release-output/qrwarden-${version}-changelog.md`,
  );
  const section = extractVersionChangelog(await readFile(input, "utf8"), version);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
  await writeFile(output, section, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${path.relative(root, output)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
