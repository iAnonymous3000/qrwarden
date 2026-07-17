import type { DisplayField, DisplayFieldKind } from "./types";
import { escapeForbiddenForDisplay } from "./characters";

export const ANALYZER_LIMITS = Object.freeze({
  logicalFields: 64,
  nesting: 4,
  fieldScalars: 2_048,
  reportScalars: 8_192,
  expandedBytes: 8_192,
  hexPreviewBytes: 256,
  urlNames: 64,
});

export interface FieldOptions {
  readonly kind?: DisplayFieldKind;
  readonly sensitive?: boolean;
  readonly masked?: boolean;
  readonly collapsed?: boolean;
  readonly count?: number;
  readonly omittedCount?: number;
  readonly reportValue?: string;
  readonly reportRedacted?: boolean;
}

export function scalarLength(value: string): number {
  return Array.from(value).length;
}

export function truncateScalars(
  value: string,
  maximum: number,
): { readonly value: string; readonly truncated: boolean; readonly used: number } {
  const scalars = Array.from(value);
  if (scalars.length <= maximum) {
    return { value, truncated: false, used: scalars.length };
  }

  return {
    value: scalars.slice(0, Math.max(0, maximum)).join(""),
    truncated: true,
    used: Math.max(0, maximum),
  };
}

export class ReportFields {
  readonly #fields: DisplayField[] = [];
  #remaining = ANALYZER_LIMITS.reportScalars;

  add(id: string, label: string, value: string, options: FieldOptions = {}): void {
    if (this.#fields.length >= ANALYZER_LIMITS.logicalFields || this.#remaining <= 0) {
      return;
    }

    const available = Math.min(ANALYZER_LIMITS.fieldScalars, this.#remaining);
    const bounded = truncateScalars(escapeForbiddenForDisplay(value), available);
    // The replacement report value obeys the same escape-and-truncate bound,
    // so the copied report never carries content beyond what review could
    // have shown on screen.
    const boundedReport =
      options.reportValue === undefined
        ? undefined
        : truncateScalars(escapeForbiddenForDisplay(options.reportValue), available);
    this.#remaining -= bounded.used;
    this.#fields.push({
      id,
      label,
      value: bounded.value,
      actionValue: value,
      kind: options.kind ?? "text",
      sensitive: options.sensitive ?? false,
      masked: options.masked ?? false,
      collapsed: options.collapsed ?? false,
      truncated: bounded.truncated || (boundedReport?.truncated ?? false),
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.omittedCount === undefined
        ? {}
        : { omittedCount: options.omittedCount }),
      ...(boundedReport === undefined ? {} : { reportValue: boundedReport.value }),
      ...(options.reportRedacted === undefined
        ? {}
        : { reportRedacted: options.reportRedacted }),
    });
  }

  get value(): readonly DisplayField[] {
    return this.#fields;
  }
}

export function hasValidFrozenBytes(bytes: AnalyzerBytesLike): boolean {
  return (
    Number.isSafeInteger(bytes.byteLength) &&
    bytes.byteLength >= 0 &&
    /^[0-9a-f]*$/.test(bytes.hex) &&
    bytes.hex.length === bytes.byteLength * 2
  );
}

interface AnalyzerBytesLike {
  readonly byteLength: number;
  readonly hex: string;
}
