import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { releaseCandidateNames } from "./assemble-release-candidate.mjs";
import {
  assertCommit,
  assertReleaseVersion,
  collectRegularFiles,
  optionsFromArgs,
  sha256,
  sha256File,
  stableJson,
} from "./release-contract.mjs";

const execFileAsync = promisify(execFile);

export const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const CYCLONEDX_PREDICATE_TYPE = "https://cyclonedx.org/bom";

const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_SOURCE_REF = "refs/heads/main";
const MINIMUM_ATTESTATIONS = 2;
const GITHUB_RUN_INVOCATION_URI =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new Error("GitHub repository must be exactly owner/repository");
  }
  return repository;
}

function assertGitHubRunNumber(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive decimal integer`);
  }
  return value;
}

export function githubRunInvocationUri({ repository, runId, runAttempt }) {
  assertRepository(repository);
  assertGitHubRunNumber(runId, "GitHub run id");
  assertGitHubRunNumber(runAttempt, "GitHub run attempt");
  return `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
}

function executionStdout(result) {
  if (typeof result === "string") return result;
  if (isRecord(result) && typeof result.stdout === "string") return result.stdout;
  throw new Error("gh execution did not return UTF-8 stdout");
}

function executionFailure(error) {
  if (isRecord(error) && error.code === "ENOENT") {
    return "gh is not available on PATH";
  }
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim() !== "") {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function runGh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export function ghVerificationArguments({ artifact, repository, commit, predicateType }) {
  assertRepository(repository);
  assertCommit(commit);
  const certificateIdentity =
    `https://github.com/${repository}/.github/workflows/release.yml@${GITHUB_SOURCE_REF}`;
  return [
    "attestation",
    "verify",
    artifact,
    "--hostname",
    "github.com",
    "--repo",
    repository,
    "--cert-identity",
    certificateIdentity,
    "--signer-digest",
    commit,
    "--source-digest",
    commit,
    "--source-ref",
    GITHUB_SOURCE_REF,
    "--cert-oidc-issuer",
    GITHUB_OIDC_ISSUER,
    "--deny-self-hosted-runners",
    "--predicate-type",
    predicateType,
    "--limit",
    "100",
    "--format",
    "json",
  ];
}

export async function collectCandidateSubjects({ directory, version }) {
  assertReleaseVersion(version);
  const files = await collectRegularFiles(directory);
  const actualNames = files.map(({ relative }) => relative).sort();
  const expectedNames = releaseCandidateNames(version);
  if (actualNames.join("\0") !== expectedNames.join("\0")) {
    throw new Error(
      `attestation candidate file set differs from the locked contract: ${actualNames.join(", ")}`,
    );
  }

  return Promise.all(
    expectedNames.map(async (name) => ({
      name,
      digest: await sha256File(path.join(directory, name)),
    })),
  );
}

function assertExactSubjects(subjects, expectedSubjects, label) {
  if (!Array.isArray(subjects)) {
    throw new Error(`${label}: statement.subject must be an array`);
  }
  if (subjects.length !== expectedSubjects.length) {
    throw new Error(
      `${label}: subject set has ${subjects.length} entries, expected ${expectedSubjects.length}`,
    );
  }

  const expected = new Map(expectedSubjects.map(({ name, digest }) => [name, digest]));
  const present = new Set();
  for (const [index, subject] of subjects.entries()) {
    if (!isRecord(subject) || typeof subject.name !== "string" || !isRecord(subject.digest)) {
      throw new Error(`${label}: subject ${index + 1} is malformed`);
    }
    const digestKeys = Object.keys(subject.digest);
    const digest = subject.digest.sha256;
    if (
      digestKeys.length !== 1 ||
      digestKeys[0] !== "sha256" ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(digest)
    ) {
      throw new Error(`${label}: subject ${subject.name} must contain exactly one lowercase SHA-256`);
    }
    if (present.has(subject.name)) {
      throw new Error(`${label}: duplicate subject name ${subject.name}`);
    }
    present.add(subject.name);

    const expectedDigest = expected.get(subject.name);
    if (expectedDigest === undefined) {
      throw new Error(`${label}: unexpected subject ${subject.name}`);
    }
    if (digest !== expectedDigest) {
      throw new Error(
        `${label}: subject ${subject.name} has SHA-256 ${digest}, expected ${expectedDigest}`,
      );
    }
  }

  for (const name of expected.keys()) {
    if (!present.has(name)) throw new Error(`${label}: missing subject ${name}`);
  }
}

export function parseVerifiedAttestations({
  stdout,
  predicateType,
  expectedSubjects,
  expectedPredicate,
  expectedRunInvocationUri,
}) {
  if (
    typeof expectedRunInvocationUri !== "string" ||
    !GITHUB_RUN_INVOCATION_URI.test(expectedRunInvocationUri)
  ) {
    throw new Error("expected GitHub run invocation URI is malformed");
  }
  let results;
  try {
    results = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`gh returned malformed JSON for ${predicateType}`, { cause: error });
  }
  if (!Array.isArray(results)) {
    throw new Error(`gh JSON for ${predicateType} must be an array`);
  }

  const distinctBundles = new Set();
  for (const [index, result] of results.entries()) {
    const label = `${predicateType} attestation ${index + 1}`;
    if (!isRecord(result) || !isRecord(result.attestation) || !isRecord(result.verificationResult)) {
      throw new Error(`${label}: result is malformed`);
    }
    const signature = result.verificationResult.signature;
    if (!isRecord(signature) || !isRecord(signature.certificate)) {
      throw new Error(`${label}: verified certificate is missing`);
    }
    const runInvocationUri = signature.certificate.runInvocationURI;
    if (typeof runInvocationUri !== "string" || !GITHUB_RUN_INVOCATION_URI.test(runInvocationUri)) {
      throw new Error(`${label}: certificate run invocation URI is malformed`);
    }
    if (runInvocationUri !== expectedRunInvocationUri) continue;

    const statement = result.verificationResult.statement;
    if (!isRecord(statement)) throw new Error(`${label}: verified statement is missing`);
    const verifiedTimestamps = result.verificationResult.verifiedTimestamps;
    if (!Array.isArray(verifiedTimestamps) || verifiedTimestamps.length === 0) {
      throw new Error(`${label}: verified timestamps are missing`);
    }
    if (verifiedTimestamps.some((timestamp) => !isRecord(timestamp))) {
      throw new Error(`${label}: verified timestamps are malformed`);
    }
    if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
      throw new Error(`${label}: statement type is not ${IN_TOTO_STATEMENT_TYPE}`);
    }
    if (statement.predicateType !== predicateType) {
      throw new Error(`${label}: predicate type is ${String(statement.predicateType)}`);
    }
    assertExactSubjects(statement.subject, expectedSubjects, label);
    if (predicateType === CYCLONEDX_PREDICATE_TYPE) {
      if (expectedPredicate === undefined) {
        throw new Error(`${label}: expected local CycloneDX predicate is missing`);
      }
      if (stableJson(statement.predicate) !== stableJson(expectedPredicate)) {
        throw new Error(`${label}: signed CycloneDX predicate differs from the local SBOM`);
      }
    }
    distinctBundles.add(sha256(Buffer.from(stableJson(result.attestation), "utf8")));
  }

  if (distinctBundles.size < MINIMUM_ATTESTATIONS) {
    throw new Error(
      `${predicateType}: requires at least ${MINIMUM_ATTESTATIONS} distinct verified attestations; found ${distinctBundles.size}`,
    );
  }
  return distinctBundles.size;
}

export async function verifyReleaseAttestations({
  directory,
  version,
  commit,
  repository,
  runId,
  runAttempt,
  executeGh = runGh,
}) {
  assertReleaseVersion(version);
  assertCommit(commit);
  assertRepository(repository);
  const expectedRunInvocationUri = githubRunInvocationUri({ repository, runId, runAttempt });

  const expectedSubjects = await collectCandidateSubjects({ directory, version });
  const artifact = path.join(directory, `qrwarden-${version}-archive.sha256`);
  const sbomFile = path.join(directory, `qrwarden-${version}-sbom.cdx.json`);
  let expectedCycloneDx;
  try {
    expectedCycloneDx = JSON.parse(await readFile(sbomFile, "utf8"));
  } catch (error) {
    throw new Error("local CycloneDX SBOM is not valid JSON", { cause: error });
  }
  if (!isRecord(expectedCycloneDx)) {
    throw new Error("local CycloneDX SBOM must be a JSON object");
  }
  const verified = {};

  for (const predicateType of [PROVENANCE_PREDICATE_TYPE, CYCLONEDX_PREDICATE_TYPE]) {
    const args = ghVerificationArguments({ artifact, repository, commit, predicateType });
    let result;
    try {
      result = await executeGh(args);
    } catch (error) {
      throw new Error(
        `gh attestation verify failed for ${predicateType}: ${executionFailure(error)}`,
        { cause: error },
      );
    }
    const stdout = executionStdout(result);
    verified[predicateType] = parseVerifiedAttestations({
      stdout,
      predicateType,
      expectedSubjects,
      expectedPredicate:
        predicateType === CYCLONEDX_PREDICATE_TYPE ? expectedCycloneDx : undefined,
      expectedRunInvocationUri,
    });
  }

  return { subjects: expectedSubjects, verified };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const options = optionsFromArgs(
    process.argv.slice(2),
    new Set(["--artifacts", "--version", "--commit", "--run-id", "--run-attempt"]),
  );
  const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const constants = JSON.parse(await readFile(path.join(root, "release/constants.json"), "utf8"));
  const owner = constants.github?.owner;
  const name = constants.github?.repository;
  if (typeof owner !== "string" || typeof name !== "string") {
    throw new Error("release constants do not define the GitHub owner and repository");
  }
  const repository = assertRepository(`${owner}/${name}`);
  const version = assertReleaseVersion(options["--version"] ?? packageMetadata.version);
  const commit = assertCommit(
    options["--commit"] ?? process.env.QRWARDEN_COMMIT ?? process.env.GITHUB_SHA ?? "",
  );
  const runId = assertGitHubRunNumber(
    options["--run-id"] ?? process.env.GITHUB_RUN_ID ?? "",
    "GitHub run id",
  );
  const runAttempt = assertGitHubRunNumber(
    options["--run-attempt"] ?? process.env.GITHUB_RUN_ATTEMPT ?? "",
    "GitHub run attempt",
  );
  const directory = path.resolve(root, options["--artifacts"] ?? "release-output");

  const result = await verifyReleaseAttestations({
    directory,
    version,
    commit,
    repository,
    runId,
    runAttempt,
  });
  process.stdout.write(
    `verified ${result.verified[PROVENANCE_PREDICATE_TYPE]} provenance and ${result.verified[CYCLONEDX_PREDICATE_TYPE]} CycloneDX attestations over ${result.subjects.length} release artifacts\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `attestation verification: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
