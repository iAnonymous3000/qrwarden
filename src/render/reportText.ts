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

function isUrlNamesField(report: AnalysisReport, field: DisplayField): boolean {
  return report.kind === "web-url" &&
    (field.id === "query-names" || field.id === "fragment-names");
}

function urlNamesReportValue(field: DisplayField): string {
  const count = fieldCount(field);
  if (count === null) return COPY.reportHiddenValue;
  if (count > 0) return COPY.reportUrlEntriesHidden(count);
  if (field.value !== "None") return COPY.reportHiddenValue;
  return translateFieldValue(field).text;
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
  if (queryCount === null || queryCount !== canonicalQueryCount) {
    return COPY.reportHiddenValue;
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
    } else if (
      !report.displayFields.some(
        (candidate) => candidate.id === "fragment" && candidate.value === "Present",
      )
    ) {
      return COPY.reportHiddenValue;
    }
  }

  return (
    parsed.origin +
    safePath +
    (parsed.search === "" ? "" : `?${COPY.reportQueryHidden}`) +
    (parsed.hash === "" ? "" : `#${COPY.reportFragmentHidden}`)
  );
}

function reportFieldValue(report: AnalysisReport, field: DisplayField): string {
  if (isUrlNamesField(report, field)) return urlNamesReportValue(field);
  if (report.kind === "web-url" && field.id === "path") {
    return urlPathReportValue(field);
  }
  if (report.kind === "web-url" && field.id === "original") {
    return safeOriginalUrlSummary(report, field);
  }
  if (field.sensitive || field.reportRedacted) return COPY.reportHiddenValue;
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
 * structural evidence only: sensitive and report-redacted field values are
 * never included, regardless of the on-screen reveal state, and individual
 * values are exported only via the explicit per-field copy buttons.
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
    if (field.truncated) {
      lines.push(`  ${COPY.reportTruncatedNote}`);
    }
  }

  for (const limitation of report.limitations) {
    lines.push(LIMITATION_COPY[limitation] ?? limitation);
  }
  lines.push(`${COPY.analyzerLabel}: ${report.analyzerVersion}`);
  return lines.join("\n");
}
