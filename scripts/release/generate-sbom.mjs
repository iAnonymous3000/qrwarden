import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Spec, Validation } from "@cyclonedx/cyclonedx-library";

import {
  loadAnalyzerDataComponents,
  normalizeAnalyzerDataComponents,
} from "./analyzer-data-components.mjs";
import {
  SBOM_NAMESPACE,
  assertCommit,
  assertEpoch,
  assertReleaseVersion,
  compareBytes,
  npmPurl,
  optionsFromArgs,
  stableJson,
  uuidV5,
} from "./release-contract.mjs";

const execFileAsync = promisify(execFile);
const GENERATOR_VERSION = "6.0.0";

function canonicalPurl(component) {
  if (typeof component.purl === "string" && component.purl.startsWith("pkg:npm/")) {
    return component.purl;
  }
  const name = component.group ? `${component.group}/${component.name}` : component.name;
  return npmPurl(name, component.version);
}

function purlFromRawRef(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("CycloneDX dependency reference must be a nonempty string");
  }
  const leaf = reference.slice(reference.lastIndexOf("|") + 1);
  const separator = leaf.lastIndexOf("@");
  if (separator <= 0 || separator === leaf.length - 1) {
    throw new Error(`cannot canonicalize CycloneDX dependency reference: ${reference}`);
  }
  return npmPurl(leaf.slice(0, separator), leaf.slice(separator + 1));
}

function stableArray(values, key) {
  return [...values].sort((left, right) => compareBytes(key(left), key(right)));
}

function normalizeComponent(component) {
  const normalized = structuredClone(component);
  const purl = canonicalPurl(normalized);
  normalized.purl = purl;
  normalized["bom-ref"] = purl;
  if (Array.isArray(normalized.properties)) {
    normalized.properties = stableArray(
      normalized.properties.filter(({ name }) => name !== "cdx:npm:package:path"),
      ({ name, value }) => `${name}\0${value}`,
    );
    if (normalized.properties.length === 0) delete normalized.properties;
  }
  if (Array.isArray(normalized.licenses)) {
    normalized.licenses = stableArray(normalized.licenses, (entry) => JSON.stringify(entry));
  }
  if (Array.isArray(normalized.hashes)) {
    normalized.hashes = stableArray(normalized.hashes, ({ alg, content }) => `${alg}\0${content}`);
  }
  if (Array.isArray(normalized.externalReferences)) {
    normalized.externalReferences = stableArray(
      normalized.externalReferences,
      ({ type, url, comment = "" }) => `${type}\0${url}\0${comment}`,
    );
  }
  return normalized;
}

function analyzerDataCycloneDxComponent(component) {
  const externalReferences = [
    { type: "license", url: component.licenseTermsUrl },
    ...component.sourceUrls.map((url) => ({ type: "distribution", url })),
  ];
  const uniqueExternalReferences = [...new Map(
    externalReferences.map((reference) => [
      `${reference.type}\0${reference.url}`,
      reference,
    ]),
  ).values()].sort((left, right) =>
    compareBytes(`${left.type}\0${left.url}`, `${right.type}\0${right.url}`),
  );
  return {
    type: "data",
    name: component.name,
    version: component.version,
    "bom-ref": component.purl,
    purl: component.purl,
    hashes: [{ alg: "SHA-256", content: component.contentSha256 }],
    licenses: [{ license: { id: component.licenseExpression, url: component.licenseTermsUrl } }],
    externalReferences: uniqueExternalReferences,
    properties: [{ name: "qrwarden:dataset:captured", value: component.captured }],
  };
}

function mergeComponents(left, right) {
  const collectionKeys = ["properties", "licenses", "hashes", "externalReferences"];
  const leftIdentity = structuredClone(left);
  const rightIdentity = structuredClone(right);
  for (const key of collectionKeys) {
    delete leftIdentity[key];
    delete rightIdentity[key];
  }
  // CycloneDX defines an omitted scope as required. The same package/version can
  // be reached through both required and optional lockfile paths, so collapse
  // those occurrences to the most reachable scope instead of retaining an
  // install-path-dependent duplicate component.
  const scopeRank = new Map([
    ["excluded", 0],
    ["optional", 1],
    ["required", 2],
  ]);
  const leftScope = leftIdentity.scope ?? "required";
  const rightScope = rightIdentity.scope ?? "required";
  if (!scopeRank.has(leftScope) || !scopeRank.has(rightScope)) {
    throw new Error(`same-purl CycloneDX component has invalid scope: ${left.purl}`);
  }
  delete leftIdentity.scope;
  delete rightIdentity.scope;
  if (stableJson(leftIdentity) !== stableJson(rightIdentity)) {
    throw new Error(`same-purl CycloneDX components disagree: ${left.purl}`);
  }
  const merged = structuredClone(leftIdentity);
  merged.scope = scopeRank.get(leftScope) >= scopeRank.get(rightScope) ? leftScope : rightScope;
  for (const key of collectionKeys) {
    const values = [...(left[key] ?? []), ...(right[key] ?? [])];
    if (values.length > 0) {
      merged[key] = [...new Map(values.map((value) => [stableJson(value), value])).values()].sort(
        (first, second) => compareBytes(stableJson(first), stableJson(second)),
      );
    }
  }
  return merged;
}

function normalizeDependencies(rawDependencies, allowedPurls) {
  const merged = new Map();
  for (const dependency of rawDependencies ?? []) {
    const reference = purlFromRawRef(dependency.ref);
    if (!allowedPurls.has(reference)) {
      throw new Error(`CycloneDX dependency has no component: ${reference}`);
    }
    const dependsOn = merged.get(reference) ?? new Set();
    for (const rawChild of dependency.dependsOn ?? []) {
      const child = purlFromRawRef(rawChild);
      if (!allowedPurls.has(child)) {
        throw new Error(`CycloneDX dependency edge has no component: ${child}`);
      }
      if (child !== reference) dependsOn.add(child);
    }
    merged.set(reference, dependsOn);
  }
  for (const purl of allowedPurls) {
    if (!merged.has(purl)) merged.set(purl, new Set());
  }
  return [...merged]
    .map(([ref, children]) => ({
      ref,
      dependsOn: [...children].sort(compareBytes),
    }))
    .sort((left, right) => compareBytes(left.ref, right.ref));
}

function assertNoEnvironmentPaths(value, projectRoot) {
  if (typeof value === "string") {
    if (value.includes(projectRoot) || value.includes("cdx:npm:package:path")) {
      throw new Error("normalized SBOM contains local path metadata");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoEnvironmentPaths(entry, projectRoot));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((entry) => assertNoEnvironmentPaths(entry, projectRoot));
  }
}

export function normalizeCycloneDx(
  raw,
  {
    version,
    commit,
    epoch,
    projectRoot = path.resolve("."),
    dataComponents = [],
  },
) {
  assertReleaseVersion(version);
  assertCommit(commit);
  const normalizedEpoch = assertEpoch(epoch);
  if (raw?.bomFormat !== "CycloneDX" || raw.specVersion !== "1.6") {
    throw new Error("raw SBOM must be CycloneDX JSON 1.6");
  }
  if (raw.metadata?.component === undefined || !Array.isArray(raw.components)) {
    throw new Error("raw SBOM is missing its application or component inventory");
  }

  const application = normalizeComponent(raw.metadata.component);
  if (application.name !== "qrwarden" || application.version !== version) {
    throw new Error("SBOM application identity differs from the release version");
  }
  const componentsByPurl = new Map();
  for (const rawComponent of raw.components) {
    const component = normalizeComponent(rawComponent);
    const previous = componentsByPurl.get(component.purl);
    componentsByPurl.set(
      component.purl,
      previous === undefined ? component : mergeComponents(previous, component),
    );
  }
  const normalizedDataComponents = normalizeAnalyzerDataComponents(dataComponents);
  for (const dataComponent of normalizedDataComponents) {
    if (dataComponent.purl === application.purl || componentsByPurl.has(dataComponent.purl)) {
      throw new Error(`analyzer data purl collides with another SBOM component: ${dataComponent.purl}`);
    }
    componentsByPurl.set(dataComponent.purl, analyzerDataCycloneDxComponent(dataComponent));
  }
  const components = [...componentsByPurl.values()];
  const componentPurls = components.map(({ purl }) => purl);
  components.sort((left, right) => compareBytes(left.purl, right.purl));

  const rawTools = raw.metadata.tools?.components ?? [];
  const tools = rawTools
    .filter(({ group, name }) => group === "@cyclonedx" && name !== undefined)
    .map(normalizeComponent)
    .sort((left, right) => compareBytes(left.purl, right.purl));
  if (!tools.some(({ name, version: toolVersion }) => name === "cyclonedx-npm" && toolVersion === GENERATOR_VERSION)) {
    throw new Error(`SBOM must identify pinned cyclonedx-npm ${GENERATOR_VERSION}`);
  }

  const allowedPurls = new Set([application.purl, ...componentPurls]);
  const dependencies = normalizeDependencies(raw.dependencies, allowedPurls);
  const applicationDependency = dependencies.find(({ ref }) => ref === application.purl);
  if (applicationDependency === undefined) {
    throw new Error("normalized SBOM dependency graph is missing the application root");
  }
  applicationDependency.dependsOn = [...new Set([
    ...applicationDependency.dependsOn,
    ...normalizedDataComponents.map(({ purl }) => purl),
  ])].sort(compareBytes);
  const serialName = `qrwarden-sbom:v${version}:${commit}`;
  const normalized = {
    ...structuredClone(raw),
    serialNumber: `urn:uuid:${uuidV5(SBOM_NAMESPACE, serialName)}`,
    metadata: {
      ...structuredClone(raw.metadata),
      timestamp: new Date(normalizedEpoch * 1_000).toISOString(),
      tools: { components: tools },
      component: application,
    },
    components,
    dependencies,
  };
  assertNoEnvironmentPaths(normalized, path.resolve(projectRoot));
  return normalized;
}

export async function validateCycloneDxJson(text) {
  const validator = new Validation.JsonValidator(Spec.Version.v1dot6);
  const error = await validator.validate(text);
  if (error !== null) throw new Error(`normalized CycloneDX validation failed: ${JSON.stringify(error)}`);
}

async function generateRawSbom(root, outputFile, epoch) {
  const generatorPackage = JSON.parse(
    await readFile(path.join(root, "node_modules/@cyclonedx/cyclonedx-npm/package.json"), "utf8"),
  );
  if (generatorPackage.version !== GENERATOR_VERSION) {
    throw new Error(`installed cyclonedx-npm must be ${GENERATOR_VERSION}`);
  }
  const binary = path.join(root, "node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js");
  await execFileAsync(
    process.execPath,
    [
      binary,
      "--package-lock-only",
      "--flatten-components",
      "--output-reproducible",
      "--spec-version",
      "1.6",
      "--output-format",
      "JSON",
      "--validate",
      "--output-file",
      outputFile,
      path.join(root, "package.json"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        BOM_REPRODUCIBLE: "1",
        SOURCE_DATE_EPOCH: String(epoch),
        TZ: "UTC",
        LC_ALL: "C",
        LANG: "C",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--commit", "--epoch", "--output", "--raw-input"]),
  );
  const version = assertReleaseVersion(packageMetadata.version);
  const commit = assertCommit(options["--commit"] ?? "");
  const epoch = assertEpoch(options["--epoch"] ?? process.env.SOURCE_DATE_EPOCH ?? "");
  const outputFile = path.resolve(
    root,
    options["--output"] ?? `release-output/qrwarden-${version}-sbom.cdx.json`,
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "qrwarden-sbom-"));
  try {
    const rawFile = options["--raw-input"]
      ? path.resolve(root, options["--raw-input"])
      : path.join(temporary, "raw.cdx.json");
    if (!options["--raw-input"]) await generateRawSbom(root, rawFile, epoch);
    const raw = JSON.parse(await readFile(rawFile, "utf8"));
    const dataComponents = await loadAnalyzerDataComponents(root);
    const output = stableJson(normalizeCycloneDx(raw, {
      version,
      commit,
      epoch,
      projectRoot: root,
      dataComponents,
    }));
    await validateCycloneDxJson(output);
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
