import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertPlainObject(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

export function assertExactKeys(value, keys, label) {
  const actual = Object.keys(assertPlainObject(value, label)).sort();
  const expected = [...keys].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys must be exactly ${expected.join(", ")}`,
  );
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJsonFile(url, label) {
  const bytes = await readFile(url);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

export async function readVerifiedUtf8(directoryUrl, entry, label) {
  invariant(path.basename(entry.file) === entry.file, `${label} file must be a basename`);
  invariant(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, `${label} byteLength is invalid`);
  invariant(/^[0-9a-f]{64}$/.test(entry.sha256), `${label} sha256 is invalid`);
  const fileUrl = new URL(entry.file, directoryUrl);
  const metadata = await lstat(fileUrl);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = await readFile(fileUrl);
  invariant(bytes.byteLength === entry.byteLength, `${label} byte length does not match provenance`);
  invariant(sha256(bytes) === entry.sha256, `${label} SHA-256 does not match provenance`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

export async function writeGeneratedFile(url, content, check = false) {
  invariant(content.endsWith("\n"), "generated content must end with one newline");
  invariant(!content.endsWith("\n\n"), "generated content must not end with blank lines");
  const current = await readFile(url, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (check) {
    invariant(current === content, `${fileURLToPath(url)} is not the deterministic generated output`);
    return;
  }
  if (current !== content) await writeFile(url, content, "utf8");
}

export function isDirectExecution(moduleUrl) {
  const script = process.argv[1];
  return script !== undefined && pathToFileURL(path.resolve(script)).href === moduleUrl;
}

export function directoryUrl(moduleUrl) {
  return new URL("./", pathToFileURL(fileURLToPath(moduleUrl)).href);
}
