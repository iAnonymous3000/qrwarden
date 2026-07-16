import type { CapturedReaderResult } from "../src/decoder/publicResultAdapter";
import {
  checkModel2,
  MAX_SYMBOL_BYTES,
  parseCanonicalModel2Version,
  type UnsupportedCodeReason,
} from "./model2";

/**
 * Positive verification profiles for every symbology QRWarden decodes. Each
 * profile admits only canonically versioned, non-structured-append symbols
 * whose AIM symbology identifiers were verified against the reader:
 * QR family reports ]Q1/]Q3/]Q5, ECC200 Data Matrix reports ]d1..]d3, and
 * Aztec reports ]z0..]z2. Anything else fails closed as unsupported.
 */

/** Reader-option format names accepted by zxing-wasm. */
export const SUPPORTED_READER_FORMATS = Object.freeze([
  "QRCode",
  "MicroQRCode",
  "rMQRCode",
  "DataMatrix",
  "Aztec",
] as const);

/** Symbology families covering the supported result formats. */
const SUPPORTED_SYMBOLOGIES: ReadonlySet<string> = new Set([
  "QRCode",
  "DataMatrix",
  "Aztec",
]);

export type SymbolCheck =
  | { readonly kind: "supported"; readonly version: number }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedCodeReason };

/** ISO/IEC 23941 rMQR version names in canonical order. */
const RMQR_VERSIONS = Object.freeze([
  "R7x43", "R7x59", "R7x77", "R7x99", "R7x139",
  "R9x43", "R9x59", "R9x77", "R9x99", "R9x139",
  "R11x27", "R11x43", "R11x59", "R11x77", "R11x99", "R11x139",
  "R13x27", "R13x43", "R13x59", "R13x77", "R13x99", "R13x139",
  "R15x43", "R15x59", "R15x77", "R15x99", "R15x139",
  "R17x43", "R17x59", "R17x77", "R17x99", "R17x139",
] as const);

/** ISO/IEC 16022 ECC200 symbol sizes (rows x columns) in canonical order. */
const DATA_MATRIX_VERSIONS = Object.freeze([
  "10x10", "12x12", "14x14", "16x16", "18x18", "20x20", "22x22", "24x24",
  "26x26", "32x32", "36x36", "40x40", "44x44", "48x48", "52x52", "64x64",
  "72x72", "80x80", "88x88", "96x96", "104x104", "120x120", "132x132",
  "144x144", "8x18", "8x32", "12x26", "12x36", "16x36", "16x48",
] as const);

const MICRO_QR_VERSION = /^M([1-4])$/;
const AZTEC_VERSION = /^([1-9]|[12][0-9]|3[0-2])$/;

function extraVersion(extra: string): string | null {
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
  return typeof version === "string" ? version : null;
}

function listedVersion(
  extra: string,
  versions: readonly string[],
): number | null {
  const version = extraVersion(extra);
  if (version === null) return null;
  const index = versions.indexOf(version);
  return index < 0 ? null : index + 1;
}

interface SymbolProfile {
  readonly identifiers: ReadonlySet<string>;
  readonly parseVersion: (extra: string) => number | null;
}

const PROFILES: Readonly<Record<string, SymbolProfile>> = Object.freeze({
  MicroQRCode: {
    identifiers: new Set(["]Q1"]),
    parseVersion: (extra) => {
      const match = MICRO_QR_VERSION.exec(extraVersion(extra) ?? "");
      return match === null ? null : Number(match[1]);
    },
  },
  RMQRCode: {
    identifiers: new Set(["]Q1"]),
    parseVersion: (extra) => listedVersion(extra, RMQR_VERSIONS),
  },
  DataMatrix: {
    identifiers: new Set(["]d1", "]d2", "]d3"]),
    parseVersion: (extra) => listedVersion(extra, DATA_MATRIX_VERSIONS),
  },
  Aztec: {
    identifiers: new Set(["]z0", "]z1", "]z2"]),
    parseVersion: (extra) => {
      const match = AZTEC_VERSION.exec(extraVersion(extra) ?? "");
      return match === null ? null : Number(match[0]);
    },
  },
});

/** Canonical numeric version for any supported format, or null. */
export function parseCanonicalSymbolVersion(
  format: string,
  extra: string,
): number | null {
  if (format === "QRCode") {
    return parseCanonicalModel2Version(extra);
  }
  return PROFILES[format]?.parseVersion(extra) ?? null;
}

export function checkSupportedSymbol(result: CapturedReaderResult): SymbolCheck {
  if (result.format === "QRCode") {
    return checkModel2(result);
  }

  if (!result.isValid) {
    return { kind: "unsupported", reason: "invalid-reader-result" };
  }
  const profile = PROFILES[result.format];
  if (profile === undefined) {
    return { kind: "unsupported", reason: "unexpected-format" };
  }
  if (!profile.identifiers.has(result.symbologyIdentifier)) {
    return { kind: "unsupported", reason: "unexpected-symbology-identifier" };
  }

  const version = profile.parseVersion(result.extra);
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

/** True for any valid result within the supported symbology families. */
export function isValidSupportedSymbol(result: CapturedReaderResult): boolean {
  return result.isValid && SUPPORTED_SYMBOLOGIES.has(result.symbology);
}
