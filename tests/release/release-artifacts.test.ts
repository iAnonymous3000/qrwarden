import { copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateArchiveManifest, ordinaryArtifactNames } from "../../scripts/release/generate-archive-manifest.mjs";
import { isGnuGzipVersion, isGnuTarVersion, normalizedTarArguments, parseGitTree } from "../../scripts/release/generate-archives.mjs";
import { generateDistFilesManifest } from "../../scripts/release/generate-dist-files-manifest.mjs";
import { canonicalSpdx, generateLicenseReport } from "../../scripts/release/generate-license-report.mjs";
import { normalizeCycloneDx, validateCycloneDxJson } from "../../scripts/release/generate-sbom.mjs";
import { loadAnalyzerDataComponents } from "../../scripts/release/analyzer-data-components.mjs";
import { parseHashManifest, sha256, uuidV5 } from "../../scripts/release/release-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const contractFile = path.join(projectRoot, "release/artifact-contract.json");
const commit = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function analyzerDataFixture(): Promise<string> {
  const root = await temporary();
  for (const dataset of ["iana", "psl", "unicode"]) {
    await cp(
      path.join(projectRoot, "data-src", dataset),
      path.join(root, "data-src", dataset),
      { recursive: true },
    );
  }
  return root;
}

describe("analyzer data release components", () => {
  it("loads exactly the three hash-pinned data components in canonical order", async () => {
    const components = await loadAnalyzerDataComponents(projectRoot);

    expect(
      components.map(
        ({ purl, licenseExpression, contentSha256, licenseTextSha256 }) => ({
          purl,
          licenseExpression,
          contentSha256,
          licenseTextSha256,
        }),
      ),
    ).toEqual([
      {
        purl: "pkg:generic/iana-ip-registries@2026-07-15",
        licenseExpression: "CC0-1.0",
        contentSha256: "30a9207bb7946ec8268982290044fd60e86b4ca7691235267b46662728b256ed",
        licenseTextSha256: "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
      },
      {
        purl: "pkg:generic/public-suffix-list@2026-07-14_09-26-39_UTC",
        licenseExpression: "MPL-2.0",
        contentSha256: "bd9a62671db32654cfdc5a1eaf57f4c410943d81a7edb1e876f91c0b642e23d8",
        licenseTextSha256: "66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172",
      },
      {
        purl: "pkg:generic/unicode-data@17.0.0",
        licenseExpression: "Unicode-3.0",
        contentSha256: "0b98ba743b2ad8b628ca0366802653154ecd7f528125641dadec73f6b0b4aa35",
        licenseTextSha256: "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96",
      },
    ]);
    expect(new Set(components.map(({ purl }) => purl)).size).toBe(3);
    expect(components.every(({ sourceUrls }) => sourceUrls.length > 0)).toBe(true);
  });

  it("fails closed when source bytes, aggregate hashes, licenses, or provenance drift", async () => {
    const root = await analyzerDataFixture();
    const restore = (relative: string) =>
      copyFile(path.join(projectRoot, relative), path.join(root, relative));

    await writeFile(path.join(root, "data-src/psl/LICENSE"), "tampered\n");
    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "PSL license byte length differs from provenance",
    );
    await restore("data-src/psl/LICENSE");

    const ianaProvenanceFile = path.join(root, "data-src/iana/provenance.json");
    const ianaProvenance = JSON.parse(await readFile(ianaProvenanceFile, "utf8"));
    ianaProvenance.unreviewed = true;
    await writeFile(ianaProvenanceFile, `${JSON.stringify(ianaProvenance, null, 2)}\n`);
    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "IANA provenance keys must be exactly",
    );
    await restore("data-src/iana/provenance.json");

    const unicodeProvenanceFile = path.join(root, "data-src/unicode/provenance.json");
    const unicodeProvenance = JSON.parse(await readFile(unicodeProvenanceFile, "utf8"));
    unicodeProvenance.license.sha256 = "0".repeat(64);
    await writeFile(unicodeProvenanceFile, `${JSON.stringify(unicodeProvenance, null, 2)}\n`);
    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "Unicode license entries disagree",
    );
    await restore("data-src/unicode/provenance.json");

    const currentIanaProvenance = JSON.parse(await readFile(ianaProvenanceFile, "utf8"));
    const ianaSourceFile = path.join(root, "data-src/iana", currentIanaProvenance.files[0].file);
    await writeFile(ianaSourceFile, "tampered\n");
    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "IANA source set ipv4-special-csv byte length differs from provenance",
    );
    await restore(`data-src/iana/${currentIanaProvenance.files[0].file}`);

    currentIanaProvenance.sourceSetSha256 = "0".repeat(64);
    await writeFile(ianaProvenanceFile, `${JSON.stringify(currentIanaProvenance, null, 2)}\n`);
    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "IANA source set aggregate SHA-256 differs from provenance",
    );
  });

  it("rejects symbolic-link license inputs", async () => {
    const root = await analyzerDataFixture();
    const license = path.join(root, "data-src/iana/CC0-1.0.txt");
    await rm(license);
    await symlink(path.join(projectRoot, "data-src/iana/CC0-1.0.txt"), license);

    await expect(loadAnalyzerDataComponents(root)).rejects.toThrow(
      "IANA license must be a regular file",
    );
  });
});

describe("dist-files manifest", () => {
  it("hashes every artifact-contract input in bytewise path order", async () => {
    const root = await temporary();
    const dist = path.join(root, "dist");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html>\n");
    await writeFile(path.join(dist, "_headers"), "/\n");
    await writeFile(path.join(dist, "app.webmanifest"), "{}\n");
    await writeFile(path.join(dist, "assets/app-abcdefgh.js"), "export {};\n");

    const manifest = await generateDistFilesManifest({ distDirectory: dist, contractFile });
    const entries = parseHashManifest(manifest, "dist");
    expect(entries.map(({ name }) => name)).toEqual([
      "dist/_headers",
      "dist/app.webmanifest",
      "dist/assets/app-abcdefgh.js",
      "dist/index.html",
    ]);
    expect(entries.find(({ name }) => name === "dist/index.html")?.digest).toBe(
      sha256(Buffer.from("<!doctype html>\n")),
    );
  });

  it("rejects unmatched files and symbolic links", async () => {
    const root = await temporary();
    const dist = path.join(root, "dist");
    await mkdir(dist);
    await writeFile(path.join(dist, "index.html"), "ok\n");
    await writeFile(path.join(dist, "payload.bin"), "forbidden\n");
    await expect(generateDistFilesManifest({ distDirectory: dist, contractFile })).rejects.toThrow(
      "0 artifact-contract input classes",
    );
    await rm(path.join(dist, "payload.bin"));
    await symlink("index.html", path.join(dist, "alias.html"));
    await expect(generateDistFilesManifest({ distDirectory: dist, contractFile })).rejects.toThrow(
      "symbolic links are forbidden",
    );
  });

});

describe("CycloneDX normalization", () => {
  it("adds all analyzer datasets and remains deterministic for shuffled descriptor input", async () => {
    const raw = {
      $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        tools: {
          components: [
            { type: "application", name: "npm", version: "99.0.0" },
            { type: "application", group: "@cyclonedx", name: "cyclonedx-npm", version: "6.0.0" },
          ],
        },
        component: {
          type: "application",
          name: "qrwarden",
          version: "0.1.0",
          "bom-ref": "qrwarden@0.1.0",
          purl: "pkg:npm/qrwarden@0.1.0",
          properties: [
            { name: "cdx:npm:package:path", value: "" },
            { name: "cdx:npm:package:private", value: "true" },
          ],
        },
      },
      components: [
        {
          type: "library",
          name: "alpha",
          version: "1.0.0",
          "bom-ref": "qrwarden@0.1.0|alpha@1.0.0",
          purl: "pkg:npm/alpha@1.0.0",
          properties: [{ name: "cdx:npm:package:path", value: "node_modules/alpha" }],
        },
        {
          type: "library",
          name: "alpha",
          version: "1.0.0",
          scope: "optional",
          "bom-ref": "qrwarden@0.1.0|nested@2.0.0|alpha@1.0.0",
          purl: "pkg:npm/alpha@1.0.0",
          properties: [{ name: "cdx:npm:package:path", value: "node_modules/nested/node_modules/alpha" }],
        },
      ],
      dependencies: [
        { ref: "qrwarden@0.1.0", dependsOn: ["qrwarden@0.1.0|alpha@1.0.0"] },
        { ref: "qrwarden@0.1.0|alpha@1.0.0", dependsOn: [] },
        { ref: "qrwarden@0.1.0|nested@2.0.0|alpha@1.0.0", dependsOn: [] },
      ],
    };
    const dataComponents = await loadAnalyzerDataComponents(projectRoot);
    const first = normalizeCycloneDx(raw, {
      version: "0.1.0",
      commit,
      epoch: 1_700_000_000,
      projectRoot,
      dataComponents,
    });
    const second = normalizeCycloneDx(raw, {
      version: "0.1.0",
      commit,
      epoch: 1_700_000_000,
      projectRoot,
      dataComponents: [...dataComponents].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.serialNumber).toBe("urn:uuid:075a3f23-6efe-55eb-89f0-6b36da0a0afe");
    expect(first.metadata.timestamp).toBe("2023-11-14T22:13:20.000Z");
    expect(first.metadata.tools.components).toHaveLength(1);
    expect(first.components).toHaveLength(4);
    const analyzerComponents = first.components.filter(({ purl }) => purl.startsWith("pkg:generic/"));
    expect(analyzerComponents.map(({ purl }) => purl)).toEqual(
      dataComponents.map(({ purl }) => purl),
    );
    for (const descriptor of dataComponents) {
      const component = analyzerComponents.find(({ purl }) => purl === descriptor.purl);
      expect(component).toMatchObject({
        type: "data",
        name: descriptor.name,
        version: descriptor.version,
        "bom-ref": descriptor.purl,
        purl: descriptor.purl,
        hashes: [{ alg: "SHA-256", content: descriptor.contentSha256 }],
        licenses: [{
          license: {
            id: descriptor.licenseExpression,
            url: descriptor.licenseTermsUrl,
          },
        }],
        properties: [{ name: "qrwarden:dataset:captured", value: descriptor.captured }],
      });
      expect(component?.scope ?? "required").toBe("required");
    }
    const alpha = first.components.find(({ purl }) => purl === "pkg:npm/alpha@1.0.0");
    expect(alpha?.["bom-ref"]).toBe("pkg:npm/alpha@1.0.0");
    expect(alpha?.scope).toBe("required");
    expect(JSON.stringify(first)).not.toContain("cdx:npm:package:path");
    expect(first.dependencies).toEqual([
      ...dataComponents.map(({ purl }) => ({ ref: purl, dependsOn: [] })),
      { ref: "pkg:npm/alpha@1.0.0", dependsOn: [] },
      {
        ref: "pkg:npm/qrwarden@0.1.0",
        dependsOn: [
          ...dataComponents.map(({ purl }) => purl),
          "pkg:npm/alpha@1.0.0",
        ],
      },
    ]);
    await validateCycloneDxJson(JSON.stringify(first));
  });

  it("implements RFC 4122 UUIDv5", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });
});

describe("license report", () => {
  async function packageFixture(
    root: string,
    name: string,
    version: string,
    license: unknown,
    files: Readonly<Record<string, string | Buffer>>,
  ): Promise<string> {
    const packageRoot = path.join(root, "node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name, version, license })}\n`);
    for (const [filename, contents] of Object.entries(files)) {
      await writeFile(path.join(packageRoot, filename), contents);
    }
    return packageRoot;
  }

  it("normalizes SPDX, text bytes, purl order, and full-text deduplication", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", {
      LICENSE: Buffer.from("\ufeffsame license\r\n"),
    });
    const scoped = await packageFixture(root, "@scope/beta", "2.0.0", "MIT OR Apache-2.0", {
      "LICENSE.MIT": "same license\n\n",
      NOTICE: "notice\rbody",
    });
    const output = await generateLicenseReport({
      inventory: {
        "@scope/beta@2.0.0": { licenses: "MIT OR Apache-2.0", path: scoped },
        "alpha@1.0.0": { licenses: "MIT", path: alpha },
      },
      overrides: { schemaVersion: 1, overrides: [] },
      version: "0.1.0",
      commit,
      projectRoot: root,
    });
    expect(output).toContain("dependency-count: 2");
    expect(output.indexOf("pkg:npm/%40scope/beta@2.0.0")).toBeLessThan(
      output.indexOf("pkg:npm/alpha@1.0.0"),
    );
    expect(output).toContain("license-expression: Apache-2.0 OR MIT");
    expect(output.match(/kind: license/g)).toHaveLength(1);
    expect(output).not.toContain(root);
    expect(output).not.toContain("\r");
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });

  it("includes a hash-pinned non-package data license", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", {
      LICENSE: "MIT license\n",
    });
    const unicodeLicense = "UNICODE LICENSE V3\n\nfixture\n";
    await mkdir(path.join(root, "data-src/unicode"), { recursive: true });
    await writeFile(path.join(root, "data-src/unicode/license.txt"), unicodeLicense);
    const digest = sha256(Buffer.from(unicodeLicense));
    const output = await generateLicenseReport({
      inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
      overrides: { schemaVersion: 1, overrides: [] },
      dataComponents: [{
        purl: "pkg:generic/unicode-data@17.0.0",
        packageName: "Unicode Data Files@17.0.0",
        licenseExpression: "Unicode-3.0",
        licenseFile: "data-src/unicode/license.txt",
        licenseTextSha256: digest,
      }],
      version: "0.1.0",
      commit,
      projectRoot: root,
    });
    expect(output).toContain("dependency-count: 2");
    expect(output).toContain("purl: pkg:generic/unicode-data@17.0.0");
    expect(output).toContain("license-expression: Unicode-3.0");
    expect(output).toContain(`license-text-sha256: ${digest}`);
    expect(output).toContain("UNICODE LICENSE V3");
  });

  it("includes every analyzer data license deterministically regardless of descriptor order", async () => {
    const root = await analyzerDataFixture();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", {
      LICENSE: "MIT license\n",
    });
    const descriptors = await loadAnalyzerDataComponents(root);
    const generate = (components: typeof descriptors) =>
      generateLicenseReport({
        inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
        overrides: { schemaVersion: 1, overrides: [] },
        dataComponents: components,
        version: "0.1.0",
        commit,
        projectRoot: root,
      });

    const canonical = await generate(descriptors);
    const shuffled = await generate([...descriptors].reverse());

    expect(shuffled).toBe(canonical);
    expect(canonical).toContain("dependency-count: 4");
    for (const { purl, licenseExpression, licenseTextSha256 } of descriptors) {
      expect(canonical).toContain(`purl: ${purl}`);
      expect(canonical).toContain(`license-expression: ${licenseExpression}`);
      expect(canonical).toContain(`license-text-sha256: ${licenseTextSha256}`);
    }
    expect(canonical).toContain("Creative Commons Legal Code");
    expect(canonical).toContain("Mozilla Public License Version 2.0");
    expect(canonical).toContain("UNICODE LICENSE V3");
  });

  it("fails closed when a dependency has no eligible license text", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", { "README.md": "MIT\n" });
    await expect(
      generateLicenseReport({
        inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
        overrides: { schemaVersion: 1, overrides: [] },
        version: "0.1.0",
        commit,
        projectRoot: root,
      }),
    ).rejects.toThrow("no eligible normalized LICENSE or COPYING text");
  });

  it("uses only an exact reviewed override for legacy declarations", async () => {
    const root = await temporary();
    const licenseText = "reviewed license\n";
    const digest = sha256(Buffer.from(licenseText));
    const alpha = await packageFixture(root, "alpha", "1.0.0", { type: "Legacy" }, {
      LICENSE: licenseText,
    });
    const output = await generateLicenseReport({
      inventory: { "alpha@1.0.0": { licenses: ["Legacy", "MIT"], path: alpha } },
      overrides: {
        schemaVersion: 1,
        overrides: [{
          purl: "pkg:npm/alpha@1.0.0",
          licenseExpression: "MIT",
          licenseTextSha256: [digest],
          noticeSha256: [],
        }],
      },
      version: "0.1.0",
      commit,
      projectRoot: root,
    });
    expect(output).toContain("license-expression: MIT");
    expect(output).toContain(`license-text-sha256: ${digest}`);
  });

  it("allows an exact reviewed override to resolve missing or non-UTF-8 text", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", {
      LICENSE: Buffer.from([0xff]),
    });
    const output = await generateLicenseReport({
      inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
      overrides: {
        schemaVersion: 1,
        overrides: [{
          purl: "pkg:npm/alpha@1.0.0",
          licenseExpression: "MIT",
          licenseTextSha256: [],
          noticeSha256: [],
        }],
      },
      version: "0.1.0",
      commit,
      projectRoot: root,
    });
    expect(output).toContain("license-text-sha256: none");
    expect(output).not.toContain("kind: license");
  });

  it("permits an unused override only for an exact optional lockfile package", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", {
      LICENSE: "MIT\n",
    });
    await writeFile(
      path.join(root, "package-lock.json"),
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", version: "0.1.0" },
          "node_modules/@scope/native-linux-x64": {
            version: "2.0.0",
            optional: true,
            os: ["linux"],
            cpu: ["x64"],
          },
        },
      })}\n`,
    );
    const optionalOverride = {
      purl: "pkg:npm/%40scope/native-linux-x64@2.0.0",
      licenseExpression: "MIT",
      licenseTextSha256: [],
      noticeSha256: [],
    };
    await expect(
      generateLicenseReport({
        inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
        overrides: { schemaVersion: 1, overrides: [optionalOverride] },
        version: "0.1.0",
        commit,
        projectRoot: root,
      }),
    ).resolves.toContain("package: alpha@1.0.0");

    await expect(
      generateLicenseReport({
        inventory: { "alpha@1.0.0": { licenses: "MIT", path: alpha } },
        overrides: {
          schemaVersion: 1,
          overrides: [{ ...optionalOverride, purl: "pkg:npm/not-in-lock@2.0.0" }],
        },
        version: "0.1.0",
        commit,
        projectRoot: root,
      }),
    ).rejects.toThrow("unused license override");
  });

  it("rejects checker and package declaration mismatch without an override", async () => {
    const root = await temporary();
    const alpha = await packageFixture(root, "alpha", "1.0.0", "MIT", { LICENSE: "MIT\n" });
    await expect(
      generateLicenseReport({
        inventory: { "alpha@1.0.0": { licenses: "Apache-2.0", path: alpha } },
        overrides: { schemaVersion: 1, overrides: [] },
        version: "0.1.0",
        commit,
        projectRoot: root,
      }),
    ).rejects.toThrow("license-checker and package.json disagree");
  });

  it("sorts commutative SPDX operands without changing mixed grouping", () => {
    expect(canonicalSpdx("MIT OR Apache-2.0")).toBe("Apache-2.0 OR MIT");
    expect(canonicalSpdx("MIT AND (ISC OR Apache-2.0)")).toBe("(Apache-2.0 OR ISC) AND MIT");
  });
});

describe("archive contracts", () => {
  it("hashes exactly the ordinary unsigned base set", async () => {
    const root = await temporary();
    for (const [index, name] of ordinaryArtifactNames("0.1.0").entries()) {
      await writeFile(path.join(root, name), `artifact-${index}\n`);
    }
    const manifest = await generateArchiveManifest({ artifactDirectory: root, version: "0.1.0" });
    const entries = parseHashManifest(manifest);
    expect(entries.map(({ name }) => name)).toEqual([...ordinaryArtifactNames("0.1.0")].sort());
    expect(entries).toHaveLength(6);
    expect(manifest).not.toContain("archive.sha256");
    expect(manifest).not.toContain(".minisig");
  });

  it("locks GNU tar normalization flags and rejects non-GNU tools", () => {
    expect(isGnuTarVersion("tar (GNU tar) 1.35\n")).toBe(true);
    expect(isGnuTarVersion("bsdtar 3.5.3\n")).toBe(false);
    expect(isGnuGzipVersion("gzip 1.13\n")).toBe(true);
    expect(isGnuGzipVersion("Apple gzip 479\n")).toBe(false);
    expect(normalizedTarArguments("qrwarden-0.1.0-dist", 123)).toEqual([
      "--sort=name",
      "--format=posix",
      "--pax-option=delete=atime,delete=ctime",
      "--mtime=@123",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mode=u+rwX,go+rX,go-w",
      "-cf",
      "-",
      "qrwarden-0.1.0-dist",
    ]);
  });

  it("rejects symlinks and submodules from git source inventories", () => {
    expect(() =>
      parseGitTree(Buffer.from(`120000 blob ${"a".repeat(40)}\tlink\0`, "utf8")),
    ).toThrow("forbids symlink");
    expect(() =>
      parseGitTree(Buffer.from(`160000 commit ${"b".repeat(40)}\tvendor\0`, "utf8")),
    ).toThrow("forbids submodule");
  });
});
