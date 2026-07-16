import { describe, expect, it } from "vitest";

import {
  ImageHeaderError,
  inspectImageHeader,
  parseImageHeaderBytes,
  validateStaticImageStructure,
} from "../../decoder-worker/imageHeaders";

const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const chars = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

function pngChunk(type: string, data: number[]) {
  return [...be32(data.length), ...chars(type), ...data, 0, 0, 0, 0];
}

function png(width = 1, height = 1, extra: number[] = []) {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...pngChunk("IDAT", [0]),
    ...extra,
    ...pngChunk("IEND", []),
  ]);
}

function webp(width = 1, height = 1) {
  const w = width - 1;
  const h = height - 1;
  const data = [0x2f, w & 0xff, ((w >>> 8) & 0x3f) | ((h & 3) << 6), (h >>> 2) & 0xff, (h >>> 10) & 0x0f];
  const chunk = [...chars("VP8L"), ...le32(data.length), ...data, 0];
  return Uint8Array.from([...chars("RIFF"), ...le32(4 + chunk.length), ...chars("WEBP"), ...chunk]);
}

function jpeg(orientation = 6) {
  const exif = [
    ...chars("Exif"), 0, 0, ...chars("II"), 42, 0, 8, 0, 0, 0,
    1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
  ];
  const segment = (marker: number, data: number[]) => [0xff, marker, (data.length + 2) >>> 8, (data.length + 2) & 0xff, ...data];
  const sof = [8, 0, 2, 0, 3, 1, 1, 0x11, 0];
  return Uint8Array.from([0xff, 0xd8, ...segment(0xe1, exif), ...segment(0xc0, sof), 0xff, 0xda]);
}

describe("bounded image headers", () => {
  it("accepts static PNG, WebP, and oriented JPEG signatures", () => {
    expect(parseImageHeaderBytes(png(), png().length, "image/png")).toMatchObject({ format: "png", width: 1, height: 1 });
    expect(parseImageHeaderBytes(webp(), webp().length, "")).toMatchObject({ format: "webp", width: 1, height: 1 });
    expect(parseImageHeaderBytes(jpeg(), jpeg().length, "image/jpeg")).toMatchObject({ format: "jpeg", width: 3, height: 2, orientation: 6 });
  });

  it("rejects MIME mismatch, unknown input, bombs, and animation", async () => {
    expect(() => parseImageHeaderBytes(png(), png().length, "image/jpeg")).toThrow(ImageHeaderError);
    expect(() => parseImageHeaderBytes(new TextEncoder().encode("<svg/>"), 6, "image/svg+xml")).toThrow(ImageHeaderError);
    const bomb = png(5_000, 5_001);
    expect(() => parseImageHeaderBytes(bomb, bomb.length)).toThrowError("invalid-dimensions");
    const animated = png(1, 1, pngChunk("acTL", [0, 0, 0, 1, 0, 0, 0, 0]));
    await expect(
      validateStaticImageStructure(
        new Blob([animated]),
        parseImageHeaderBytes(animated, animated.length),
      ),
    ).rejects.toThrowError("animated-image");
  });

  it("walks complete PNG/WebP structures and enforces the file cap", async () => {
    const pngBytes = png();
    const pngBlob = new Blob([pngBytes], { type: "image/png" });
    const pngHeader = await inspectImageHeader(pngBlob);
    await expect(validateStaticImageStructure(pngBlob, pngHeader)).resolves.toBeUndefined();
    const webpBytes = webp();
    const webpBlob = new Blob([webpBytes], { type: "image/webp" });
    const webpHeader = await inspectImageHeader(webpBlob);
    await expect(validateStaticImageStructure(webpBlob, webpHeader)).resolves.toBeUndefined();
    await expect(inspectImageHeader(new Blob([new Uint8Array(25_000_001)]))).rejects.toThrowError("file-too-large");
  });
});
