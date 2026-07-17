import dataStatus from "../../release/data-status.json";
import { hasValidFrozenBytes, ReportFields } from "./limits";
import { createReport } from "./report";
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
    fields.add("byte-count", "Byte count", "Unavailable", { kind: "count" });
    fields.add("hex-preview", "Hexadecimal preview", "Unavailable", { kind: "hex" });
  } else {
    const previewCharacters = 256 * 2;
    const preview = bytes.hex.slice(0, previewCharacters);
    fields.add("byte-count", "Byte count", String(bytes.byteLength), {
      kind: "count",
      count: bytes.byteLength,
    });
    fields.add(
      "hex-preview",
      "Hexadecimal preview",
      bytes.byteLength > 256
        ? `${preview}… (${bytes.byteLength} bytes total)`
        : preview || "Empty",
      { kind: "hex", collapsed: true, reportRedacted: true },
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
  );
  fields.add("content", "Decoded content", text, {
    collapsed: true,
    reportRedacted: true,
  });
  return createReport({ kind, fields: fields.value });
}

function textReport(text: string): AnalysisReport {
  const fields = new ReportFields();
  fields.add("text", "Text", text, { collapsed: true, reportRedacted: true });
  return createReport({ kind: "text", fields: fields.value });
}

function emptyReport(): AnalysisReport {
  const fields = new ReportFields();
  fields.add("content", "QR content", "Empty");
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
      ...(field.reportValue === undefined
        ? {}
        : { reportValue: field.reportValue }),
      ...(field.reportRedacted === undefined
        ? {}
        : { reportRedacted: field.reportRedacted }),
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

/**
 * Pure decoder-to-report boundary. Decoder DecodeResult is structurally
 * compatible with AnalyzerInput, so the analyzer retains no worker object.
 */
export function analyzeDecodeResult(input: AnalyzerInput): AnalysisReport {
  if (input.decoding.kind !== "text") return binaryReport(input.rawBytes);

  if (input.contentType === "GS1") {
    return inertReaderText("gs1", input.decoding.text);
  }
  if (input.contentType === "ISO15434") {
    return inertReaderText("iso-15434", input.decoding.text);
  }
  if (input.contentType !== "Text") return binaryReport(input.rawBytes);

  const text = input.decoding.text;
  const url = analyzeHttpUrl(text);
  if (url !== null) return url;
  const structured = analyzeStructuredText(text);
  if (structured !== null) return ensureExactStructuredSource(structured, text);
  if (text === "") return emptyReport();
  return textReport(text);
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
