import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ACTIONS = Object.freeze({
  checkout: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  attest: "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
});
export const RELEASE_IMAGE = "node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6";

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

export function validateActionPins(text, label = "workflow") {
  const errors = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!/^\s*-?\s*uses:/u.test(line)) continue;
    const match = /^\s*-?\s*uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#.*)?$/u.exec(line);
    if (match === null) {
      errors.push(`${label}:${index + 1} action reference cannot be parsed safely`);
      continue;
    }
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference.startsWith("./")) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*@[0-9a-f]{40}$/u.test(reference) &&
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(reference)) {
      errors.push(`${label}:${index + 1} action reference is not a full commit SHA: ${reference}`);
    }
  }
  return errors;
}

export function validateReleaseWorkflow(text) {
  const errors = [...validateActionPins(text, "release.yml")];
  const requireText = (fragment, message) => {
    if (!text.includes(fragment)) errors.push(message);
  };
  requireText("workflow_dispatch:", "release workflow must be manually dispatched");
  if (/^\s+(?:push|pull_request|schedule):/mu.test(text)) {
    errors.push("release workflow must not run from push, pull_request, or schedule");
  }
  requireText("group: qrwarden-production-release", "release concurrency group is missing");
  requireText("cancel-in-progress: false", "release concurrency must never cancel an in-progress candidate");
  if (occurrences(text, "environment: production-release") !== 1) {
    errors.push("release preflight must enter the protected production-release environment exactly once");
  }
  requireText("replica: [first, second]", "release build must have exactly two named replicas");
  if (occurrences(text, `image: ${RELEASE_IMAGE}`) !== 3) {
    errors.push("all three release jobs must use the locked release image digest");
  }
  if (occurrences(text, "options: --platform linux/amd64") !== 3) {
    errors.push("all three release jobs must force linux/amd64");
  }
  if (occurrences(text, "git=1:2.39.5-0+deb12u3") !== 3) {
    errors.push("all three release jobs must install the exact source-archive Git tool");
  }
  requireText("snapshot.debian.org/archive/debian/20260713T000000Z", "Git must come from the timestamp-pinned Debian snapshot");
  requireText("GITHUB_REF_PROTECTED", "release preflight must enforce protected main");
  requireText("scripts/release/verify-release-context.mjs", "release GitHub context verification is missing");
  requireText("node scripts/validate-release-constants.mjs --release", "release constants gate is missing");
  requireText("node scripts/validate-release-readiness.mjs", "internal release readiness gate is missing");
  if (
    text.includes("verify-local-release-commit.mjs") ||
    text.includes("git verify-commit") ||
    text.includes("release:validate")
  ) {
    errors.push("release workflow must rely on GitHub signature preflight without a local keyring");
  }
  requireText("npm run release:wrangler:check", "committed Wrangler configuration gate is missing");
  requireText(
    "npm ci --ignore-scripts=false --strict-allow-scripts",
    "independent builds must explicitly enable reviewed scripts and fail on unreviewed scripts",
  );
  requireText("scripts/release/assemble-release-candidate.mjs", "locked release artifact assembly is missing");
  requireText("SOURCE_DATE_EPOCH", "release build must derive SOURCE_DATE_EPOCH");
  requireText("NPM_CONFIG_CACHE: /tmp/qrwarden-npm-cache", "release build must use an isolated npm cache");
  if (occurrences(text, `uses: ${ACTIONS.attest}`) !== 2) {
    errors.push("each replica must create exactly one provenance and one SBOM attestation");
  }
  requireText("sbom-path:", "CycloneDX SBOM attestation is missing");
  requireText("attestations: write", "attestation permission is missing");
  requireText("id-token: write", "OIDC permission is missing");
  requireText("name: unsigned-release-${{ matrix.replica }}", "replica artifacts must have distinct names");
  requireText("name: unsigned-release-first", "finalization must download the first replica");
  requireText("name: unsigned-release-second", "finalization must download the second replica");
  requireText("path: candidates/first", "first replica must download to an isolated directory");
  requireText("path: candidates/second", "second replica must download to an isolated directory");
  requireText("digest-mismatch: error", "workflow artifact download must reject digest mismatch");
  requireText("scripts/release/compare-release-candidates.mjs", "bytewise candidate comparison is missing");
  requireText("name: approved-unsigned-release", "approved unsigned candidate upload is missing");
  requireText("if-no-files-found: error", "workflow artifact uploads must fail when files are missing");
  return errors;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workflowDirectory = path.join(root, ".github/workflows");
  const names = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name)).sort();
  const errors = [];
  for (const name of names) {
    const text = await readFile(path.join(workflowDirectory, name), "utf8");
    errors.push(...validateActionPins(text, name));
    if (name === "release.yml") errors.push(...validateReleaseWorkflow(text).filter((error) => !errors.includes(error)));
  }
  if (!names.includes("release.yml")) errors.push("release.yml is missing");
  if (errors.length > 0) {
    errors.forEach((error) => process.stderr.write(`workflow validation: ${error}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write(`validated ${names.length} SHA-pinned workflows and the release invariants\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
