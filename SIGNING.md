# Release signing

QRWarden uses Minisign 0.12. Its macOS zip SHA-256 is `89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63`; its Linux tarball SHA-256 is `9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73`. Verify the selected archive hash and upstream signature before use.

## Verify the release tool

Download only the exact 0.12 archive and adjacent `.minisig` file from the upstream release:

- [minisign-0.12-macos.zip](https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-macos.zip) and its [signature](https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-macos.zip.minisig)
- [minisign-0.12-linux.tar.gz](https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz) and its [signature](https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz.minisig)

The upstream 0.12 README pins this release-verification public key:

```text
untrusted comment: Minisign 0.12 release verification key
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
```

Compare the archive SHA-256 with the value above, then use a previously trusted Minisign installation or an independent compatible verifier—not the unverified archive itself—to verify the adjacent signature:

```sh
minisign -Vm minisign-0.12-macos.zip -p minisign-upstream.pub
minisign -Vm minisign-0.12-linux.tar.gz -p minisign-upstream.pub
```

## Key custody

- Generate the release key on an offline machine.
- Protect the secret key with an interactively entered passphrase. Never use `-W` or no-password mode.
- Never attach primary-key media to a networked development or CI machine.
- Keep one encrypted offline backup on separately stored media.
- Require two people to check artifact identity, version, commit, hashes, command lines, and outputs.
- Verify every signature in a second clean offline environment before it leaves custody.

The fingerprint is lowercase SHA-256 of the canonical base64-decoded Minisign public-key material line: the complete 42-byte blob containing algorithm identifier, key ID, and Ed25519 public key. Comment lines do not participate. The repository, About view, well-known public key, and DNSSEC TXT record must agree.

At steady state, publish exactly one TXT value at `_qrwarden-release-key.<canonical-domain>`. After DNS TXT-string concatenation, its value is exactly the 64-character lowercase hexadecimal fingerprint: no label, algorithm prefix, whitespace, quotes in the logical value, or public-key material. The zone must validate with DNSSEC. During a planned rotation, the RRset contains exactly the predecessor and successor fingerprints for the documented 30-day overlap; after the overlap, remove only the predecessor value.

## Signature contract

Use untrusted comment `QRWarden release signature` and trusted comment:

```text
QRWarden vX.Y.Z commit <40hex> file <basename> sha256 <64hex>
```

Sign any required transition/recovery statement first, then the source archive, dist archive, dist-files manifest, and archive manifest. Detached signatures append `.minisig`. The repository does not yet ship an automated signed-set finalizer. For an ordinary release, a separate verifier must manually check every required filename, commit, digest, trusted comment, public key, signature, and set member before upload, then repeat that verification against the downloaded draft assets before deployment or publication.

## Rotation and recovery

The closed `release/key-transition-input.schema.json` and recovery schema define operator inputs, and `scripts/release/validate-key-input.mjs` validates those inputs. Deterministic statement generation, frozen-commit injection, candidate assembly, and complete transition/recovery signature-set verification are not implemented yet, so those release paths are not operationally ready.

Before a planned major-version rotation, implement and review the missing path for the deterministic statement, dual DNS values for 30 days, and predecessor/successor signatures. Before emergency recovery, implement and review the parallel path for an independently established last-trusted release, successor-only signatures, a permanent incident advisory, DNSSEC replacement, and approval by at least two hardware-backed GitHub maintainers. Never cross-sign with a compromised key or mutate an existing release.
