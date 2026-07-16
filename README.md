# QRWarden

QRWarden is a production-grade, local-first progressive web app for inspecting QR codes before acting on them. Scans stay in the browser, decoded content is not uploaded, and the app does not visit a destination while analyzing it. It is intentionally a pre-action QR inspector, not a barcode generator, scan history, or automation suite.

## What it does

- Scans QR codes with a camera or from a local image.
- Decodes in a disposable same-origin worker with strict input and time limits.
- Shows decoded content as inert text before offering any action.
- Highlights observable URL, hostname, Unicode, control-character, and payload properties.
- Requires explicit confirmation for actions that need additional review.
- Works offline after the application shell has been installed and verified.

QRWarden reports evidence, not reputation. It does not label a destination safe, trusted, malicious, clean, or verified.

## Privacy and security model

QRWarden has no account, analytics, telemetry, advertising, scan-history service, or application backend. Inspection does not fetch decoded destinations, redirects, favicons, certificates, DNS answers, previews, or blocklist results.

The implementation uses a bounded decoder worker, an inert renderer, object-bound action handling, strict Content Security Policy, closed production artifacts, hash-pinned analyzer data, and reproducible-build checks. The detailed boundaries and residual risks are documented in [PRIVACY.md](PRIVACY.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

## Quick start

The toolchain is locked to Node.js 24.18.0 and npm 11.16.0. Dependencies are exact pins and the committed lockfile is authoritative.

```sh
npm ci --ignore-scripts=false --strict-allow-scripts
npm run dev
```

The committed `.npmrc` makes plain npm installs skip lifecycle scripts. The explicit flags above enable scripts only for the exact reviewed `allowScripts` entries and fail closed on an unclassified hook.

Run the full local verification suite for every source or release change:

```sh
npm run validate
npm run build
npm run verify:reproducible
npx playwright install chromium firefox webkit
npm run test:browser
```

`npm run data:generate` deterministically rebuilds the pinned PSL, IANA, and Unicode analyzer modules. It is needed only when reviewing a data update.

## Release engineering

Releases are produced by a fail-closed pipeline. Production-grade source is not presented as a signed public release until operator identity, canonical-domain, signing, deployment, and live-verification gates all pass. `npm run release:validate` rejects placeholder release constants and runs the complete verification suite:

```sh
npm run validate:constants
npm run release:validate
```

The production build verifies the reader WASM hash, emits fixed same-origin workers, verifies precache integrity and size, generates route-specific security headers, rejects source maps, and enforces a closed artifact contract. The dispatch-only release workflow adds two independent digest-pinned builds, normalized archives and manifests, an SBOM, a license report, attestations, and byte-for-byte candidate comparison. Deployment, verification, and rollback follow [RELEASE.md](RELEASE.md) and [docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md); artifact signing follows [SIGNING.md](SIGNING.md).

## Documentation

- [Security policy](SECURITY.md)
- [Privacy policy](PRIVACY.md)
- [Threat model](THREAT_MODEL.md)
- [Self-hosting](SELF_HOSTING.md)
- [Reproducible builds](REPRODUCIBLE_BUILDS.md)
- [Release process](RELEASE.md)
- [Cloudflare release operations](docs/DEPLOY_CLOUDFLARE.md)
- [Release signing](SIGNING.md)
- [Dependencies and provenance](DEPENDENCIES.md)

Do not open a public issue for a suspected vulnerability. Follow the private-reporting instructions in [SECURITY.md](SECURITY.md).

## License

QRWarden's original source code and documentation are licensed under AGPL-3.0-or-later except where a file says otherwise. Vendored packages and analyzer data retain their upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [DEPENDENCIES.md](DEPENDENCIES.md). Copyright remains with the respective contributors and upstream rightsholders.
