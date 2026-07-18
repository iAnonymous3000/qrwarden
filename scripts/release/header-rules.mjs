export const REPORTING_HEADER_NAMES = Object.freeze([
  "nel",
  "report-to",
  "reporting-endpoints",
]);

export function normalizeHeaderValue(value) {
  return value.trim().replace(/[\t ]+/gu, " ");
}

/** Resolves one exact CSP class from the authoritative artifact contract. */
export function expectedCspForClass(cspClasses, cspClass) {
  if (
    cspClasses === null ||
    typeof cspClasses !== "object" ||
    Array.isArray(cspClasses) ||
    typeof cspClass !== "string" ||
    !Object.hasOwn(cspClasses, cspClass)
  ) {
    throw new Error(`unknown CSP class: ${String(cspClass)}`);
  }
  const expected = cspClasses[cspClass];
  if (expected === null) return null;
  if (
    typeof expected !== "string" ||
    expected.length === 0 ||
    expected.includes("\n") ||
    expected.includes("\r") ||
    normalizeHeaderValue(expected) !== expected
  ) {
    throw new Error(`invalid exact CSP policy for class: ${cspClass}`);
  }
  return expected;
}

/** Requires one route's effective CSP to equal its committed class exactly. */
export function assertExactCspForPath({
  headers,
  pathname,
  cspClasses,
  cspClass,
}) {
  const expected = expectedCspForClass(cspClasses, cspClass);
  const actual = headers.get("content-security-policy") ?? null;
  if (actual !== expected) {
    throw new Error(`CSP for ${pathname} does not match the exact ${cspClass} policy`);
  }
}

/** Parses the supported Cloudflare Pages _headers subset fail-closed. */
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
      current = { pattern: line, headers: [], detachments: [] };
      rules.push(current);
      continue;
    }
    if (current === null) {
      throw new Error(`orphan _headers value at line ${index + 1}`);
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("!")) {
      const detached = /^!\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/u.exec(trimmed);
      if (detached === null) {
        throw new Error(`invalid detached _headers field at line ${index + 1}`);
      }
      const name = detached[1];
      // Pages supports arbitrary detachments, but this release contract only
      // removes reporting endpoints. Accepting broader removals here could let
      // a generated file silently detach CSP or another required safeguard.
      if (name === undefined || !REPORTING_HEADER_NAMES.includes(name.toLowerCase())) {
        throw new Error(`detaching header ${name ?? ""} is unsupported at line ${index + 1}`);
      }
      const normalized = name.toLowerCase();
      if (current.detachments.includes(normalized)) {
        throw new Error(`duplicate detached _headers field at line ${index + 1}`);
      }
      current.detachments.push(normalized);
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 1) {
      throw new Error(`invalid _headers value at line ${index + 1}`);
    }
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || value.length === 0) {
      throw new Error(`invalid _headers field at line ${index + 1}`);
    }
    if (REPORTING_HEADER_NAMES.includes(name.toLowerCase())) {
      throw new Error(
        `reporting header ${name} is forbidden in _headers at line ${index + 1}`,
      );
    }
    current.headers.push([name.toLowerCase(), normalizeHeaderValue(value)]);
  }
  if (rules.length === 0) {
    throw new Error("_headers must contain at least one rule");
  }
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

/** Resolves one response's effective headers and rejects ambiguous values. */
export function expectedHeadersForPath(rules, pathname) {
  const headers = new Map();
  for (const rule of rules) {
    if (!routeMatches(rule.pattern, pathname)) continue;
    // A narrower later rule may remove a value inherited from an earlier,
    // more pervasive match, mirroring Pages' documented detach semantics.
    for (const name of rule.detachments) {
      headers.delete(name);
    }
    for (const [name, value] of rule.headers) {
      if (headers.has(name)) {
        throw new Error(`multiple _headers values resolve for ${pathname}: ${name}`);
      }
      headers.set(name, value);
    }
  }
  return headers;
}
