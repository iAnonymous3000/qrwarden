import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ordinaryArtifactNames } from "../../scripts/release/generate-archive-manifest.mjs";
import { renderHashManifest } from "../../scripts/release/release-contract.mjs";
import {
  parseSignature,
  signedArtifactNames,
  bareMinisignKey,
  verifySignedSet,
} from "../../scripts/release/verify-signed-set.mjs";

const version = "0.1.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const publicKey = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function signature(file: string, digest: string, overrides: Partial<Record<"comment", string>> = {}): string {
  const trusted =
    overrides.comment ??
    `QRWarden v${version} commit ${commit} file ${file} sha256 ${digest}`;
  return [
    "untrusted comment: QRWarden release signature",
    "RWQf6LRCGA9i5ZJhc2lnbmF0dXJl",
    `trusted comment: ${trusted}`,
    "Z2xvYmFsc2lnbmF0dXJl",
    "",
  ].join("\n");
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Builds a complete, internally consistent candidate directory. */
async function candidate(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-signed-set-"));
  directories.push(directory);
  const ordinary = ordinaryArtifactNames(version);
  const manifestName = `qrwarden-${version}-archive.sha256`;

  const covered: { name: string; digest: string }[] = [];
  for (const name of ordinary) {
    const bytes = Buffer.from(`contents of ${name}\n`);
    await writeFile(path.join(directory, name), bytes);
    covered.push({ name, digest: sha256(bytes) });
  }
  // The archive manifest is what transitively covers the unsigned artifacts,
  // so the fixture has to be a real manifest over real bytes.
  const manifest = Buffer.from(renderHashManifest(covered));
  await writeFile(path.join(directory, manifestName), manifest);

  const signed = new Set(signedArtifactNames(version));
  for (const { name, digest } of [...covered, { name: manifestName, digest: sha256(manifest) }]) {
    if (!signed.has(name)) continue;
    await writeFile(path.join(directory, `${name}.minisig`), signature(name, digest));
  }
  return directory;
}

// minisign is not installed in the test environment, and installing it is a
// ceremony step rather than a test dependency, so these exercise every
// structural check the verifier makes around the cryptographic one.
const options = { version, commit, publicKey, verifySignatures: false } as const;

describe("signed release set", () => {
  it("accepts a complete, internally consistent signed set", async () => {
    expect(await verifySignedSet({ directory: await candidate(), ...options })).toEqual([]);
  });

  it("rejects a swapped artifact whose signature still names the old digest", async () => {
    const directory = await candidate();
    const target = `qrwarden-${version}-dist.tar.gz`;
    await writeFile(path.join(directory, target), Buffer.from("substituted payload\n"));

    expect(await verifySignedSet({ directory, ...options })).toContainEqual(
      expect.stringContaining("does not match the artifact's sha256"),
    );
  });

  it("rejects a signature carried over from another release or commit", async () => {
    const directory = await candidate();
    const target = `qrwarden-${version}-source.tar.gz`;
    const digest = createHash("sha256")
      .update(Buffer.from(`contents of ${target}\n`))
      .digest("hex");
    await writeFile(
      path.join(directory, `${target}.minisig`),
      signature(target, digest, {
        comment: `QRWarden v${version} commit ${"f".repeat(40)} file ${target} sha256 ${digest}`,
      }),
    );

    expect(await verifySignedSet({ directory, ...options })).toContainEqual(
      expect.stringContaining("trusted comment names commit"),
    );
  });

  it("rejects a signature that names a different file than it signs", async () => {
    const directory = await candidate();
    const target = `qrwarden-${version}-dist-files.sha256`;
    const digest = createHash("sha256")
      .update(Buffer.from(`contents of ${target}\n`))
      .digest("hex");
    await writeFile(
      path.join(directory, `${target}.minisig`),
      signature(`qrwarden-${version}-licenses.txt`, digest),
    );

    expect(await verifySignedSet({ directory, ...options })).toContainEqual(
      expect.stringContaining("trusted comment names file"),
    );
  });

  it("rejects an incomplete set and an unexpected extra signature", async () => {
    const directory = await candidate();
    await rm(path.join(directory, `qrwarden-${version}-archive.sha256.minisig`));
    await writeFile(
      path.join(directory, `qrwarden-${version}-licenses.txt.minisig`),
      signature(`qrwarden-${version}-licenses.txt`, "0".repeat(64)),
    );

    const errors = await verifySignedSet({ directory, ...options });
    expect(errors).toContainEqual(expect.stringContaining("missing signature"));
    expect(errors).toContainEqual(expect.stringContaining("unexpected signature not in the signed set"));
  });

  it("rejects a swapped artifact that carries no signature of its own", async () => {
    // The SBOM, the license report and the changelog are unsigned; only the
    // signed archive manifest's digests stand between them and substitution.
    for (const name of [
      `qrwarden-${version}-sbom.cdx.json`,
      `qrwarden-${version}-licenses.txt`,
      `qrwarden-${version}-changelog.md`,
    ]) {
      const directory = await candidate();
      await writeFile(path.join(directory, name), Buffer.from("substituted\n"));

      expect(await verifySignedSet({ directory, ...options })).toContainEqual(
        expect.stringContaining(`lists ${name} as`),
      );
    }
  });

  it("rejects an archive manifest that does not cover every required artifact", async () => {
    const directory = await candidate();
    const manifestName = `qrwarden-${version}-archive.sha256`;
    const dropped = `qrwarden-${version}-licenses.txt`;
    const kept = (ordinaryArtifactNames(version) as string[])
      .filter((name: string) => name !== dropped)
      .map((name: string) => ({
        name,
        digest: sha256(Buffer.from(`contents of ${name}\n`)),
      }));
    await writeFile(path.join(directory, manifestName), renderHashManifest(kept));

    expect(await verifySignedSet({ directory, ...options })).toContainEqual(
      expect.stringContaining(`does not cover required artifact ${dropped}`),
    );
  });

  it("rejects a candidate missing an unsigned but required artifact", async () => {
    const directory = await candidate();
    await rm(path.join(directory, `qrwarden-${version}-sbom.cdx.json`));

    expect(await verifySignedSet({ directory, ...options })).toContainEqual(
      expect.stringContaining("missing release artifact"),
    );
  });

  it("requires minisign before it will report a set as verified", async () => {
    const directory = await candidate();
    const errors = await verifySignedSet({ directory, version, commit, publicKey });
    // The environment has no minisign, so the verifier must refuse rather than
    // silently downgrade to structural checks only.
    expect(errors).toContainEqual(expect.stringContaining("minisign is not available"));
  });

  it("rejects a malformed or re-commented signature file", async () => {
    expect(parseSignature("untrusted comment: x\nsig\n", "a.minisig").errors).toContainEqual(
      expect.stringContaining("expected exactly four lines"),
    );
    const wrongUntrusted = parseSignature(
      [
        "untrusted comment: signed by someone else",
        "c2ln",
        `trusted comment: QRWarden v${version} commit ${commit} file a sha256 ${"0".repeat(64)}`,
        "Z2xvYmFs",
        "",
      ].join("\n"),
      "a.minisig",
    );
    expect(wrongUntrusted.errors).toContainEqual(
      expect.stringContaining("untrusted comment must be exactly"),
    );
    expect(
      parseSignature(
        [
          "untrusted comment: QRWarden release signature",
          "c2ln",
          "trusted comment: release 0.1.0",
          "Z2xvYmFs",
          "",
        ].join("\n"),
        "a.minisig",
      ).errors,
    ).toContainEqual(expect.stringContaining("does not match the signature contract"));
  });
});

describe("minisign public-key argument", () => {
  const key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

  it("strips the untrusted comment line the constants file carries", () => {
    // release/constants.json holds the public-key FILE body, comment included:
    // validate-release-constants.mjs tolerates the comment line and
    // validate-release-readiness.mjs byte-matches it against
    // .well-known/qrwarden-release-key.pub. `minisign -P` takes a bare key.
    expect(
      bareMinisignKey(`untrusted comment: QRWarden release key\n${key}\n`),
    ).toBe(key);
    expect(bareMinisignKey(`untrusted comment: x\r\n${key}\r\n`)).toBe(key);
  });

  it("passes a bare key through unchanged", () => {
    expect(bareMinisignKey(key)).toBe(key);
    expect(bareMinisignKey(`${key}\n`)).toBe(key);
  });
});
