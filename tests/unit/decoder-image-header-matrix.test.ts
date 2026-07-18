import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImageHeaderError,
  inspectImageHeader,
  orientationCorrectedDimensions,
  parseImageHeaderBytes,
  validateStaticImageStructure,
} from "../../decoder-worker/imageHeaders";
import { RasterError, withRasterizedFile } from "../../decoder-worker/raster";

const chars = (value: string) => Array.from(value, (character) => character.charCodeAt(0));
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
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

function pngChunk(type: string, data: readonly number[], crcDelta = 0): number[] {
  const body = [...chars(type), ...data];
  const crc = crc32(body);
  crc[3] = (crc[3]! + crcDelta) & 0xff;
  return [...be32(data.length), ...body, ...crc];
}

function pngIhdr(
  width: number,
  height: number,
  bitDepth = 8,
  colorType = 6,
  compression = 0,
  filter = 0,
  interlace = 0,
): number[] {
  return pngChunk("IHDR", [
    ...be32(width),
    ...be32(height),
    bitDepth,
    colorType,
    compression,
    filter,
    interlace,
  ]);
}

function pngFromChunks(chunks: readonly number[][]): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunks.flat(),
  ]);
}

function png(width = 1, height = 1): Uint8Array {
  return pngFromChunks([pngIhdr(width, height), pngChunk("IDAT", [0]), pngChunk("IEND", [])]);
}

function webpChunk(type: string, data: readonly number[], padding = 0): number[] {
  return [
    ...chars(type),
    ...le32(data.length),
    ...data,
    ...(data.length % 2 === 1 ? [padding] : []),
  ];
}

function vp8lData(width: number, height: number): number[] {
  const w = width - 1;
  const h = height - 1;
  return [
    0x2f,
    w & 0xff,
    ((w >>> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >>> 2) & 0xff,
    (h >>> 10) & 0x0f,
  ];
}

function vp8xData(width: number, height: number, flags = 0): number[] {
  const w = width - 1;
  const h = height - 1;
  return [
    flags,
    0,
    0,
    0,
    w & 0xff,
    (w >>> 8) & 0xff,
    (w >>> 16) & 0xff,
    h & 0xff,
    (h >>> 8) & 0xff,
    (h >>> 16) & 0xff,
  ];
}

function webpFromChunks(chunks: readonly number[][]): Uint8Array {
  const body = [...chars("WEBP"), ...chunks.flat()];
  return Uint8Array.from([...chars("RIFF"), ...le32(body.length), ...body]);
}

function webp(width = 1, height = 1, padding = 0): Uint8Array {
  return webpFromChunks([webpChunk("VP8L", vp8lData(width, height), padding)]);
}

function jpegSegment(marker: number, data: readonly number[]): number[] {
  return [0xff, marker, ...be16(data.length + 2), ...data];
}

function tiffOrientation(orientation: number, littleEndian: boolean): number[] {
  return littleEndian
    ? [
        ...chars("II"), 42, 0, 8, 0, 0, 0,
        1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
      ]
    : [
        ...chars("MM"), 0, 42, 0, 0, 0, 8,
        0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0,
      ];
}

function exifOrientation(orientation: number, littleEndian: boolean): number[] {
  return [...chars("Exif"), 0, 0, ...tiffOrientation(orientation, littleEndian)];
}

function crc32(bytes: readonly number[]): number[] {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
    }
  }
  return be32((crc ^ 0xff_ff_ff_ff) >>> 0);
}

function pngExifChunk(orientation: number): number[] {
  const payload = tiffOrientation(orientation, true);
  const body = [...chars("eXIf"), ...payload];
  return [...be32(payload.length), ...body, ...crc32(body)];
}

function pngWithExif(orientation: number, width = 3, height = 2): Uint8Array {
  return pngFromChunks([
    pngIhdr(width, height),
    pngExifChunk(orientation),
    pngChunk("IDAT", [0]),
    pngChunk("IEND", []),
  ]);
}

function webpWithExif(orientation: number, prefixed: boolean): Uint8Array {
  const payload = prefixed
    ? exifOrientation(orientation, true)
    : tiffOrientation(orientation, true);
  return webpFromChunks([
    webpChunk("VP8X", vp8xData(3, 2, 0x08)),
    webpChunk("VP8L", vp8lData(3, 2)),
    webpChunk("EXIF", payload),
  ]);
}

/** The VP8L payload padding pushes the EXIF chunk past a 64-byte prefix. */
function webpWithDeferredExif(orientation: number): Uint8Array {
  return webpFromChunks([
    webpChunk("VP8X", vp8xData(3, 2, 0x08)),
    webpChunk("VP8L", [...vp8lData(3, 2), ...Array.from({ length: 4096 }, () => 0)]),
    webpChunk("EXIF", tiffOrientation(orientation, true)),
  ]);
}

function jpeg(
  orientation = 1,
  littleEndian = true,
  width = 3,
  height = 2,
): Uint8Array {
  const sof = [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0];
  return Uint8Array.from([
    0xff,
    0xd8,
    ...jpegSegment(0xe1, exifOrientation(orientation, littleEndian)),
    ...jpegSegment(0xc0, sof),
    0xff,
    0xda,
  ]);
}

function blobFrom(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

function expectHeaderError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ImageHeaderError);
    expect((error as ImageHeaderError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ImageHeaderError(${code})`);
}

describe("encoded image header boundary matrix", () => {
  it.each([
    [8_192, 1, true],
    [8_193, 1, false],
    [4_096, 4_096, true],
    [4_096, 4_097, false],
    [0, 1, false],
  ])("enforces PNG dimensions %d x %d", (width, height, accepted) => {
    const bytes = png(width, height);
    if (accepted) {
      expect(parseImageHeaderBytes(bytes, bytes.length)).toMatchObject({ width, height });
    } else {
      expect(() => parseImageHeaderBytes(bytes, bytes.length)).toThrow(ImageHeaderError);
    }
  });

  it.each([
    [4, 2, 0, 0, 0],
    [8, 5, 0, 0, 0],
    [8, 6, 1, 0, 0],
    [8, 6, 0, 1, 0],
    [8, 6, 0, 0, 2],
  ])(
    "rejects invalid PNG IHDR bitDepth=%d colorType=%d compression=%d filter=%d interlace=%d",
    (bitDepth, colorType, compression, filter, interlace) => {
      const bytes = pngFromChunks([
        pngIhdr(1, 1, bitDepth, colorType, compression, filter, interlace),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
      ]);
      expectHeaderError(() => parseImageHeaderBytes(bytes, bytes.length), "malformed-header");
    },
  );

  it("requires exact MIME when one is declared", () => {
    const fixtures = [
      [png(), "image/png"],
      [webp(), "image/webp"],
      [jpeg(), "image/jpeg"],
    ] as const;
    for (const [bytes, mime] of fixtures) {
      expect(parseImageHeaderBytes(bytes, bytes.length, "").mime).toBe(mime);
      expect(parseImageHeaderBytes(bytes, bytes.length, mime).mime).toBe(mime);
      expectHeaderError(
        () => parseImageHeaderBytes(bytes, bytes.length, "application/octet-stream"),
        "mime-mismatch",
      );
    }
  });

  it("distinguishes an incomplete bounded prefix from a malformed complete JPEG", () => {
    const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 100, 1, 2, 3]);
    expectHeaderError(
      () => parseImageHeaderBytes(truncated, truncated.length + 100),
      "metadata-too-large",
    );
    expectHeaderError(
      () => parseImageHeaderBytes(truncated, truncated.length),
      "malformed-header",
    );
  });

  it.each([true, false])("parses all EXIF orientations in %s-endian TIFF", (littleEndian) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const bytes = jpeg(orientation, littleEndian);
      const header = parseImageHeaderBytes(bytes, bytes.length);
      expect(header.orientation).toBe(orientation);
      expect(orientationCorrectedDimensions(header)).toEqual(
        orientation >= 5 ? { width: 2, height: 3 } : { width: 3, height: 2 },
      );
    }
  });

  it.each([0, 9])("rejects EXIF orientation %d", (orientation) => {
    const bytes = jpeg(orientation);
    expectHeaderError(() => parseImageHeaderBytes(bytes, bytes.length), "malformed-header");
  });

  it("rejects duplicate JPEG orientation and dimension declarations", () => {
    const exif = jpegSegment(0xe1, exifOrientation(1, true));
    const sof = jpegSegment(0xc0, [8, ...be16(2), ...be16(3), 1, 1, 0x11, 0]);
    const duplicateExif = Uint8Array.from([
      0xff, 0xd8, ...exif, ...exif, ...sof, 0xff, 0xda,
    ]);
    const duplicateSof = Uint8Array.from([
      0xff, 0xd8, ...sof, ...sof, 0xff, 0xda,
    ]);
    expectHeaderError(
      () => parseImageHeaderBytes(duplicateExif, duplicateExif.length),
      "malformed-header",
    );
    expectHeaderError(
      () => parseImageHeaderBytes(duplicateSof, duplicateSof.length),
      "malformed-header",
    );
  });

  it("rejects animated and dimension-inconsistent extended WebP", () => {
    const animated = webpFromChunks([
      webpChunk("VP8X", vp8xData(1, 1, 0x02)),
      webpChunk("VP8L", vp8lData(1, 1)),
    ]);
    const mismatch = webpFromChunks([
      webpChunk("VP8X", vp8xData(2, 1)),
      webpChunk("VP8L", vp8lData(1, 1)),
    ]);
    expectHeaderError(() => parseImageHeaderBytes(animated, animated.length), "animated-image");
    expectHeaderError(() => parseImageHeaderBytes(mismatch, mismatch.length), "malformed-header");
  });

  it("rejects oversized-axis and over-pixel WebP dimensions", () => {
    for (const [width, height] of [[8_193, 1], [4_096, 4_097]]) {
      const bytes = webp(width, height);
      expectHeaderError(() => parseImageHeaderBytes(bytes, bytes.length), "invalid-dimensions");
    }
    const maximumEncodedDimensions = webpFromChunks([
      webpChunk("VP8L", [0x2f, 0xff, 0xff, 0xff, 0x0f]),
    ]);
    expectHeaderError(
      () => parseImageHeaderBytes(maximumEncodedDimensions, maximumEncodedDimensions.length),
      "invalid-dimensions",
    );
  });

  it("checks empty and oversized blobs before slicing", async () => {
    const empty = { size: 0, type: "", slice: () => new Blob() } as Blob;
    const oversized = {
      size: 25_000_001,
      type: "image/png",
      slice: () => new Blob(),
    } as Blob;
    await expect(inspectImageHeader(empty)).rejects.toMatchObject({ code: "malformed-header" });
    await expect(inspectImageHeader(oversized)).rejects.toMatchObject({ code: "file-too-large" });
  });
});

describe("declared EXIF orientation for PNG and WebP containers", () => {
  it.each([3, 6, 8])(
    "parses PNG eXIf orientation %d and passes the structure gate",
    async (orientation) => {
      const bytes = pngWithExif(orientation);
      const header = parseImageHeaderBytes(bytes, bytes.length);
      expect(header.orientation).toBe(orientation);
      expect(orientationCorrectedDimensions(header)).toEqual(
        orientation >= 5 ? { width: 2, height: 3 } : { width: 3, height: 2 },
      );
      await expect(
        validateStaticImageStructure(blobFrom(bytes), header),
      ).resolves.toBe(header);
    },
  );

  it("rejects a duplicate PNG eXIf chunk", () => {
    const bytes = pngFromChunks([
      pngIhdr(3, 2),
      pngExifChunk(6),
      pngExifChunk(6),
      pngChunk("IDAT", [0]),
      pngChunk("IEND", []),
    ]);
    expectHeaderError(() => parseImageHeaderBytes(bytes, bytes.length), "malformed-header");
  });

  it.each([
    ["raw TIFF", false],
    ["Exif\\0\\0-prefixed", true],
  ])("parses the flagged WebP EXIF chunk with a %s payload", async (_label, prefixed) => {
    const bytes = webpWithExif(6, prefixed);
    const header = parseImageHeaderBytes(bytes, bytes.length);
    expect(header).toMatchObject({ format: "webp", width: 3, height: 2, orientation: 6 });
    expect(orientationCorrectedDimensions(header)).toEqual({ width: 2, height: 3 });
    await expect(
      validateStaticImageStructure(blobFrom(bytes), header),
    ).resolves.toBe(header);
  });

  it("fails closed when the VP8X EXIF flag has no EXIF chunk", () => {
    const bytes = webpFromChunks([
      webpChunk("VP8X", vp8xData(1, 1, 0x08)),
      webpChunk("VP8L", vp8lData(1, 1)),
    ]);
    expectHeaderError(() => parseImageHeaderBytes(bytes, bytes.length), "malformed-header");
  });

  it("ignores an EXIF chunk that VP8X does not declare", () => {
    const bytes = webpFromChunks([
      webpChunk("VP8X", vp8xData(3, 2)),
      webpChunk("VP8L", vp8lData(3, 2)),
      webpChunk("EXIF", tiffOrientation(6, true)),
    ]);
    expect(parseImageHeaderBytes(bytes, bytes.length).orientation).toBe(1);
  });

  it("keeps identity orientation when the declared EXIF chunk sits past the bounded header read", () => {
    // Spec chunk ordering places EXIF after the image data, so a large photo's
    // EXIF chunk can lie beyond the bounded prefix. The image must still parse.
    const bytes = webpWithDeferredExif(6);
    const header = parseImageHeaderBytes(bytes.slice(0, 64), bytes.length);
    expect(header).toMatchObject({
      format: "webp",
      width: 3,
      height: 2,
      orientation: 1,
      orientationUnresolved: true,
    });
  });

  it("keeps identity orientation when the EXIF payload is cut off by the bounded read", () => {
    const bytes = webpWithExif(6, false);
    const truncated = bytes.slice(0, bytes.length - 4);
    const header = parseImageHeaderBytes(truncated, bytes.length);
    expect(header).toMatchObject({
      format: "webp",
      width: 3,
      height: 2,
      orientation: 1,
      orientationUnresolved: true,
    });
  });

  it("resolves the deferred EXIF orientation during the whole-file structure walk", async () => {
    const bytes = webpWithDeferredExif(6);
    const header = parseImageHeaderBytes(bytes.slice(0, 64), bytes.length);
    const resolved = await validateStaticImageStructure(blobFrom(bytes), header);
    expect(resolved).toMatchObject({ format: "webp", width: 3, height: 2, orientation: 6 });
    expect(resolved.orientationUnresolved).toBeUndefined();
    expect(orientationCorrectedDimensions(resolved)).toEqual({ width: 2, height: 3 });
  });

  it("fails closed when the complete file never delivers the deferred EXIF chunk", async () => {
    const flagged = webpWithDeferredExif(6);
    const header = parseImageHeaderBytes(flagged.slice(0, 64), flagged.length);
    const withoutExif = webpFromChunks([
      webpChunk("VP8X", vp8xData(3, 2, 0x08)),
      webpChunk("VP8L", [...vp8lData(3, 2), ...Array.from({ length: 4096 }, () => 0)]),
    ]);
    await expect(
      validateStaticImageStructure(blobFrom(withoutExif), header),
    ).rejects.toMatchObject({ code: "malformed-structure" });
  });

  it("fails closed on duplicate or oversized deferred EXIF chunks", async () => {
    const duplicated = webpFromChunks([
      webpChunk("VP8X", vp8xData(3, 2, 0x08)),
      webpChunk("VP8L", [...vp8lData(3, 2), ...Array.from({ length: 4096 }, () => 0)]),
      webpChunk("EXIF", tiffOrientation(6, true)),
      webpChunk("EXIF", tiffOrientation(6, true)),
    ]);
    const oversized = webpFromChunks([
      webpChunk("VP8X", vp8xData(3, 2, 0x08)),
      webpChunk("VP8L", [...vp8lData(3, 2), ...Array.from({ length: 4096 }, () => 0)]),
      webpChunk("EXIF", Array.from({ length: 65_537 }, () => 0)),
    ]);
    for (const bytes of [duplicated, oversized]) {
      const header = parseImageHeaderBytes(bytes.slice(0, 64), bytes.length);
      expect(header).toMatchObject({ orientationUnresolved: true });
      await expect(
        validateStaticImageStructure(blobFrom(bytes), header),
      ).rejects.toMatchObject({ code: "malformed-structure" });
    }
  });
});

describe("orientation-tolerant browser dimension check", () => {
  class FakeOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext(): OffscreenCanvasRenderingContext2D {
      return {
        drawImage: () => undefined,
        getImageData: () => ({} as ImageData),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
      } as unknown as OffscreenCanvasRenderingContext2D;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function rasterize(
    bytes: Uint8Array,
    bitmapWidth: number,
    bitmapHeight: number,
  ): Promise<unknown> {
    const header = parseImageHeaderBytes(bytes, bytes.length);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("createImageBitmap", async () => ({
      width: bitmapWidth,
      height: bitmapHeight,
      close: () => undefined,
    }));
    return withRasterizedFile(
      blobFrom(bytes),
      header,
      2_048,
      2_048 * 2_048,
      async () => "consumed",
    );
  }

  it("accepts oriented or encoded dimensions for transposing orientations", async () => {
    await expect(rasterize(pngWithExif(6), 2, 3)).resolves.toBe("consumed");
    await expect(rasterize(pngWithExif(6), 3, 2)).resolves.toBe("consumed");
    await expect(rasterize(webpWithExif(6, false), 3, 2)).resolves.toBe("consumed");
  });

  it("still rejects genuinely wrong dimensions", async () => {
    await expect(rasterize(pngWithExif(6), 3, 3)).rejects.toBeInstanceOf(RasterError);
    await expect(rasterize(pngWithExif(6), 4, 6)).rejects.toBeInstanceOf(RasterError);
  });

  it("keeps the strict check for non-transposing orientations", async () => {
    await expect(rasterize(pngWithExif(3), 3, 2)).resolves.toBe("consumed");
    await expect(rasterize(pngWithExif(3), 2, 3)).rejects.toBeInstanceOf(RasterError);
  });

  it("closes the source bitmap before the raster is consumed", async () => {
    const bytes = pngWithExif(3);
    const header = parseImageHeaderBytes(bytes, bytes.length);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    let closed = 0;
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 3,
      height: 2,
      close: () => {
        closed += 1;
      },
    }));
    await expect(
      withRasterizedFile(blobFrom(bytes), header, 2_048, 2_048 * 2_048, async () => {
        expect(closed).toBe(1);
        return "consumed";
      }),
    ).resolves.toBe("consumed");
    expect(closed).toBe(1);
  });
});

describe("complete static image structure matrix", () => {
  it.each([
    [
      "unknown critical PNG chunk",
      pngFromChunks([
        pngIhdr(1, 1),
        pngChunk("ABCD", []),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
      ]),
    ],
    [
      "non-contiguous PNG IDAT",
      pngFromChunks([
        pngIhdr(1, 1),
        pngChunk("IDAT", [0]),
        pngChunk("tEXt", []),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
      ]),
    ],
    [
      "indexed PNG without PLTE",
      pngFromChunks([
        pngIhdr(1, 1, 8, 3),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
      ]),
    ],
    [
      "grayscale PNG with PLTE",
      pngFromChunks([
        pngIhdr(1, 1, 8, 0),
        pngChunk("PLTE", [0, 0, 0]),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
      ]),
    ],
    [
      "PNG data after IEND",
      pngFromChunks([
        pngIhdr(1, 1),
        pngChunk("IDAT", [0]),
        pngChunk("IEND", []),
        pngChunk("tEXt", []),
      ]),
    ],
  ])("rejects %s", async (_label, bytes) => {
    const header = parseImageHeaderBytes(bytes, bytes.length);
    await expect(validateStaticImageStructure(blobFrom(bytes), header)).rejects.toMatchObject({
      code: "malformed-structure",
    });
  });

  it("rejects nonzero WebP padding after the primary image", async () => {
    const bytes = webp(1, 1, 0xff);
    const header = parseImageHeaderBytes(bytes, bytes.length);
    await expect(validateStaticImageStructure(blobFrom(bytes), header)).rejects.toMatchObject({
      code: "malformed-structure",
    });
  });

  it.each([["IHDR"], ["IDAT"], ["IEND"]])(
    "rejects a corrupted %s chunk CRC",
    async (target) => {
      const delta = (type: string) => (type === target ? 1 : 0);
      const bytes = pngFromChunks([
        pngChunk(
          "IHDR",
          [...be32(1), ...be32(1), 8, 6, 0, 0, 0],
          delta("IHDR"),
        ),
        pngChunk("IDAT", [0], delta("IDAT")),
        pngChunk("IEND", [], delta("IEND")),
      ]);
      const header = parseImageHeaderBytes(bytes, bytes.length);
      await expect(validateStaticImageStructure(blobFrom(bytes), header)).rejects.toMatchObject({
        code: "malformed-structure",
      });
    },
  );

  it("accepts a pristine PNG whose chunk CRCs all verify", async () => {
    const bytes = png();
    const header = parseImageHeaderBytes(bytes, bytes.length);
    await expect(validateStaticImageStructure(blobFrom(bytes), header)).resolves.toBe(header);
  });

  it("aborts the structure walk when the cooperative deadline trips", async () => {
    class WalkDeadlineError extends Error {}
    const pngBytes = png();
    const pngHeader = parseImageHeaderBytes(pngBytes, pngBytes.length);
    let remaining = 2;
    await expect(
      validateStaticImageStructure(blobFrom(pngBytes), pngHeader, () => {
        remaining -= 1;
        if (remaining < 0) throw new WalkDeadlineError();
      }),
    ).rejects.toBeInstanceOf(WalkDeadlineError);

    const webpBytes = webp();
    const webpHeader = parseImageHeaderBytes(webpBytes, webpBytes.length);
    await expect(
      validateStaticImageStructure(blobFrom(webpBytes), webpHeader, () => {
        throw new WalkDeadlineError();
      }),
    ).rejects.toBeInstanceOf(WalkDeadlineError);
  });

  it("rejects duplicate WebP primary chunks and ALPH with VP8L", async () => {
    const duplicate = webpFromChunks([
      webpChunk("VP8L", vp8lData(1, 1)),
      webpChunk("VP8L", vp8lData(1, 1)),
    ]);
    const alphaLossless = webpFromChunks([
      webpChunk("ALPH", []),
      webpChunk("VP8L", vp8lData(1, 1)),
    ]);
    for (const bytes of [duplicate, alphaLossless]) {
      const header = parseImageHeaderBytes(bytes, bytes.length);
      await expect(validateStaticImageStructure(blobFrom(bytes), header)).rejects.toMatchObject({
        code: "malformed-structure",
      });
    }
  });
});
