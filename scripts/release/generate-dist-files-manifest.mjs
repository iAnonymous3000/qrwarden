import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  collectRegularFiles,
  compareBytes,
  optionsFromArgs,
  renderHashManifest,
  sha256File,
} from "./release-contract.mjs";

function publicUrl(relative, rule) {
  if (rule === "preserve-path") return `/${relative}`;
  if (rule === "no-public-body") return null;
  if (rule.startsWith("exact:")) return rule.slice("exact:".length);
  throw new Error(`unsupported canonical URL rule for ${relative}: ${rule}`);
}
export async function generateDistFilesManifest({ distDirectory, contractFile }) {
  const contract = JSON.parse(await readFile(contractFile, "utf8"));
  if (
    contract?.schemaVersion !== 1 ||
    contract.unmatchedDistPolicy !== "reject" ||
    !Array.isArray(contract.entries)
  ) {
    throw new Error("artifact contract must be closed schema version 1");
  }
  const inputRules = contract.entries
    .filter(({ kind }) => kind === "dist" || kind === "dist-control")
    .map((entry) => ({ ...entry, matcher: new RegExp(entry.sourcePattern, "u") }));
  const files = await collectRegularFiles(distDirectory);
  if (files.length === 0) throw new Error("dist tree is empty");

  const publicUrls = new Map();
  const htmlFiles = [];
  const manifestEntries = [];
  for (const file of files) {
    const matches = inputRules.filter(({ matcher }) => matcher.test(file.relative));
    if (matches.length !== 1) {
      throw new Error(
        `${file.relative} maps to ${matches.length} artifact-contract input classes (expected exactly one)`,
      );
    }
    const [rule] = matches;
    if (file.relative.endsWith(".html")) htmlFiles.push(file.relative);
    const url = publicUrl(file.relative, rule.canonicalUrlRule);
    if (url !== null) {
      const previous = publicUrls.get(url);
      if (previous !== undefined) {
        throw new Error(`public URL collision at ${url}: ${previous}, ${file.relative}`);
      }
      publicUrls.set(url, file.relative);
    }
    manifestEntries.push({ name: file.relative, digest: await sha256File(file.absolute) });
  }
  if (htmlFiles.length !== 1 || htmlFiles[0] !== "index.html") {
    throw new Error(`dist must contain index.html as its only HTML file: ${htmlFiles.join(", ")}`);
  }
  if (publicUrls.get("/") !== "index.html") {
    throw new Error("dist/index.html must map to the canonical public URL /");
  }
  manifestEntries.sort((left, right) => compareBytes(left.name, right.name));
  return renderHashManifest(manifestEntries, "dist");
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(process.argv.slice(2), new Set(["--dist", "--contract", "--output"]));
  const distDirectory = path.resolve(root, options["--dist"] ?? "dist");
  const contractFile = path.resolve(root, options["--contract"] ?? "release/artifact-contract.json");
  const outputFile = path.resolve(
    root,
    options["--output"] ??
      `release-output/qrwarden-${packageMetadata.version}-dist-files.sha256`,
  );
  const manifest = await generateDistFilesManifest({ distDirectory, contractFile });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, manifest, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${path.relative(root, outputFile)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
