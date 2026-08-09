import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { releaseCandidateNames } from "../../scripts/release/assemble-release-candidate.mjs";
import {
  CYCLONEDX_PREDICATE_TYPE,
  PROVENANCE_PREDICATE_TYPE,
  verifyReleaseAttestations,
} from "../../scripts/release/verify-attestations.mjs";

const version = "0.1.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const repository = "iAnonymous3000/qrwarden";
const runId = "123456789";
const runAttempt = "2";
const runInvocationURI =
  `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
const directories: string[] = [];
type Subject = { name: string; digest: { sha256: string } };
const sbomPredicate = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  components: [],
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function candidate(): Promise<{
  directory: string;
  subjects: Subject[];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-attestations-"));
  directories.push(directory);
  const subjects = [];
  for (const name of releaseCandidateNames(version) as string[]) {
    const bytes = Buffer.from(
      name === `qrwarden-${version}-sbom.cdx.json`
        ? `${JSON.stringify(sbomPredicate, null, 2)}\n`
        : `contents of ${name}\n`,
    );
    await writeFile(path.join(directory, name), bytes);
    subjects.push({ name, digest: { sha256: sha256(bytes) } });
  }
  return { directory, subjects };
}

function verifiedResult(
  predicateType: string,
  identifier: string,
  subjects: Subject[],
  overrides: {
    certificate?: unknown;
    predicate?: unknown;
    verifiedTimestamps?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    attestation: { bundle: identifier },
    verificationResult: {
      signature: {
        certificate: overrides.certificate ?? { runInvocationURI },
      },
      verifiedTimestamps: overrides.verifiedTimestamps ?? [{ type: "transparency-log" }],
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType,
        subject: subjects,
        predicate:
          overrides.predicate ??
          (predicateType === CYCLONEDX_PREDICATE_TYPE ? sbomPredicate : {}),
      },
    },
  };
}

function successfulExecutor(
  subjects: Subject[],
  calls: string[][] = [],
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    calls.push(args);
    const predicateIndex = args.indexOf("--predicate-type");
    const predicate = args[predicateIndex + 1];
    if (predicate === undefined) throw new Error("missing predicate argument");
    return JSON.stringify([
      verifiedResult(predicate, `${predicate}:first`, subjects),
      verifiedResult(predicate, `${predicate}:second`, subjects),
    ]);
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("release attestations", () => {
  it("verifies two distinct provenance and CycloneDX attestations over the exact candidate", async () => {
    const { directory, subjects } = await candidate();
    const calls: string[][] = [];

    const result = await verifyReleaseAttestations({
      directory,
      version,
      commit,
      repository,
      runId,
      runAttempt,
      executeGh: successfulExecutor(subjects, calls),
    });

    expect(result.subjects.map(({ name }: { name: string }) => name)).toEqual(
      releaseCandidateNames(version),
    );
    expect(result.verified).toEqual({
      [PROVENANCE_PREDICATE_TYPE]: 2,
      [CYCLONEDX_PREDICATE_TYPE]: 2,
    });
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((args) => valueAfter(args, "--predicate-type")))).toEqual(
      new Set([PROVENANCE_PREDICATE_TYPE, CYCLONEDX_PREDICATE_TYPE]),
    );
    for (const args of calls) {
      expect(args.slice(0, 3)).toEqual([
        "attestation",
        "verify",
        path.join(directory, `qrwarden-${version}-archive.sha256`),
      ]);
      expect(valueAfter(args, "--hostname")).toBe("github.com");
      expect(valueAfter(args, "--repo")).toBe(repository);
      expect(valueAfter(args, "--cert-identity")).toBe(
        `https://github.com/${repository}/.github/workflows/release.yml@refs/heads/main`,
      );
      expect(args).not.toContain("--signer-workflow");
      expect(valueAfter(args, "--signer-digest")).toBe(commit);
      expect(valueAfter(args, "--source-digest")).toBe(commit);
      expect(valueAfter(args, "--source-ref")).toBe("refs/heads/main");
      expect(valueAfter(args, "--cert-oidc-issuer")).toBe(
        "https://token.actions.githubusercontent.com",
      );
      expect(args).toContain("--deny-self-hosted-runners");
      expect(valueAfter(args, "--format")).toBe("json");
    }
  });

  it("fails closed when gh is missing", async () => {
    const { directory } = await candidate();
    const missingGh = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => {
          throw missingGh;
        },
      }),
    ).rejects.toThrow("gh is not available on PATH");
  });

  it("fails closed on malformed gh output", async () => {
    const { directory } = await candidate();
    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => "not JSON",
      }),
    ).rejects.toThrow("gh returned malformed JSON");
  });

  it("requires at least two distinct attestations for each predicate", async () => {
    const { directory, subjects } = await candidate();
    const duplicate = verifiedResult(PROVENANCE_PREDICATE_TYPE, "same-bundle", subjects);

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => JSON.stringify([duplicate, duplicate]),
      }),
    ).rejects.toThrow("requires at least 2 distinct verified attestations; found 1");
  });

  const subjectMutations: Array<[string, (subjects: Subject[]) => Subject[]]> = [
    ["a partial subject set", (subjects) => subjects.slice(1)],
    [
      "a wrong subject digest",
      (subjects) => {
        const [first, ...rest] = subjects;
        if (first === undefined) return [];
        return [{ ...first, digest: { sha256: "f".repeat(64) } }, ...rest];
      },
    ],
  ];

  it.each(subjectMutations)("rejects %s", async (_label, mutate) => {
    const { directory, subjects } = await candidate();
    const wrong = mutate(subjects);

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async (args: string[]) => {
          const predicate = valueAfter(args, "--predicate-type") ?? "";
          return JSON.stringify([
            verifiedResult(predicate, "first", wrong),
            verifiedResult(predicate, "second", wrong),
          ]);
        },
      }),
    ).rejects.toThrow(/subject set has|has SHA-256/u);
  });

  it("rejects a CycloneDX predicate that differs from the local SBOM", async () => {
    const { directory, subjects } = await candidate();

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async (args: string[]) => {
          const predicate = valueAfter(args, "--predicate-type") ?? "";
          return JSON.stringify([
            verifiedResult(predicate, "first", subjects, {
              predicate: predicate === CYCLONEDX_PREDICATE_TYPE ? { ...sbomPredicate, version: 2 } : {},
            }),
            verifiedResult(predicate, "second", subjects, {
              predicate: predicate === CYCLONEDX_PREDICATE_TYPE ? { ...sbomPredicate, version: 2 } : {},
            }),
          ]);
        },
      }),
    ).rejects.toThrow("signed CycloneDX predicate differs from the local SBOM");
  });

  it("requires nonempty cryptographically verified timestamps", async () => {
    const { directory, subjects } = await candidate();

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => JSON.stringify([
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "first", subjects, {
            verifiedTimestamps: [],
          }),
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "second", subjects),
        ]),
      }),
    ).rejects.toThrow("verified timestamps are missing");
  });

  it.each([
    ["a missing run invocation URI", {}],
    ["a malformed run invocation URI", { runInvocationURI: "not-a-github-run" }],
  ])("rejects %s in the verified certificate", async (_label, certificate) => {
    const { directory, subjects } = await candidate();

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => JSON.stringify([
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "first", subjects, { certificate }),
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "second", subjects),
        ]),
      }),
    ).rejects.toThrow("certificate run invocation URI");
  });

  it("ignores historical attestations and counts two from the exact current invocation", async () => {
    const { directory, subjects } = await candidate();
    const historicalRunInvocationURI =
      `https://github.com/${repository}/actions/runs/987654321/attempts/1`;

    const result = await verifyReleaseAttestations({
      directory,
      version,
      commit,
      repository,
      runId,
      runAttempt,
      executeGh: async (args: string[]) => {
        const predicate = valueAfter(args, "--predicate-type") ?? "";
        return JSON.stringify([
          verifiedResult(predicate, "historical", subjects.slice(0, -1), {
            certificate: { runInvocationURI: historicalRunInvocationURI },
          }),
          verifiedResult(predicate, "current-first", subjects),
          verifiedResult(predicate, "current-second", subjects),
        ]);
      },
    });

    expect(result.verified).toEqual({
      [PROVENANCE_PREDICATE_TYPE]: 2,
      [CYCLONEDX_PREDICATE_TYPE]: 2,
    });
  });

  it("rejects historical attestations plus only one from the current invocation", async () => {
    const { directory, subjects } = await candidate();
    const historicalRunInvocationURI =
      `https://github.com/${repository}/actions/runs/${runId}/attempts/1`;

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh: async () => JSON.stringify([
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "historical", subjects, {
            certificate: { runInvocationURI: historicalRunInvocationURI },
          }),
          verifiedResult(PROVENANCE_PREDICATE_TYPE, "current", subjects),
        ]),
      }),
    ).rejects.toThrow("requires at least 2 distinct verified attestations; found 1");
  });

  it.each([
    ["run id", "", runAttempt],
    ["run attempt", runId, "0"],
  ])("requires an explicit positive GitHub %s", async (_label, candidateRunId, candidateRunAttempt) => {
    const { directory } = await candidate();
    let calls = 0;

    await expect(
      verifyReleaseAttestations({
        directory,
        version,
        commit,
        repository,
        runId: candidateRunId,
        runAttempt: candidateRunAttempt,
        executeGh: async () => {
          calls += 1;
          return "[]";
        },
      }),
    ).rejects.toThrow("must be a positive decimal integer");
    expect(calls).toBe(0);
  });

  it("rejects incomplete or expanded local candidate directories before invoking gh", async () => {
    const missing = await candidate();
    await rm(path.join(missing.directory, releaseCandidateNames(version)[0]));
    let calls = 0;
    const executeGh = async (): Promise<string> => {
      calls += 1;
      return "[]";
    };

    await expect(
      verifyReleaseAttestations({
        directory: missing.directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh,
      }),
    ).rejects.toThrow("candidate file set differs from the locked contract");
    expect(calls).toBe(0);

    const expanded = await candidate();
    await writeFile(path.join(expanded.directory, "unexpected.txt"), "unexpected\n");
    await expect(
      verifyReleaseAttestations({
        directory: expanded.directory,
        version,
        commit,
        repository,
        runId,
        runAttempt,
        executeGh,
      }),
    ).rejects.toThrow("candidate file set differs from the locked contract");
    expect(calls).toBe(0);
  });
});
