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

const ODD_TO_EVEN_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  "]Q1": "]Q2",
  "]Q3": "]Q4",
  "]Q5": "]Q6",
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
  const evenIdentifier = ODD_TO_EVEN_PREFIX[publicIdentifier];
  if (evenIdentifier === undefined) {
    return { kind: "error", reason: "malformed-eci" };
  }

  const expectedPrefix = asciiBytes(evenIdentifier);
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
      return binary("invalid-utf8");
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
