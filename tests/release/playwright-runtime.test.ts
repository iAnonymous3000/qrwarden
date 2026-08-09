import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveInstalledRoot,
  validatePlaywrightRuntime,
} from "../../scripts/validate-playwright-runtime.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runtime = JSON.parse(
  await readFile(path.join(repositoryRoot, "release/playwright-runtime.json"), "utf8"),
);
const version = "1.61.1";
const integrity = `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`;
const temporaryDirectories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-playwright-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(absolute: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function lockEntry(name: string, dependencies?: Record<string, string>): Record<string, unknown> {
  const archiveName = name.startsWith("@") ? name.split("/")[1] : name;
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${archiveName}-${version}.tgz`,
    integrity,
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

async function fixture(): Promise<string> {
  const root = await temporary();
  await writeJson(path.join(root, "release/playwright-runtime.json"), runtime);
  await writeJson(path.join(root, "package.json"), {
    devDependencies: { "@playwright/test": version },
  });
  await writeJson(path.join(root, "package-lock.json"), {
    packages: {
      "": { devDependencies: { "@playwright/test": version } },
      "node_modules/@playwright/test": lockEntry("@playwright/test", { playwright: version }),
      "node_modules/playwright": lockEntry("playwright", { "playwright-core": version }),
      "node_modules/playwright-core": lockEntry("playwright-core"),
    },
  });
  await writeJson(path.join(root, "node_modules/@playwright/test/package.json"), {
    name: "@playwright/test",
    version,
  });
  await writeJson(path.join(root, "node_modules/playwright/package.json"), { name: "playwright", version });
  await writeJson(path.join(root, "node_modules/playwright-core/package.json"), {
    name: "playwright-core",
    version,
  });
  await writeJson(path.join(root, "node_modules/playwright-core/browsers.json"), {
    browsers: runtime.artifacts.map(({ registryName, revision }: { registryName: string; revision: string }) => ({
      name: registryName,
      revision,
    })),
  });
  return root;
}

async function installedFixture(root: string): Promise<string> {
  const installedRoot = path.join(root, "installed-browsers");
  await mkdir(path.join(installedRoot, ".links"), { recursive: true });
  for (const artifact of runtime.artifacts as Array<{ name: string; revision: string }>) {
    const directory = path.join(installedRoot, `${artifact.name}-${artifact.revision}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "INSTALLATION_COMPLETE"), "");
  }
  return installedRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Playwright runtime contract", () => {
  it("pins the reviewed package, image, platform, path, and browser revisions", () => {
    expect(runtime).toEqual({
      schemaVersion: 1,
      packages: {
        "@playwright/test": version,
        playwright: version,
        "playwright-core": version,
      },
      container: {
        image: "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48",
        platform: "linux/amd64",
        browsersPath: "/ms-playwright",
      },
      artifacts: [
        { name: "chromium", registryName: "chromium", revision: "1228" },
        { name: "chromium_headless_shell", registryName: "chromium-headless-shell", revision: "1228" },
        { name: "firefox", registryName: "firefox", revision: "1532" },
        { name: "webkit", registryName: "webkit", revision: "2311" },
        { name: "ffmpeg", registryName: "ffmpeg", revision: "1011" },
      ],
    });
  });

  it("accepts the pinned package graph and playwright-core registry", async () => {
    const root = await fixture();
    await expect(validatePlaywrightRuntime({ root })).resolves.toEqual([]);
  });

  it("matches the current checkout's locked and installed Playwright metadata", async () => {
    await expect(validatePlaywrightRuntime({ root: repositoryRoot })).resolves.toEqual([]);
  });

  it("fails closed when package or registry pins drift", async () => {
    const root = await fixture();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.devDependencies["@playwright/test"] = "1.61.0";
    await writeJson(path.join(root, "package.json"), packageJson);

    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    lock.packages["node_modules/playwright"].dependencies["playwright-core"] = "1.61.0";
    await writeJson(path.join(root, "package-lock.json"), lock);

    await writeJson(path.join(root, "node_modules/playwright-core/package.json"), {
      name: "playwright-core",
      version: "1.61.0",
    });
    const browsers = JSON.parse(
      await readFile(path.join(root, "node_modules/playwright-core/browsers.json"), "utf8"),
    );
    browsers.browsers.find(({ name }: { name: string }) => name === "firefox").revision = "1531";
    await writeJson(path.join(root, "node_modules/playwright-core/browsers.json"), browsers);

    await expect(validatePlaywrightRuntime({ root })).resolves.toEqual(expect.arrayContaining([
      "package.json must pin @playwright/test to 1.61.1",
      "playwright must depend on playwright-core 1.61.1",
      "installed playwright-core must be 1.61.1",
      "playwright-core firefox revision must be 1532, got 1531",
    ]));
  });

  it("rejects substituted package identities and malformed lockfile integrity", async () => {
    const root = await fixture();
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    lock.packages["node_modules/playwright-core"].resolved =
      "https://registry.npmjs.org/substitute/-/substitute-1.61.1.tgz";
    lock.packages["node_modules/playwright"].integrity = "sha512-A";
    await writeJson(path.join(root, "package-lock.json"), lock);
    await writeJson(path.join(root, "node_modules/@playwright/test/package.json"), {
      name: "substitute",
      version,
    });

    await expect(validatePlaywrightRuntime({ root })).resolves.toEqual(expect.arrayContaining([
      "node_modules/playwright-core must resolve to https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz",
      "node_modules/playwright must have SHA-512 lockfile integrity",
      "installed @playwright/test package must identify itself as @playwright/test",
    ]));
  });

  it("requires every installed artifact directory and marker, with no stale artifact directories", async () => {
    const root = await fixture();
    const installedRoot = await installedFixture(root);
    await expect(validatePlaywrightRuntime({ root, installedRoot })).resolves.toEqual([]);

    await rm(path.join(installedRoot, "webkit-2311/INSTALLATION_COMPLETE"));
    await rm(path.join(installedRoot, "ffmpeg-1011"), { recursive: true });
    await mkdir(path.join(installedRoot, "firefox-1531"));
    await mkdir(path.join(installedRoot, ".stale-browser-revision"));
    await expect(validatePlaywrightRuntime({ root, installedRoot })).resolves.toEqual(expect.arrayContaining([
      "unexpected Playwright artifact directory: firefox-1531",
      "unexpected Playwright artifact directory: .stale-browser-revision",
      "Playwright installation marker is missing: webkit-2311/INSTALLATION_COMPLETE",
      "Playwright artifact directory is missing: ffmpeg-1011",
    ]));
  });

  it("resolves an explicit installed root or PLAYWRIGHT_BROWSERS_PATH without ambiguity", () => {
    expect(resolveInstalledRoot([], {})).toBeUndefined();
    expect(resolveInstalledRoot(["--installed-root", "/tmp/browsers"], {})).toBe("/tmp/browsers");
    expect(resolveInstalledRoot([], { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" })).toBe("/ms-playwright");
    expect(() => resolveInstalledRoot(
      ["--installed-root=/tmp/browsers"],
      { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
    )).toThrow("must identify the same directory");
    expect(() => resolveInstalledRoot(["--unknown"], {})).toThrow("unknown argument");
  });
});
