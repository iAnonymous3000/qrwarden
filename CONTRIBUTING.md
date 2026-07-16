# Contributing

Contribution intake is not open yet. It opens after the repository publishes a real maintainer roster and private conduct-reporting route, activates the documented branch rules, and selects a DCO check. Until then, the public source is available for review, but unsolicited pull requests may be closed without review.

When intake opens, contributions must preserve QRWarden's local-first privacy and non-verdict product contract.

## Workflow

1. Open an issue for architecture, security-contract, dependency, data, copy, or release-process changes before implementation.
2. Use Node.js 24.18.0 and npm 11.16.0. Plain npm installs skip lifecycle scripts under the committed `.npmrc`; use the reviewed installation path `npm ci --ignore-scripts=false --strict-allow-scripts`, which enables only explicitly approved exact-package hooks.
3. Keep security-sensitive modules pure and typed. UI code must not decode text, classify payloads, construct destination URLs, or introduce live payload-derived attributes.
4. Add focused tests and update the threat model, frozen snapshots, provenance, notices, and release fixtures affected by the change.
5. Run `npm run validate`, `npm run build`, and relevant browser tests.
6. Keep commits reviewable and include a Developer Certificate of Origin sign-off.

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s` to add the line. By signing off, you certify [DCO.txt](DCO.txt). Original code and documentation contributed to QRWarden are submitted under AGPL-3.0-or-later unless a reviewed file-level notice says otherwise. Vendored packages and analyzer-data updates retain their upstream licenses; preserve their notices, source identity, hashes, and provenance. Do not contribute material you lack the right to submit under the license that applies to it.

## Security and privacy changes

Do not weaken egress, CSP, Trusted Types, inert rendering, explicit actions, bounded decoding, lifecycle teardown, offline integrity, artifact closure, signing, or reproducibility without a reviewed contract change. Never put real sensitive QR payloads, credentials, private reports, or production secrets in issues, fixtures, commits, or logs. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md).

Dependency upgrades must be isolated reviewed pull requests that update the exact pin, lockfile, provenance, licenses/notices, SBOM fixtures, decoder hashes when applicable, security review, and reproducibility snapshot together.
