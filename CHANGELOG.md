# Changelog

All notable changes to QRWarden are documented here. Release headings use exact semantic versions and must agree with `package.json`, the tag, release marker, and signed artifacts.

## [0.1.0] - Unreleased

### Added

- Repository and exact-pinned toolchain, with privacy, threat-model, release, signing, manifest, and machine-readable release contracts.
- Disposable same-origin decoder worker with pinned ZXing WASM, bounded image parsing/rasterization, ECI handling, QR-only limits, and multi-code selection data.
- Pure offline analyzer with inert display fields, explicit action policies, URL/host/IDN/control-character signals, and machine-readable data-provenance status.
- Camera lifecycle, exact two-frame matching, local image intake, stale-work invalidation, and report-lifetime controls.
- Preact interface with accessible review states, sensitive-value reveal controls, trusted clipboard writes, and object-bound two-step navigation.
- Integrity-checked precache generation, install-time cache validation, coordinated update state, strict deployment headers, and a closed production artifact set.
- Unit and browser suites covering analyzer behavior, decoder core/header checks, state lifetimes, camera matching, production response contracts, offline startup, and real QR review flows.
- Supported `typescript@6.0.3` pin for `typescript-eslint@8.64.0`, with legacy peer resolution removed.
- Synchronous selection-preview ownership, background canvas disposal, exact update-idle accounting, best-effort post-activation notification, and positional selection labels.
- Hash-pinned complete PSL, IANA, and Unicode 17 generation with non-mutating drift checks, official normalization/IDNA conformance corpora, and UTS 39 security-profile coverage.
- Exact-purl license overrides for published packages without eligible root texts, optional-platform lockfile validation, and Unicode License v3 inclusion in deterministic release reports.
- SHA-pinned CI and a protected, dual-build unsigned-candidate workflow with normalized artifact generators, CycloneDX/license contracts, attestations, and bytewise final comparison.
- Expanded image-header/intake, camera lifecycle, report/work/clipboard, copy-contract, adversarial corpus, Trusted Types, mutation, no-egress, permissions, and release-contract tests.
- Cloudflare release operations runbook with rendered upload/trigger Wrangler configs, live byte/header verification, and rollback contracts.
- Dark-first adaptive appearance with an accessible persistent light/dark control and matching browser, PWA, and privacy metadata.
- Dedicated Pixel, narrow-Android, 280px-reflow, and iPhone browser projects covering touch targets, responsive review flows, dialogs, multi-code selection, and short-landscape camera use.
- Micro QR, rMQR, Data Matrix, and Aztec decoding behind per-symbology canonical-verification profiles with reader-verified identifiers, version allowlists, and generated corpus fixtures.
- A pinned link-shortener signal that flags redirect services as hidden destinations, with corpus and analyzer coverage.
- Web Share Target intake for installed instances: a shared image is handed to the redirected document as an in-memory message, is never written to storage, and re-enters the standard bounded image pipeline.
- Paste-from-clipboard image intake on the home view, haptic acknowledgment on camera detections, and a user-initiated plain-text report copy that always excludes sensitive values.
- An offline signal glossary view plus per-signal "What this means" explainers, exhaustively typed against the analyzer signal codes.
- Locale-negotiated Spanish interface copy behind a typed dictionary contract, with hash-pinned copy sources for both languages and a Spanish end-to-end browser flow.
- Brave-on-iOS camera guidance driven by the injected `navigator.brave` marker, and a browser regression suite for Brave-style instrumentation, missing service workers, and denied registrations.

### Changed

- Positioned the repository as production-grade pre-action QR inspection source while keeping signed public-release gates fail closed until operator, domain, signing, deployment, and live-verification facts are configured.
- Every structured payload report now preserves the exact decoded QR content as masked, collapsed, inert evidence when its parsed summary is selective.
- Mobile camera previews show the complete decoded frame instead of a visually cropped region, respect display cutouts and dynamic viewport height, and reset new workflows to the top of the view.
- Result and recovery language now distinguishes evidence, review cues, and genuine failures; reviewed URL destinations show their scheme, host, and explicit port consistently.
- View changes hand keyboard focus to the new heading, system appearance can be restored after an override, and technical release data stays available without dominating the About page.
- Scan actions remain visible on short phones, use recognizable high-contrast-safe icons, and provide hover and pressed feedback on pointer devices.
- Camera-permission recovery now gives an actionable iPhone and iPad settings path and offers image selection directly from camera failure cards.
- Camera and service-worker startup waits are bounded; camera failures can be retried directly, while unverifiable controlled releases stop with an explicit reload action instead of polling forever.

### Fixed

- Camera startup no longer stalls when orientation changes before metadata is ready, and stale overlapping camera switches cannot tear down the newest stream.
- Camera controls now identify the active track rather than assuming enumeration order, and iOS camera selectors avoid focus zoom.
- The locked application shell renders immediately while service-worker verification is pending instead of leaving slow mobile launches blank.
- Result-status symbols remain circular beside long headings, 280px cover-width viewports no longer pan horizontally, and multi-code rows reflow below 320px.
- Browser chrome now receives a first-paint theme color that matches the system preference and the app's dark header palette.
- Stale camera work, consumed multi-code previews, failed canvas draws, and deferred service-worker updates now recover without poisoning the next interaction or presenting a blank surface.
- The page behind an open confirmation dialog can no longer scroll on touch devices, and dialog overscroll is contained.
