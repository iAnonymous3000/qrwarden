import { deepFreeze } from "./freeze";
import type {
  ActionPolicy,
  AnalysisReport,
  AnalysisSignal,
  PayloadKind,
  DisplayField,
} from "./types";

export const ANALYZER_VERSION = "1.0.4";

export const PERMANENT_LIMITATIONS = Object.freeze([
  "Analysis uses only the content contained in the QR code.",
  "QRWarden does not visit the destination or check reputation, DNS, TLS, redirects, domain age, or page content.",
]);

export interface ReportParts {
  readonly kind: PayloadKind;
  readonly fields: readonly DisplayField[];
  readonly signals?: readonly AnalysisSignal[];
  readonly actionPolicy?: ActionPolicy;
  readonly canonicalHref?: string;
  readonly limitations?: readonly string[];
}

export function createReport(parts: ReportParts): AnalysisReport {
  const report: AnalysisReport = {
    schemaVersion: 1,
    analyzerVersion: ANALYZER_VERSION,
    kind: parts.kind,
    ...(parts.canonicalHref === undefined
      ? {}
      : { canonicalHref: parts.canonicalHref }),
    displayFields: [...parts.fields],
    signals: [...(parts.signals ?? [])],
    limitations: [...(parts.limitations ?? PERMANENT_LIMITATIONS)],
    actionPolicy: parts.actionPolicy ?? "inspect-only",
  };
  return deepFreeze(report);
}

export function signal(
  code: AnalysisSignal["code"],
  level: AnalysisSignal["level"],
  title: string,
  detail: string,
): AnalysisSignal {
  return { code, level, title, detail };
}
