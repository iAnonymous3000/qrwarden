import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

const PLACEHOLDER = /(?:<[^>]+>|CHANGE_ME|SET_[A-Z0-9_]+)/;

function requireLiteral(value, label) {
  if (typeof value !== "string" || value.length === 0 || PLACEHOLDER.test(value)) {
    throw new TypeError(`${label} must be a committed external literal`);
  }
  return value;
}

export function wranglerConfig(constants, baseline, previewUrls) {
  const domain = requireLiteral(
    constants.production?.canonicalDomain,
    "production.canonicalDomain",
  );
  const accountId = requireLiteral(constants.cloudflare?.accountId, "cloudflare.accountId");
  const workerName = requireLiteral(constants.product?.workerName, "product.workerName");
  const compatibilityDate = requireLiteral(
    baseline.compatibilityDate,
    "cloudflare-baseline.compatibilityDate",
  );

  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: workerName,
    account_id: accountId,
    compatibility_date: compatibilityDate,
    compatibility_flags: [],
    workers_dev: false,
    preview_urls: previewUrls,
    routes: [{ pattern: domain, custom_domain: true }],
    assets: {
      directory: "./dist",
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      run_worker_first: false,
    },
  };
}

export function renderWranglerConfig(constants, baseline, previewUrls) {
  return `${JSON.stringify(wranglerConfig(constants, baseline, previewUrls), null, 2)}\n`;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    throw new TypeError("Usage: render-wrangler-configs.mjs --check|--write");
  }
  const constants = JSON.parse(
    await readFile(new URL("../../release/constants.json", import.meta.url), "utf8"),
  );
  const baseline = JSON.parse(
    await readFile(new URL("../../release/cloudflare-baseline.json", import.meta.url), "utf8"),
  );
  const outputs = [
    [new URL("../../wrangler.jsonc", import.meta.url), renderWranglerConfig(constants, baseline, false)],
    [
      new URL("../../wrangler.release.jsonc", import.meta.url),
      renderWranglerConfig(constants, baseline, true),
    ],
  ];

  for (const [target, expected] of outputs) {
    if (mode === "--write") {
      await writeFile(target, expected);
      continue;
    }
    let actual;
    try {
      actual = await readFile(target, "utf8");
    } catch {
      throw new TypeError(`${target.pathname} is missing; render and commit it`);
    }
    if (actual !== expected) {
      throw new TypeError(`${target.pathname} does not match release constants`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
