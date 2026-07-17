import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  collectRegularFiles,
  optionsFromArgs,
  sha256,
} from "./release-contract.mjs";

const RELEASE_ID = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\+[0-9a-f]{40}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORKER_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_FAILURE_BODY_BYTES = 64 * 1024;
const REPORTING_HEADER_NAMES = ["nel", "report-to", "reporting-endpoints"];

function normalizeHeaderValue(value) {
  return value.trim().replace(/[\t ]+/gu, " ");
}

function assertHeaderToken(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x21 || codePoint > 0x7e;
    })
  ) {
    throw new Error(`${label} must be a bounded visible-ASCII value`);
  }
  return value;
}

export function assertOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloudflare origin must be an absolute URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Cloudflare origin must be one bare HTTPS origin");
  }
  return url.origin;
}

export function assertExpectedRelease(value) {
  if (!RELEASE_ID.test(value) || value.endsWith(`+${"0".repeat(40)}`)) {
    throw new Error("expected release must be v<SemVer>+<nonzero 40-hex commit>");
  }
  return value;
}

export function parseHeaderRules(source) {
  if (source.charCodeAt(0) === 0xfeff || source.includes("\r")) {
    throw new Error("_headers must be BOM-free LF text");
  }
  const rules = [];
  let current = null;
  for (const [index, line] of source.split("\n").entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      if (!/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+|\*[A-Za-z0-9._~-]*)?$/u.test(line)) {
        throw new Error(`unsupported _headers route at line ${index + 1}`);
      }
      current = { pattern: line, headers: [] };
      rules.push(current);
      continue;
    }
    if (current === null) throw new Error(`orphan _headers value at line ${index + 1}`);
    const trimmed = line.trim();
    if (trimmed.startsWith("!")) {
      throw new Error(`detached _headers values are unsupported at line ${index + 1}`);
    }
    const separator = trimmed.indexOf(":");
    if (separator < 1) throw new Error(`invalid _headers value at line ${index + 1}`);
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || value.length === 0) {
      throw new Error(`invalid _headers field at line ${index + 1}`);
    }
    current.headers.push([name.toLowerCase(), normalizeHeaderValue(value)]);
  }
  if (rules.length === 0) throw new Error("_headers must contain at least one rule");
  return rules;
}

function routeMatches(pattern, pathname) {
  if (pattern === "/*") return true;
  const splat = pattern.indexOf("*");
  if (splat === -1) return pathname === pattern;
  const prefix = pattern.slice(0, splat);
  const suffix = pattern.slice(splat + 1);
  return (
    pathname.length >= prefix.length + suffix.length &&
    pathname.startsWith(prefix) &&
    pathname.endsWith(suffix)
  );
}

export function expectedHeadersForPath(rules, pathname) {
  const headers = new Map();
  for (const rule of rules) {
    if (!routeMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      if (headers.has(name)) {
        throw new Error(`multiple _headers values resolve for ${pathname}: ${name}`);
      }
      headers.set(name, value);
    }
  }
  return headers;
}

export function buildRequestHeaders({
  workerName,
  versionId,
  accessClientId,
  accessClientSecret,
} = {}) {
  if ((workerName === undefined) !== (versionId === undefined)) {
    throw new Error("worker name and version ID must be supplied together");
  }
  if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
    throw new Error("both Cloudflare Access service-token values are required");
  }
  const headers = new Headers({
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  });
  if (workerName !== undefined && versionId !== undefined) {
    if (!WORKER_NAME.test(workerName)) throw new Error("invalid Cloudflare Worker name");
    if (!VERSION_ID.test(versionId)) throw new Error("invalid Cloudflare Worker version ID");
    headers.set(
      "Cloudflare-Workers-Version-Overrides",
      `${workerName}="${versionId.toLowerCase()}"`,
    );
  }
  if (accessClientId !== undefined && accessClientSecret !== undefined) {
    headers.set("CF-Access-Client-Id", assertHeaderToken(accessClientId, "Access client ID"));
    headers.set(
      "CF-Access-Client-Secret",
      assertHeaderToken(accessClientSecret, "Access client secret"),
    );
  }
  return headers;
}

function exactPath(rule) {
  const prefix = "exact:";
  if (typeof rule.canonicalUrlRule !== "string" || !rule.canonicalUrlRule.startsWith(prefix)) {
    throw new Error(`artifact entry ${rule.id} must use an exact URL rule`);
  }
  return rule.canonicalUrlRule.slice(prefix.length);
}

function mapRules(contract) {
  return contract.entries
    .filter((entry) => entry.kind === "dist" || entry.kind === "dist-control")
    .map((entry) => ({ ...entry, pattern: new RegExp(entry.sourcePattern, "u") }));
}

function requireEntry(contract, id) {
  const entry = contract.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`artifact contract is missing ${id}`);
  return entry;
}

export async function loadLiveProbes({
  distDirectory,
  contractFile,
  expectedRelease,
}) {
  const release = assertExpectedRelease(expectedRelease);
  const dist = path.resolve(distDirectory);
  const contract = JSON.parse(await readFile(path.resolve(contractFile), "utf8"));
  const files = await collectRegularFiles(dist);
  const rules = mapRules(contract);
  const headerRules = parseHeaderRules(await readFile(path.join(dist, "_headers"), "utf8"));
  const probes = [];

  for (const rule of rules) {
    if (!files.some((file) => rule.pattern.test(file.relative))) {
      throw new Error(`dist is missing live artifact class ${rule.id}`);
    }
  }

  for (const file of files) {
    const matches = rules.filter((rule) => rule.pattern.test(file.relative));
    if (matches.length !== 1) {
      throw new Error(`${file.relative} maps to ${matches.length} live artifact classes`);
    }
    const rule = matches[0];
    if (rule.kind === "dist-control") continue;
    const pathname = file.relative === "index.html" ? "/" : `/${file.relative}`;
    const headers = expectedHeadersForPath(headerRules, pathname);
    if (rule.releaseMarker === true && headers.get("x-qrwarden-release") !== release) {
      throw new Error(`release marker for ${pathname} differs from ${release}`);
    }
    const expectedCache = contract.cacheClasses?.[rule.cacheClass];
    if (expectedCache !== null && headers.get("cache-control") !== expectedCache) {
      throw new Error(`cache contract for ${pathname} is not represented in _headers`);
    }
    if (rule.cspClass !== "none" && !headers.has("content-security-policy")) {
      throw new Error(`CSP contract for ${pathname} is not represented in _headers`);
    }
    if (rule.cspClass === "none" && headers.has("content-security-policy")) {
      throw new Error(`CSP must be absent for ${pathname}`);
    }
    probes.push({
      id: rule.id,
      pathname,
      expectedStatus: rule.expectedStatus,
      expectedMediaType: rule.mediaType,
      expectedHeaders: headers,
      forbiddenHeaders: rule.cspClass === "none" ? ["content-security-policy"] : [],
      expectedBody: await readFile(file.absolute),
    });
  }

  const manifest = JSON.parse(await readFile(path.join(dist, "app.webmanifest"), "utf8"));
  const releaseVersion = release.slice(1, release.indexOf("+"));
  if (manifest.version !== releaseVersion) {
    throw new Error("web manifest version differs from the expected live release");
  }

  const indexRedirect = requireEntry(contract, "index-redirect");
  probes.push({
    id: indexRedirect.id,
    pathname: exactPath(indexRedirect),
    expectedStatus: indexRedirect.expectedStatus,
    expectedLocation: indexRedirect.location,
  });

  const platformHeaders = requireEntry(contract, "platform-headers");
  probes.push({
    id: platformHeaders.id,
    pathname: "/_headers",
    expectedStatus: platformHeaders.expectedStatus,
  });

  const sourceMaps = requireEntry(contract, "source-maps");
  const mappedAssets = files.filter(
    (file) => file.relative.startsWith("assets/") && /\.(?:css|js)$/u.test(file.relative),
  );
  if (mappedAssets.length === 0) throw new Error("dist has no hashed assets for source-map probes");
  for (const asset of mappedAssets) {
    probes.push({
      id: sourceMaps.id,
      pathname: `/${asset.relative}.map`,
      expectedStatus: sourceMaps.expectedStatus,
    });
  }
  probes.push({
    id: sourceMaps.id,
    pathname: "/assets/qrwarden-live-probe-missing.map",
    expectedStatus: sourceMaps.expectedStatus,
  });
  probes.push({
    id: "unknown-path",
    pathname: "/.well-known/qrwarden-live-probe-missing",
    expectedStatus: contract.unmatchedPublicStatus,
  });

  return probes;
}

async function readBoundedBody(response, limit) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response body exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function verifyProbeResponse({ probe, response }) {
  if (response.status !== probe.expectedStatus) {
    throw new Error(`${probe.pathname} returned ${response.status}, expected ${probe.expectedStatus}`);
  }
  if (probe.expectedLocation !== undefined) {
    const location = response.headers.get("location");
    if (location !== probe.expectedLocation) {
      throw new Error(`${probe.pathname} returned an unexpected redirect location`);
    }
  }
  if (probe.expectedMediaType !== undefined && probe.expectedMediaType !== null) {
    const mediaType = response.headers.get("content-type");
    if (normalizeHeaderValue(mediaType ?? "") !== normalizeHeaderValue(probe.expectedMediaType)) {
      throw new Error(`${probe.pathname} returned an unexpected Content-Type`);
    }
  }
  for (const [name, expected] of probe.expectedHeaders ?? []) {
    const actual = response.headers.get(name);
    if (normalizeHeaderValue(actual ?? "") !== expected) {
      throw new Error(`${probe.pathname} returned an unexpected ${name} header`);
    }
  }
  for (const name of probe.forbiddenHeaders ?? []) {
    if (response.headers.has(name)) {
      throw new Error(`${probe.pathname} returned forbidden ${name}`);
    }
  }
  for (const name of REPORTING_HEADER_NAMES) {
    if (response.headers.has(name) && probe.expectedHeaders?.has(name) !== true) {
      throw new Error(
        `${probe.pathname} returned reporting header ${name}; opt out of Network Error Logging in the Cloudflare dashboard — verification fails closed until live responses stop advertising reporting endpoints`,
      );
    }
  }
  if (probe.expectedBody !== undefined) {
    const actual = await readBoundedBody(response, probe.expectedBody.byteLength + 1);
    if (actual.byteLength !== probe.expectedBody.byteLength || sha256(actual) !== sha256(probe.expectedBody)) {
      throw new Error(`${probe.pathname} body differs from the verified dist bytes`);
    }
  } else {
    await readBoundedBody(response, MAX_FAILURE_BODY_BYTES);
  }
}

export async function verifyCloudflareLive({
  origin,
  distDirectory,
  contractFile,
  expectedRelease,
  workerName,
  versionId,
  accessClientId,
  accessClientSecret,
  timeoutMs = 15_000,
  fetchImplementation = fetch,
}) {
  const normalizedOrigin = assertOrigin(origin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("timeout must be an integer from 1000 through 60000 milliseconds");
  }
  const probes = await loadLiveProbes({ distDirectory, contractFile, expectedRelease });
  const headers = buildRequestHeaders({
    workerName,
    versionId,
    accessClientId,
    accessClientSecret,
  });
  for (const probe of probes) {
    let response;
    try {
      response = await fetchImplementation(new URL(probe.pathname, normalizedOrigin), {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`${probe.pathname} request failed`);
    }
    await verifyProbeResponse({ probe, response });
  }
  return probes.length;
}

async function main() {
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set([
      "--origin",
      "--dist",
      "--expected-release",
      "--worker-name",
      "--version-id",
      "--timeout-ms",
    ]),
  );
  if (options["--origin"] === undefined || options["--expected-release"] === undefined) {
    throw new Error(
      "usage: verify-cloudflare-live.mjs --origin <https-origin> --expected-release <id> [--dist <directory>] [--worker-name <name> --version-id <uuid>] [--timeout-ms <ms>]",
    );
  }
  const count = await verifyCloudflareLive({
    origin: options["--origin"],
    distDirectory: options["--dist"] ?? "dist",
    contractFile: "release/artifact-contract.json",
    expectedRelease: options["--expected-release"],
    workerName: options["--worker-name"],
    versionId: options["--version-id"],
    accessClientId: process.env.CF_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
    timeoutMs: options["--timeout-ms"] === undefined
      ? 15_000
      : Number(options["--timeout-ms"]),
  });
  process.stdout.write(
    `verified ${count} live Cloudflare responses at ${assertOrigin(options["--origin"])}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
