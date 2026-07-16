import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { decodeCapturedPayload } from "../../decoder-worker/eci";
import { createStrictLocateFile } from "../../decoder-worker/locateFile";
import {
  checkModel2,
  enforceResultCount,
} from "../../decoder-worker/model2";
import { readerOptions } from "../../decoder-worker/readerOptions";
import {
  freezeBytes,
  freezeDecodeResult,
  thawBytes,
  validateFrozenBytes,
} from "../../src/decoder/frozenBytes";
import {
  capturePublicResult,
  type PublicReaderResult,
} from "../../src/decoder/publicResultAdapter";
import { contentTypePolicy } from "../../src/decoder/types";

const encoder = new TextEncoder();
const position = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

function result(overrides: Partial<PublicReaderResult> = {}) {
  const raw = overrides.bytes ?? encoder.encode("hello");
  return capturePublicResult({
    isValid: true,
    error: "",
    format: "QRCode",
    symbology: "QRCode",
    bytes: raw,
    bytesECI: Uint8Array.from([...encoder.encode("]Q1"), ...raw]),
    contentType: "Text",
    hasECI: false,
    position,
    symbologyIdentifier: "]Q1",
    sequenceSize: -1,
    sequenceIndex: -1,
    sequenceId: "",
    extra: '{"Version":"1"}',
    ...overrides,
  });
}

function withEci(assignment: number, raw: Uint8Array) {
  const escaped = Array.from(raw).flatMap((byte) =>
    byte === 0x5c ? [0x5c, 0x5c] : [byte],
  );
  return result({
    bytes: raw,
    bytesECI: Uint8Array.from([
      ...encoder.encode("]Q2\\" + String(assignment).padStart(6, "0")),
      ...escaped,
    ]),
    hasECI: true,
  });
}

describe("locked reader contract", () => {
  it("snapshots every exact reader option", () => {
    expect(readerOptions).toMatchInlineSnapshot(`
      {
        "binarizer": "LocalAverage",
        "characterSet": "UTF8",
        "downscaleFactor": 3,
        "downscaleThreshold": 500,
        "eanAddOnSymbol": "Ignore",
        "formats": [
          "QRCode",
          "MicroQRCode",
          "rMQRCode",
          "DataMatrix",
          "Aztec",
        ],
        "isPure": false,
        "maxNumberOfSymbols": 9,
        "minLineCount": 2,
        "returnErrors": false,
        "textMode": "Plain",
        "tryCode39ExtendedMode": true,
        "tryDenoise": false,
        "tryDownscale": false,
        "tryHarder": true,
        "tryInvert": true,
        "tryRotate": true,
        "validateOptionalChecksum": false,
      }
    `);
  });

  it("allows only the exact same-origin reader WASM request", () => {
    const locate = createStrictLocateFile(
      "/assets/reader-Ab12_cd3.wasm",
      "https://qr.example",
    );
    expect(locate("zxing_reader.wasm", "https://cdn.invalid/")).toBe(
      "https://qr.example/assets/reader-Ab12_cd3.wasm",
    );
    expect(() => locate("zxing_full.wasm", "/assets/")).toThrow();
    expect(() =>
      createStrictLocateFile("https://cdn.example/reader.wasm", "https://qr.example"),
    ).toThrow();
  });
});

describe("public adapter and Model 2 filter", () => {
  it("statically bans upstream result.text access", () => {
    const adapterSource = readFileSync(
      new URL("../../src/decoder/publicResultAdapter.ts", import.meta.url),
      "utf8",
    );
    expect(adapterSource).not.toMatch(/\bresult\s*(?:\.|\[\s*["'])text\b/);
  });

  it("does not observe poisoned reader text", () => {
    const upstream = result() as unknown as PublicReaderResult & { text: string };
    Object.defineProperty(upstream, "text", {
      get: () => {
        throw new Error("reader text was consumed");
      },
    });
    expect(() => capturePublicResult(upstream)).not.toThrow();
  });

  it("accepts only canonical quoted Model 2 versions 1 through 40", () => {
    for (let version = 1; version <= 40; version += 1) {
      expect(checkModel2(result({ extra: JSON.stringify({ Version: String(version) }) }))).toEqual({
        kind: "supported",
        version,
      });
    }
    for (const Version of [1, "01", " 1", "41", "0", null]) {
      expect(checkModel2(result({ extra: JSON.stringify({ Version }) })).kind).toBe(
        "unsupported",
      );
    }
    expect(checkModel2(result({ symbologyIdentifier: "]Q0" })).kind).toBe("unsupported");
    expect(checkModel2(result({ format: "MicroQRCode" })).kind).toBe("unsupported");
    expect(checkModel2(result({ sequenceSize: 2, sequenceIndex: 0, sequenceId: "7" })).kind).toBe(
      "unsupported",
    );
    expect(checkModel2(result({ bytes: new Uint8Array(8_193) })).kind).toBe("unsupported");
  });

  it("counts nine valid symbols as overflow before support filtering", () => {
    const unsupported = result({ symbologyIdentifier: "]Q0" });
    expect(enforceResultCount(Array.from({ length: 9 }, () => unsupported))).toEqual({
      kind: "overflow",
    });
  });
});

describe("bytesECI-owned decoding", () => {
  it("decodes allowlisted ECI assignments exactly", () => {
    expect(decodeCapturedPayload(withEci(26, encoder.encode("hé")))).toMatchObject({
      kind: "text",
      text: "hé",
      encoding: "utf-8",
      eci: { assignment: 26, source: "bytesECI" },
    });
    expect(decodeCapturedPayload(withEci(20, Uint8Array.from([0x82, 0xa0])))).toMatchObject({
      kind: "text",
      text: "あ",
      encoding: "shift_jis",
    });
    expect(decodeCapturedPayload(withEci(3, Uint8Array.from([0x80, 0x9f])))).toMatchObject({
      kind: "text",
      text: "\u0080\u009f",
      encoding: "iso-8859-1",
    });
  });

  it("fails closed for unknown, mixed, malformed, mismatched, and invalid text", () => {
    expect(decodeCapturedPayload(withEci(27, encoder.encode("x")))).toMatchObject({
      kind: "binary",
      reason: "unsupported-eci",
    });
    const mixed = withEci(26, encoder.encode("x"));
    mixed.bytesECI = Uint8Array.from([
      ...mixed.bytesECI,
      ...encoder.encode("\\000003y"),
    ]);
    expect(decodeCapturedPayload(mixed)).toMatchObject({ kind: "binary", reason: "mixed-eci" });
    expect(
      decodeCapturedPayload(result({ bytesECI: encoder.encode("]Q2\\000026x"), hasECI: true })),
    ).toMatchObject({ kind: "binary", reason: "eci-payload-mismatch" });
    expect(decodeCapturedPayload(result({ bytes: Uint8Array.of(0xff), bytesECI: Uint8Array.of(0x5d, 0x51, 0x31, 0xff) }))).toMatchObject({
      kind: "binary",
      reason: "invalid-utf8",
    });
  });

  it("treats marker-shaped bytes as data without ECI and enforces content policy", () => {
    const literal = encoder.encode("\\123456");
    expect(decodeCapturedPayload(result({ bytes: literal, bytesECI: Uint8Array.from([...encoder.encode("]Q1"), ...literal]) }))).toMatchObject({
      kind: "text",
      text: "\\123456",
    });
    expect(decodeCapturedPayload(result({ contentType: "Binary" }))).toMatchObject({
      kind: "binary",
      reason: "reader-content-type",
    });
    expect(contentTypePolicy("GS1")).toEqual({ renderText: true, urlEligible: false });
    expect(contentTypePolicy("Text")).toEqual({ renderText: true, urlEligible: true });
  });
});

describe("FrozenBytes", () => {
  it("is canonical and independent from the mutable source message", () => {
    const source = Uint8Array.of(0, 15, 255);
    const frozen = freezeBytes(source);
    source.fill(7);
    expect(frozen).toEqual({ byteLength: 3, hex: "000fff" });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(thawBytes(frozen)).toEqual(Uint8Array.of(0, 15, 255));
    expect(() => validateFrozenBytes({ byteLength: 1, hex: "FF" })).toThrow();
  });

  it("deep-freezes the document result", () => {
    const captured = result();
    const decoded = freezeDecodeResult({
      rawBytes: captured.bytes,
      bytesECI: captured.bytesECI,
      hasECI: false,
      contentType: "Text",
      format: "QRCode",
      symbologyIdentifier: "]Q1",
      symbolVersion: 1,
      structuredAppend: null,
      decoding: decodeCapturedPayload(captured),
      source: "image",
      position,
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.position.topLeft)).toBe(true);
    expect(Object.isFrozen(decoded.decoding)).toBe(true);
  });
});
