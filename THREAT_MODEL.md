# Threat model

Last reviewed: 2026-07-18 · Applies to: v0.1.0 (pre-release)

## Security objective

QRWarden lets a person inspect untrusted QR input without that input causing navigation, network access, executable markup, resource loading, persistent retention, or an automatic privileged action. It reports observable properties and never claims a destination is safe, malicious, trusted, clean, verified, or low/high risk.

## Protected assets

- decoded images, frames, bytes, strings, filenames, and structured fields;
- the user's destination choice, clipboard, camera permission, and browsing context;
- report integrity and object identity across asynchronous work;
- offline application integrity, release artifacts, signing keys, and update state;
- the privacy promise that scanning and inspection create no destination egress.

## Trust boundaries

Hostile camera frames and validated image files enter one disposable decoder worker. Image files arrive by file selection, drag and drop, clipboard paste, or a service-worker share-target handoff that correlates each delivery with a one-time token and forwards the file to the page strictly in memory; every path passes the same validation before the worker. The worker owns file parsing, rasterization, scaling, WASM initialization, matrix-symbology decoding behind per-format canonical-verification profiles (QR Model 2, Micro QR, rMQR, ECC200 Data Matrix, Aztec), result filtering, ECI validation, and text transcoding under a single five-second deadline. The document receives bounded typed results. Pure classifiers and analyzers produce immutable reports, inert renderers display text, and explicit action brokers alone may copy or open a reviewed value.

The application origin, service worker, browser, operating system, Cloudflare static host, GitHub, npm packages, pinned build container, release tooling, signing ceremony, and DNSSEC trust anchor are distinct boundaries. Deployment secrets and the signing secret key never enter application code or artifacts.

## Primary threats and controls

| Threat | Required controls |
|---|---|
| Parser exploitation or resource exhaustion | Disposable worker, bounded dimensions/bytes/results, structural image walkers, one monotonic deadline, termination and generation tokens |
| Unsupported or misleading decoder output | QR Model 2 versions 1 through 40 only, public zxing-wasm fields only, no ZXing human text, strict `bytesECI`, no structured-append reassembly |
| Markup or script injection | Text-only rendering, no HTML/CSS sinks, strict CSP, feature-aware Trusted Types, mutation tests, payload-derived live-attribute ban |
| Destination egress during inspection | `connect-src 'none'` in the document, no previews/reputation lookups/speculation, DNS/HTTP canary tests, separate explicit Open path |
| Stale asynchronous action | Immutable object identity plus report/work/action generation tokens; stale clipboard and confirmation settlements cannot update UI |
| Click substitution or automatic navigation | Two-step object-bound confirmation where required, synchronous trusted click, exact revalidation immediately before navigation |
| Camera or lifecycle leakage | Tracks/workers/bitmaps/buffers torn down on cancel, hidden, pagehide, replacement, update preparation, and generation invalidation |
| Cache/update substitution | Hash-and-length allowlist, install/pre-commit verification, no fallible activation work, release-consistency gate, availability-preserving failure |
| Supply-chain compromise | Exact pins and lockfile, decoder WASM hash, digest-pinned release image, two clean reproducible builds, SBOM/licenses, hosted attestations with independent readback, Minisign and DNSSEC |
| Deployment drift | Closed artifact/header/permissions contracts, static-assets-only Cloudflare baseline, captured version IDs, zero-percent override smoke, drift monitoring |

## Residual risks

JavaScript strings are immutable and garbage collectors may copy them, so QRWarden minimizes lifetime and remasks presentation but cannot prove memory zeroization. Browser memory, swap, screenshots, screen recording, camera and OS internals, clipboard synchronization, extensions, accessibility tools, and a compromised device remain outside the app's guarantees. A decoder or browser zero-day can cross the worker boundary. Opening a destination deliberately exposes a request to that destination and its infrastructure. Unicode and registry snapshots may contain upstream or implementation errors and can age between reviewed updates. Offline availability depends on browser storage remaining present.

The system also relies on maintainers protecting repository, DNS, Cloudflare, and offline signing credentials. Two independent builds and an external DNS trust anchor reduce, but do not eliminate, maintainer and build-system compromise.

## Review cadence

Update this model at every milestone, dependency/data change, new browser capability, security finding, release-key transition/recovery, or material architecture change. Stable v1 requires independent security review and physical-device validation against the exact signed candidate.
