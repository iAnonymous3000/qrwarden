import type { AnalysisReport } from "../analyzer";
import { COPY } from "../copy";

export interface ReportTextInput {
  readonly report: AnalysisReport;
  readonly kindLabel: string;
  readonly statusHeading: string;
}

/**
 * Renders the reviewed report as plain text for a user-initiated copy, e.g.
 * to forward a suspicious code to a security team. Sensitive field values are
 * never included, regardless of the on-screen reveal state, so the copied
 * text cannot leak more than the visible non-sensitive evidence.
 */
export function reportAsText(input: ReportTextInput): string {
  const { report } = input;
  const lines: string[] = [
    COPY.reportTitle,
    `Kind: ${input.kindLabel}`,
    `Status: ${input.statusHeading}`,
  ];

  if (report.signals.length > 0) {
    lines.push("Signals:");
    for (const signal of report.signals) {
      const level =
        signal.level === "review" ? COPY.signalNeedsReview : COPY.signalContext;
      lines.push(`- [${level}] ${signal.title}: ${signal.detail}`);
    }
  }

  lines.push("Decoded contents:");
  for (const field of report.displayFields) {
    const value = field.sensitive ? COPY.reportHiddenValue : field.value;
    lines.push(`- ${field.label}: ${value}`);
    if (field.truncated) {
      lines.push("  (value truncated for display)");
    }
  }

  for (const limitation of report.limitations) {
    lines.push(limitation);
  }
  lines.push(`Analyzer: ${report.analyzerVersion}`);
  return lines.join("\n");
}
