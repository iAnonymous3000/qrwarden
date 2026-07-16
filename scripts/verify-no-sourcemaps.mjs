import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve("dist");
if (!(await stat(dist).catch(() => null))?.isDirectory()) {
  throw new Error("dist/ does not exist; build before verifying release output");
}

const files = [];
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
    else throw new Error(`non-regular dist entry: ${path}`);
  }
}
await walk(dist);

const mapFiles = files.filter((path) => path.endsWith(".map"));
if (mapFiles.length > 0) throw new Error(`production source maps are forbidden: ${mapFiles.join(", ")}`);
for (const path of files.filter((file) => /\.(?:css|js)$/.test(file))) {
  const body = await readFile(path, "utf8");
  if (/[@#]\s*sourceMappingURL\s*=/.test(body)) {
    throw new Error(`sourceMappingURL annotation is forbidden: ${path}`);
  }
  if (/[@#]\s*sourceURL\s*=/.test(body)) {
    throw new Error(`sourceURL annotation is forbidden: ${path}`);
  }
}
process.stdout.write(`verified ${files.length} dist files: no source maps\n`);
