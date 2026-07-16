import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const SBOM_NAMESPACE = "7ff18788-45d2-4d91-80a8-391cac338e88";

export function compareBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
export function assertReleaseVersion(version) {
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version)) {
    throw new Error(`release version must be exact SemVer core: ${version}`);
  }
  return version;
}

export function assertCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("release commit must be 40 lowercase hexadecimal characters");
  }
  return commit;
}

export function assertEpoch(epoch) {
  const parsed = typeof epoch === "number" ? epoch : Number(epoch);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative safe integer");
  }
  return parsed;
}

export function assertSafeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`unsafe release path: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`non-normalized release path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function collectRegularFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareBytes(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    assertSafeRelativePath(relative);
    const absolute = path.join(directory, entry.name);
    const status = await lstat(absolute);
    if (status.isSymbolicLink()) {
      throw new Error(`symbolic links are forbidden in release inputs: ${relative}`);
    }
    if (status.isDirectory()) {
      files.push(...(await collectRegularFiles(absolute, relative)));
    } else if (status.isFile()) {
      files.push({ absolute, relative, mode: status.mode & 0o777 });
    } else {
      throw new Error(`non-regular release input: ${relative}`);
    }
  }
  files.sort((left, right) => compareBytes(left.relative, right.relative));
  return files;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(file) {
  return sha256(await readFile(file));
}

export function renderHashManifest(entries, prefix = "") {
  const seen = new Set();
  const lines = [...entries]
    .map(({ digest, name }) => {
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`invalid SHA-256 for ${name}`);
      }
      assertSafeRelativePath(name);
      const renderedName = prefix === "" ? name : `${prefix}/${name}`;
      assertSafeRelativePath(renderedName);
      if (seen.has(renderedName)) throw new Error(`duplicate manifest path: ${renderedName}`);
      seen.add(renderedName);
      return { digest, name: renderedName };
    })
    .sort((left, right) => compareBytes(left.name, right.name))
    .map(({ digest, name }) => `${digest}  ${name}`);
  if (lines.length === 0) throw new Error("release manifest must not be empty");
  return `${lines.join("\n")}\n`;
}

export function parseHashManifest(text, prefix = "") {
  if (text.charCodeAt(0) === 0xfeff || text.includes("\r") || !text.endsWith("\n")) {
    throw new Error("manifest must be BOM-free LF text with one trailing newline");
  }
  if (text.endsWith("\n\n")) throw new Error("manifest must have exactly one trailing newline");
  const entries = text.slice(0, -1).split("\n").map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (match === null) throw new Error(`invalid manifest line: ${line}`);
    const name = match[2];
    assertSafeRelativePath(name);
    if (prefix !== "" && !name.startsWith(`${prefix}/`)) {
      throw new Error(`manifest path must start with ${prefix}/: ${name}`);
    }
    return { digest: match[1], name };
  });
  const sorted = [...entries].sort((left, right) => compareBytes(left.name, right.name));
  if (entries.some((entry, index) => entry.name !== sorted[index]?.name)) {
    throw new Error("manifest paths are not bytewise sorted");
  }
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
    throw new Error("manifest paths must be unique");
  }
  return entries;
}

export function npmPurl(name, version) {
  if (typeof name !== "string" || typeof version !== "string" || name.length === 0 || version.length === 0) {
    throw new Error("npm package name and version are required");
  }
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1).split("/")[0] ?? "")}/${encodeURIComponent(name.split("/")[1] ?? "")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function uuidBytes(uuid) {
  const compact = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error(`invalid UUID namespace: ${uuid}`);
  return Buffer.from(compact, "hex");
}

export function uuidV5(namespace, name) {
  const digest = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeUtf8Text(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/u, "\n");
  return text;
}

export function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareBytes(left, right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

export function optionsFromArgs(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (options[flag] !== undefined) throw new Error(`duplicate option: ${flag}`);
    options[flag] = next;
    index += 1;
  }
  return options;
}
