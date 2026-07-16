import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prepareZXingModule,
  writeBarcode,
} from "zxing-wasm/writer";

const wasm = path.resolve("node_modules/zxing-wasm/dist/writer/zxing_writer.wasm");
await prepareZXingModule({
  overrides: { wasmBinary: await readFile(wasm) },
  fireImmediately: true,
});
const output = await writeBarcode("http://127.0.0.1:8080/review?token=hidden#part", {
  format: "QRCode",
  scale: 8,
  addQuietZones: true,
});
if (output.image === null || output.error !== "") {
  throw new Error(output.error || "ZXing writer returned no PNG");
}
await writeFile(
  path.resolve("tests/corpus/url-review.png"),
  Buffer.from(await output.image.arrayBuffer()),
);
