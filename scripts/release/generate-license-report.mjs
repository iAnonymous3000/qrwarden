import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertCanonicalGenericPurl,
  loadAnalyzerDataComponents,
  normalizeAnalyzerDataComponents,
} from "./analyzer-data-components.mjs";
import {
  assertCommit,
  assertReleaseVersion,
  assertSafeRelativePath,
  compareBytes,
  normalizeUtf8Text,
  npmPurl,
  optionsFromArgs,
  sha256,
} from "./release-contract.mjs";

const require = createRequire(import.meta.url);
const parseSpdx = require("spdx-expression-parse");
const spdxIds = require("spdx-license-ids");
const spdxExceptions = require("spdx-exceptions");
const execFileAsync = promisify(execFile);
const LICENSE_CHECKER_VERSION = "5.0.1";
const ELIGIBLE_TEXT = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:$|[._-])/iu;
const NOTICE_TEXT = /^NOTICE(?:$|[._-])/iu;
const ALLOWED_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unicode-3.0",
  "WTFPL",
]);
const ID_BY_CASE = new Map(spdxIds.map((identifier) => [identifier.toLowerCase(), identifier]));
const EXCEPTION_BY_CASE = new Map(
  spdxExceptions.map((identifier) => [identifier.toLowerCase(), identifier]),
);

function normalizeSpdxNode(node) {
  if (node.license !== undefined) {
    const identifier = ID_BY_CASE.get(String(node.license).toLowerCase());
    if (identifier === undefined || !ALLOWED_IDS.has(identifier)) {
      throw new Error(`unknown or unreviewed SPDX identifier: ${node.license}`);
    }
    let rendered = identifier;
    if (node.plus) throw new Error(`deprecated SPDX plus syntax is forbidden: ${node.license}+`);
    if (node.exception !== undefined) {
      const exception = EXCEPTION_BY_CASE.get(String(node.exception).toLowerCase());
      if (exception === undefined) throw new Error(`unknown SPDX exception: ${node.exception}`);
      rendered += ` WITH ${exception}`;
    }
    return { kind: "leaf", rendered };
  }
  const operator = String(node.conjunction).toUpperCase();
  if (operator !== "AND" && operator !== "OR") throw new Error("invalid SPDX conjunction");
  const collect = (child) => {
    const normalized = normalizeSpdxNode(child);
    return normalized.kind === "group" && normalized.operator === operator
      ? normalized.children
      : [normalized];
  };
  const children = [...collect(node.left), ...collect(node.right)].sort((left, right) =>
    compareBytes(renderSpdxNode(left), renderSpdxNode(right)),
  );
  return { kind: "group", operator, children };
}

function renderSpdxNode(node, parent = null) {
  if (node.kind === "leaf") return node.rendered;
  const value = node.children.map((child) => renderSpdxNode(child, node.operator)).join(` ${node.operator} `);
  return parent !== null && parent !== node.operator ? `(${value})` : value;
}

export function canonicalSpdx(expression) {
  if (typeof expression !== "string" || expression.length === 0) {
    throw new Error("license expression must be one SPDX string");
  }
  let parsed;
  try {
    parsed = parseSpdx(expression);
  } catch (error) {
    throw new Error(`invalid SPDX expression: ${expression}`, { cause: error });
  }
  return renderSpdxNode(normalizeSpdxNode(parsed));
}

function parseInventoryKey(key) {
  const separator = key.lastIndexOf("@");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`invalid license-checker package key: ${key}`);
  }
  return { name: key.slice(0, separator), version: key.slice(separator + 1) };
}

function validateOverrides(raw) {
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.overrides)) {
    throw new Error("license overrides must use schema version 1 with an overrides array");
  }
  const overrides = new Map();
  for (const entry of raw.overrides) {
    const keys = Object.keys(entry).sort(compareBytes);
    const expected = ["licenseExpression", "licenseTextSha256", "noticeSha256", "purl"].sort(compareBytes);
    if (keys.join("\0") !== expected.join("\0")) {
      throw new Error("license override keys must be exactly purl, licenseExpression, licenseTextSha256, noticeSha256");
    }
    if (
      typeof entry.purl !== "string" ||
      !Array.isArray(entry.licenseTextSha256) ||
      !Array.isArray(entry.noticeSha256) ||
      overrides.has(entry.purl)
    ) {
      throw new Error(`invalid or duplicate license override: ${entry.purl}`);
    }
    for (const digest of [...entry.licenseTextSha256, ...entry.noticeSha256]) {
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid override text hash: ${digest}`);
    }
    overrides.set(entry.purl, {
      expression: canonicalSpdx(entry.licenseExpression),
      licenses: [...new Set(entry.licenseTextSha256)].sort(compareBytes),
      notices: [...new Set(entry.noticeSha256)].sort(compareBytes),
    });
  }
  return overrides;
}

function selectHashes(available, selected, label) {
  if (selected === null) return [...available].sort(compareBytes);
  for (const digest of selected) {
    if (!available.has(digest)) throw new Error(`${label} override selects unavailable text ${digest}`);
  }
  return selected;
}

function normalizeDataLicenseComponent(component, index) {
  const label = `data license component ${index + 1}`;
  if (component === null || typeof component !== "object" || Array.isArray(component)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.hasOwn(component, "name")) {
    const normalized = normalizeAnalyzerDataComponents([component])[0];
    return {
      purl: normalized.purl,
      packageName: `${normalized.name}@${normalized.version}`,
      licenseExpression: normalized.licenseExpression,
      licenseFile: normalized.licenseFile,
      licenseTextSha256: normalized.licenseTextSha256,
    };
  }

  const keys = Object.keys(component).sort(compareBytes);
  const expected = [
    "licenseExpression",
    "licenseFile",
    "licenseTextSha256",
    "packageName",
    "purl",
  ].sort(compareBytes);
  if (keys.join("\0") !== expected.join("\0")) {
    throw new Error(`${label} has invalid keys`);
  }
  const purlIdentity = assertCanonicalGenericPurl(component.purl, label);
  if (
    typeof component.packageName !== "string" ||
    component.packageName.length === 0 ||
    typeof component.licenseFile !== "string" ||
    !/^[0-9a-f]{64}$/.test(component.licenseTextSha256)
  ) {
    throw new Error(`${label} is invalid`);
  }
  const packageSeparator = component.packageName.lastIndexOf("@");
  if (
    packageSeparator <= 0 ||
    component.packageName.slice(packageSeparator + 1) !== purlIdentity.version
  ) {
    throw new Error(`${label} package identity differs from its purl`);
  }
  assertSafeRelativePath(component.licenseFile);
  return component;
}

async function optionalLockfilePurls(root) {
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const purls = new Set();
  for (const [location, entry] of Object.entries(lockfile.packages ?? {})) {
    if (
      typeof entry?.version !== "string" ||
      !(entry.optional === true || Array.isArray(entry.os) || Array.isArray(entry.cpu))
    ) {
      continue;
    }
    const marker = "node_modules/";
    const index = location.lastIndexOf(marker);
    if (index < 0) continue;
    const name = location.slice(index + marker.length);
    if (name === "" || name.includes("/node_modules/")) continue;
    purls.add(npmPurl(name, entry.version));
  }
  return purls;
}

export async function generateLicenseReport({
  inventory,
  overrides: rawOverrides,
  dataComponents = [],
  version,
  commit,
  projectRoot,
}) {
  assertReleaseVersion(version);
  assertCommit(commit);
  const root = path.resolve(projectRoot);
  const nodeModules = `${path.join(root, "node_modules")}${path.sep}`;
  const overrides = validateOverrides(rawOverrides);
  const usedOverrides = new Set();
  const optionalPurls = await optionalLockfilePurls(root);
  const texts = new Map();
  const dependencies = [];

  for (const [key, entry] of Object.entries(inventory)) {
    const { name, version: dependencyVersion } = parseInventoryKey(key);
    const packageRoot = path.resolve(entry.path);
    if (packageRoot === root && name === "qrwarden") continue;
    if (!packageRoot.startsWith(nodeModules)) {
      throw new Error(`license inventory path escapes node_modules: ${key}`);
    }
    const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (packageMetadata.name !== name || packageMetadata.version !== dependencyVersion) {
      throw new Error(`license inventory identity differs from package.json: ${key}`);
    }
    const purl = npmPurl(name, dependencyVersion);
    const override = overrides.get(purl) ?? null;
    if (override !== null) usedOverrides.add(purl);
    let declared;
    if (override === null) {
      declared = canonicalSpdx(entry.licenses);
      const packageDeclared = canonicalSpdx(packageMetadata.license);
      if (declared !== packageDeclared) {
        throw new Error(`license-checker and package.json disagree for ${purl}`);
      }
    } else {
      // An exact-purl, reviewed override is the only escape hatch for legacy
      // arrays/objects, unknown identifiers, or checker/package disagreement.
      declared = override.expression;
    }

    const files = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((candidate) => candidate.isFile() && ELIGIBLE_TEXT.test(candidate.name))
      .sort((left, right) => compareBytes(left.name, right.name));
    const licenseHashes = new Set();
    const noticeHashes = new Set();
    for (const file of files) {
      let normalized;
      try {
        normalized = normalizeUtf8Text(
          await readFile(path.join(packageRoot, file.name)),
          `${purl} ${file.name}`,
        );
      } catch (error) {
        if (override === null) throw error;
        continue;
      }
      const digest = sha256(Buffer.from(normalized, "utf8"));
      const kind = NOTICE_TEXT.test(file.name) ? "notice" : "license";
      const previous = texts.get(digest);
      if (previous !== undefined && (previous.text !== normalized || previous.kind !== kind)) {
        throw new Error(`license text hash collision or kind ambiguity: ${digest}`);
      }
      texts.set(digest, { digest, kind, text: normalized });
      (kind === "notice" ? noticeHashes : licenseHashes).add(digest);
    }
    const selectedLicenses = selectHashes(
      licenseHashes,
      override?.licenses ?? null,
      `${purl} license`,
    );
    const selectedNotices = selectHashes(
      noticeHashes,
      override?.notices ?? null,
      `${purl} notice`,
    );
    if (selectedLicenses.length === 0 && override === null) {
      throw new Error(`${purl} has no eligible normalized LICENSE or COPYING text`);
    }
    dependencies.push({
      purl,
      packageName: `${name}@${dependencyVersion}`,
      expression: declared,
      licenses: selectedLicenses,
      notices: selectedNotices,
    });
  }

  if (!Array.isArray(dataComponents)) throw new Error("data license components must be an array");
  for (const [index, rawComponent] of dataComponents.entries()) {
    const component = normalizeDataLicenseComponent(rawComponent, index);
    const licenseFile = path.resolve(root, component.licenseFile);
    if (!licenseFile.startsWith(`${root}${path.sep}`)) {
      throw new Error(`data license component ${component.purl} escapes the project root`);
    }
    const metadata = await lstat(licenseFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`data license component ${component.purl} is not a regular file`);
    }
    const normalized = normalizeUtf8Text(
      await readFile(licenseFile),
      `${component.purl} license`,
    );
    const digest = sha256(Buffer.from(normalized, "utf8"));
    if (digest !== component.licenseTextSha256) {
      throw new Error(`data license component ${component.purl} text hash differs`);
    }
    const previous = texts.get(digest);
    if (previous !== undefined && (previous.text !== normalized || previous.kind !== "license")) {
      throw new Error(`license text hash collision or kind ambiguity: ${digest}`);
    }
    texts.set(digest, { digest, kind: "license", text: normalized });
    dependencies.push({
      purl: component.purl,
      packageName: component.packageName,
      expression: canonicalSpdx(component.licenseExpression),
      licenses: [digest],
      notices: [],
    });
  }

  for (const purl of overrides.keys()) {
    if (!usedOverrides.has(purl) && !optionalPurls.has(purl)) {
      throw new Error(`unused license override: ${purl}`);
    }
  }
  dependencies.sort((left, right) => compareBytes(left.purl, right.purl));
  if (new Set(dependencies.map(({ purl }) => purl)).size !== dependencies.length) {
    throw new Error("license dependencies must have unique canonical purls");
  }
  const selectedTextHashes = new Set(
    dependencies.flatMap(({ licenses, notices }) => [...licenses, ...notices]),
  );
  const selectedTexts = [...selectedTextHashes]
    .map((digest) => texts.get(digest))
    .sort((left, right) => compareBytes(left.digest, right.digest));

  const lines = [
    "QRWARDEN-LICENSE-REPORT-1",
    `release: v${version}`,
    `commit: ${commit}`,
    `dependency-count: ${dependencies.length}`,
    "",
    "DEPENDENCIES",
  ];
  for (const dependency of dependencies) {
    lines.push(
      `purl: ${dependency.purl}`,
      `package: ${dependency.packageName}`,
      `license-expression: ${dependency.expression}`,
      `license-text-sha256: ${dependency.licenses.join(",") || "none"}`,
      `notice-sha256: ${dependency.notices.join(",") || "none"}`,
      "",
    );
  }
  lines.push("LICENSE-TEXTS");
  for (const text of selectedTexts) {
    lines.push(
      `sha256: ${text.digest}`,
      `kind: ${text.kind}`,
      `bytes: ${Buffer.byteLength(text.text, "utf8")}`,
      "----",
      text.text.slice(0, -1),
      "----",
      "",
    );
  }
  return `${lines.join("\n").replace(/\n*$/u, "")}\n`;
}

async function generateInventory(root, outputFile) {
  const checkerRoot = path.join(root, "node_modules/license-checker-rseidelsohn");
  const checkerPackage = JSON.parse(
    await readFile(path.join(checkerRoot, "package.json"), "utf8"),
  );
  if (checkerPackage.version !== LICENSE_CHECKER_VERSION) {
    throw new Error(`installed license-checker-rseidelsohn must be ${LICENSE_CHECKER_VERSION}`);
  }
  const binaryEntry = checkerPackage.bin?.["license-checker-rseidelsohn"];
  if (typeof binaryEntry !== "string" || path.isAbsolute(binaryEntry)) {
    throw new Error("license-checker-rseidelsohn package exposes no safe named binary");
  }
  const binary = path.resolve(checkerRoot, binaryEntry);
  if (!binary.startsWith(`${checkerRoot}${path.sep}`)) {
    throw new Error("license-checker-rseidelsohn binary escapes its package root");
  }
  await execFileAsync(process.execPath, [binary, "--json", "--start", root, "--out", outputFile], {
    cwd: root,
    env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--commit", "--output", "--inventory", "--overrides"]),
  );
  const version = assertReleaseVersion(packageMetadata.version);
  const commit = assertCommit(options["--commit"] ?? "");
  const outputFile = path.resolve(
    root,
    options["--output"] ?? `release-output/qrwarden-${version}-licenses.txt`,
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "qrwarden-licenses-"));
  try {
    const inventoryFile = options["--inventory"]
      ? path.resolve(root, options["--inventory"])
      : path.join(temporary, "inventory.json");
    if (!options["--inventory"]) await generateInventory(root, inventoryFile);
    const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
    const overrides = JSON.parse(
      await readFile(path.resolve(root, options["--overrides"] ?? "release/license-overrides.json"), "utf8"),
    );
    const dataComponents = await loadAnalyzerDataComponents(root);
    const output = await generateLicenseReport({
      inventory,
      overrides,
      dataComponents,
      version,
      commit,
      projectRoot: root,
    });
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, output, { encoding: "utf8", mode: 0o644 });
    process.stdout.write(`${path.relative(root, outputFile)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
