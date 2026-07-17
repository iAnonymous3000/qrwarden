import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { prepareZXingModule as prepareReaderModule, readBarcodes } from "zxing-wasm/reader";
import { prepareZXingModule as prepareWriterModule, writeBarcode } from "zxing-wasm/writer";

import { decodeCapturedPayload } from "../../decoder-worker/eci";
import { makeReaderOptions } from "../../decoder-worker/readerOptions";
import { checkSupportedSymbol } from "../../decoder-worker/symbolProfiles";
import { capturePublicResult } from "../../src/decoder/publicResultAdapter";

const FIXTURE_TEXT = "héllo 世界";

function asciiPrefix(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.subarray(0, length));
}

beforeAll(async () => {
  const writerWasm = await readFile(
    resolve(process.cwd(), "node_modules/zxing-wasm/dist/writer/zxing_writer.wasm"),
  );
  prepareWriterModule({ overrides: { wasmBinary: writerWasm } });
  const readerWasm = await readFile(
    resolve(process.cwd(), "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"),
  );
  prepareReaderModule({ overrides: { wasmBinary: readerWasm } });
});

describe("real ECI symbols across supported symbologies", () => {
  it.each([
    ["DataMatrix", "]d1", "]d4"],
    ["Aztec", "]z0", "]z3"],
    ["QRCode", "]Q1", "]Q2"],
  ] as const)(
    "decodes a written %s symbol whose bytesECI shifts %s to %s",
    async (format, identifier, shifted) => {
      const written = await writeBarcode(FIXTURE_TEXT, { format, options: "eci=26" });
      expect(written.error).toBe("");
      expect(written.image).not.toBeNull();

      const results = await readBarcodes(written.image!, makeReaderOptions());
      expect(results).toHaveLength(1);
      const captured = capturePublicResult(results[0]!);

      expect(captured.isValid).toBe(true);
      expect(captured.hasECI).toBe(true);
      expect(captured.symbologyIdentifier).toBe(identifier);
      expect(asciiPrefix(captured.bytesECI, 3)).toBe(shifted);

      expect(checkSupportedSymbol(captured)).toMatchObject({ kind: "supported" });
      expect(decodeCapturedPayload(captured)).toMatchObject({
        kind: "text",
        text: FIXTURE_TEXT,
        encoding: "utf-8",
        eci: { assignment: 26, encoding: "utf-8", source: "bytesECI" },
      });
    },
  );

  it("fails closed on a written Shift JIS symbol carrying the ambiguous yen byte", async () => {
    // The bundled writer encodes the yen sign as 0x5C, which the WHATWG
    // shift_jis decoder renders as a backslash; a JIS X 0201-faithful scanner
    // renders yen, so the payload cannot be decoded faithfully.
    const written = await writeBarcode("https://example.com/¥100", {
      format: "QRCode",
      options: "eci=20",
    });
    expect(written.error).toBe("");
    expect(written.image).not.toBeNull();

    const results = await readBarcodes(written.image!, makeReaderOptions());
    expect(results).toHaveLength(1);
    const captured = capturePublicResult(results[0]!);
    expect(captured.hasECI).toBe(true);
    expect(captured.bytes.at(-4)).toBe(0x5c);

    expect(decodeCapturedPayload(captured)).toMatchObject({
      kind: "binary",
      reason: "ambiguous-eci-text",
    });
  });
});
