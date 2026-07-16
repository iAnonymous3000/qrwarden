import { describe, expect, it } from "vitest";

import type { CapturedReaderResult } from "../../src/decoder/publicResultAdapter";
import { MAX_SYMBOL_BYTES } from "../../decoder-worker/model2";
import {
  checkSupportedSymbol,
  isValidSupportedSymbol,
  parseCanonicalSymbolVersion,
  SUPPORTED_READER_FORMATS,
} from "../../decoder-worker/symbolProfiles";

function result(overrides: Partial<CapturedReaderResult>): CapturedReaderResult {
  return {
    isValid: true,
    error: "",
    format: "QRCode",
    symbology: "QRCode",
    bytes: new Uint8Array([0x41]),
    bytesECI: new Uint8Array([0x41]),
    contentType: "Text",
    hasECI: false,
    position: {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 1, y: 0 },
      bottomRight: { x: 1, y: 1 },
      bottomLeft: { x: 0, y: 1 },
    },
    symbologyIdentifier: "]Q1",
    sequenceSize: -1,
    sequenceIndex: -1,
    sequenceId: "",
    extra: '{"Version":"2"}',
    originalIndex: 0,
    ...overrides,
  };
}

describe("supported symbol profiles", () => {
  it("lists exactly the reviewed reader formats", () => {
    expect([...SUPPORTED_READER_FORMATS]).toEqual([
      "QRCode",
      "MicroQRCode",
      "rMQRCode",
      "DataMatrix",
      "Aztec",
    ]);
  });

  it("accepts each canonical symbology with its verified identifier and version", () => {
    const cases = [
      { format: "QRCode", symbologyIdentifier: "]Q1", extra: '{"Version":"2"}', version: 2 },
      { format: "MicroQRCode", symbologyIdentifier: "]Q1", extra: '{"Version":"M2"}', version: 2 },
      { format: "RMQRCode", symbologyIdentifier: "]Q1", extra: '{"Version":"R13x43"}', version: 18 },
      { format: "DataMatrix", symbologyIdentifier: "]d1", extra: '{"Version":"12x12"}', version: 2 },
      { format: "DataMatrix", symbologyIdentifier: "]d2", extra: '{"Version":"16x48"}', version: 30 },
      { format: "Aztec", symbologyIdentifier: "]z0", extra: '{"Version":"1"}', version: 1 },
      { format: "Aztec", symbologyIdentifier: "]z1", extra: '{"Version":"32"}', version: 32 },
    ] as const;
    for (const item of cases) {
      const check = checkSupportedSymbol(
        result({
          format: item.format,
          symbologyIdentifier: item.symbologyIdentifier,
          extra: item.extra,
        }),
      );
      expect(check, item.format).toEqual({ kind: "supported", version: item.version });
    }
  });

  it("fails closed on unknown formats, identifiers, and non-canonical versions", () => {
    expect(
      checkSupportedSymbol(result({ format: "PDF417", symbologyIdentifier: "]L2" })).kind,
    ).toBe("unsupported");
    expect(
      checkSupportedSymbol(
        result({ format: "DataMatrix", symbologyIdentifier: "]d0", extra: '{"Version":"12x12"}' }),
      ),
    ).toEqual({ kind: "unsupported", reason: "unexpected-symbology-identifier" });
    expect(
      checkSupportedSymbol(
        result({ format: "DataMatrix", symbologyIdentifier: "]d1", extra: '{"Version":"20x44"}' }),
      ),
    ).toEqual({ kind: "unsupported", reason: "missing-or-malformed-version" });
    expect(
      checkSupportedSymbol(
        result({ format: "MicroQRCode", extra: '{"Version":"M5"}' }),
      ),
    ).toEqual({ kind: "unsupported", reason: "missing-or-malformed-version" });
    expect(
      checkSupportedSymbol(
        result({ format: "Aztec", symbologyIdentifier: "]z0", extra: '{"Version":"33"}' }),
      ),
    ).toEqual({ kind: "unsupported", reason: "missing-or-malformed-version" });
    expect(
      checkSupportedSymbol(
        result({ format: "RMQRCode", extra: '{"Version":"R8x43"}' }),
      ),
    ).toEqual({ kind: "unsupported", reason: "missing-or-malformed-version" });
  });

  it("rejects structured append and oversize payloads for every profile", () => {
    expect(
      checkSupportedSymbol(
        result({ format: "Aztec", symbologyIdentifier: "]z0", extra: '{"Version":"3"}', sequenceSize: 2, sequenceIndex: 0 }),
      ),
    ).toEqual({ kind: "unsupported", reason: "structured-append" });
    expect(
      checkSupportedSymbol(
        result({
          format: "DataMatrix",
          symbologyIdentifier: "]d1",
          extra: '{"Version":"144x144"}',
          bytes: new Uint8Array(MAX_SYMBOL_BYTES + 1),
        }),
      ),
    ).toEqual({ kind: "unsupported", reason: "payload-too-large" });
  });

  it("continues to delegate QR checks to the Model 2 profile", () => {
    expect(
      checkSupportedSymbol(result({ symbologyIdentifier: "]Q2" })),
    ).toEqual({ kind: "unsupported", reason: "unexpected-symbology-identifier" });
    expect(parseCanonicalSymbolVersion("QRCode", '{"Version":"40"}')).toBe(40);
    expect(parseCanonicalSymbolVersion("QRCode", '{"Version":"41"}')).toBeNull();
    expect(parseCanonicalSymbolVersion("Unknown", '{"Version":"2"}')).toBeNull();
  });

  it("gates on the supported symbology families only", () => {
    expect(isValidSupportedSymbol(result({ symbology: "QRCode" }))).toBe(true);
    expect(isValidSupportedSymbol(result({ symbology: "DataMatrix" }))).toBe(true);
    expect(isValidSupportedSymbol(result({ symbology: "Aztec" }))).toBe(true);
    expect(isValidSupportedSymbol(result({ symbology: "PDF417" }))).toBe(false);
    expect(isValidSupportedSymbol(result({ isValid: false }))).toBe(false);
  });
});
