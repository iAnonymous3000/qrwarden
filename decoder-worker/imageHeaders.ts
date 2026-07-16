export const MAX_ENCODED_FILE_BYTES = 25_000_000;
export const MAX_ENCODED_PIXELS = 25_000_000;
export const MAX_ENCODED_AXIS = 8_192;
export const MAX_HEADER_BYTES = 1_048_576;

export type EncodedImageFormat = "jpeg" | "png" | "webp";

export type ImageHeaderErrorCode =
  | "file-too-large"
  | "unsupported-format"
  | "mime-mismatch"
  | "malformed-header"
  | "metadata-too-large"
  | "animated-image"
  | "invalid-dimensions"
  | "malformed-structure";

export class ImageHeaderError extends Error {
  readonly code: ImageHeaderErrorCode;

  constructor(code: ImageHeaderErrorCode) {
    super(code);
    this.name = "ImageHeaderError";
    this.code = code;
  }
}

export interface ImageHeader {
  readonly format: EncodedImageFormat;
  readonly mime: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

function fail(code: ImageHeaderErrorCode): never {
  throw new ImageHeaderError(code);
}

function equalPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1_00_00_00 +
    bytes[offset + 1]! * 0x1_00_00 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x1_00_00 +
    bytes[offset + 3]! * 0x1_00_00_00
  );
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    fail("malformed-header");
  }
  if (
    width > MAX_ENCODED_AXIS ||
    height > MAX_ENCODED_AXIS ||
    width * height > MAX_ENCODED_PIXELS
  ) {
    fail("invalid-dimensions");
  }
}

function assertMime(actual: ImageHeader["mime"], declared: string): void {
  if (declared !== "" && declared !== actual) fail("mime-mismatch");
}

function incomplete(completeFileInBuffer: boolean): never {
  fail(completeFileInBuffer ? "malformed-header" : "metadata-too-large");
}

function parseTiffOrientation(segment: Uint8Array): number | null {
  if (
    segment.byteLength < 14 ||
    !equalPrefix(segment, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  ) {
    return null;
  }

  const tiff = 6;
  const byteOrder = ascii(segment, tiff, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") fail("malformed-header");
  const little = byteOrder === "II";

  const read16 = (offset: number): number => {
    if (offset < tiff || offset + 2 > segment.byteLength) fail("malformed-header");
    return little
      ? segment[offset]! + segment[offset + 1]! * 0x100
      : u16be(segment, offset);
  };
  const read32 = (offset: number): number => {
    if (offset < tiff || offset + 4 > segment.byteLength) fail("malformed-header");
    return little ? u32le(segment, offset) : u32be(segment, offset);
  };

  if (read16(tiff + 2) !== 42) fail("malformed-header");
  const ifdOffset = read32(tiff + 4);
  const ifd = tiff + ifdOffset;
  const count = read16(ifd);
  if (count > 4_096 || ifd + 2 + count * 12 + 4 > segment.byteLength) {
    fail("malformed-header");
  }

  let orientation: number | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (read16(entry) !== 0x0112) continue;
    if (orientation !== null || read16(entry + 2) !== 3 || read32(entry + 4) !== 1) {
      fail("malformed-header");
    }
    orientation = read16(entry + 8);
    if (orientation < 1 || orientation > 8) fail("malformed-header");
  }
  return orientation;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpegHeader(bytes: Uint8Array, complete: boolean): ImageHeader {
  if (bytes.byteLength < 4) incomplete(complete);
  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let orientation: number | null = null;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) fail("malformed-header");
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) incomplete(complete);
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0x00 || marker === 0xd8) fail("malformed-header");
    if (marker === 0xd9 || marker === 0xda) {
      if (width === null || height === null) fail("malformed-header");
      return {
        format: "jpeg",
        mime: "image/jpeg",
        width,
        height,
        orientation: (orientation ?? 1) as ImageHeader["orientation"],
      };
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) incomplete(complete);
    const length = u16be(bytes, offset);
    if (length < 2) fail("malformed-header");
    const dataStart = offset + 2;
    const segmentEnd = offset + length;
    if (segmentEnd > bytes.byteLength) incomplete(complete);

    if (marker === 0xe1) {
      const parsed = parseTiffOrientation(bytes.subarray(dataStart, segmentEnd));
      if (parsed !== null) {
        if (orientation !== null) fail("malformed-header");
        orientation = parsed;
      }
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 8 || bytes[dataStart] === 0) fail("malformed-header");
      const nextHeight = u16be(bytes, dataStart + 1);
      const nextWidth = u16be(bytes, dataStart + 3);
      const components = bytes[dataStart + 5]!;
      if (components === 0 || length < 8 + components * 3) fail("malformed-header");
      assertDimensions(nextWidth, nextHeight);
      if (width !== null || height !== null) fail("malformed-header");
      width = nextWidth;
      height = nextHeight;
    }

    offset = segmentEnd;
  }

  incomplete(complete);
}

function validatePngIhdr(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 13) fail("malformed-header");
  const width = u32be(data, 0);
  const height = u32be(data, 4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const validBitDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
  if (
    !validBitDepth ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    (data[12] !== 0 && data[12] !== 1)
  ) {
    fail("malformed-header");
  }
  assertDimensions(width, height);
  return { width, height };
}

function validChunkType(type: string): boolean {
  return /^[A-Za-z]{4}$/.test(type) && type[2] === type[2]!.toUpperCase();
}

function parsePngHeader(
  bytes: Uint8Array,
  complete: boolean,
  totalSize: number,
): ImageHeader {
  if (bytes.byteLength < 33) incomplete(complete);
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    fail("malformed-header");
  }
  const { width, height } = validatePngIhdr(bytes.subarray(16, 29));

  let offset = 8;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) incomplete(complete);
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    if (!validChunkType(type) || length > totalSize - offset - 12) {
      fail("malformed-header");
    }
    if (type === "acTL") fail("animated-image");
    if (type === "IDAT") {
      return {
        format: "png",
        mime: "image/png",
        width,
        height,
        orientation: 1,
      };
    }
    const next = offset + 12 + length;
    if (next > bytes.byteLength) incomplete(complete);
    offset = next;
  }

  incomplete(complete);
}

function parseVp8Dimensions(data: Uint8Array): { width: number; height: number } {
  if (
    data.byteLength < 10 ||
    data[3] !== 0x9d ||
    data[4] !== 0x01 ||
    data[5] !== 0x2a
  ) {
    fail("malformed-header");
  }
  const width = (data[6]! + data[7]! * 0x100) & 0x3fff;
  const height = (data[8]! + data[9]! * 0x100) & 0x3fff;
  assertDimensions(width, height);
  return { width, height };
}

function parseVp8lDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 5 || data[0] !== 0x2f) fail("malformed-header");
  const width = 1 + data[1]! + ((data[2]! & 0x3f) << 8);
  const height = 1 + (data[2]! >> 6) + (data[3]! << 2) + ((data[4]! & 0x0f) << 10);
  assertDimensions(width, height);
  return { width, height };
}

function parseVp8x(data: Uint8Array): { width: number; height: number; flags: number } {
  if (data.byteLength < 10) fail("malformed-header");
  const flags = data[0]!;
  if ((flags & 0xc1) !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) {
    fail("malformed-header");
  }
  if ((flags & 0x02) !== 0) fail("animated-image");
  const width = 1 + data[4]! + (data[5]! << 8) + (data[6]! << 16);
  const height = 1 + data[7]! + (data[8]! << 8) + (data[9]! << 16);
  assertDimensions(width, height);
  return { width, height, flags };
}

function parseWebpHeader(
  bytes: Uint8Array,
  complete: boolean,
  totalSize: number,
): ImageHeader {
  if (bytes.byteLength < 20) incomplete(complete);
  if (u32le(bytes, 4) + 8 !== totalSize) fail("malformed-header");

  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) incomplete(complete);
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type) || length > totalSize - offset - 8) {
      fail("malformed-header");
    }
    const dataStart = offset + 8;
    if (type === "ANIM" || type === "ANMF") fail("animated-image");

    if (type === "VP8X") {
      if (offset !== 12 || length !== 10) fail("malformed-header");
      if (dataStart + 10 > bytes.byteLength) incomplete(complete);
      canvas = parseVp8x(bytes.subarray(dataStart, dataStart + 10));
    }

    if (type === "VP8 " || type === "VP8L") {
      const needed = type === "VP8 " ? 10 : 5;
      if (length < needed) fail("malformed-header");
      if (dataStart + needed > bytes.byteLength) incomplete(complete);
      const primary =
        type === "VP8 "
          ? parseVp8Dimensions(bytes.subarray(dataStart, dataStart + needed))
          : parseVp8lDimensions(bytes.subarray(dataStart, dataStart + needed));
      if (
        canvas !== null &&
        (canvas.width !== primary.width || canvas.height !== primary.height)
      ) {
        fail("malformed-header");
      }
      return {
        format: "webp",
        mime: "image/webp",
        width: canvas?.width ?? primary.width,
        height: canvas?.height ?? primary.height,
        orientation: 1,
      };
    }

    const paddedLength = length + (length & 1);
    const next = dataStart + paddedLength;
    if (next > bytes.byteLength) incomplete(complete);
    offset = next;
  }

  incomplete(complete);
}

export function parseImageHeaderBytes(
  bytes: Uint8Array,
  totalSize: number,
  declaredMime = "",
): ImageHeader {
  const complete = bytes.byteLength === totalSize;
  let header: ImageHeader;

  if (equalPrefix(bytes, [0xff, 0xd8, 0xff])) {
    header = parseJpegHeader(bytes, complete);
  } else if (equalPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    header = parsePngHeader(bytes, complete, totalSize);
  } else if (
    bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    header = parseWebpHeader(bytes, complete, totalSize);
  } else {
    fail("unsupported-format");
  }

  assertMime(header.mime, declaredMime);
  return Object.freeze(header);
}

export async function inspectImageHeader(file: Blob): Promise<ImageHeader> {
  if (file.size > MAX_ENCODED_FILE_BYTES) fail("file-too-large");
  if (file.size === 0) fail("malformed-header");
  const bytes = new Uint8Array(
    await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer(),
  );
  return parseImageHeaderBytes(bytes, file.size, file.type);
}

async function readAt(file: Blob, offset: number, length: number): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > file.size
  ) {
    fail("malformed-structure");
  }
  const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  if (bytes.byteLength !== length) fail("malformed-structure");
  return bytes;
}

async function validatePngStructure(file: Blob, header: ImageHeader): Promise<void> {
  const signature = await readAt(file, 0, 8);
  if (!equalPrefix(signature, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    fail("malformed-structure");
  }

  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  let idatEnded = false;
  let sawPlte = false;
  let colorType: number | null = null;

  while (offset < file.size) {
    const chunkHeader = await readAt(file, offset, 8);
    const length = u32be(chunkHeader, 0);
    const type = ascii(chunkHeader, 4, 4);
    if (!validChunkType(type) || length > file.size - offset - 12) {
      fail("malformed-structure");
    }
    const chunkEnd = offset + 12 + length;

    if (type === "acTL") fail("animated-image");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      fail("malformed-structure");
    }
    if (chunkIndex > 0 && type === "IHDR") fail("malformed-structure");
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      fail("malformed-structure");
    }

    if (type === "IHDR") {
      const ihdr = await readAt(file, offset + 8, 13);
      const dimensions = validatePngIhdr(ihdr);
      if (dimensions.width !== header.width || dimensions.height !== header.height) {
        fail("malformed-structure");
      }
      colorType = ihdr[9]!;
    } else if (type === "PLTE") {
      if (sawPlte || sawIdat || length === 0 || length > 768 || length % 3 !== 0) {
        fail("malformed-structure");
      }
      sawPlte = true;
    } else if (type === "IDAT") {
      if (idatEnded) fail("malformed-structure");
      sawIdat = true;
    } else if (sawIdat) {
      idatEnded = true;
    }

    if (type === "IEND") {
      if (!sawIdat || length !== 0 || chunkEnd !== file.size) {
        fail("malformed-structure");
      }
      if (colorType === 3 && !sawPlte) fail("malformed-structure");
      if ((colorType === 0 || colorType === 4) && sawPlte) fail("malformed-structure");
      return;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  fail("malformed-structure");
}

async function validateWebpStructure(file: Blob, header: ImageHeader): Promise<void> {
  const riff = await readAt(file, 0, 12);
  if (
    ascii(riff, 0, 4) !== "RIFF" ||
    ascii(riff, 8, 4) !== "WEBP" ||
    u32le(riff, 4) + 8 !== file.size
  ) {
    fail("malformed-structure");
  }

  let offset = 12;
  let index = 0;
  let sawExtended = false;
  let sawPrimary = false;
  let sawAlpha = false;

  while (offset < file.size) {
    const chunkHeader = await readAt(file, offset, 8);
    const type = ascii(chunkHeader, 0, 4);
    const length = u32le(chunkHeader, 4);
    if (!/^[\x20-\x7e]{4}$/.test(type) || length > file.size - offset - 8) {
      fail("malformed-structure");
    }
    const paddedLength = length + (length & 1);
    const chunkEnd = offset + 8 + paddedLength;
    if (chunkEnd > file.size) fail("malformed-structure");
    if (type === "ANIM" || type === "ANMF") fail("animated-image");

    if (type === "VP8X") {
      if (index !== 0 || sawExtended || length !== 10) fail("malformed-structure");
      const extended = parseVp8x(await readAt(file, offset + 8, 10));
      if (extended.width !== header.width || extended.height !== header.height) {
        fail("malformed-structure");
      }
      sawExtended = true;
    } else if (type === "ALPH") {
      if (sawAlpha || sawPrimary) fail("malformed-structure");
      sawAlpha = true;
    } else if (type === "VP8 " || type === "VP8L") {
      if (sawPrimary || (type === "VP8L" && sawAlpha)) fail("malformed-structure");
      const needed = type === "VP8 " ? 10 : 5;
      if (length < needed) fail("malformed-structure");
      const primary =
        type === "VP8 "
          ? parseVp8Dimensions(await readAt(file, offset + 8, needed))
          : parseVp8lDimensions(await readAt(file, offset + 8, needed));
      if (primary.width !== header.width || primary.height !== header.height) {
        fail("malformed-structure");
      }
      sawPrimary = true;
    }

    if ((length & 1) !== 0) {
      const padding = await readAt(file, offset + 8 + length, 1);
      if (padding[0] !== 0) fail("malformed-structure");
    }
    offset = chunkEnd;
    index += 1;
  }

  if (!sawPrimary || offset !== file.size) fail("malformed-structure");
}

/**
 * Walks complete PNG/WebP structures with constant-size reads. JPEG structure
 * beyond SOS is delegated to the browser decoder after its bounded header pass.
 */
export async function validateStaticImageStructure(
  file: Blob,
  header: ImageHeader,
): Promise<void> {
  if (header.format === "png") await validatePngStructure(file, header);
  if (header.format === "webp") await validateWebpStructure(file, header);
}

export function orientationCorrectedDimensions(header: ImageHeader): {
  readonly width: number;
  readonly height: number;
} {
  return header.orientation >= 5 && header.orientation <= 8
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
}
