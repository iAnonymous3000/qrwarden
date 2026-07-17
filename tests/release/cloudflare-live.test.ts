import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertExpectedRelease,
  assertOrigin,
  buildRequestHeaders,
  expectedHeadersForPath,
  parseHeaderRules,
  verifyCloudflareLive,
  verifyProbeResponse,
} from "../../scripts/release/verify-cloudflare-live.mjs";

const release = "v0.1.0+0123456789abcdef0123456789abcdef01234567";
const generatedHeadersFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "_headers",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function fixture(): Promise<{
  root: string;
  dist: string;
  contract: string;
  bodies: Map<string, string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "qrwarden-cloudflare-live-"));
  temporaryDirectories.push(root);
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  const bodies = new Map([
    ["/", "<!doctype html>\n"],
    ["/app.webmanifest", '{"version":"0.1.0"}\n'],
    ["/assets/app-abcdefgh.js", "export {};\n"],
  ]);
  await writeFile(path.join(dist, "index.html"), bodies.get("/") ?? "");
  await writeFile(path.join(dist, "app.webmanifest"), bodies.get("/app.webmanifest") ?? "");
  await writeFile(path.join(dist, "assets/app-abcdefgh.js"), bodies.get("/assets/app-abcdefgh.js") ?? "");
  await writeFile(
    path.join(dist, "_headers"),
    `/*
  Referrer-Policy: no-referrer
  X-QRWarden-Release: ${release}

/
  Content-Security-Policy: default-src 'none'
  Cache-Control: no-cache, must-revalidate

/app.webmanifest
  Cache-Control: no-cache, must-revalidate

/assets/*.js
  Content-Type: text/javascript; charset=utf-8

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
  );
  const contract = path.join(root, "artifact-contract.json");
  await writeFile(
    contract,
    `${JSON.stringify({
      unmatchedPublicStatus: 404,
      cacheClasses: {
        revalidate: "no-cache, must-revalidate",
        immutable: "public, max-age=31536000, immutable",
        infrastructure: null,
      },
      entries: [
        {
          id: "document",
          kind: "dist",
          sourcePattern: "^index\\.html$",
          expectedStatus: 200,
          mediaType: "text/html; charset=utf-8",
          cacheClass: "revalidate",
          cspClass: "document",
          releaseMarker: true,
        },
        {
          id: "manifest",
          kind: "dist",
          sourcePattern: "^app\\.webmanifest$",
          expectedStatus: 200,
          mediaType: "application/manifest+json",
          cacheClass: "revalidate",
          cspClass: "none",
          releaseMarker: true,
        },
        {
          id: "hashed-javascript",
          kind: "dist",
          sourcePattern: "^assets/.+\\.js$",
          expectedStatus: 200,
          mediaType: "text/javascript; charset=utf-8",
          cacheClass: "immutable",
          cspClass: "none",
          releaseMarker: true,
        },
        {
          id: "platform-headers",
          kind: "dist-control",
          sourcePattern: "^_headers$",
          expectedStatus: 404,
          cacheClass: "infrastructure",
          cspClass: "none",
          releaseMarker: false,
        },
        {
          id: "source-maps",
          kind: "public-probe-only",
          sourcePattern: "^assets/.+\\.map$",
          expectedStatus: 404,
          cacheClass: "infrastructure",
          cspClass: "none",
          releaseMarker: false,
        },
        {
          id: "index-redirect",
          kind: "public-probe-only",
          sourcePattern: "^index\\.html$",
          canonicalUrlRule: "exact:/index.html",
          expectedStatus: 307,
          location: "/",
          cacheClass: "infrastructure",
          cspClass: "none",
          releaseMarker: false,
        },
      ],
    }, null, 2)}\n`,
  );
  return { root, dist, contract, bodies };
}

function responseFor(pathname: string, bodies: Map<string, string>, tamper = false): Response {
  if (pathname === "/index.html") {
    return new Response(null, { status: 307, headers: { Location: "/" } });
  }
  const body = bodies.get(pathname);
  if (body === undefined) return new Response("Not found\n", { status: 404 });
  const headers = new Headers({
    "Referrer-Policy": "no-referrer",
    "X-QRWarden-Release": release,
  });
  if (pathname === "/") {
    headers.set("Content-Security-Policy", "default-src 'none'");
    headers.set("Cache-Control", "no-cache, must-revalidate");
    headers.set("Content-Type", "text/html; charset=utf-8");
  } else if (pathname === "/app.webmanifest") {
    headers.set("Cache-Control", "no-cache, must-revalidate");
    headers.set("Content-Type", "application/manifest+json");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Content-Type", "text/javascript; charset=utf-8");
  }
  return new Response(tamper && pathname.endsWith(".js") ? "tampered\n" : body, {
    status: 200,
    headers,
  });
}

describe("Cloudflare live release verifier", () => {
  it("checks every file plus redirects, source maps, control files, and unknown paths", async () => {
    const { dist, contract, bodies } = await fixture();
    const requests: { pathname: string; headers: Headers; redirect?: RequestRedirect }[] = [];
    const count = await verifyCloudflareLive({
      origin: "https://qrwarden.example",
      distDirectory: dist,
      contractFile: contract,
      expectedRelease: release,
      workerName: "qrwarden",
      versionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
      accessClientId: "access-id.example",
      accessClientSecret: "access-secret",
      fetchImplementation: (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({
          pathname: url.pathname,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        });
        return Promise.resolve(responseFor(url.pathname, bodies));
      },
    });

    expect(count).toBe(8);
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      "/app.webmanifest",
      "/assets/app-abcdefgh.js",
      "/",
      "/index.html",
      "/_headers",
      "/assets/app-abcdefgh.js.map",
      "/assets/qrwarden-live-probe-missing.map",
      "/.well-known/qrwarden-live-probe-missing",
    ]);
    expect(requests.every(({ redirect }) => redirect === "manual")).toBe(true);
    expect(requests[0]?.headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'qrwarden="dc8dcd28-271b-4367-9840-6c244f84cb40"',
    );
    expect(requests[0]?.headers.get("CF-Access-Client-Id")).toBe("access-id.example");
    expect(requests[0]?.headers.get("CF-Access-Client-Secret")).toBe("access-secret");
  });

  it("fails when Cloudflare serves bytes other than the verified dist", async () => {
    const { dist, contract, bodies } = await fixture();
    await expect(
      verifyCloudflareLive({
        origin: "https://qrwarden.example",
        distDirectory: dist,
        contractFile: contract,
        expectedRelease: release,
        fetchImplementation: (input: URL | RequestInfo) => {
          const url = new URL(input.toString());
          return Promise.resolve(responseFor(url.pathname, bodies, true));
        },
      }),
    ).rejects.toThrow("body differs from the verified dist bytes");
  });

  it("requires the redirect contract's exact raw Location value", async () => {
    await expect(
      verifyProbeResponse({
        probe: {
          pathname: "/index.html",
          expectedStatus: 307,
          expectedLocation: "/",
        },
        response: new Response(null, {
          status: 307,
          headers: { Location: "https://qrwarden.example/" },
        }),
      }),
    ).rejects.toThrow("unexpected redirect location");
  });

  it("rejects files outside the closed artifact contract before networking", async () => {
    const { dist, contract } = await fixture();
    await writeFile(path.join(dist, "unexpected.txt"), "not in the contract\n");
    await expect(
      verifyCloudflareLive({
        origin: "https://qrwarden.example",
        distDirectory: dist,
        contractFile: contract,
        expectedRelease: release,
        fetchImplementation: () => {
          throw new Error("network must not be reached");
        },
      }),
    ).rejects.toThrow("unexpected.txt maps to 0 live artifact classes");
  });

  it("does not echo credentials or raw fetch errors", async () => {
    const { dist, contract } = await fixture();
    const secret = "sentinel-access-secret";
    let error: unknown;
    try {
      await verifyCloudflareLive({
        origin: "https://qrwarden.example",
        distDirectory: dist,
        contractFile: contract,
        expectedRelease: release,
        accessClientId: "sentinel-access-id",
        accessClientSecret: secret,
        fetchImplementation: () => {
          throw new Error(`transport included ${secret}`);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: /app.webmanifest request failed");
    expect(String(error)).not.toContain(secret);
  });

  it("rejects unsafe identity, origin, Access, override, and header inputs", () => {
    expect(() => assertOrigin("http://qrwarden.example")).toThrow("bare HTTPS origin");
    expect(() => assertOrigin("https://qrwarden.example:8443")).toThrow("bare HTTPS origin");
    expect(() => assertExpectedRelease(`v0.1.0+${"0".repeat(40)}`)).toThrow("nonzero");
    expect(() => buildRequestHeaders({ accessClientId: "only-id" })).toThrow("both Cloudflare Access");
    expect(() =>
      buildRequestHeaders({
        accessClientId: "access-id.example",
        accessClientSecret: "secret\u0000value",
      })
    ).toThrow("bounded visible-ASCII");
    expect(() => buildRequestHeaders({ workerName: "qrwarden" })).toThrow("supplied together");
    expect(() =>
      buildRequestHeaders({
        workerName: "qrwarden",
        versionId: "not-a-version",
      })
    ).toThrow("version ID");
    expect(() => parseHeaderRules("/assets/*/nested\n  X-Test: one\n")).toThrow(
      "unsupported _headers route",
    );
    expect(() => parseHeaderRules("/assets/*.js/nested\n  X-Test: one\n")).toThrow(
      "unsupported _headers route",
    );
    expect(() => parseHeaderRules("/assets/**\n  X-Test: one\n")).toThrow(
      "unsupported _headers route",
    );
    expect(() => parseHeaderRules("/assets/app-*.js\n  X-Test: one\n")).toThrow(
      "unsupported _headers route",
    );
    const rules = parseHeaderRules("/*\n  X-Test: one\n/asset\n  X-Test: two\n");
    expect(() => expectedHeadersForPath(rules, "/asset")).toThrow("multiple _headers values");
  });

  it("parses the generated _headers and matches the /assets/*.js suffix route", async () => {
    const rules = parseHeaderRules(await readFile(generatedHeadersFixture, "utf8"));
    expect(rules.map(({ pattern }: { pattern: string }) => pattern)).toContain("/assets/*.js");
    const hashedScript = expectedHeadersForPath(rules, "/assets/app-abc123.js");
    expect(hashedScript.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(hashedScript.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const hashedStylesheet = expectedHeadersForPath(rules, "/assets/style-abc123.css");
    expect(hashedStylesheet.has("content-type")).toBe(false);
    expect(hashedStylesheet.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const outsideAssets = expectedHeadersForPath(rules, "/other/x.js");
    expect(outsideAssets.has("content-type")).toBe(false);
    expect(outsideAssets.has("cache-control")).toBe(false);
  });

  it("fails closed on NEL, Report-To, and Reporting-Endpoints in any casing", async () => {
    const reportingHeaderSets: Record<string, string>[] = [
      { NEL: '{"report_to":"cf-nel","max_age":604800}' },
      { "report-to": '{"group":"cf-nel","endpoints":[{"url":"https://a.nel.cloudflare.com/report"}]}' },
      { "Reporting-Endpoints": 'cf-nel="https://a.nel.cloudflare.com/report"' },
    ];
    for (const headers of reportingHeaderSets) {
      await expect(
        verifyProbeResponse({
          probe: { pathname: "/", expectedStatus: 200 },
          response: new Response("ok\n", { status: 200, headers }),
        }),
      ).rejects.toThrow("opt out of Network Error Logging in the Cloudflare dashboard");
    }
    await expect(
      verifyProbeResponse({
        probe: { pathname: "/missing", expectedStatus: 404 },
        response: new Response("Not found\n", {
          status: 404,
          headers: { "Report-To": '{"endpoints":[{"url":"https://a.nel.cloudflare.com/report"}]}' },
        }),
      }),
    ).rejects.toThrow("verification fails closed");
  });

  it("fails the live run when Cloudflare injects reporting headers on a probe", async () => {
    const { dist, contract, bodies } = await fixture();
    await expect(
      verifyCloudflareLive({
        origin: "https://qrwarden.example",
        distDirectory: dist,
        contractFile: contract,
        expectedRelease: release,
        fetchImplementation: (input: URL | RequestInfo) => {
          const url = new URL(input.toString());
          const response = responseFor(url.pathname, bodies);
          response.headers.set("NEL", '{"report_to":"cf-nel","max_age":604800}');
          return Promise.resolve(response);
        },
      }),
    ).rejects.toThrow("opt out of Network Error Logging");
  });
});
