import type { AnalysisReport } from "../analyzer";
import { COPY } from "../copy";
import { translateFieldLabel, translateSignalTitle } from "../copy/evidence";

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
    const value =
      field.sensitive || field.reportRedacted
        ? COPY.reportHiddenValue
        : (field.reportValue ?? field.value);
    lines.push(`- ${translateFieldLabel(field.label).text}: ${value}`);
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
