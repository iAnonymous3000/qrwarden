import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertExactCspForPath,
  expectedHeadersForPath,
  parseHeaderRules,
} from "../../scripts/release/header-rules.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const verifyDist = path.join(projectRoot, "scripts/verify-dist.mjs");
const contract = JSON.parse(
  await readFile(path.join(projectRoot, "release/artifact-contract.json"), "utf8"),
);
const generatedHeaders = await readFile(
  path.join(import.meta.dirname, "fixtures/_headers"),
  "utf8",
);

function assertDocumentCsp(source: string): void {
  const headers = expectedHeadersForPath(parseHeaderRules(source), "/");
  assertExactCspForPath({
    headers,
    pathname: "/",
    cspClasses: contract.cspClasses,
    cspClass: "document",
  });
}

async function createDistFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "qrwarden-csp-contract-"));
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "icons"), { recursive: true });
  await mkdir(path.join(dist, ".well-known"), { recursive: true });
  await mkdir(path.join(root, "release"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "release/artifact-contract.json"),
    path.join(root, "release/artifact-contract.json"),
  );
  await Promise.all([
    writeFile(path.join(dist, "index.html"), "<!doctype html>\n"),
    writeFile(path.join(dist, "app.webmanifest"), "{}\n"),
    writeFile(path.join(dist, "decoder-worker.js"), "export {};\n"),
    writeFile(path.join(dist, "sw.js"), `sha384-test ${"a".repeat(64)}\n`),
    writeFile(path.join(dist, "assets/reader-abcdefgh.wasm"), "wasm\n"),
    writeFile(path.join(dist, "assets/app-abcdefgh.js"), "export {};\n"),
    writeFile(path.join(dist, "assets/app-abcdefgh.css"), "body {}\n"),
    writeFile(path.join(dist, "icons/icon-192.png"), "png\n"),
    writeFile(path.join(dist, ".well-known/qrwarden-release-key.pub"), "key\n"),
    writeFile(path.join(dist, ".well-known/security.txt"), "Contact: test@example.invalid\n"),
    writeFile(path.join(dist, "_headers"), generatedHeaders),
  ]);
  return root;
}

function runVerifyDist(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifyDist], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("exact CSP release contract", () => {
  it("matches every generated CSP class and requires CSP absence for none", () => {
    const rules = parseHeaderRules(generatedHeaders);
    for (const [pathname, cspClass] of [
      ["/", "document"],
      ["/decoder-worker.js", "decoder-worker"],
      ["/sw.js", "service-worker"],
      ["/app.webmanifest", "none"],
      ["/assets/app-abcdefgh.js", "none"],
    ]) {
      assertExactCspForPath({
        headers: expectedHeadersForPath(rules, pathname),
        pathname,
        cspClasses: contract.cspClasses,
        cspClass,
      });
    }
  });

  it.each([
    ["an external connection target", "connect-src 'none'", "connect-src https://telemetry.example"],
    ["inline styles", "style-src 'self'", "style-src 'self' 'unsafe-inline'"],
    ["same-origin objects", "object-src 'none'", "object-src 'self'"],
    ["a same-origin base URL", "base-uri 'none'", "base-uri 'self'"],
  ])("rejects %s added to the document policy", (_label, before, after) => {
    const tampered = generatedHeaders.replace(before, after);
    expect(tampered).not.toBe(generatedHeaders);
    expect(() => assertDocumentCsp(tampered)).toThrow(
      "CSP for / does not match the exact document policy",
    );
  });

  it("makes the production dist verifier reject a relaxed generated policy", async () => {
    const root = await createDistFixture();
    try {
      expect(runVerifyDist(root).status).toBe(0);
      await writeFile(
        path.join(root, "dist/_headers"),
        generatedHeaders.replace(
          "style-src 'self'",
          "style-src 'self' 'unsafe-inline'",
        ),
      );
      const result = runVerifyDist(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "CSP for / does not match the exact document policy",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
