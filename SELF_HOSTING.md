# Self-hosting

QRWarden is a static one-document PWA. It has no API, server-executed application code, account, database, telemetry, or runtime secrets.

The current artifact contract requires deployment at the root of a dedicated HTTPS origin. The manifest, workers, icons, start URL, and scope use root-absolute paths. Subpath deployment is unsupported unless a reviewed source and artifact-contract change updates every affected path and test together.

Build from the exact pinned toolchain and committed lockfile:

```sh
npm ci --ignore-scripts=false --strict-allow-scripts
npm run validate
npm run build
npm run verify:reproducible
npx playwright install chromium firefox webkit
npm run test:browser
```

Plain npm installs honor `.npmrc` and skip lifecycle scripts. The committed policy also keeps strict enforcement enabled if scripts are deliberately turned back on; under the exact pinned npm 11.16.0 runtime, the explicit install flags above enable only the exact reviewed hooks and reject an unclassified lifecycle script. Run `npm run validate:install-policy` to exercise the native approved, denied, and unreviewed-hook behavior with a synthetic local package.

Serve only the verified `dist/` tree. The generated `_headers` file is deployment input for the canonical Cloudflare target, not a portable web-server standard. A non-Cloudflare operator must translate it without weakening the behavior and verify the result: the document, decoder worker, and service worker each receive exactly one intended CSP; common privacy/security headers apply to successful assets; fixed workers and the manifest revalidate; hashed assets are immutable; `_headers` and source maps return 404; `/index.html` redirects 307 to `/`; and unknown paths return 404. A host that merely copies `dist/` while ignoring `_headers` is not a compatible deployment.

The generated `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header is a commitment, not just a hardening flag: `includeSubDomains` binds every subdomain of the serving domain to HTTPS for a year, and `preload` signals eligibility for browser HSTS preload lists, which effectively extend that commitment to the whole registrable domain and are slow to leave once entered. The HSTS directives are the one place a translated configuration may deliberately differ: an operator who cannot make that domain-wide commitment must knowingly reduce them rather than serve a preload signal that is false for their domain.

The shipped `/.well-known/security.txt` names the upstream QRWarden maintainers' vulnerability-reporting route and an explicit expiry date. A self-host operator is the responsible security contact for their own deployment and must replace or remove that file rather than implying upstream maintainers operate their origin.

Do not add a reverse-proxy fallback to `index.html`, analytics, injection, external fonts/assets, destination previews, CSP relaxation, runtime Worker, or logging of decoded content. A self-host operator must replace canonical domain, signing, deployment, privacy, and contact claims with truthful values and becomes responsible for HTTPS, headers, availability, connection-metadata handling and retention, updates, incident response, and release trust. Review and comply with AGPL-3.0-or-later and the third-party terms in `THIRD_PARTY_NOTICES.md`, including the source-offer obligations that apply to modified network-served versions. An unmodified build served from another origin is not an official QRWarden release.

Cloudflare is the official deployment target, not a requirement for compatible self-hosting. The committed Cloudflare baseline is deliberately static-assets-only and forbids application bindings and server logic.
