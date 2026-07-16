import assert from "node:assert/strict";
import test from "node:test";

import {
  renderWranglerConfig,
  wranglerConfig,
} from "../../scripts/release/render-wrangler-configs.mjs";

const constants = {
  product: { workerName: "qrwarden" },
  production: { canonicalDomain: "qrwarden.example" },
  cloudflare: { accountId: "0123456789abcdef0123456789abcdef" },
};
const baseline = { compatibilityDate: "2026-07-15" };

test("production and release Wrangler configs differ only by preview_urls", () => {
  const production = wranglerConfig(constants, baseline, false);
  const release = wranglerConfig(constants, baseline, true);
  assert.deepEqual({ ...release, preview_urls: false }, production);
  assert.equal(production.workers_dev, false);
  assert.deepEqual(production.compatibility_flags, []);
  assert.equal(production.assets.run_worker_first, false);
  assert.equal(production.assets.not_found_handling, "none");
});

test("rendering is normalized JSON with one trailing newline", () => {
  const rendered = renderWranglerConfig(constants, baseline, false);
  assert.equal(rendered.endsWith("\n"), true);
  assert.equal(rendered.endsWith("\n\n"), false);
  assert.deepEqual(JSON.parse(rendered), wranglerConfig(constants, baseline, false));
});

test("placeholder external values fail closed", () => {
  assert.throws(
    () =>
      renderWranglerConfig(
        {
          ...constants,
          production: { canonicalDomain: "<SET_CANONICAL_PRODUCTION_DOMAIN>" },
        },
        baseline,
        false,
      ),
    /committed external literal/,
  );
});
