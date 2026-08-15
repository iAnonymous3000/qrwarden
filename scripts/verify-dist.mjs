import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertExactCspForPath,
  expectedHeadersForPath,
  parseHeaderRules,
  REPORTING_HEADER_NAMES,
} from "./release/header-rules.mjs";

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
const parsedHeaderRules = parseHeaderRules(headers);
const catchAllRules = parsedHeaderRules.filter((rule) => rule.pattern === "/*");
if (catchAllRules.length !== 1) {
  throw new Error("production headers must contain exactly one catch-all rule");
}
for (const name of REPORTING_HEADER_NAMES) {
  if (!catchAllRules[0].detachments.includes(name)) {
    throw new Error(`catch-all rule must detach reporting header: ${name}`);
  }
}
// A whole-file substring test accepted these headers anywhere in _headers,
// including scoped to a path that no request reaches, which would leave every
// real route unprotected while the check still passed. Require them on the
// catch-all rule, which is what actually covers every route.
const catchAllHeaderNames = new Map(catchAllRules[0].headers);
for (const expected of [
  "Referrer-Policy: no-referrer",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "X-DNS-Prefetch-Control: off",
  "Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy: same-origin",
  "Cross-Origin-Resource-Policy: same-origin",
]) {
  const separator = expected.indexOf(":");
  const name = expected.slice(0, separator);
  const value = expected.slice(separator + 2);
  if (catchAllHeaderNames.get(name.toLowerCase()) !== value) {
    throw new Error(`catch-all rule must set common production header: ${expected}`);
  }
}
for (const file of files) {
  const rule = rules.find((candidate) => candidate.pattern.test(file));
  if (rule === undefined) throw new Error(`${file} lacks an artifact-contract class`);
  const pathname = file === "index.html" ? "/" : `/${file}`;
  assertExactCspForPath({
    headers: expectedHeadersForPath(parsedHeaderRules, pathname),
    pathname,
    cspClasses: contract.cspClasses,
    cspClass: rule.cspClass,
  });
}

const sw = await readFile(path.join(dist, "sw.js"), "utf8");
if (
  sw.includes("self.__WB_MANIFEST") ||
  sw.includes("__QRWARDEN_SIZE_MANIFEST__")
) {
  throw new Error("service-worker manifest injection did not complete");
}
// Testing the worker for a "sha384-" substring proved nothing: the worker's
// own source builds that prefix in a template literal, so the check passed
// whether or not a single precache entry carried integrity metadata. Recompute
// the digests here and require the exact strings, which fails closed if an
// entry is dropped, stale, or injected without integrity.
for (const file of files) {
  const rule = rules.find((candidate) => candidate.pattern.test(file));
  if (rule?.precache !== true) continue;
  const bytes = await readFile(path.join(dist, file));
  const url = file === "index.html" ? "/" : `/${file}`;
  const revision = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  // Matched without quotes: the manifest is minified output, so pinning the
  // bundler's quote style would turn a future toolchain bump into a confusing
  // "manifest omits /" build failure. The revision and integrity checks below
  // carry the actual security weight and are encoding-independent.
  if (!sw.includes(url)) {
    throw new Error(`service-worker precache manifest omits ${url}`);
  }
  if (!sw.includes(revision)) {
    throw new Error(`service-worker precache revision missing for ${url}`);
  }
  if (!sw.includes(integrity)) {
    throw new Error(`service-worker precache integrity missing for ${url}`);
  }
}

process.stdout.write(`verified closed dist contract for ${files.length} files\n`);
