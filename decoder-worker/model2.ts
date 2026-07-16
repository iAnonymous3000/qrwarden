import type { CapturedReaderResult } from "../src/decoder/publicResultAdapter";

export const MAX_SYMBOL_BYTES = 8_192;

const CANONICAL_MODEL_2_VERSION = /^(?:[1-9]|[1-3][0-9]|40)$/;
const MODEL_2_IDENTIFIERS = new Set(["]Q1", "]Q3", "]Q5"]);

export type UnsupportedCodeReason =
  | "invalid-reader-result"
  | "unexpected-format"
  | "unexpected-symbology-identifier"
  | "missing-or-malformed-version"
  | "structured-append"
  | "payload-too-large";

export type Model2Check =
  | { readonly kind: "supported"; readonly version: number }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedCodeReason };

export function parseCanonicalModel2Version(extra: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extra);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const version = Object.prototype.hasOwnProperty.call(parsed, "Version")
    ? (parsed as { Version?: unknown }).Version
    : undefined;

  if (typeof version !== "string" || !CANONICAL_MODEL_2_VERSION.test(version)) {
    return null;
  }

  return Number(version);
}
export function checkModel2(result: CapturedReaderResult): Model2Check {
  if (!result.isValid) {
    return { kind: "unsupported", reason: "invalid-reader-result" };
  }
  if (result.format !== "QRCode") {
    return { kind: "unsupported", reason: "unexpected-format" };
  }
  if (!MODEL_2_IDENTIFIERS.has(result.symbologyIdentifier)) {
    return { kind: "unsupported", reason: "unexpected-symbology-identifier" };
  }

  const version = parseCanonicalModel2Version(result.extra);
  if (version === null) {
    return { kind: "unsupported", reason: "missing-or-malformed-version" };
  }

  if (
    result.sequenceSize !== -1 ||
    result.sequenceIndex !== -1 ||
    result.sequenceId !== ""
  ) {
    return { kind: "unsupported", reason: "structured-append" };
  }

  if (result.bytes.byteLength > MAX_SYMBOL_BYTES) {
    return { kind: "unsupported", reason: "payload-too-large" };
  }

  return { kind: "supported", version };
}

export function isValidQrFamilyResult(result: CapturedReaderResult): boolean {
  return result.isValid && result.symbology === "QRCode";
}

export type ResultCount =
  | { readonly kind: "none" }
  | { readonly kind: "results"; readonly results: readonly CapturedReaderResult[] }
  | { readonly kind: "overflow" };

/** Counts valid results before any Model 2/support filtering. */
export function enforceResultCount(
  results: readonly CapturedReaderResult[],
): ResultCount {
  const valid = results.filter((result) => result.isValid);
  if (valid.length >= 9) {
    return { kind: "overflow" };
  }
  if (valid.length === 0) {
    return { kind: "none" };
  }
  return { kind: "results", results: valid };
}
