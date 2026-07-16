import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertReleaseOutputDirectory,
} from "../../scripts/release/assemble-release-candidate.mjs";
import { compareReleaseCandidates } from "../../scripts/release/compare-release-candidates.mjs";
import { extractVersionChangelog } from "../../scripts/release/generate-version-changelog.mjs";
import { generateArchiveManifest } from "../../scripts/release/generate-archive-manifest.mjs";
import { sha256 } from "../../scripts/release/release-contract.mjs";
import {
  RELEASE_IMAGE,
  validateActionPins,
  validateReleaseWorkflow,
} from "../../scripts/release/validate-workflows.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const commit = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-release-workflow-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeCandidate(directory: string, source = "source\n"): Promise<void> {
  await mkdir(directory, { recursive: true });
  const version = "0.1.0";
  const distIndex = Buffer.from("index\n");
  const distHeaders = Buffer.from("headers\n");
  await writeFile(path.join(directory, `qrwarden-${version}-source.tar.gz`), source);
  await writeFile(path.join(directory, `qrwarden-${version}-dist.tar.gz`), "dist archive\n");
  await writeFile(
    path.join(directory, `qrwarden-${version}-dist-files.sha256`),
    `${sha256(distHeaders)}  dist/_headers\n${sha256(distIndex)}  dist/index.html\n`,
  );
  await writeFile(
    path.join(directory, `qrwarden-${version}-sbom.cdx.json`),
    `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", metadata: { component: { version } } })}\n`,
  );
  await writeFile(
    path.join(directory, `qrwarden-${version}-licenses.txt`),
    `QRWARDEN-LICENSE-REPORT-1\nrelease: v${version}\ncommit: ${commit}\ndependency-count: 0\n`,
  );
  await writeFile(
    path.join(directory, `qrwarden-${version}-changelog.md`),
    `## [${version}] - 2026-07-15\n\n### Added\n\n- Release.\n`,
  );
  await writeFile(
    path.join(directory, `qrwarden-${version}-archive.sha256`),
    await generateArchiveManifest({ artifactDirectory: directory, version }),
  );
}

describe("release workflow policy", () => {
  it("pins every action in every workflow and enforces the release topology", async () => {
    const workflowDirectory = path.join(root, ".github/workflows");
    for (const name of await readdir(workflowDirectory)) {
      if (!/\.ya?ml$/u.test(name)) continue;
      const text = await readFile(path.join(workflowDirectory, name), "utf8");
      expect(validateActionPins(text, name)).toEqual([]);
    }
    const release = await readFile(path.join(workflowDirectory, "release.yml"), "utf8");
    expect(release).toContain(`image: ${RELEASE_IMAGE}`);
    expect(validateReleaseWorkflow(release)).toEqual([]);
  });

  it("rejects floating actions and weakened independent-build invariants", async () => {
    const release = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
    expect(validateReleaseWorkflow(release.replace(/actions\/checkout@[0-9a-f]{40}/u, "actions/checkout@v7"))).toContainEqual(
      expect.stringContaining("not a full commit SHA"),
    );
    expect(validateActionPins('steps:\n  - uses: "actions/checkout@v7"\n')).toContainEqual(
      expect.stringContaining("not a full commit SHA"),
    );
    expect(validateReleaseWorkflow(release.replace("replica: [first, second]", "replica: [first]"))).toContain(
      "release build must have exactly two named replicas",
    );
    expect(validateReleaseWorkflow(release.replace("environment: production-release", "environment: unprotected"))).toContain(
      "release preflight must enter the protected production-release environment exactly once",
    );
    expect(validateReleaseWorkflow(release.replace(`image: ${RELEASE_IMAGE}`, "image: node:24-bookworm-slim"))).toContain(
      "all three release jobs must use the locked release image digest",
    );
    expect(validateReleaseWorkflow(release.replace(/\n\s+sbom-path:.*\n/u, "\n"))).toContain(
      "CycloneDX SBOM attestation is missing",
    );
    expect(validateReleaseWorkflow(release.replace("path: candidates/second", "path: candidates/first"))).toContain(
      "second replica must download to an isolated directory",
    );
    expect(validateReleaseWorkflow(release.replace("scripts/release/compare-release-candidates.mjs", "scripts/release/no-compare.mjs"))).toContain(
      "bytewise candidate comparison is missing",
    );
    expect(validateReleaseWorkflow(release.replace("npm run release:wrangler:check", "npm run release:wrangler:skip"))).toContain(
      "committed Wrangler configuration gate is missing",
    );
  });
});

describe("release candidate finalization", () => {
  it("refuses to recursively clear any directory except repository release-output", () => {
    expect(assertReleaseOutputDirectory(root, path.join(root, "release-output"))).toBe(
      path.join(root, "release-output"),
    );
    expect(() => assertReleaseOutputDirectory(root, root)).toThrow(
      "repository release-output directory",
    );
    expect(() => assertReleaseOutputDirectory(root, path.join(root, "src"))).toThrow(
      "repository release-output directory",
    );
  });

  it("extracts one dated version section and rejects an Unreleased heading", () => {
    const changelog = "# Changelog\n\n## [0.1.0] - 2026-07-15\n\n### Added\n\n- One.\n\n## [0.0.1] - 2026-01-01\n\n### Added\n\n- Old.\n";
    expect(extractVersionChangelog(changelog, "0.1.0")).toBe(
      "## [0.1.0] - 2026-07-15\n\n### Added\n\n- One.\n",
    );
    expect(() => extractVersionChangelog(changelog.replace("2026-07-15", "Unreleased"), "0.1.0")).toThrow(
      "exactly one dated heading",
    );
  });

  it("approves only two closed, byte-identical, manifest-authenticated sets", async () => {
    const work = await temporary();
    const first = path.join(work, "first");
    const second = path.join(work, "second");
    const approved = path.join(work, "approved");
    await writeCandidate(first);
    await cp(first, second, { recursive: true });
    const names = await compareReleaseCandidates({ first, second, output: approved, version: "0.1.0", commit });
    expect(await readdir(approved)).toEqual(names);
  });

  it("rejects independently valid sets when any candidate byte differs", async () => {
    const work = await temporary();
    const first = path.join(work, "first");
    const second = path.join(work, "second");
    await writeCandidate(first, "source one\n");
    await writeCandidate(second, "source two\n");
    await expect(
      compareReleaseCandidates({
        first,
        second,
        output: path.join(work, "approved"),
        version: "0.1.0",
        commit,
      }),
    ).rejects.toThrow("independent release candidates differ");
  });
});
