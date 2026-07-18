import dataStatus from "../../release/data-status.json";
import { hasValidFrozenBytes, ReportFields } from "./limits";
import { createReport, signal } from "./report";
import { analyzeStructuredText } from "./structured";
import type {
  AnalysisReport,
  AnalyzerFrozenBytes,
  AnalyzerInput,
} from "./types";
import { analyzeHttpUrl } from "./url";

export type {
  ActionPolicy,
  AnalysisReport,
  AnalysisSignal,
  AnalysisSignalCode,
  AnalyzerFrozenBytes,
  AnalyzerInput,
  AnalyzerTextDecoding,
  DisplayField,
  DisplayFieldKind,
  PayloadKind,
  ReportFieldPolicy,
  SignalLevel,
} from "./types";
export { ANALYZER_LIMITS } from "./limits";
export { ANALYZER_VERSION, PERMANENT_LIMITATIONS } from "./report";

export const ANALYZER_DATA_STATUS = Object.freeze({
  releaseReady: dataStatus.releaseReady,
  publicSuffix: Object.freeze({
    captured: dataStatus.publicSuffix.captured,
    completeness: dataStatus.publicSuffix.completeness,
  }),
  ianaSpecialPurpose: Object.freeze({
    captured: dataStatus.ianaSpecialPurpose.captured,
    completeness: dataStatus.ianaSpecialPurpose.completeness,
  }),
  unicodeSecurity: Object.freeze({
    captured: dataStatus.unicodeSecurity.captured,
    unicodeVersion: dataStatus.unicodeSecurity.unicodeVersion,
    completeness: dataStatus.unicodeSecurity.completeness,
  }),
});

function binaryReport(bytes: AnalyzerFrozenBytes): AnalysisReport {
  const fields = new ReportFields();
  if (!hasValidFrozenBytes(bytes)) {
    fields.add("byte-count", "Byte count", "Unavailable", {
      kind: "count",
      reportPolicy: "safe",
    });
    fields.add("hex-preview", "Hexadecimal preview", "Unavailable", { kind: "hex" });
  } else {
    const previewCharacters = 256 * 2;
    const preview = bytes.hex.slice(0, previewCharacters);
    fields.add("byte-count", "Byte count", String(bytes.byteLength), {
      kind: "count",
      count: bytes.byteLength,
      reportPolicy: "safe",
    });
    fields.add(
      "hex-preview",
      "Hexadecimal preview",
      bytes.byteLength > 256
        ? `${preview}… (${bytes.byteLength} bytes total)`
        : preview || "Empty",
      { kind: "hex", collapsed: true },
    );
  }
  return createReport({ kind: "binary", fields: fields.value });
}

function inertReaderText(
  kind: "gs1" | "iso-15434",
  text: string,
): AnalysisReport {
  const fields = new ReportFields();
  fields.add(
    "format",
    "Structured format",
    kind === "gs1" ? "GS1" : "ISO/IEC 15434",
    { reportPolicy: "safe" },
  );
  fields.add("content", "Decoded content", text, {
    collapsed: true,
  });
  return createReport({ kind, fields: fields.value });
}

function textReport(text: string): AnalysisReport {
  const fields = new ReportFields();
  fields.add("text", "Text", text, { collapsed: true });
  return createReport({ kind: "text", fields: fields.value });
}

function emptyReport(): AnalysisReport {
  const fields = new ReportFields();
  fields.add("content", "QR content", "Empty", { reportPolicy: "safe" });
  return createReport({ kind: "empty", fields: fields.value });
}

const EXACT_STRUCTURED_SOURCE_FIELD_IDS = new Set([
  "original",
  "text",
  "otp-payload",
  "dpp-payload",
]);

/**
 * Structured summaries are intentionally selective, but the decoder output
 * must never be lost. Reserve the exact source before re-budgeting highlights,
 * then render it last so the useful parsed fields stay prominent.
 */
function ensureExactStructuredSource(
  report: AnalysisReport,
  text: string,
): AnalysisReport {
  const alreadyRetainsExactSource = report.displayFields.some(
    (field) =>
      EXACT_STRUCTURED_SOURCE_FIELD_IDS.has(field.id) &&
      field.actionValue === text,
  );
  if (alreadyRetainsExactSource) return report;

  const fields = new ReportFields();
  fields.add("original", "Original QR content", text, {
    sensitive: true,
    masked: true,
    collapsed: true,
  });
  const original = fields.value[0]!;

  for (const field of report.displayFields) {
    fields.add(field.id, field.label, field.actionValue, {
      kind: field.kind,
      sensitive: field.sensitive,
      masked: field.masked,
      collapsed: field.collapsed,
      ...(field.count === undefined ? {} : { count: field.count }),
      ...(field.omittedCount === undefined
        ? {}
        : { omittedCount: field.omittedCount }),
      reportPolicy: field.reportPolicy,
      ...(field.reportValue === undefined
        ? {}
        : { reportValue: field.reportValue }),
    });
  }

  const highlights = fields.value.slice(1);
  return createReport({
    kind: report.kind,
    fields: [...highlights, original],
    signals: report.signals,
    limitations: report.limitations,
    actionPolicy: report.actionPolicy,
    ...(report.canonicalHref === undefined
      ? {}
      : { canonicalHref: report.canonicalHref }),
  });
}

function reportForDecodedText(
  contentType: string,
  text: string,
  rawBytes: AnalyzerFrozenBytes,
): AnalysisReport {
  if (contentType === "GS1") {
    return inertReaderText("gs1", text);
  }
  if (contentType === "ISO15434") {
    return inertReaderText("iso-15434", text);
  }
  if (contentType !== "Text") return binaryReport(rawBytes);

  const url = analyzeHttpUrl(text);
  if (url !== null) return url;
  const structured = analyzeStructuredText(text);
  if (structured !== null) return ensureExactStructuredSource(structured, text);
  if (text === "") return emptyReport();
  return textReport(text);
}

function appendAssumedIso88591Signal(
  report: AnalysisReport,
  decoding: Extract<AnalyzerInput["decoding"], { readonly kind: "text" }>,
): AnalysisReport {
  if (decoding.encoding !== "iso-8859-1" || decoding.eci !== null) {
    return report;
  }

  return createReport({
    kind: report.kind,
    fields: report.displayFields,
    signals: [
      ...report.signals,
      signal(
        "assumed-iso-8859-1",
        "context",
        "ISO-8859-1 assumed (no ECI marker)",
        "The symbol did not declare an ECI encoding, and its bytes were not valid UTF-8, so QRWarden interpreted them as ISO-8859-1.",
      ),
    ],
    limitations: report.limitations,
    actionPolicy: report.actionPolicy,
    ...(report.canonicalHref === undefined
      ? {}
      : { canonicalHref: report.canonicalHref }),
  });
}

/**
 * Pure decoder-to-report boundary. Decoder DecodeResult is structurally
 * compatible with AnalyzerInput, so the analyzer retains no worker object.
 */
export function analyzeDecodeResult(input: AnalyzerInput): AnalysisReport {
  const { decoding } = input;
  if (decoding.kind !== "text") return binaryReport(input.rawBytes);

  const report = reportForDecodedText(
    input.contentType,
    decoding.text,
    input.rawBytes,
  );
  return appendAssumedIso88591Signal(report, decoding);
}

function frozenBytesForText(text: string): AnalyzerFrozenBytes {
  const bytes = new TextEncoder().encode(text);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return Object.freeze({ byteLength: bytes.byteLength, hex });
}

/** Convenience entry point for pure analyzer tests and non-worker callers. */
export function analyzeText(text: string, contentType = "Text"): AnalysisReport {
  return analyzeDecodeResult({
    rawBytes: frozenBytesForText(text),
    contentType,
    decoding: {
      kind: "text",
      text,
      encoding: "utf-8",
      eci: null,
    },
  });
}
