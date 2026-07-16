/** Minimal globals used by the pinned zxing-wasm public declarations. */
interface EmscriptenModule {
  locateFile?: (path: string, prefix: string) => string;
  readonly HEAPU8?: Uint8Array;
  _malloc?(size: number): number;
  _free?(pointer: number): void;
}
interface EmscriptenModuleFactory<T extends EmscriptenModule> {
  (moduleOverrides?: Partial<T>): Promise<T>;
}

declare module "zxing-wasm/reader/zxing_reader.wasm?url" {
  const url: string;
  export default url;
}
