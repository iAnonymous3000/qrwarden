import {
  escapeCodePoint,
  forbiddenCharacters,
  hasAsciiConfusableLabel,
  hasMixedScripts,
} from "./characters";
import { classifyIp, classifyLocalHostname } from "./ip";
import { toAsciiDomain, toUnicodeDomain } from "./idna";
import { ANALYZER_LIMITS, ReportFields } from "./limits";
import { matchLinkShortener } from "./linkShorteners";
import { registrableDomain } from "./publicSuffix";
import { createReport, signal } from "./report";
import type { AnalysisReport, AnalysisSignal } from "./types";

interface LexicalAuthority {
  readonly prefix: string;
  readonly rawAuthority: string;
  readonly suffix: string;
  readonly boundary: string;
}

function lexicalAuthority(original: string): LexicalAuthority | null {
  const prefix = /^(?:https?):\/\//i.exec(original)?.[0];
  if (prefix === undefined) return null;
  const rest = original.slice(prefix.length);
  const boundaryIndex = rest.search(/[\\/?#]/);
  if (boundaryIndex < 0) {
    return { prefix, rawAuthority: rest, suffix: "", boundary: "" };
  }
  return {
    prefix,
    rawAuthority: rest.slice(0, boundaryIndex),
    suffix: rest.slice(boundaryIndex),
    boundary: rest[boundaryIndex] ?? "",
  };
}

interface RawHostPort {
  readonly host: string;
  readonly port: string | null;
}

function rawHostPort(rawAuthority: string): RawHostPort {
  const afterUserinfo = rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1);
  if (afterUserinfo.startsWith("[")) {
    const close = afterUserinfo.indexOf("]");
    if (close >= 0) {
      const rest = afterUserinfo.slice(close + 1);
      return {
        host: afterUserinfo.slice(0, close + 1),
        port: /^:[0-9]+$/.test(rest) ? rest.slice(1) : null,
      };
    }
  }
  const colon = afterUserinfo.lastIndexOf(":");
  if (colon >= 0 && /^[0-9]+$/.test(afterUserinfo.slice(colon + 1))) {
    return {
      host: afterUserinfo.slice(0, colon),
      port: afterUserinfo.slice(colon + 1),
    };
  }
  return { host: afterUserinfo, port: null };
}

function normalizePercentHex(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());
}

function canonicalSuffix(url: URL): string {
  const authority = /^(?:https?):\/\/[^/?#]*/i.exec(url.href)?.[0];
  return authority === undefined ? "" : url.href.slice(authority.length);
}

function materialBrowserRewrite(
  original: string,
  url: URL,
  lexical: LexicalAuthority | null,
  pinnedSuppliedHostname: string | null,
): boolean {
  if (lexical === null) return true;
  if (/^[\u0000-\u0020]|[\u0000-\u0020]$/.test(original)) return true;
  if (/[\t\n\r\\]/.test(original)) return true;
  if ((lexical.rawAuthority.match(/@/g)?.length ?? 0) > 1) return true;

  let expectedSuffix = lexical.suffix;
  if (expectedSuffix === "") expectedSuffix = "/";
  else if (expectedSuffix.startsWith("?") || expectedSuffix.startsWith("#")) {
    expectedSuffix = `/${expectedSuffix}`;
  }
  if (normalizePercentHex(expectedSuffix) !== normalizePercentHex(canonicalSuffix(url))) {
    return true;
  }

  const suppliedParts = rawHostPort(lexical.rawAuthority);
  const supplied = suppliedParts.host;
  const suppliedWithoutBrackets = supplied.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const parsedWithoutBrackets = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (pinnedSuppliedHostname !== null) {
    if (
      pinnedSuppliedHostname.replace(/\.$/, "") !==
      parsedWithoutBrackets
    ) {
      return true;
    }
  } else if (/^[\x00-\x7f]*$/.test(suppliedWithoutBrackets)) {
    if (suppliedWithoutBrackets.toLowerCase() !== parsedWithoutBrackets.toLowerCase()) {
      return true;
    }
  } else {
    // A non-ASCII raw host is an allowed serialization-only rewrite only when
    // the pinned Unicode 17 conversion was available and matched the browser.
    return true;
  }
  if (suppliedParts.port !== null) {
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    const exactDefaultElision = suppliedParts.port === defaultPort && url.port === "";
    if (!exactDefaultElision && suppliedParts.port !== url.port) return true;
  }
  return false;
}

interface NameSummary {
  readonly names: string;
  readonly reportNames: string;
  readonly count: number;
  readonly omitted: number;
}

function summarizeNames(parameters: URLSearchParams, raw: string): NameSummary {
  const names: string[] = [];
  let count = 0;
  for (const [name] of parameters) {
    if (names.length < ANALYZER_LIMITS.urlNames) names.push(name);
    count += 1;
  }
  // A pair without "=" is all payload: the parser surfaces the whole token
  // as a name, so the copied report treats it as a hidden value instead.
  const listed: string[] = [];
  let valueless = 0;
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    if (!pair.includes("=")) {
      valueless += 1;
      continue;
    }
    for (const [name] of new URLSearchParams(pair)) {
      if (listed.length < ANALYZER_LIMITS.urlNames) listed.push(name);
    }
  }
  const valuelessNote =
    valueless === 0
      ? ""
      : `(${valueless} valueless ${valueless === 1 ? "entry" : "entries"} hidden)`;
  const reportNames = [listed.join(", "), valuelessNote]
    .filter((part) => part !== "")
    .join(" ");
  return {
    names: names.length === 0 ? "None" : names.join(", "),
    reportNames: reportNames === "" ? "None" : reportNames,
    count,
    omitted: Math.max(0, count - names.length),
  };
}

function malformedUrlReport(
  original: string,
  lexical: LexicalAuthority | null,
  parsed: URL | null,
): AnalysisReport {
  const fields = new ReportFields();
  const signals: AnalysisSignal[] = [];
  // Unparsable payloads have no structural form to export, so the copied
  // report hides the value rather than leaking whatever the query carried.
  fields.add("original", "QR content", original, { reportRedacted: true });

  const authorityControls =
    lexical === null ? forbiddenCharacters(original) : forbiddenCharacters(lexical.rawAuthority);
  if (authorityControls.length > 0) {
    signals.push(
      signal(
        "forbidden-authority-character",
        "review",
        "Forbidden character in the address authority",
        `Opening is disabled because the authority contains ${authorityControls
          .map(escapeCodePoint)
          .join(", ")}.`,
      ),
    );
  }
  if (lexical?.rawAuthority.includes("@") || parsed?.username || parsed?.password) {
    const host = parsed?.hostname || "an unavailable host";
    signals.push(
      signal(
        "userinfo",
        "review",
        "Text before @ is not the destination",
        `Text before @ is not the destination. The actual host is ${host}.`,
      ),
    );
  }
  signals.push(
    signal(
      "malformed-web-url",
      "review",
      "Web address cannot be opened",
      "The complete payload did not parse as an absolute HTTP or HTTPS address with a host.",
    ),
  );
  return createReport({
    kind: "web-url",
    fields: fields.value,
    signals,
    actionPolicy: "inspect-only",
  });
}

/** Returns null only when the text is not an HTTP(S)-shaped candidate. */
export function analyzeHttpUrl(original: string): AnalysisReport | null {
  let parsed: URL | null = null;
  try {
    parsed = new URL(original);
  } catch {
    // An explicit HTTP(S) scheme still gets a web report explaining the failure.
  }
  const webShaped = /^(?:https?):/i.test(original) ||
    parsed?.protocol === "http:" || parsed?.protocol === "https:";
  if (!webShaped) return null;

  const lexical = lexicalAuthority(original);
  if (
    parsed === null ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === ""
  ) {
    return malformedUrlReport(original, lexical, parsed);
  }

  const fields = new ReportFields();
  const signals: AnalysisSignal[] = [];
  const asciiHostname = parsed.hostname;
  const ip = classifyIp(asciiHostname);
  const localCategory = classifyLocalHostname(asciiHostname);
  const trailingDot = asciiHostname.endsWith(".");
  const raw = lexical === null ? null : rawHostPort(lexical.rawAuthority);
  let unicode = asciiHostname;
  let pinnedSuppliedHostname: string | null = null;

  if (ip === null) {
    const pinnedUnicode = toUnicodeDomain(asciiHostname);
    if (pinnedUnicode === null) return malformedUrlReport(original, lexical, parsed);
    unicode = pinnedUnicode;

    const suppliedHostname = raw?.host.replace(/^\[|\]$/g, "") ?? "";
    if (/[^\x00-\x7f]/.test(suppliedHostname) && !suppliedHostname.includes("%")) {
      pinnedSuppliedHostname = toAsciiDomain(suppliedHostname);
      if (pinnedSuppliedHostname === null) {
        return malformedUrlReport(original, lexical, parsed);
      }
    }
  }

  fields.add("ascii-hostname", "Destination host", asciiHostname, { kind: "hostname" });
  if (unicode !== asciiHostname) {
    fields.add("unicode-hostname", "Unicode host", unicode, { kind: "hostname" });
    signals.push(
      signal(
        "idn-hostname",
        "context",
        "Internationalized domain name",
        "The host contains an internationalized label; its ASCII and Unicode forms are both shown.",
      ),
    );
  }

  if (ip === null) {
    const domain = registrableDomain(asciiHostname);
    fields.add(
      "registrable-domain",
      "Registrable domain",
      domain.registrableDomain ?? "Not available",
      { kind: "domain" },
    );
  }

  const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  fields.add(
    "port",
    "Port",
    raw?.port === null || raw?.port === undefined
      ? `${effectivePort} (effective)`
      : `${raw.port} (explicit)`,
    { kind: "port" },
  );
  // Path segments routinely carry capability tokens such as password-reset
  // and share links, so the copied report keeps only the segment count.
  const pathSegments = parsed.pathname.split("/").filter((part) => part !== "").length;
  const reportPath =
    pathSegments === 0
      ? parsed.pathname
      : `/(${pathSegments} ${pathSegments === 1 ? "segment" : "segments"} hidden)`;
  fields.add("path", "Path", parsed.pathname, {
    kind: "path",
    collapsed: true,
    reportValue: reportPath,
  });

  const query = summarizeNames(parsed.searchParams, parsed.search.slice(1));
  fields.add("query-names", "Query names", query.names, {
    kind: "names",
    collapsed: true,
    count: query.count,
    omittedCount: query.omitted,
    reportValue: query.reportNames,
  });

  if (parsed.hash === "") {
    fields.add("fragment", "Fragment", "Not present", { kind: "presence" });
  } else {
    const fragmentText = parsed.hash.slice(1);
    if (fragmentText.includes("=") || fragmentText.includes("&")) {
      const fragment = summarizeNames(new URLSearchParams(fragmentText), fragmentText);
      fields.add("fragment-names", "Fragment names", fragment.names, {
        kind: "names",
        collapsed: true,
        count: fragment.count,
        omittedCount: fragment.omitted,
        reportValue: fragment.reportNames,
      });
    } else {
      fields.add("fragment", "Fragment", "Present", {
        kind: "presence",
        collapsed: true,
      });
    }
  }
  fields.add("original", "Original QR content", original, {
    collapsed: true,
    // The copied report keeps the structure but never the path, query, or
    // fragment values, which routinely carry tokens and other secrets.
    reportValue:
      parsed.origin +
      reportPath +
      (parsed.search === "" ? "" : "?(query values hidden)") +
      (parsed.hash === "" ? "" : "#(fragment hidden)"),
  });

  if (trailingDot) {
    signals.push(
      signal(
        "trailing-dot-host",
        "context",
        "Trailing-dot host",
        "The destination host ends with a DNS root dot.",
      ),
    );
  }
  if (parsed.protocol === "http:") {
    signals.push(
      signal(
        "http",
        "review",
        "Unencrypted HTTP",
        "The address uses HTTP rather than HTTPS.",
      ),
    );
  }
  if (ip !== null) {
    signals.push(
      signal(
        "ip-address",
        "review",
        "IP-address destination",
        `The destination is an IPv${ip.version} address rather than a domain name.`,
      ),
    );
  }
  const specialCategory =
    ip !== null && ip.special && !ip.globallyReachable ? ip.category : localCategory;
  if (specialCategory !== undefined && specialCategory !== null) {
    fields.add("destination-category", "Destination category", specialCategory);
    signals.push(
      signal(
        "local-or-special-destination",
        "review",
        "Local or special-purpose destination",
        `The destination is classified as ${specialCategory}.`,
      ),
    );
  }
  if (parsed.port !== "") {
    signals.push(
      signal(
        "non-default-port",
        "review",
        "Non-default port",
        `The address explicitly uses port ${parsed.port}.`,
      ),
    );
  }
  const shortener = ip === null ? matchLinkShortener(asciiHostname) : null;
  if (shortener !== null) {
    signals.push(
      signal(
        "link-shortener",
        "review",
        "Link-shortener destination",
        `The host ${shortener} is a link-shortening service. The final destination stays hidden until the link is opened.`,
      ),
    );
  }
  if (hasMixedScripts(unicode)) {
    signals.push(
      signal(
        "mixed-scripts",
        "review",
        "Mixed writing systems",
        "The complete host falls outside the Unicode Highly Restrictive profile.",
      ),
    );
  }
  if (hasAsciiConfusableLabel(unicode)) {
    signals.push(
      signal(
        "confusable-label",
        "review",
        "ASCII-like internationalized label",
        "A non-ASCII host label has a different ASCII-only confusable skeleton.",
      ),
    );
  }

  const afterAuthorityControls =
    lexical === null ? [] : forbiddenCharacters(lexical.suffix);
  if (afterAuthorityControls.length > 0) {
    signals.push(
      signal(
        "hidden-character",
        "review",
        "Hidden or control character",
        `Outside the authority, the original contains ${afterAuthorityControls
          .map(escapeCodePoint)
          .join(", ")}.`,
      ),
    );
  }

  const authorityControls =
    lexical === null ? forbiddenCharacters(original) : forbiddenCharacters(lexical.rawAuthority);
  const rawUserinfo = lexical?.rawAuthority.includes("@") ?? false;
  const parsedUserinfo = parsed.username !== "" || parsed.password !== "";
  if (rawUserinfo || parsedUserinfo) {
    signals.push(
      signal(
        "userinfo",
        "review",
        "Text before @ is not the destination",
        `Text before @ is not the destination. The actual host is ${asciiHostname}.`,
      ),
    );
  }
  if (authorityControls.length > 0) {
    signals.push(
      signal(
        "forbidden-authority-character",
        "review",
        "Forbidden character in the address authority",
        `Opening is disabled because the authority contains ${authorityControls
          .map(escapeCodePoint)
          .join(", ")}.`,
      ),
    );
  }
  if (materialBrowserRewrite(original, parsed, lexical, pinnedSuppliedHostname)) {
    signals.push(
      signal(
        "material-browser-rewrite",
        "review",
        "Material browser rewrite",
        "The browser's parsed address differs in a way beyond the allowed serialization-only normalizations.",
      ),
    );
  }

  const inspectOnly =
    rawUserinfo ||
    parsedUserinfo ||
    authorityControls.length > 0 ||
    (lexical === null && forbiddenCharacters(original).length > 0);
  const actionPolicy = inspectOnly
    ? "inspect-only"
    : signals.some((item) => item.level === "review")
      ? "confirm-web"
      : "open-web";

  return createReport({
    kind: "web-url",
    canonicalHref: parsed.href,
    fields: fields.value,
    signals,
    actionPolicy,
  });
}
