import { createHash } from "node:crypto";
import {
  copyFile,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { injectManifest } from "workbox-build";

import { expectedCspForClass } from "./release/header-rules.mjs";

const DIST = path.resolve("dist");
const EXPECTED_WASM_SHA256 =
  "6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f";
const MAX_COMPRESSED_PRECACHE_BYTES = 2 * 1024 * 1024;
const sourceWasm = path.resolve(
  "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm",
);

const releaseConstants = JSON.parse(
  await readFile(path.resolve("release/constants.json"), "utf8"),
);
const configuredPublicKey = releaseConstants.signing?.minisignPublicKey;
if (
  typeof configuredPublicKey === "string" &&
  configuredPublicKey.length > 0 &&
  !/[<>]/.test(configuredPublicKey)
) {
  const normalizedPublicKey = `${configuredPublicKey
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")}\n`;
  await writeFile(
    path.join(DIST, ".well-known", "qrwarden-release-key.pub"),
    normalizedPublicKey,
    "utf8",
  );
}

function digest(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function walkFiles(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`non-regular dist entry: ${relative}`);
  }
  return files;
}

const sourceWasmBytes = await readFile(sourceWasm);
if (digest("sha256", sourceWasmBytes) !== EXPECTED_WASM_SHA256) {
  throw new Error("locked zxing-wasm reader artifact hash mismatch");
}
const artifactContract = JSON.parse(
  await readFile(path.resolve("release/artifact-contract.json"), "utf8"),
);
const distRules = artifactContract.entries
  .filter((entry) => entry.kind === "dist")
  .map((entry) => ({ ...entry, pattern: new RegExp(entry.sourcePattern) }));

const builtServiceWorker = path.join(DIST, "sw.js");
const serviceWorkerSource = path.join(DIST, "sw-source.js");
await copyFile(builtServiceWorker, serviceWorkerSource);
await rm(builtServiceWorker);
let sizeManifest = [];
let compressedPrecacheBytes = 0;

const { count, size, warnings } = await injectManifest({
  swSrc: serviceWorkerSource,
  swDest: builtServiceWorker,
  globDirectory: DIST,
  globPatterns: [
    "index.html",
    "app.webmanifest",
    "decoder-worker.js",
    "assets/**/*.{js,css,wasm}",
    "icons/*.png",
    ".well-known/qrwarden-release-key.pub",
  ],
  globIgnores: ["**/*.map", "sw.js", "sw-source.js", "_headers"],
  maximumFileSizeToCacheInBytes: MAX_COMPRESSED_PRECACHE_BYTES,
  manifestTransforms: [
    async (entries) => {
      const manifest = [];
      for (const entry of entries) {
        const relative = entry.url.replace(/^\/+/, "");
        const bytes = await readFile(path.join(DIST, relative));
        const matches = distRules.filter((rule) => rule.pattern.test(relative));
        if (
          matches.length !== 1 ||
          matches[0].precache !== true ||
          typeof matches[0].mediaType !== "string"
        ) {
          throw new Error(`invalid precache contract mapping for ${relative}`);
        }
        compressedPrecacheBytes += gzipSync(bytes, { level: 9 }).byteLength;
        manifest.push({
          url: relative === "index.html" ? "/" : `/${relative}`,
          revision: digest("sha256", bytes),
          integrity: `sha384-${digest("sha384", bytes, "base64")}`,
          size: bytes.byteLength,
          mediaType: matches[0].mediaType,
        });
      }
      manifest.sort((left, right) =>
        Buffer.from(left.url).compare(Buffer.from(right.url)),
      );
      sizeManifest = manifest.map(({ url, size: entrySize, mediaType }) => ({
        url,
        size: entrySize,
        mediaType,
      }));
      return { manifest, warnings: [] };
    },
  ],
});
await rm(serviceWorkerSource);
if (warnings.length > 0) {
  throw new Error(`service-worker injection warnings: ${warnings.join("; ")}`);
}
if (compressedPrecacheBytes > MAX_COMPRESSED_PRECACHE_BYTES) {
  throw new Error(
    `compressed precache exceeds 2 MiB (${compressedPrecacheBytes} bytes)`,
  );
}
const expectedPrecache = (await walkFiles(DIST))
  .filter((file) => {
    const matches = distRules.filter((rule) => rule.pattern.test(file));
    return matches.length === 1 && matches[0].precache === true;
  })
  .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
const actualPrecache = sizeManifest
  .map(({ url }) => (url === "/" ? "index.html" : url.replace(/^\//, "")))
  .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
if (JSON.stringify(actualPrecache) !== JSON.stringify(expectedPrecache)) {
  throw new Error("precache entries differ from artifact-contract eligibility");
}
const injectedServiceWorker = await readFile(builtServiceWorker, "utf8");
if (!injectedServiceWorker.includes("__QRWARDEN_SIZE_MANIFEST__")) {
  throw new Error("service-worker size-manifest placeholder is missing");
}
await writeFile(
  builtServiceWorker,
  injectedServiceWorker.replace(
    /\b__QRWARDEN_SIZE_MANIFEST__\b/g,
    JSON.stringify(sizeManifest),
  ),
  "utf8",
);

const permissionRegistry = JSON.parse(
  await readFile(path.resolve("release/permissions-policy.json"), "utf8"),
);
const permissions = permissionRegistry.directives
  .map(({ name, allow }) => `${name}=(${allow === "self" ? "self" : ""})`)
  .join(", ");
const releaseId = `v${process.env.npm_package_version ?? "0.1.0"}+${
  process.env.QRWARDEN_COMMIT ?? "0000000000000000000000000000000000000000"
}`;
function requiredCsp(cspClass) {
  const policy = expectedCspForClass(artifactContract.cspClasses, cspClass);
  if (policy === null) throw new Error(`CSP class ${cspClass} must define a policy`);
  return policy;
}

const documentCsp = requiredCsp("document");
const decoderWorkerCsp = requiredCsp("decoder-worker");
const serviceWorkerCsp = requiredCsp("service-worker");
const headers = `/*
  ! NEL
  ! Report-To
  ! Reporting-Endpoints
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-DNS-Prefetch-Control: off
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: ${permissions}
  X-QRWarden-Release: ${releaseId}

/
  Content-Security-Policy: ${documentCsp}
  Cache-Control: no-cache, must-revalidate

/decoder-worker.js
  Content-Security-Policy: ${decoderWorkerCsp}
  Cache-Control: no-cache, must-revalidate
  Content-Type: text/javascript; charset=utf-8

/sw.js
  Content-Security-Policy: ${serviceWorkerCsp}
  Cache-Control: no-cache, must-revalidate
  Content-Type: text/javascript; charset=utf-8

/app.webmanifest
  Cache-Control: no-cache, must-revalidate

/.well-known/qrwarden-release-key.pub
  Cache-Control: no-cache, must-revalidate
  Content-Type: text/plain; charset=utf-8

/.well-known/security.txt
  Cache-Control: no-cache, must-revalidate
  Content-Type: text/plain; charset=utf-8

/icons/*
  Cache-Control: no-cache, must-revalidate

/assets/*.js
  Content-Type: text/javascript; charset=utf-8

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
await writeFile(path.join(DIST, "_headers"), headers, "utf8");

const wasmNames = (await readdir(path.join(DIST, "assets"))).filter((name) =>
  name.endsWith(".wasm"),
);
if (wasmNames.length !== 1) {
  throw new Error(`expected exactly one reader WASM, found ${wasmNames.length}`);
}
const emittedWasm = await readFile(path.join(DIST, "assets", wasmNames[0]));
if (digest("sha256", emittedWasm) !== EXPECTED_WASM_SHA256) {
  throw new Error("emitted reader WASM differs from locked upstream bytes");
}

process.stdout.write(
  `injected ${count} verified precache entries (${size} bytes; ${compressedPrecacheBytes} gzip bytes) and generated _headers\n`,
);
