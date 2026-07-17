import type { CapturedReaderResult } from "../src/decoder/publicResultAdapter";
import {
  contentTypePolicy,
  type BinaryReason,
  type EciMetadata,
  type SupportedEci,
  type TextDecoding,
  type TextEncoding,
} from "../src/decoder/types";

const ASCII_BACKSLASH = 0x5c;
const PREFIX_LENGTH = 3;
const ECI_DIGITS = 6;

const ECI_ENCODINGS: Readonly<Record<SupportedEci, TextEncoding>> = Object.freeze({
  3: "iso-8859-1",
  20: "shift_jis",
  26: "utf-8",
});

/**
 * The reader reports the base AIM identifier on the public result (see
 * symbolProfiles.ts) but prefixes bytesECI with its ECI-modified form: QR
 * shifts its odd modifier to the next even value, while Data Matrix and
 * Aztec shift their modifiers by three.
 */
const ECI_SHIFTED_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  "]Q1": "]Q2",
  "]Q3": "]Q4",
  "]Q5": "]Q6",
  "]d1": "]d4",
  "]d2": "]d5",
  "]d3": "]d6",
  "]z0": "]z3",
  "]z1": "]z4",
  "]z2": "]z5",
});

function binary(reason: BinaryReason): TextDecoding {
  return { kind: "binary", reason, eci: null };
}
function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function hasSixDigitMarker(bytes: Uint8Array, offset: number): boolean {
  if (bytes[offset] !== ASCII_BACKSLASH) return false;
  for (let index = 1; index <= ECI_DIGITS; index += 1) {
    if (!isAsciiDigit(bytes[offset + index])) return false;
  }
  return true;
}

function decodeAssignment(bytes: Uint8Array, offset: number): number {
  let assignment = 0;
  for (let index = 1; index <= ECI_DIGITS; index += 1) {
    assignment = assignment * 10 + bytes[offset + index]! - 0x30;
  }
  return assignment;
}

type EciParse =
  | { readonly kind: "ok"; readonly assignment: number; readonly payload: Uint8Array }
  | { readonly kind: "error"; readonly reason: BinaryReason };

export function parseBytesEci(
  publicIdentifier: string,
  rawBytes: Uint8Array,
  bytesECI: Uint8Array,
): EciParse {
  const shiftedIdentifier = ECI_SHIFTED_PREFIX[publicIdentifier];
  if (shiftedIdentifier === undefined) {
    return { kind: "error", reason: "malformed-eci" };
  }

  const expectedPrefix = asciiBytes(shiftedIdentifier);
  if (!startsWith(bytesECI, expectedPrefix)) {
    return { kind: "error", reason: "malformed-eci" };
  }

  if (!hasSixDigitMarker(bytesECI, PREFIX_LENGTH)) {
    return { kind: "error", reason: "malformed-eci" };
  }

  const assignment = decodeAssignment(bytesECI, PREFIX_LENGTH);
  const reconstructed: number[] = [];
  let offset = PREFIX_LENGTH + 1 + ECI_DIGITS;

  while (offset < bytesECI.byteLength) {
    const byte = bytesECI[offset]!;
    if (byte !== ASCII_BACKSLASH) {
      reconstructed.push(byte);
      offset += 1;
      continue;
    }

    if (bytesECI[offset + 1] === ASCII_BACKSLASH) {
      reconstructed.push(ASCII_BACKSLASH);
      offset += 2;
      continue;
    }

    if (hasSixDigitMarker(bytesECI, offset)) {
      return { kind: "error", reason: "mixed-eci" };
    }

    return { kind: "error", reason: "malformed-eci" };
  }

  const payload = Uint8Array.from(reconstructed);
  if (!equalBytes(payload, rawBytes)) {
    return { kind: "error", reason: "eci-payload-mismatch" };
  }

  return { kind: "ok", assignment, payload };
}

function validateNoEciBytes(
  publicIdentifier: string,
  rawBytes: Uint8Array,
  bytesECI: Uint8Array,
): BinaryReason | null {
  const expectedPrefix = asciiBytes(publicIdentifier);
  if (!startsWith(bytesECI, expectedPrefix)) {
    return "malformed-eci";
  }

  if (!equalBytes(bytesECI.subarray(PREFIX_LENGTH), rawBytes)) {
    return "eci-payload-mismatch";
  }

  return null;
}

function decodeIso88591(bytes: Uint8Array): string {
  let decoded = "";
  for (const byte of bytes) {
    decoded += String.fromCharCode(byte);
  }
  return decoded;
}

function decodeFatal(bytes: Uint8Array, encoding: "utf-8" | "shift_jis"): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/**
 * JIS X 0201 renders 0x5C as yen and 0x7E as overline while the WHATWG
 * shift_jis decoder (the only one browsers ship) renders backslash and
 * tilde, so the same bytes carry different URL-meaningful text on other
 * scanners. A Shift JIS payload holding either byte in single-byte position
 * cannot be decoded faithfully and fails closed to binary. Both bytes stay
 * legal as the trail byte of a double-byte character, which the scan skips.
 */
function hasAmbiguousShiftJisSingleByte(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.byteLength) {
    const byte = bytes[index]!;
    if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
      index += 2;
      continue;
    }
    if (byte === ASCII_BACKSLASH || byte === 0x7e) return true;
    index += 1;
  }
  return false;
}

function textResult(
  text: string,
  encoding: TextEncoding,
  eci: EciMetadata | null,
): TextDecoding {
  return { kind: "text", text, encoding, eci };
}

/** Derives all user-visible text from bytes; it never accepts reader text. */
export function decodeCapturedPayload(result: CapturedReaderResult): TextDecoding {
  const { bytes: rawBytes, bytesECI } = result;

  if (rawBytes.byteLength === 0) {
    if (bytesECI.byteLength === 0 && result.hasECI === false) {
      if (!contentTypePolicy(result.contentType).renderText) {
        return binary("reader-content-type");
      }
      return textResult("", "utf-8", null);
    }
    return binary("malformed-eci");
  }

  if (!contentTypePolicy(result.contentType).renderText) {
    return binary("reader-content-type");
  }

  if (!result.hasECI) {
    const invalid = validateNoEciBytes(
      result.symbologyIdentifier,
      rawBytes,
      bytesECI,
    );
    if (invalid !== null) return binary(invalid);

    try {
      return textResult(decodeFatal(rawBytes, "utf-8"), "utf-8", null);
    } catch {
      // ISO/IEC 18004:2015 section 7.4.5: byte mode without an ECI defaults
      // to ECI 000003 (ISO/IEC 8859-1). UTF-8 stays the primary reading
      // because most writers emit it without an ECI; the spec-default
      // fallback maps every byte, so it cannot fail.
      return textResult(decodeIso88591(rawBytes), "iso-8859-1", null);
    }
  }

  const parsed = parseBytesEci(
    result.symbologyIdentifier,
    rawBytes,
    bytesECI,
  );
  if (parsed.kind === "error") return binary(parsed.reason);

  if (parsed.assignment !== 3 && parsed.assignment !== 20 && parsed.assignment !== 26) {
    return binary("unsupported-eci");
  }

  const assignment: SupportedEci = parsed.assignment;
  const encoding = ECI_ENCODINGS[assignment];
  const metadata: EciMetadata = {
    assignment,
    encoding,
    source: "bytesECI",
  };

  if (assignment === 20 && hasAmbiguousShiftJisSingleByte(parsed.payload)) {
    return binary("ambiguous-eci-text");
  }

  try {
    if (assignment === 3) {
      return textResult(decodeIso88591(parsed.payload), encoding, metadata);
    }
    return textResult(
      decodeFatal(parsed.payload, assignment === 20 ? "shift_jis" : "utf-8"),
      encoding,
      metadata,
    );
  } catch {
    return binary("invalid-eci-text");
  }
}
