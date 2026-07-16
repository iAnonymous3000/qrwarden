# Dependencies and provenance

All package versions are exact pins. The reviewed `package-lock.json` is the normative package-integrity graph. The committed `.npmrc` makes plain installs skip lifecycle scripts; `npm ci --ignore-scripts=false --strict-allow-scripts` is the only CI/release installation path and enables only the exact hooks classified by `allowScripts`.

| Component | Version | License | Source |
|---|---:|---|---|
| Node.js | 24.18.0 | MIT | https://github.com/nodejs/node |
| npm | 11.16.0 | Artistic-2.0 | https://github.com/npm/cli |
| Preact | 10.29.7 | MIT | https://github.com/preactjs/preact |
| TypeScript | 6.0.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Vite | 8.1.4 | MIT | https://github.com/vitejs/vite |
| @preact/preset-vite | 2.10.5 | MIT | https://github.com/preactjs/preset-vite |
| Vitest | 4.1.10 | MIT | https://github.com/vitest-dev/vitest |
| @playwright/test | 1.61.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| @types/node | 24.13.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| ESLint | 10.7.0 | MIT | https://github.com/eslint/eslint |
| typescript-eslint | 8.64.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| workbox-build | 7.4.1 | MIT | https://github.com/googlechrome/workbox |
| workbox-precaching | 7.4.1 | MIT | https://github.com/googlechrome/workbox |
| workbox-routing | 7.4.1 | MIT | https://github.com/googlechrome/workbox |
| zxing-wasm | 3.1.1 | MIT | https://github.com/Sec-ant/zxing-wasm |
| Wrangler | 4.111.0 | MIT OR Apache-2.0 | https://github.com/cloudflare/workers-sdk |
| @cyclonedx/cyclonedx-npm | 6.0.0 | Apache-2.0 | https://github.com/CycloneDX/cyclonedx-node-npm |
| @cyclonedx/cyclonedx-library | 10.1.0 | Apache-2.0 | https://github.com/CycloneDX/cyclonedx-javascript-library |
| license-checker-rseidelsohn | 5.0.1 | BSD-3-Clause | https://github.com/RSeidelsohn/license-checker-rseidelsohn |
| spdx-expression-parse | 4.0.0 | MIT | https://github.com/jslicense/spdx-expression-parse.js |
| spdx-license-ids | 3.0.23 | CC0-1.0 | https://github.com/jslicense/spdx-license-ids |
| spdx-exceptions | 2.5.0 | CC-BY-3.0 | https://github.com/kemitchell/spdx-exceptions.json |
| Minisign | 0.12 | ISC | https://github.com/jedisct1/minisign |

## Decoder provenance

- zxing-wasm package: 3.1.1; source commit `41d92eadda2a556dff9a044ff29fd3e41e70c657`
- zxing-cpp source commit: `6c2961d2a9ea4bc4e4ae8f37b1497299f04dd861`
- Emscripten: 5.0.4; linux/amd64 image digest `sha256:61aa4ca6e3dcdf0cfce9c3018767a0698bdc0f7ff72ca5982a0536c5caff93f7`
- upstream reader WASM SHA-256: `6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f`

The build verifies lockfile integrity and the reader hash before copying the unchanged, self-hosted artifact. Updating decoder provenance requires an isolated security-reviewed dependency change.

The root `allowScripts` policy narrowly approves only the exact versions of the four transitive packages whose lifecycle scripts are required by the pinned build/release toolchain (`esbuild`, `libxmljs2`, `sharp`, and `workerd`). The optional hooks for `fsevents@2.3.2` and `fsevents@2.3.3` are explicit version-scoped denials, not approvals. Every registry package in `package-lock.json` carries its resolved URL and integrity digest, and CI/release installation enables strict script enforcement so a newly introduced or upgraded lifecycle-script package fails until it is reviewed and explicitly classified.

Some exact npm artifacts, especially platform-native optional packages, declare a valid SPDX license but publish no package-root `LICENSE*`, `COPYING*`, or `NOTICE*` file. `release/license-overrides.json` enumerates those exact purls and uses empty selected-text lists only for that verified absence. The release generator still rejects an unlisted omission, a stale non-optional override, a checker/package identity mismatch, and any incompatible or unreviewed SPDX expression; optional platform overrides must resolve to an exact package-lock entry.

## Data provenance

| Data | License or terms | Required source and scope | Current implementation state |
|---|---|---|---|
| Public Suffix List | MPL-2.0 | publicsuffix/list, ICANN and private sections, source commit and retrieval date | Complete ICANN/private snapshot generated from the hash-verified source pinned at `f8d153aafe2dd6aa1c27cfdabaeb41b90ece3d48`; exact, wildcard, and exception rules retain their section |
| IANA IPv4 special-purpose registry | CC0-1.0 under the joint IANA/IETF registry-data statement | IANA registry XML/CSV, source update/retrieval date | Complete 2025-10-09 special-purpose snapshot plus the official address-space multicast coverage, generated from hash-verified raw inputs |
| IANA IPv6 special-purpose registry | CC0-1.0 under the joint IANA/IETF registry-data statement | IANA registry XML/CSV, source update/retrieval date | Complete 2025-10-09 special-purpose snapshot plus the official address-space multicast coverage, generated from hash-verified raw inputs |
| Unicode UTS 46 | Unicode-3.0 | unicode.org IDNA data, exact Unicode version and hashes | Complete Unicode 17.0.0 nontransitional profile: pinned mapping and normalization, STD3, ContextJ, RFC 5893 Bidi, Punycode, and DNS-length validation generated from hash-verified sources |
| Unicode UTS 39 | Unicode-3.0 | unicode.org security data for Highly Restrictive scripts/confusables, exact version and hashes | Complete Unicode 17.0.0 data for the General Security Profile, augmented `Script_Extensions`, Highly Restrictive host evaluation, confusable prototypes, default ignorables, and LTR bidi skeleton processing |
| QR ECI allowlist | Project policy | QRWarden decoder policy: assignments 3, 20, and 26 only | Implemented and covered by focused decoder tests |

`npm run data:generate` deterministically rebuilds the PSL, IANA, and Unicode modules from vendored raw inputs; `npm run validate:data` verifies their hashes, aggregate provenance, release-status parity, completeness, and generated bytes without modifying the checkout. The Public Suffix List retains its MPL-2.0 status, IANA protocol-registry data follows the [joint IANA/IETF CC0 statement](https://www.iana.org/help/licensing-terms), and the Unicode snapshot is derived from 18 pinned Unicode 17.0.0 files under the Unicode License v3. The Unicode aggregate source-set SHA-256 is `0b98ba743b2ad8b628ca0366802653154ecd7f528125641dadec73f6b0b4aa35`, with UTS 39 revision 32 and UTS 46 revision 35. PSL and IANA snapshots are refreshed for every minor release and must be no older than 90 days. Unicode changes use a separate reviewed data pull request. No runtime data refresh exists.

## TypeScript compatibility

`typescript-eslint@8.64.0` supports TypeScript `>=4.8.4 <6.1.0`, so the implementation pins `typescript@6.0.3`, the newest stable compiler inside that range. Legacy peer resolution is disabled; clean installation must resolve the parser-backed lint graph without overrides.

## Update procedure

Open one reviewed pull request per dependency or coherent data update. Update the exact pin and lock integrity, upstream provenance, licenses/notices, SBOM fixtures, decoder hash/toolchain where applicable, corpus/security results, browser compatibility evidence, and reproducibility snapshot. Never renovate during a release build.
