# Contributing to QRWarden

QRWarden is a security- and privacy-sensitive project in a pre-release state. Contributions are welcome, but the bar is deliberately high: the build is fail-closed, most contracts are hash-pinned, and reviews prioritize correctness and honesty over feature velocity. Read this document before opening a pull request.

Suspected vulnerabilities are never reported in issues, discussions, or pull requests. Follow the private-reporting process in [SECURITY.md](SECURITY.md).

## Toolchain

The toolchain is pinned exactly: Node.js **24.18.0** and npm **11.16.0**. The committed `.npmrc` sets `engine-strict=true`, so `npm ci` fails on any other Node or npm version — this is intentional, not a compatibility bug to work around.

With nvm (reads the committed `.nvmrc`):

```sh
nvm install 24.18.0
nvm use
```

With fnm:

```sh
fnm install 24.18.0
fnm use
```

Then install the pinned npm, matching what CI does:

```sh
npm install --global --ignore-scripts npm@11.16.0
```

## Quick start

```sh
npm ci --ignore-scripts=false --strict-allow-scripts
npm run dev
```

The committed `.npmrc` makes plain installs skip lifecycle scripts and keeps strict allowlist enforcement enabled if scripts are deliberately turned back on. The pinned npm 11.16.0 runtime natively reads the exact reviewed `allowScripts` entries in `package.json`; the explicit flags above fail closed on an unclassified hook. Run `npm run validate:install-policy` to exercise approved, denied, and unreviewed synthetic hooks. Do not install with different flags and do not add overrides to make an install pass.

## Validation ladder

Run these before opening a pull request, cheapest first:

```sh
npm run lint          # eslint --max-warnings=0 plus scripts/lint-source.mjs
npm run typecheck     # tsc -b across app, worker, and node configs
npm run test          # vitest unit and integration suites
npm run validate      # everything above plus runtime, data, constants,
                      # metadata, workflow, and release-fixture checks
```

For changes that touch build output or runtime behavior, also run:

```sh
npm run build
npm run verify:reproducible
npx playwright install chromium firefox webkit   # one-time browser download
npm run test:browser
```

`npm run test:browser` fails until the Playwright browsers are installed; the `npx playwright install` step is required once per machine (and after Playwright version bumps).

`scripts/lint-source.mjs` enforces project-specific bans in `src/` and `decoder-worker/`: `innerHTML`-style sinks, inline `style` attributes and Preact style props, console output, `window.open`, dynamic `href`/`src` attribute bindings, and `javascript:` URLs. These are not style preferences; do not add suppressions.

## Repository layout

| Path | Purpose |
|---|---|
| `src/analyzer/` | Offline URL/payload analysis: IDNA, Unicode security, public-suffix, IP, and link-shortener evidence |
| `src/copy/` | All user-facing strings — English and Spanish dictionaries plus locale resolution (hash-pinned, see below) |
| `src/render/` | Preact UI: inert result rendering, glossary, report text, theme |
| `src/sw/` | Service worker, activation commit, and page client for verified offline use |
| `src/action/`, `src/camera/`, `src/decoder/`, `src/image/` | Confirmed actions, camera control, decoder-worker client, and bounded image intake |
| `decoder-worker/` | The disposable same-origin decode worker: input limits, ECI policy, symbology profiles |
| `scripts/` | Build, data-generation, lint, and fail-closed release/verification tooling |
| `tests/` | `unit/`, `integration/`, `browser/` (Playwright), `release/` (pinned release contracts), and the decode `corpus/` |

## Changing user-facing copy

App copy is deliberately hash-pinned by `tests/unit/copy-contract.test.ts` so that no string reaches users without review. A copy change is never a one-file edit:

1. Update `src/copy/locales/en.ts` **and** `src/copy/locales/es.ts` together. Every locale must stay key-identical to English; the type `CopyDictionary` (exported from `en.ts`) makes a missing or re-typed key fail `typecheck`.
2. If you add a function-valued key (parameterized copy), add an explicit `case` for it in the `materialize()` switch in `tests/unit/copy-contract.test.ts` with representative snapshot inputs. Unknown function keys throw on purpose.
3. Run `npm run test -- copy-contract`. It will fail with the actual values for the pinned constants. Review the failure output to confirm the rendered-string diff is exactly the change you intended, then update:
   - `SOURCE_SHA256` — per-file SHA-256 of `index.ts`, `locale.ts`, `locales/en.ts`, `locales/es.ts`
   - `COPY_KEY_COUNT` — the number of top-level keys per locale
   - `RUNTIME_CONTRACT_SHA256` — the hash of the fully rendered snapshot
4. Re-run `npm run test -- copy-contract` and confirm it passes.

Re-pinning hashes without reviewing the rendered diff defeats the contract and will be rejected in review.

## Adding a translation

1. Create `src/copy/locales/<locale>.ts` exporting a frozen dictionary typed as `CopyDictionary` (imported from `./en`). The type checker enforces identical keys, function arities, and nested shapes.
2. Add the locale to the `AppLocale` union and `SUPPORTED_LOCALES` in `src/copy/locale.ts`, and wire selection in `src/copy/index.ts`.
3. Extend `tests/unit/copy-contract.test.ts`: add the new file to `SOURCE_SHA256`, include the locale in the key-parity and rendered-snapshot assertions, and re-pin per the procedure above. Add locale cases to the `resolveAppLocale` test.
4. Update the language statements in `README.md` and `PRIVACY.md`, which currently name English and Spanish.

Analyzer evidence strings inside reports intentionally remain English for now; a translation PR should follow that boundary unless it also proposes (and justifies) changing it.

## Security-sensitive expectations

- **Fail closed.** Verification scripts reject rather than warn. Do not convert a hard failure into a warning or a default.
- **Pinned strings live in reviewed contracts.** Exact CSP policies live authoritatively in `release/artifact-contract.json`; generation and verification consume that contract, while `tests/release/fixtures/_headers` deliberately mirrors it as an independent review pin. Other headers, artifact lists, and similar expectations may still be duplicated across scripts, docs, and `tests/release/`. When you change a pinned value, grep for projections and fixtures, update them consistently, and prove it with `npm run validate` and `npm run build`.
- **No new dependencies without review.** Dependencies are exact pins with a reviewed lifecycle-script allowlist. A dependency addition or update is its own pull request following the procedure in [DEPENDENCIES.md](DEPENDENCIES.md), including provenance, license, SBOM fixture, and lockfile-integrity updates. Never bundle a dependency change into a feature change.
- **No egress, no telemetry.** Inspection must not fetch decoded destinations or anything derived from them, and the app must not gain analytics, logging of decoded content, or external assets. See [PRIVACY.md](PRIVACY.md) and [THREAT_MODEL.md](THREAT_MODEL.md) for the boundaries a change must not cross.
- **Docs never overclaim.** Prose in this repository is honest and specific. Do not describe planned behavior as existing, and do not label destinations or the project itself "safe" or "verified".
- **Vulnerabilities go to private reporting.** [SECURITY.md](SECURITY.md) is the only channel. Never open an issue or pull request describing a suspected vulnerability.

## Pull requests

Use the pull-request template: describe the change, list the verification commands you actually ran, and complete the checklist. Use synthetic test data only — no real QR payloads, credentials, or personal data. Contributions are licensed under AGPL-3.0-or-later like the rest of the original code. Community expectations are set by the [code of conduct](CODE_OF_CONDUCT.md).
