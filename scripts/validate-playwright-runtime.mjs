import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_ARTIFACTS = Object.freeze([
  ["chromium", "chromium"],
  ["chromium_headless_shell", "chromium-headless-shell"],
  ["firefox", "firefox"],
  ["webkit", "webkit"],
  ["ffmpeg", "ffmpeg"],
]);
const PACKAGE_NAMES = Object.freeze(["@playwright/test", "playwright", "playwright-core"]);
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

function exactKeys(value, expected, label, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} keys must be exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

async function jsonFile(absolute, label, errors) {
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${label} cannot be read as JSON: ${detail}`);
    return null;
  }
}

function validateContract(contract, errors) {
  if (!exactKeys(contract, ["schemaVersion", "packages", "container", "artifacts"], "Playwright runtime contract", errors)) {
    return;
  }
  if (contract.schemaVersion !== 1) errors.push("Playwright runtime schemaVersion must be 1");

  if (exactKeys(contract.packages, PACKAGE_NAMES, "Playwright runtime packages", errors)) {
    const versions = PACKAGE_NAMES.map((name) => contract.packages[name]);
    for (const [index, version] of versions.entries()) {
      if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
        errors.push(`${PACKAGE_NAMES[index]} must have an exact semantic-version pin`);
      }
    }
    if (new Set(versions).size !== 1) {
      errors.push("@playwright/test, playwright, and playwright-core must use one identical version");
    }
  }

  if (exactKeys(contract.container, ["image", "platform", "browsersPath"], "Playwright runtime container", errors)) {
    const version = contract.packages?.["playwright-core"];
    const escapedVersion = typeof version === "string"
      ? version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      : "(?!)";
    const image = new RegExp(
      `^mcr\\.microsoft\\.com/playwright:v${escapedVersion}-noble@sha256:[0-9a-f]{64}$`,
      "u",
    );
    if (typeof contract.container.image !== "string" || !image.test(contract.container.image)) {
      errors.push("Playwright container image must use the matching noble version and a SHA-256 digest");
    }
    if (contract.container.platform !== "linux/amd64") {
      errors.push("Playwright container platform must be linux/amd64");
    }
    if (contract.container.browsersPath !== "/ms-playwright") {
      errors.push("Playwright container browsersPath must be /ms-playwright");
    }
  }

  if (!Array.isArray(contract.artifacts)) {
    errors.push("Playwright runtime artifacts must be an array");
    return;
  }
  if (contract.artifacts.length !== EXPECTED_ARTIFACTS.length) {
    errors.push(`Playwright runtime must pin exactly ${EXPECTED_ARTIFACTS.length} artifacts`);
  }
  const seenNames = new Set();
  const seenRegistryNames = new Set();
  for (const [index, expected] of EXPECTED_ARTIFACTS.entries()) {
    const artifact = contract.artifacts[index];
    if (!exactKeys(artifact, ["name", "registryName", "revision"], `Playwright artifact ${index + 1}`, errors)) {
      continue;
    }
    if (artifact.name !== expected[0] || artifact.registryName !== expected[1]) {
      errors.push(`Playwright artifact ${index + 1} must be ${expected[0]} (${expected[1]})`);
    }
    if (typeof artifact.revision !== "string" || !/^[1-9][0-9]*$/u.test(artifact.revision)) {
      errors.push(`Playwright artifact ${artifact.name ?? index + 1} must have a decimal revision`);
    }
    if (seenNames.has(artifact.name)) errors.push(`duplicate Playwright artifact name: ${artifact.name}`);
    if (seenRegistryNames.has(artifact.registryName)) {
      errors.push(`duplicate Playwright registry name: ${artifact.registryName}`);
    }
    seenNames.add(artifact.name);
    seenRegistryNames.add(artifact.registryName);
  }
}

function validateLockEntry(lock, name, version, errors) {
  const key = `node_modules/${name}`;
  const entry = lock?.packages?.[key];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`package-lock.json is missing ${key}`);
    return null;
  }
  if (entry.version !== version) errors.push(`${key} must resolve to ${version}`);
  const archiveName = name.split("/").at(-1);
  const expectedResolved = `https://registry.npmjs.org/${name}/-/${archiveName}-${version}.tgz`;
  if (entry.resolved !== expectedResolved) {
    errors.push(`${key} must resolve to ${expectedResolved}`);
  }
  if (!canonicalSha512Integrity(entry.integrity)) {
    errors.push(`${key} must have SHA-512 lockfile integrity`);
  }
  return entry;
}

function canonicalSha512Integrity(value) {
  if (typeof value !== "string" || !SHA512_INTEGRITY.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.byteLength === 64 && decoded.toString("base64") === encoded;
  } catch {
    return false;
  }
}

function validateInstalledPackage(metadata, name, version, errors) {
  if (metadata?.name !== name) errors.push(`installed ${name} package must identify itself as ${name}`);
  if (metadata?.version !== version) errors.push(`installed ${name} must be ${version}`);
}

async function validateInstalledRoot(installedRoot, contract, errors) {
  const absolute = path.resolve(installedRoot);
  let rootStat;
  try {
    rootStat = await lstat(absolute);
  } catch {
    errors.push(`Playwright installed root is missing: ${absolute}`);
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    errors.push(`Playwright installed root must be a real directory: ${absolute}`);
    return;
  }

  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`Playwright installed root cannot be listed: ${detail}`);
    return;
  }
  const expectedDirectories = new Set(
    contract.artifacts.map(({ name, revision }) => `${name}-${revision}`),
  );
  for (const entry of entries) {
    if (entry.name === ".links") continue;
    if ((entry.isDirectory() || entry.isSymbolicLink()) && !expectedDirectories.has(entry.name)) {
      errors.push(`unexpected Playwright artifact directory: ${entry.name}`);
    }
  }

  for (const directory of expectedDirectories) {
    const artifactPath = path.join(absolute, directory);
    let artifactStat;
    try {
      artifactStat = await lstat(artifactPath);
    } catch {
      errors.push(`Playwright artifact directory is missing: ${directory}`);
      continue;
    }
    if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
      errors.push(`Playwright artifact path must be a real directory: ${directory}`);
      continue;
    }
    const markerPath = path.join(artifactPath, "INSTALLATION_COMPLETE");
    try {
      const marker = await lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink()) {
        errors.push(`Playwright installation marker must be a regular file: ${directory}/INSTALLATION_COMPLETE`);
      }
    } catch {
      errors.push(`Playwright installation marker is missing: ${directory}/INSTALLATION_COMPLETE`);
    }
  }
}

export async function validatePlaywrightRuntime({ root, installedRoot } = {}) {
  const repositoryRoot = path.resolve(root ?? path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const errors = [];
  const contract = await jsonFile(
    path.join(repositoryRoot, "release/playwright-runtime.json"),
    "release/playwright-runtime.json",
    errors,
  );
  if (contract === null) return errors;
  validateContract(contract, errors);
  if (errors.length > 0) return errors;

  const [packageJson, lock, installedTest, installedPlaywright, installedCore, browsers] = await Promise.all([
    jsonFile(path.join(repositoryRoot, "package.json"), "package.json", errors),
    jsonFile(path.join(repositoryRoot, "package-lock.json"), "package-lock.json", errors),
    jsonFile(
      path.join(repositoryRoot, "node_modules/@playwright/test/package.json"),
      "installed @playwright/test package.json",
      errors,
    ),
    jsonFile(
      path.join(repositoryRoot, "node_modules/playwright/package.json"),
      "installed playwright package.json",
      errors,
    ),
    jsonFile(
      path.join(repositoryRoot, "node_modules/playwright-core/package.json"),
      "installed playwright-core package.json",
      errors,
    ),
    jsonFile(
      path.join(repositoryRoot, "node_modules/playwright-core/browsers.json"),
      "installed playwright-core browsers.json",
      errors,
    ),
  ]);

  const testVersion = contract.packages["@playwright/test"];
  if (packageJson?.devDependencies?.["@playwright/test"] !== testVersion) {
    errors.push(`package.json must pin @playwright/test to ${testVersion}`);
  }
  if (lock?.packages?.[""]?.devDependencies?.["@playwright/test"] !== testVersion) {
    errors.push(`package-lock.json root must pin @playwright/test to ${testVersion}`);
  }

  const testEntry = validateLockEntry(lock, "@playwright/test", testVersion, errors);
  const playwrightVersion = contract.packages.playwright;
  if (testEntry?.dependencies?.playwright !== playwrightVersion) {
    errors.push(`@playwright/test must depend on playwright ${playwrightVersion}`);
  }
  const playwrightEntry = validateLockEntry(lock, "playwright", playwrightVersion, errors);
  const coreVersion = contract.packages["playwright-core"];
  if (playwrightEntry?.dependencies?.["playwright-core"] !== coreVersion) {
    errors.push(`playwright must depend on playwright-core ${coreVersion}`);
  }
  validateLockEntry(lock, "playwright-core", coreVersion, errors);
  validateInstalledPackage(installedTest, "@playwright/test", testVersion, errors);
  validateInstalledPackage(installedPlaywright, "playwright", playwrightVersion, errors);
  validateInstalledPackage(installedCore, "playwright-core", coreVersion, errors);

  if (!Array.isArray(browsers?.browsers)) {
    errors.push("installed playwright-core browsers.json must contain a browsers array");
  } else {
    for (const artifact of contract.artifacts) {
      const matches = browsers.browsers.filter(({ name }) => name === artifact.registryName);
      if (matches.length !== 1) {
        errors.push(`playwright-core registry must contain ${artifact.registryName} exactly once`);
      } else if (matches[0].revision !== artifact.revision) {
        errors.push(
          `playwright-core ${artifact.registryName} revision must be ${artifact.revision}, got ${String(matches[0].revision)}`,
        );
      }
    }
  }

  if (installedRoot !== undefined) await validateInstalledRoot(installedRoot, contract, errors);
  return errors;
}

export function resolveInstalledRoot(argv = process.argv.slice(2), env = process.env) {
  let flag;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--installed-root") {
      if (flag !== undefined) throw new TypeError("--installed-root may be supplied only once");
      flag = argv[index + 1];
      if (flag === undefined || flag.startsWith("--")) {
        throw new TypeError("--installed-root requires a directory path");
      }
      index += 1;
    } else if (argument.startsWith("--installed-root=")) {
      if (flag !== undefined) throw new TypeError("--installed-root may be supplied only once");
      flag = argument.slice("--installed-root=".length);
      if (flag.length === 0) throw new TypeError("--installed-root requires a directory path");
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  const environment = env.PLAYWRIGHT_BROWSERS_PATH;
  if (flag !== undefined && environment !== undefined && path.resolve(flag) !== path.resolve(environment)) {
    throw new TypeError("--installed-root and PLAYWRIGHT_BROWSERS_PATH must identify the same directory");
  }
  return flag ?? environment;
}

async function main() {
  let installedRoot;
  try {
    installedRoot = resolveInstalledRoot();
  } catch (error) {
    process.stderr.write(`Playwright runtime validation: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = await validatePlaywrightRuntime({ installedRoot });
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`Playwright runtime validation: ${error}\n`);
    process.exitCode = 1;
  } else {
    const suffix = installedRoot === undefined ? "metadata" : "metadata and installed artifacts";
    process.stdout.write(`validated pinned Playwright ${suffix}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
