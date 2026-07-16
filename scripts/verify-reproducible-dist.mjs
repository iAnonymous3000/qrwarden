import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DIST = path.resolve("dist");

async function snapshot(directory, prefix = "") {
  const files = new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await snapshot(absolute, relative)) files.set(name, bytes);
    } else if (entry.isFile()) {
      files.set(relative, await readFile(absolute));
    } else {
      throw new Error(`non-regular reproducibility input: ${relative}`);
    }
  }
  return files;
}

function treeDigest(tree) {
  const hash = createHash("sha256");
  for (const [name, bytes] of tree) {
    const nameBytes = Buffer.from(name, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(nameBytes);
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function build() {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}

build();
const first = await snapshot(DIST);
build();
const second = await snapshot(DIST);

const names = new Set([...first.keys(), ...second.keys()]);
const differences = [];
for (const name of [...names].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
  const left = first.get(name);
  const right = second.get(name);
  if (left === undefined || right === undefined || !left.equals(right)) differences.push(name);
}
if (differences.length > 0) {
  for (const name of differences) process.stderr.write(`reproducibility mismatch: ${name}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `two local production builds are byte-identical: ${treeDigest(first)}\n`,
  );
}
