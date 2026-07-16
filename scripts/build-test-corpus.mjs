import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "tests/corpus");
const wasm = await readFile(
  resolve(root, "node_modules/zxing-wasm/dist/writer/zxing_writer.wasm"),
);
prepareZXingModule({ overrides: { wasmBinary: wasm } });

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodeGrayscalePng(width, height, pixels) {
  if (pixels.length !== width * height) {
    throw new TypeError("PNG pixel buffer has the wrong size");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    rows[row] = 0;
    Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(rows, row + 1);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND"),
  ]);
}

function renderSymbol(symbol, scale, quiet = 4) {
  const width = (symbol.width + quiet * 2) * scale;
  const height = (symbol.height + quiet * 2) * scale;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < symbol.height; y += 1) {
    for (let x = 0; x < symbol.width; x += 1) {
      const value = symbol.data[y * symbol.width + x] ?? 255;
      for (let dy = 0; dy < scale; dy += 1) {
        const offset = (y + quiet) * scale + dy;
        for (let dx = 0; dx < scale; dx += 1) {
          pixels[offset * width + (x + quiet) * scale + dx] = value;
        }
      }
    }
  }
  return { width, height, pixels };
}

function composeHorizontal(images, gap = 48) {
  const width = images.reduce((sum, image) => sum + image.width, 0) + gap * (images.length - 1);
  const height = Math.max(...images.map((image) => image.height));
  const pixels = new Uint8Array(width * height).fill(255);
  let left = 0;
  for (const image of images) {
    const top = Math.floor((height - image.height) / 2);
    for (let y = 0; y < image.height; y += 1) {
      pixels.set(
        image.pixels.subarray(y * image.width, (y + 1) * image.width),
        (top + y) * width + left,
      );
    }
    left += image.width + gap;
  }
  return { width, height, pixels };
}

async function symbol(input, options = {}) {
  const result = await writeBarcode(input, {
    format: "QRCode",
    options: "ecLevel=H",
    addQuietZones: false,
    ...options,
  });
  return result.symbol;
}

async function emit(name, image) {
  await writeFile(resolve(output, name), encodeGrayscalePng(image.width, image.height, image.pixels));
}

await mkdir(output, { recursive: true });

await emit(
  "canary-url.png",
  renderSymbol(
    await symbol("https://canary.invalid/qrwarden-no-fetch?token=should-stay-local"),
    8,
  ),
);

await emit(
  "multi-selection.png",
  composeHorizontal([
    renderSymbol(await symbol("https://example.com/first"), 7),
    renderSymbol(
      await symbol("WIFI:T:WPA;S:Private Test;P:correct horse battery staple;;"),
      7,
    ),
  ]),
);

await emit(
  "binary-bytes.png",
  renderSymbol(await symbol(new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x42, 0x43])), 10),
);

await emit(
  "inverted-url.png",
  renderSymbol(await symbol("https://example.net/inverted", { invert: true }), 8),
);
