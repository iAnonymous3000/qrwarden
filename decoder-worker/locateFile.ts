export const EXPECTED_READER_WASM_REQUEST = "zxing_reader.wasm";

function validatedSameOriginUrl(expectedUrl: string, origin: string): URL {
  const parsedOrigin = new URL(origin);
  const parsed = new URL(expectedUrl, parsedOrigin);

  if (
    parsed.origin !== parsedOrigin.origin ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Reader WASM URL must be an exact same-origin HTTP(S) URL");
  }

  return parsed;
}
/**
 * Builds the sole Emscripten locateFile hook. The prefix is intentionally
 * ignored: no fallback or dynamically discovered URL is permitted.
 */
export function createStrictLocateFile(
  expectedWasmUrl: string,
  origin: string,
): (path: string, prefix: string) => string {
  const expected = validatedSameOriginUrl(expectedWasmUrl, origin).href;

  return (path: string, _prefix: string): string => {
    if (path !== EXPECTED_READER_WASM_REQUEST) {
      throw new TypeError(`Unexpected decoder artifact request: ${path}`);
    }
    return expected;
  };
}
