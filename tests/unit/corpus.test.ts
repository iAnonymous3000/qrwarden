import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

import { makeReaderOptions } from "../../decoder-worker/readerOptions";

const corpus = resolve(process.cwd(), "tests/corpus");

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function decode(name: string): Promise<readonly string[]> {
  const bytes = await readFile(resolve(corpus, name));
  const results = await readBarcodes(
    new Blob([bytes], { type: "image/png" }),
    makeReaderOptions(),
  );
  return results.filter((result) => result.isValid).map((result) => hex(result.bytes)).sort();
}

beforeAll(async () => {
  const wasm = await readFile(
    resolve(process.cwd(), "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"),
  );
  prepareZXingModule({ overrides: { wasmBinary: wasm } });
});

describe("normative QR image corpus", () => {
  it("decodes a network canary without relying on reader text", async () => {
    await expect(decode("canary-url.png")).resolves.toEqual([
      Buffer.from(
        "https://canary.invalid/qrwarden-no-fetch?token=should-stay-local",
      ).toString("hex"),
    ]);
  });

  it("returns both symbols from the selection fixture", async () => {
    await expect(decode("multi-selection.png")).resolves.toEqual(
      [
        Buffer.from("https://example.com/first").toString("hex"),
        Buffer.from(
          "WIFI:T:WPA;S:Private Test;P:correct horse battery staple;;",
        ).toString("hex"),
      ].sort(),
    );
  });

  it("preserves hostile binary bytes", async () => {
    await expect(decode("binary-bytes.png")).resolves.toEqual(["00ff80414243"]);
  });

  it("exercises the exact inversion option", async () => {
    await expect(decode("inverted-url.png")).resolves.toEqual([
      Buffer.from("https://example.net/inverted").toString("hex"),
    ]);
  });
});
