import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertCommit,
  assertEpoch,
  assertReleaseVersion,
  assertSafeRelativePath,
  collectRegularFiles,
  compareBytes,
  optionsFromArgs,
} from "./release-contract.mjs";
import { generateDistFilesManifest } from "./generate-dist-files-manifest.mjs";

const execFileAsync = promisify(execFile);
const FORBIDDEN_SOURCE = [
  ".git",
  ".env",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "release-output",
  "test-results",
];

export function isGnuTarVersion(output) {
  return /(?:^|\n)tar \(GNU tar\) [0-9]/u.test(output);
}

export function isGnuGzipVersion(output) {
  return /(?:^|\n)gzip [0-9]/u.test(output) && !output.startsWith("Apple gzip");
}

function locateTool(candidates, validator, label) {
  const attempts = [];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const output = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      attempts.push(`${candidate}: ${output.split("\n")[0]}`);
      if (validator(output)) return { command: candidate, version: output.split("\n")[0] };
    } catch (error) {
      attempts.push(`${candidate}: ${error.code ?? "unavailable"}`);
    }
  }
  throw new Error(`${label} is required for deterministic release archives (${attempts.join("; ")})`);
}

export function locateArchiveTools(environment = process.env) {
  const tar = locateTool(
    [environment.QRWARDEN_GNU_TAR, "gtar", "tar"],
    isGnuTarVersion,
    "GNU tar",
  );
  const gzip = locateTool(
    [environment.QRWARDEN_GNU_GZIP, "gzip"],
    isGnuGzipVersion,
    "GNU gzip",
  );
  return { tar, gzip };
}

export function normalizedTarArguments(rootName, epoch) {
  assertSafeRelativePath(rootName);
  return [
    "--sort=name",
    "--format=posix",
    "--pax-option=delete=atime,delete=ctime",
    `--mtime=@${assertEpoch(epoch)}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go+rX,go-w",
    "-cf",
    "-",
    rootName,
  ];
}

function decodeGitPath(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Git release paths must be UTF-8", { cause: error });
  }
}

export function parseGitTree(buffer) {
  const records = [];
  for (const raw of buffer.subarray(0, buffer.at(-1) === 0 ? -1 : undefined).toString("binary").split("\0")) {
    if (raw === "") continue;
    const bytes = Buffer.from(raw, "binary");
    const tab = bytes.indexOf(0x09);
    if (tab < 0) throw new Error("invalid git ls-tree record");
    const header = bytes.subarray(0, tab).toString("ascii");
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40,64})$/u.exec(header);
    if (match === null) throw new Error(`unsupported git tree entry: ${header}`);
    const relative = decodeGitPath(bytes.subarray(tab + 1));
    assertSafeRelativePath(relative);
    if (match[1] === "120000") throw new Error(`source archive forbids symlink: ${relative}`);
    if (match[1] === "160000" || match[2] !== "blob") {
      throw new Error(`source archive forbids submodule: ${relative}`);
    }
    if (FORBIDDEN_SOURCE.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) {
      throw new Error(`forbidden tracked source-archive path: ${relative}`);
    }
    records.push({ relative, object: match[3], executable: match[1] === "100755" });
  }
  records.sort((left, right) => compareBytes(left.relative, right.relative));
  if (new Set(records.map(({ relative }) => relative)).size !== records.length) {
    throw new Error("Git source paths must be unique after normalization");
  }
  return records;
}

async function gitBuffer(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

async function stageSource({ root, commit, epoch, stage, rootName }) {
  const resolved = (await gitBuffer(root, ["rev-parse", `${commit}^{commit}`])).toString("utf8").trim();
  if (resolved !== commit) throw new Error("release commit does not resolve exactly");
  const commitEpoch = Number((await gitBuffer(root, ["show", "-s", "--format=%ct", commit])).toString("utf8").trim());
  if (commitEpoch !== epoch) throw new Error("SOURCE_DATE_EPOCH must equal the release commit committer timestamp");
  const dirty = (await gitBuffer(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toString("utf8");
  if (dirty !== "") throw new Error("source archive requires a clean release-commit worktree");
  const records = parseGitTree(await gitBuffer(root, ["ls-tree", "-rz", "--full-tree", commit]));
  if (records.length === 0) throw new Error("release commit has no tracked files");

  const stagedRoot = path.join(stage, rootName);
  await mkdir(stagedRoot, { recursive: true, mode: 0o755 });
  for (const record of records) {
    const bytes = await gitBuffer(root, ["cat-file", "blob", record.object]);
    if (bytes.subarray(0, 43).toString("utf8") === "version https://git-lfs.github.com/spec/v1\n") {
      throw new Error(`source archive forbids Git LFS pointer dependency: ${record.relative}`);
    }
    const output = path.join(stagedRoot, ...record.relative.split("/"));
    await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, bytes, { mode: record.executable ? 0o755 : 0o644 });
    await chmod(output, record.executable ? 0o755 : 0o644);
  }
}

async function stageDist({ distDirectory, contractFile, stage, rootName }) {
  await generateDistFilesManifest({ distDirectory, contractFile });
  const stagedRoot = path.join(stage, rootName);
  await mkdir(stagedRoot, { recursive: true, mode: 0o755 });
  for (const file of await collectRegularFiles(distDirectory)) {
    const output = path.join(stagedRoot, ...file.relative.split("/"));
    await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    await copyFile(file.absolute, output);
    await chmod(output, 0o644);
  }
}

function waitForChild(child, label) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

async function createNormalizedArchive({ tools, stage, rootName, epoch, outputFile }) {
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp-${process.pid}`;
  const environment = { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" };
  delete environment.GZIP;
  const tar = spawn(tools.tar.command, normalizedTarArguments(rootName, epoch), {
    cwd: stage,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gzip = spawn(tools.gzip.command, ["-n", "-9"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  tar.stdout.pipe(gzip.stdin);
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o644 });
  gzip.stdout.pipe(output);
  try {
    await Promise.all([waitForChild(tar, "GNU tar"), waitForChild(gzip, "GNU gzip"), finished(output)]);
    await rename(temporary, outputFile);
  } catch (error) {
    tar.kill();
    gzip.kill();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function generateArchives({ root, distDirectory, contractFile, outputDirectory, version, commit, epoch }) {
  assertReleaseVersion(version);
  assertCommit(commit);
  const normalizedEpoch = assertEpoch(epoch);
  const tools = locateArchiveTools();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "qrwarden-archives-"));
  try {
    const sourceStage = path.join(temporary, "source");
    const distStage = path.join(temporary, "dist");
    const sourceRoot = `qrwarden-${version}`;
    const distRoot = `qrwarden-${version}-dist`;
    await mkdir(sourceStage, { recursive: true, mode: 0o755 });
    await mkdir(distStage, { recursive: true, mode: 0o755 });
    await stageSource({ root, commit, epoch: normalizedEpoch, stage: sourceStage, rootName: sourceRoot });
    await stageDist({ distDirectory, contractFile, stage: distStage, rootName: distRoot });
    await createNormalizedArchive({
      tools,
      stage: sourceStage,
      rootName: sourceRoot,
      epoch: normalizedEpoch,
      outputFile: path.join(outputDirectory, `qrwarden-${version}-source.tar.gz`),
    });
    await createNormalizedArchive({
      tools,
      stage: distStage,
      rootName: distRoot,
      epoch: normalizedEpoch,
      outputFile: path.join(outputDirectory, `qrwarden-${version}-dist.tar.gz`),
    });
    return tools;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--commit", "--epoch", "--version", "--dist", "--contract", "--output", "--tools-only"]),
  );
  if (options["--tools-only"] === "true") {
    const tools = locateArchiveTools();
    process.stdout.write(`${tools.tar.version}\n${tools.gzip.version}\n`);
    return;
  }
  const version = assertReleaseVersion(options["--version"] ?? packageMetadata.version);
  const commit = assertCommit(options["--commit"] ?? "");
  const epoch = assertEpoch(options["--epoch"] ?? process.env.SOURCE_DATE_EPOCH ?? "");
  const outputDirectory = path.resolve(root, options["--output"] ?? "release-output");
  const tools = await generateArchives({
    root,
    distDirectory: path.resolve(root, options["--dist"] ?? "dist"),
    contractFile: path.resolve(root, options["--contract"] ?? "release/artifact-contract.json"),
    outputDirectory,
    version,
    commit,
    epoch,
  });
  process.stdout.write(`${tools.tar.version}\n${tools.gzip.version}\n${path.relative(root, outputDirectory)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
