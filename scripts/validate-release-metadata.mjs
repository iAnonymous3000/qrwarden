import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const root = new URL("../", import.meta.url);
const errors = [];

async function json(relativePath) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function equal(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) errors.push(`${label} differs from the locked contract`);
}

function closed(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (!isDeepStrictEqual(actual, expected)) errors.push(`${label} keys must be exactly: ${expected.join(", ")}`);
}

const packageJson = await json("package.json");
if (packageJson) {
  equal(packageJson.engines, { node: "24.18.0", npm: "11.16.0" }, "package engines");
  if (packageJson.packageManager !== "npm@11.16.0") errors.push("packageManager must be npm@11.16.0");
  equal(
    packageJson.allowScripts,
    {
      "esbuild@0.28.1": true,
      "fsevents@2.3.2": false,
      "fsevents@2.3.3": false,
      "libxmljs2@0.37.0": true,
      "sharp@0.34.5": true,
      "workerd@1.20260710.1": true
    },
    "reviewed install-script allowlist"
  );
  const expectedDependencies = {
    preact: "10.29.7",
    "workbox-precaching": "7.4.1",
    "workbox-routing": "7.4.1",
    "zxing-wasm": "3.1.1"
  };
  const expectedDevDependencies = {
    "@cyclonedx/cyclonedx-npm": "6.0.0",
    "@cyclonedx/cyclonedx-library": "10.1.0",
    "@playwright/test": "1.61.1",
    "@preact/preset-vite": "2.10.5",
    "@types/node": "24.13.3",
    eslint: "10.7.0",
    "license-checker-rseidelsohn": "5.0.1",
    "spdx-exceptions": "2.5.0",
    "spdx-expression-parse": "4.0.0",
    "spdx-license-ids": "3.0.23",
    typescript: "6.0.3",
    "typescript-eslint": "8.64.0",
    vite: "8.1.4",
    vitest: "4.1.10",
    "workbox-build": "7.4.1",
    wrangler: "4.111.0"
  };
  equal(packageJson.dependencies, expectedDependencies, "runtime dependency pins");
  equal(packageJson.devDependencies, expectedDevDependencies, "development dependency pins");
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      errors.push(`${name} must use one exact version, not ${version}`);
    }
  }
}

const packageLock = await json("package-lock.json");
if (packageLock) {
  if (packageLock.lockfileVersion !== 3 || packageLock.requires !== true) {
    errors.push("package-lock.json must be a lockfileVersion 3 dependency graph");
  }
  if (packageLock.packages === null || typeof packageLock.packages !== "object" || Array.isArray(packageLock.packages)) {
    errors.push("package-lock.json packages must be an object");
  } else {
    const installScriptPackages = new Set();
    equal(
      packageLock.packages[""]?.dependencies,
      packageJson?.dependencies,
      "package-lock root dependencies",
    );
    equal(
      packageLock.packages[""]?.devDependencies,
      packageJson?.devDependencies,
      "package-lock root development dependencies",
    );
    for (const [packagePath, entry] of Object.entries(packageLock.packages)) {
      if (packagePath === "") continue;
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.version !== "string" ||
        typeof entry.resolved !== "string" ||
        !entry.resolved.startsWith("https://registry.npmjs.org/") ||
        !entry.resolved.endsWith(".tgz") ||
        typeof entry.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
      ) {
        errors.push(`${packagePath} must be a versioned registry artifact with resolved URL and SHA-512 integrity`);
        continue;
      }
      const encoded = entry.integrity.slice("sha512-".length);
      const digest = Buffer.from(encoded, "base64");
      if (digest.byteLength !== 64 || digest.toString("base64") !== encoded) {
        errors.push(`${packagePath} has non-canonical SHA-512 integrity`);
      }
      if (entry.hasInstallScript === true) {
        const marker = "node_modules/";
        const markerIndex = packagePath.lastIndexOf(marker);
        const packageName = markerIndex < 0 ? "" : packagePath.slice(markerIndex + marker.length);
        if (packageName === "" || packageName.includes("/node_modules/")) {
          errors.push(`${packagePath} has an install script but no canonical package identity`);
        } else {
          installScriptPackages.add(`${packageName}@${entry.version}`);
        }
      }
    }
    equal(
      [...installScriptPackages].sort(),
      Object.keys(packageJson?.allowScripts ?? {}).sort(),
      "install-script approval and denial coverage",
    );
  }
}

try {
  const npmrc = await readFile(new URL(".npmrc", root), "utf8");
  equal(
    npmrc,
    [
      "engine-strict=true",
      "save-exact=true",
      "package-lock=true",
      "fund=false",
      "audit=true",
      "ignore-scripts=true",
      "omit-lockfile-registry-resolved=false",
      "",
    ].join("\n"),
    ".npmrc supply-chain policy",
  );
} catch (error) {
  errors.push(`.npmrc: ${error instanceof Error ? error.message : String(error)}`);
}

const expectedManifest = {
  id: "/qrwarden",
  name: "QRWarden",
  short_name: "QRWarden",
  version: "0.1.0",
  description: "Scan and inspect QR codes on your device before you act.",
  lang: "en",
  dir: "ltr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0c0a09",
  theme_color: "#191715",
  share_target: {
    action: "/share-target",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      files: [
        {
          name: "image",
          accept: ["image/jpeg", "image/png", "image/webp"]
        }
      ]
    }
  },
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/icons/monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" }
  ]
};
equal(await json("public/app.webmanifest"), expectedManifest, "public/app.webmanifest");

try {
  const indexHtml = await readFile(new URL("index.html", root), "utf8");
  const colorSchemeTags = indexHtml.match(/<meta\s+name="color-scheme"\s+content="[^"]+">/gu) ?? [];
  const themeColorTags = indexHtml.match(/<meta\s+name="theme-color"[^>]*>/gu) ?? [];
  equal(
    colorSchemeTags,
    ['<meta name="color-scheme" content="dark light">'],
    "index color-scheme metadata",
  );
  equal(
    themeColorTags,
    [
      '<meta name="theme-color" content="#191715" media="(prefers-color-scheme: dark)">',
      '<meta name="theme-color" content="#fffdf8" media="(prefers-color-scheme: light)">',
    ],
    "index theme-color metadata",
  );
} catch (error) {
  errors.push(`index.html: ${error instanceof Error ? error.message : String(error)}`);
}

const permissions = await json("release/permissions-policy.json");
const deniedPermissions = [
  "accelerometer",
  "ambient-light-sensor",
  "attribution-reporting",
  "battery",
  "bluetooth",
  "browsing-topics",
  "captured-surface-control",
  "clipboard-read",
  "compute-pressure",
  "cross-origin-isolated",
  "deferred-fetch",
  "deferred-fetch-minimal",
  "digital-credentials-get",
  "direct-sockets",
  "display-capture",
  "document-domain",
  "encrypted-media",
  "execution-while-not-rendered",
  "execution-while-out-of-viewport",
  "fullscreen",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "join-ad-interest-group",
  "language-detector",
  "local-fonts",
  "local-network",
  "local-network-access",
  "loopback-network",
  "magnetometer",
  "microphone",
  "midi",
  "on-device-speech-recognition",
  "otp-credentials",
  "payment",
  "picture-in-picture",
  "private-aggregation",
  "private-state-token-issuance",
  "private-state-token-redemption",
  "proofreader",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "rewriter",
  "run-ad-auction",
  "screen-wake-lock",
  "serial",
  "shared-storage",
  "speaker-selection",
  "storage-access",
  "summarizer",
  "sync-xhr",
  "translator",
  "unload",
  "usb",
  "web-printing",
  "web-share",
  "window-management",
  "writer",
  "xr-spatial-tracking"
];
if (permissions) {
  closed(permissions, ["schemaVersion", "directives"], "permissions registry");
  if (permissions.schemaVersion !== 1 || !Array.isArray(permissions.directives)) {
    errors.push("permissions registry must be schema version 1 with directives");
  } else {
    const expectedDirectives = [
      { name: "camera", allow: "self" },
      { name: "clipboard-write", allow: "self" },
      { name: "autoplay", allow: "self" },
      ...deniedPermissions.map((name) => ({ name, allow: "none" }))
    ];
    equal(permissions.directives, expectedDirectives, "Permissions-Policy directives and order");
    const names = permissions.directives.map(({ name }) => name);
    if (new Set(names).size !== names.length) errors.push("Permissions-Policy directives must be unique");
  }
}

const artifact = await json("release/artifact-contract.json");
if (artifact) {
  closed(artifact, ["schemaVersion", "description", "unmatchedDistPolicy", "unmatchedPublicStatus", "cacheClasses", "cspClasses", "entries"], "artifact contract");
  if (
    artifact.schemaVersion !== 1 ||
    artifact.unmatchedDistPolicy !== "reject" ||
    artifact.unmatchedPublicStatus !== 404 ||
    !Array.isArray(artifact.entries)
  ) errors.push("artifact contract must reject unmatched dist files and return 404 for unmatched public paths");
  else {
    const requiredIds = [
      "document",
      "manifest",
      "decoder-worker",
      "service-worker",
      "reader-wasm",
      "hashed-javascript",
      "hashed-css",
      "png-icons",
      "release-public-key",
      "security-txt",
      "platform-headers",
      "source-maps",
      "index-redirect"
    ];
    const ids = artifact.entries.map(({ id }) => id);
    equal(ids, requiredIds, "artifact contract entries and order");
    if (new Set(ids).size !== ids.length) errors.push("artifact contract entry IDs must be unique");
    const allowedEntryKeys = [
      "id",
      "kind",
      "sourcePattern",
      "canonicalUrlRule",
      "expectedStatus",
      "location",
      "mediaType",
      "cacheClass",
      "cspClass",
      "releaseMarker",
      "precache"
    ];
    for (const entry of artifact.entries) {
      const keys = Object.keys(entry);
      if (keys.some((key) => !allowedEntryKeys.includes(key))) errors.push(`artifact entry ${entry.id} has an unknown key`);
      try {
        new RegExp(entry.sourcePattern, "u");
      } catch {
        errors.push(`artifact entry ${entry.id} has an invalid sourcePattern`);
      }
      if (![200, 307, 404].includes(entry.expectedStatus)) errors.push(`artifact entry ${entry.id} has an invalid expectedStatus`);
      if (!artifact.cspClasses.includes(entry.cspClass)) errors.push(`artifact entry ${entry.id} has an invalid CSP class`);
      if (!(entry.cacheClass in artifact.cacheClasses)) errors.push(`artifact entry ${entry.id} has an invalid cache class`);
      if (typeof entry.releaseMarker !== "boolean" || typeof entry.precache !== "boolean") {
        errors.push(`artifact entry ${entry.id} must classify releaseMarker and precache`);
      }
      if (entry.expectedStatus === 200 && entry.mediaType === null) errors.push(`artifact entry ${entry.id} needs a media type`);
      if (entry.expectedStatus !== 200 && entry.precache) errors.push(`artifact entry ${entry.id} cannot precache a non-200 response`);
    }
    const byId = Object.fromEntries(artifact.entries.map((entry) => [entry.id, entry]));
    const critical = {
      document: ["exact:/", 200, "text/html; charset=utf-8", "revalidate", "document", true, true],
      "decoder-worker": ["preserve-path", 200, "text/javascript; charset=utf-8", "revalidate", "decoder-worker", true, true],
      "service-worker": ["preserve-path", 200, "text/javascript; charset=utf-8", "revalidate", "service-worker", true, false],
      "platform-headers": ["no-public-body", 404, null, "infrastructure", "none", false, false],
      "index-redirect": ["exact:/index.html", 307, null, "infrastructure", "none", false, false]
    };
    for (const [id, expected] of Object.entries(critical)) {
      const entry = byId[id];
      equal(
        [entry?.canonicalUrlRule, entry?.expectedStatus, entry?.mediaType, entry?.cacheClass, entry?.cspClass, entry?.releaseMarker, entry?.precache],
        expected,
        `artifact contract ${id}`
      );
    }
    const distMatchers = artifact.entries
      .filter(({ kind }) => kind === "dist")
      .map(({ sourcePattern }) => new RegExp(sourcePattern, "u"));
    if (distMatchers.some((matcher) => matcher.test("assets/application-deadbeef.js.map"))) {
      errors.push("no dist artifact class may admit a production source map");
    }
  }
}

const browser = await json("release/browser-matrix.json");
if (browser) {
  closed(browser, [
    "schemaVersion",
    "recordExactBuildNumbersForEveryRelease",
    "platforms",
    "firefoxWindowsCompatibilityFloors",
    "policyNotes",
    "installedModeEvidenceFields",
    "iosAndIpadosOfflineGate"
  ], "browser matrix");
  if (browser.schemaVersion !== 1 || browser.recordExactBuildNumbersForEveryRelease !== true) errors.push("browser matrix must require exact release build numbers");
  equal(
    browser.platforms?.map(({ platform }) => platform),
    [
      "Windows 11",
      "macOS current and previous",
      "Android current and previous",
      "iOS current and previous",
      "iPadOS current and previous",
      "Ubuntu LTS"
    ],
    "browser matrix platform coverage"
  );
  equal(browser.firefoxWindowsCompatibilityFloors, { mozillaDistribution: 143, microsoftStoreDistribution: 150 }, "Firefox Windows floors");
  if (browser.platforms?.filter(({ physical }) => physical).length !== 3) errors.push("Android, iOS, and iPadOS must be physical-device rows");
  if (browser.policyNotes?.length !== 3 || browser.installedModeEvidenceFields?.length !== 9 || browser.iosAndIpadosOfflineGate?.length !== 10) {
    errors.push("browser matrix evidence and iOS/iPadOS gate are incomplete");
  }
}

for (const [path, commitField, requiredFields] of [
  [
    "release/key-transition-input.schema.json",
    "effective-commit",
    ["project", "canonical-domain", "effective-tag", "fingerprint-scheme", "previous-key-sha256", "successor-key-sha256", "successor-minisign-public-key", "dns-owner"]
  ],
  [
    "release/key-recovery-input.schema.json",
    "recovery-commit",
    ["project", "canonical-domain", "recovery-tag", "fingerprint-scheme", "compromised-key-sha256", "successor-key-sha256", "successor-minisign-public-key", "last-trusted-tag", "last-trusted-commit", "incident-url", "dns-owner"]
  ]
]) {
  const schema = await json(path);
  if (!schema) continue;
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || schema.additionalProperties !== false) {
    errors.push(`${path} must be a closed draft-2020-12 object schema`);
  }
  equal(schema.required, requiredFields, `${path} required fields and order`);
  if (commitField in (schema.properties ?? {}) || schema.required?.includes(commitField)) {
    errors.push(`${path} must not track the injected ${commitField}`);
  }
  for (const [name, definition] of Object.entries(schema.properties ?? {})) {
    if (definition.pattern) {
      try {
        new RegExp(definition.pattern, "u");
      } catch {
        errors.push(`${path} property ${name} has an invalid pattern`);
      }
    }
  }
}

const cloudflare = await json("release/cloudflare-baseline.json");
if (cloudflare) {
  closed(
    cloudflare,
    [
      "schemaVersion",
      "compatibilityDate",
      "production",
      "disabledAccountFeatures",
      "forbiddenBindingsAndRuntimeFeatures",
      "requiredOperationalControls",
      "releaseKeyDns"
    ],
    "Cloudflare baseline"
  );
  closed(
    cloudflare.releaseKeyDns,
    [
      "recordType",
      "ownerPrefix",
      "valueFormat",
      "steadyStateValueCount",
      "plannedRotationValueCount",
      "dnssecRequired"
    ],
    "Cloudflare release-key DNS contract"
  );
  if (
    cloudflare.schemaVersion !== 1 ||
    cloudflare.compatibilityDate !== "2026-07-15" ||
    cloudflare.production?.workersDev !== false ||
    cloudflare.production?.previewUrls !== false ||
    cloudflare.production?.runWorkerFirst !== false ||
    !Array.isArray(cloudflare.disabledAccountFeatures) ||
    !Array.isArray(cloudflare.forbiddenBindingsAndRuntimeFeatures)
  ) {
    errors.push("Cloudflare baseline differs from the locked no-runtime production shape");
  }
  equal(
    cloudflare.requiredOperationalControls,
    [
      "DNSSEC",
      "Always Use HTTPS",
      "minimum TLS 1.2",
      "HSTS max-age=31536000; includeSubDomains; preload",
      "persistent deny-by-default Access application for all preview deployments",
      "persistent deny-by-default Access application for QRWarden preview deployments",
      "no cache rule overriding signed Cache-Control",
      "no transform rule mutating signed response bodies or headers"
    ],
    "Cloudflare operational controls"
  );
  equal(
    cloudflare.releaseKeyDns,
    {
      recordType: "TXT",
      ownerPrefix: "_qrwarden-release-key",
      valueFormat: "64-lowercase-hex-sha256-minisign-decoded-key-blob",
      steadyStateValueCount: 1,
      plannedRotationValueCount: 2,
      dnssecRequired: true
    },
    "Cloudflare release-key DNS contract"
  );
  if (!cloudflare.disabledAccountFeatures.includes("Workers Logs and observability")) {
    errors.push("Cloudflare account baseline must disable Workers Logs and observability");
  }
}

const licenseOverrides = await json("release/license-overrides.json");
if (licenseOverrides && (licenseOverrides.schemaVersion !== 1 || !Array.isArray(licenseOverrides.overrides))) {
  errors.push("release/license-overrides.json must be schema version 1 with an overrides array");
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`release metadata: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("release metadata contracts are valid\n");
}
