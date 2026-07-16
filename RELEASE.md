# Release process

This checkout is not release-ready. Production, Cloudflare, maintainer, and signing constants and the well-known public key remain placeholders; rendered Wrangler configs, a signed clean `main` commit, final name-clearance evidence, physical-browser evidence, independent review, digest-pinned dual-build evidence, signing-ceremony evidence, and production-rehearsal evidence are absent. Analyzer data and local implementation gates are complete. `npm run release:validate` fails closed on the machine-checkable release inputs, and the manual gates above remain mandatory.

## Candidate gate

1. Require protected `main`, a clean signed commit, exact tool/action/container pins, matching version metadata, current PSL/IANA snapshots, reviewed Unicode data, passing CI/security/accessibility/browser/offline/no-egress gates, and successful `npm run release:validate`.
2. Build twice in isolated pinned environments and compare every unsigned byte. Verify decoder package integrity and the locked reader WASM SHA-256 `6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f`.
3. Produce the normalized source/dist archives, dist-files manifest, archive manifest, CycloneDX SBOM, license report, and version changelog. Verify the closed artifact contract, headers, MIME, cache, CSP, release marker, 2 MiB precache limit, and absence of source maps/absolute paths.
4. Create and verify GitHub build/SBOM attestations tied to exact digests and protected workflow identity. Attestations do not replace Minisign.
5. Follow `SIGNING.md` offline. Upload draft artifacts and signatures, read them back, and reverify before any deployment or publication.

The deterministic base set is `qrwarden-X.Y.Z-source.tar.gz`, `-dist.tar.gz`, `-dist-files.sha256`, `-archive.sha256`, `-sbom.cdx.json`, `-licenses.txt`, and `-changelog.md`. The source archive, dist archive, dist-files manifest, and archive manifest receive `.minisig` signatures. Transition/recovery releases add their deterministic statement and required signature set.

## Deployment state machine

Capture and byte-verify the single live 100-percent OLD version against the prior signed release (or v1 bootstrap baseline). Upload only a safely extracted, remanifested copy of the signed dist archive with repository-local Wrangler 4.111.0; capture exactly one NEW version ID and preview URL. Open the Access-protected preview window, create an explicit OLD 100% / NEW 0% deployment, and smoke-test NEW only through the exact version override.

Recheck OLD immediately before promotion. Promote NEW atomically to 100%, poll until exact, and run fresh-profile, installed/offline, live header/body, zero-egress, and update tests. On failure within the controlled window, roll back only to the still-independently-verified OLD. Always remove overrides, preview access, service-token activity, and preview URLs; arm and test the watchdog. A service worker already received by clients requires a forward corrective release even after infrastructure rollback.

Only after live verification succeeds should maintainers publish the immutable GitHub release and tag. Existing releases, assets, signatures, and tags are never replaced or deleted. Store operational version/deployment/Access IDs outside deterministic artifacts and update the rollback target.

## Stable v1 gate

Stable v1 additionally requires name and domain clearance, independent security review, physical current and previous platform testing with exact builds, reproducibility proof, signing ceremony, rollback and watchdog drills, permission and lifecycle tests, a 20-minute camera soak, 100 sequential image scans, and all documented acceptance gates on the exact signed candidate.
