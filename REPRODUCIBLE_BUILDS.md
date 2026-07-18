# Reproducible builds

Release builds use Node.js 24.18.0 and npm 11.16.0 inside `node:24.18.0-bookworm-slim` for `linux/amd64`, pinned to manifest digest `sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6`.

The exact signed release commit must be a clean, protected-main, signed 40-character commit. Version metadata, changelog, tag candidate, About metadata, manifest metadata, and release marker must agree. Each build sets:

```sh
SOURCE_DATE_EPOCH=<release commit committer timestamp>
TZ=UTC
LC_ALL=C
LANG=C
umask 022
npm ci --ignore-scripts=false --strict-allow-scripts --cache <empty-job-local-directory>
npm run build
```

The committed `.npmrc` defaults to `ignore-scripts=true` and `strict-allow-scripts=true`, so an unqualified install skips lifecycle scripts and any deliberate scripts-on override remains fail-closed. Release builds retain the explicit strict flag for review visibility, use npm 11.16.0's native exact `allowScripts` policy, and exercise approved, denied, and unreviewed synthetic hooks before installing the release graph.

Playwright browser executables downloaded by the browser-test job are test-runner inputs, not release inputs: they are never copied into `dist/`, the release archives, the SBOM, or the attested candidate. The exact `@playwright/test` pin selects the browser revisions, but those fetched executables remain outside the byte-reproducible release boundary.

Builds contain no current time, random identifier, locale ordering, host/user/runner name, temporary or absolute path, production source map, or environment noise. Content hashes and chunk order are deterministic. Generated SBOM, license report, changelog, archives, and manifests follow the normalized formats in `RELEASE.md`.

Run two builds in separate clean workspaces, containers, caches, and jobs. Require byte-identical dist trees and unsigned release artifacts. On mismatch, stop without signing or deployment and retain diffoscope diagnostics as private CI evidence.

`npm run verify:reproducible` is the fast local guard: it performs two complete production builds and byte-compares the closed dist trees. It does not replace the independent-workspace, independent-cache, digest-pinned container gate above.

Source archives contain exactly Git-tracked release files under `qrwarden-X.Y.Z/`. Dist archives contain exactly verified output under `qrwarden-X.Y.Z-dist/`. Both use bytewise order, UID/GID 0, empty owner/group, normalized modes, `SOURCE_DATE_EPOCH`, GNU tar behavior, and `gzip -n -9`; reject traversal, absolute paths, duplicates, normalization collisions, symlinks, hard links, and special files.
