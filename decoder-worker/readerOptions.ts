import type { ReaderOptions } from "zxing-wasm/reader";

import { SUPPORTED_READER_FORMATS } from "./symbolProfiles";

/** The complete matrix-symbology reader configuration. */
export const readerOptions = Object.freeze({
  formats: SUPPORTED_READER_FORMATS,
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: false,
  tryDenoise: false,
  binarizer: "LocalAverage",
  isPure: false,
  downscaleThreshold: 500,
  downscaleFactor: 3,
  minLineCount: 2,
  maxNumberOfSymbols: 9,
  validateOptionalChecksum: false,
  returnErrors: false,
  eanAddOnSymbol: "Ignore",
  textMode: "Plain",
  characterSet: "UTF8",
  tryCode39ExtendedMode: true,
} as const);

/** zxing-wasm's public type uses a mutable array, so each read gets a copy. */
export function makeReaderOptions(): ReaderOptions {
  return {
    ...readerOptions,
    formats: [...readerOptions.formats] as NonNullable<ReaderOptions["formats"]>,
  };
}
