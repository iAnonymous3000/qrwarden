import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");
const contract = JSON.parse(
  await readFile(path.resolve("release/artifact-contract.json"), "utf8"),
);
const rules = contract.entries
  .filter((entry) => entry.kind === "dist" || entry.kind === "dist-control")
  .map((entry) => ({ ...entry, pattern: new RegExp(entry.sourcePattern) }));
const files = [];

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  );
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, relative);
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`non-regular dist entry: ${relative}`);
  }
}
await walk(dist);

for (const file of files) {
  const matches = rules.filter((rule) => rule.pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(
      `${file} maps to ${matches.length} artifact-contract classes (expected exactly one)`,
    );
  }
}
for (const required of rules) {
  if (!files.some((file) => required.pattern.test(file))) {
    throw new Error(`missing required dist class: ${required.id}`);
  }
}
if (files.filter((file) => file.endsWith(".html")).length !== 1) {
  throw new Error("production dist must contain exactly one HTML file");
}
for (const fixed of [
  "index.html",
  "decoder-worker.js",
  "sw.js",
  "app.webmanifest",
  "_headers",
]) {
  if (!(await stat(path.join(dist, fixed)).catch(() => null))?.isFile()) {
    throw new Error(`missing fixed dist file: ${fixed}`);
  }
}

const html = await readFile(path.join(dist, "index.html"), "utf8");
if (/<style\b|\sstyle=|\son[a-z]+=|javascript:/i.test(html)) {
  throw new Error("generated document contains forbidden inline markup");
}
const inlineScripts = [
  ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
];
if (
  inlineScripts.some(
    (match) =>
      !/\bsrc=/.test(match[1] ?? "") || (match[2] ?? "").trim() !== "",
  )
) {
  throw new Error("generated document contains an inline script");
}
if (
  /rel=["'](?:modulepreload|prefetch|preconnect|dns-prefetch|prerender)["']/i.test(
    html,
  )
) {
  throw new Error("generated document contains a speculative resource hint");
}

const headers = await readFile(path.join(dist, "_headers"), "utf8");
for (const [route, expected] of [
  ["/", "require-trusted-types-for 'script'"],
  ["/decoder-worker.js", "'wasm-unsafe-eval'"],
  ["/sw.js", "script-src 'self'"],
]) {
  const start = headers.indexOf(`\n${route}\n`);
  if (start < 0) throw new Error(`missing header route block ${route}`);
  const tail = headers.slice(start + 1);
  const blockEnd = tail.indexOf("\n\n");
  const block = tail.slice(0, blockEnd < 0 ? undefined : blockEnd);
  const cspCount = (block.match(/Content-Security-Policy:/g) ?? []).length;
  if (cspCount !== 1 || !block.includes(expected)) {
    throw new Error(`invalid CSP resolution for ${route}`);
  }
}

const sw = await readFile(path.join(dist, "sw.js"), "utf8");
if (
  sw.includes("self.__WB_MANIFEST") ||
  sw.includes("__QRWARDEN_SIZE_MANIFEST__")
) {
  throw new Error("service-worker manifest injection did not complete");
}
if (!/sha384-/.test(sw) || !/[0-9a-f]{64}/.test(sw)) {
  throw new Error("service-worker entries lack full integrity metadata");
}

process.stdout.write(`verified closed dist contract for ${files.length} files\n`);
