import type { AnalysisReport, DisplayField } from "../analyzer";
import { COPY } from "../copy";
import {
  translateFieldLabel,
  translateFieldValue,
  translateSignalTitle,
} from "../copy/evidence";

export interface ReportTextInput {
  readonly report: AnalysisReport;
  readonly kindLabel: string;
  readonly statusHeading: string;
}

// The analyzer states its permanent limitations as these exact English
// sentences. Known sentences render in the localized form; anything new
// passes through in English until a translation exists.
const LIMITATION_COPY: Readonly<Record<string, string>> = Object.freeze({
  "Analysis uses only the content contained in the QR code.":
    COPY.limitationContentOnly,
  "QRWarden does not visit the destination or check reputation, DNS, TLS, redirects, domain age, or page content.":
    COPY.limitationNoVisit,
});

function fieldCount(field: DisplayField): number | null {
  return field.count !== undefined &&
    Number.isSafeInteger(field.count) &&
    field.count >= 0
    ? field.count
    : null;
}

function urlDelimiterPresence(parsed: URL): {
  readonly query: boolean;
  readonly fragment: boolean;
} {
  const authority = /^(?:https?):\/\/[^/?#]*/iu.exec(parsed.href)?.[0];
  if (authority === undefined) return { query: false, fragment: false };
  const suffix = parsed.href.slice(authority.length);
  const query = suffix.indexOf("?");
  const fragment = suffix.indexOf("#");
  return {
    query: query >= 0 && (fragment < 0 || query < fragment),
    fragment: fragment >= 0,
  };
}

function isUrlNamesField(report: AnalysisReport, field: DisplayField): boolean {
  return report.kind === "web-url" &&
    (field.id === "query-names" || field.id === "fragment-names");
}

function urlNamesReportValue(field: DisplayField): string {
  const count = fieldCount(field);
  if (count === null) return COPY.reportHiddenValue;
  if (count > 0) {
    return field.reportValue === `Count: ${count}`
      ? COPY.reportUrlEntriesHidden(count)
      : COPY.reportHiddenValue;
  }
  if (field.value !== "None" && field.value !== "Present (empty)") {
    return COPY.reportHiddenValue;
  }
  return field.reportValue === field.value
    ? translateFieldValue(field).text
    : COPY.reportHiddenValue;
}

function urlPathReportValue(field: DisplayField): string {
  const count = fieldCount(field);
  if (count === null) return COPY.reportHiddenValue;
  if (count > 0) return `/${COPY.reportPathSegmentsHidden(count)}`;

  // A zero-segment path can contain separators only. Use the analyzer-owned
  // replacement, not the original display value, and fail closed on drift.
  const safePath = field.reportValue;
  return safePath !== undefined && /^\/+$/u.test(safePath)
    ? safePath
    : COPY.reportHiddenValue;
}

function safeOriginalUrlSummary(
  report: AnalysisReport,
  field: DisplayField,
): string {
  if (report.canonicalHref === undefined || field.reportValue === undefined) {
    return COPY.reportHiddenValue;
  }

  let parsed: URL;
  try {
    parsed = new URL(report.canonicalHref);
  } catch {
    return COPY.reportHiddenValue;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.origin !== field.reportValue
  ) {
    return COPY.reportHiddenValue;
  }
  const delimiters = urlDelimiterPresence(parsed);

  const pathField = report.displayFields.find((candidate) => candidate.id === "path");
  if (pathField === undefined) return COPY.reportHiddenValue;
  const pathCount = fieldCount(pathField);
  const canonicalPathCount = parsed.pathname
    .split("/")
    .filter((part) => part !== "").length;
  if (pathCount === null || pathCount !== canonicalPathCount) {
    return COPY.reportHiddenValue;
  }
  const safePath = urlPathReportValue(pathField);
  if (safePath === COPY.reportHiddenValue) return COPY.reportHiddenValue;

  const queryField = report.displayFields.find(
    (candidate) => candidate.id === "query-names",
  );
  const queryCount = queryField === undefined ? null : fieldCount(queryField);
  const canonicalQueryCount = Array.from(parsed.searchParams).length;
  if (
    queryCount === null ||
    queryCount !== canonicalQueryCount ||
    queryField === undefined ||
    urlNamesReportValue(queryField) === COPY.reportHiddenValue
  ) {
    return COPY.reportHiddenValue;
  }
  if (canonicalQueryCount === 0) {
    const expected = delimiters.query ? "Present (empty)" : "None";
    if (queryField?.value !== expected) return COPY.reportHiddenValue;
  }

  if (parsed.hash !== "") {
    const fragmentText = parsed.hash.slice(1);
    if (fragmentText.includes("=") || fragmentText.includes("&")) {
      const fragmentField = report.displayFields.find(
        (candidate) => candidate.id === "fragment-names",
      );
      const fragmentCount =
        fragmentField === undefined ? null : fieldCount(fragmentField);
      const canonicalFragmentCount = Array.from(
        new URLSearchParams(fragmentText),
      ).length;
      if (fragmentCount === null || fragmentCount !== canonicalFragmentCount) {
        return COPY.reportHiddenValue;
      }
      if (
        fragmentField === undefined ||
        urlNamesReportValue(fragmentField) === COPY.reportHiddenValue
      ) {
        return COPY.reportHiddenValue;
      }
    } else if (
      !report.displayFields.some(
        (candidate) => candidate.id === "fragment" && candidate.value === "Present",
      )
    ) {
      return COPY.reportHiddenValue;
    }
  } else {
    const fragmentField = report.displayFields.find(
      (candidate) => candidate.id === "fragment",
    );
    const expected = delimiters.fragment ? "Present (empty)" : "Not present";
    if (fragmentField?.value !== expected) return COPY.reportHiddenValue;
  }

  return (
    parsed.origin +
    safePath +
    (parsed.search === ""
      ? delimiters.query
        ? "?"
        : ""
      : `?${COPY.reportQueryHidden}`) +
    (parsed.hash === ""
      ? delimiters.fragment
        ? "#"
        : ""
      : `#${COPY.reportFragmentHidden}`)
  );
}

/**
 * Returns the analyzer-checked, redacted address summary suitable for an
 * always-visible result card. The complete canonical URL remains reserved for
 * the explicit open confirmation.
 */
export function reviewedUrlSummary(report: AnalysisReport): string | null {
  if (report.kind !== "web-url") return null;
  const original = report.displayFields.find(
    (candidate) => candidate.id === "original",
  );
  if (original === undefined || original.reportPolicy !== "safe") return null;
  const summary = safeOriginalUrlSummary(report, original);
  return summary === COPY.reportHiddenValue ? null : summary;
}

function reportFieldValue(report: AnalysisReport, field: DisplayField): string {
  if (field.sensitive || field.reportPolicy !== "safe") {
    return COPY.reportHiddenValue;
  }
  if (isUrlNamesField(report, field)) return urlNamesReportValue(field);
  if (report.kind === "web-url" && field.id === "path") {
    return urlPathReportValue(field);
  }
  if (report.kind === "web-url" && field.id === "original") {
    return safeOriginalUrlSummary(report, field);
  }
  return translateFieldValue({
    id: field.id,
    label: field.label,
    kind: field.kind,
    value: field.reportValue ?? field.value,
    ...(field.count === undefined ? {} : { count: field.count }),
  }).text;
}

/**
 * Renders the reviewed report as plain text for a user-initiated copy, e.g.
 * to forward a suspicious code to a security team. The report carries
 * structural evidence only: sensitive and fail-closed fields are never
 * included, regardless of the on-screen reveal state. Every exported field
 * must be explicitly marked safe by its analyzer call site.
 */
export function reportAsText(input: ReportTextInput): string {
  const { report } = input;
  const lines: string[] = [
    COPY.reportTitle,
    `${COPY.reportKindLabel}: ${input.kindLabel}`,
    `${COPY.reportStatusLabel}: ${input.statusHeading}`,
  ];

  if (report.signals.length > 0) {
    lines.push(`${COPY.reportSignalsLabel}:`);
    for (const signal of report.signals) {
      const level =
        signal.level === "review" ? COPY.signalNeedsReview : COPY.signalContext;
      const title = translateSignalTitle(signal.title).text;
      lines.push(`- [${level}] ${title}: ${signal.detail}`);
    }
  }

  lines.push(`${COPY.contentsHeading}:`);
  for (const field of report.displayFields) {
    const value = reportFieldValue(report, field);
    lines.push(`- ${translateFieldLabel(field.label).text}: ${value}`);
    if (
      !isUrlNamesField(report, field) &&
      field.omittedCount !== undefined &&
      field.omittedCount > 0
    ) {
      // The on-screen review discloses this omission, so the forwarded
      // report must disclose it too rather than read as complete evidence.
      lines.push(`  ${COPY.omittedFromDisplay(field.omittedCount, field.count)}`);
    }
    if (field.truncated && value !== COPY.reportHiddenValue) {
      lines.push(`  ${COPY.reportTruncatedNote}`);
    }
  }

  for (const limitation of report.limitations) {
    lines.push(LIMITATION_COPY[limitation] ?? limitation);
  }
  lines.push(`${COPY.analyzerLabel}: ${report.analyzerVersion}`);
  return lines.join("\n");
}
