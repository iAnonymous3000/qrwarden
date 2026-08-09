import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ACTIONS = Object.freeze({
  checkout: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  attest: "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
});

const ALLOWED_ACTIONS = Object.freeze(new Set(Object.values(ACTIONS)));
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
      continue;
    }
    // A well-formed SHA only proves the reference is immutable, not that it is
    // one of ours: any owner/repo pinned to any forty hex characters satisfies
    // the shape. Every third-party action must be a reviewed member of
    // ACTIONS, so adding or re-pinning one is a deliberate, visible edit here
    // rather than a silent change inside a workflow file.
    if (!ALLOWED_ACTIONS.has(reference)) {
      errors.push(
        `${label}:${index + 1} action is not in the reviewed allowlist: ${reference}`,
      );
    }
  }
  return errors;
}

export function validateInstallScriptPolicy(text, label = "workflow") {
  const errors = [];
  const lines = text.split("\n");
  let lastProof = -1;
  let lastScriptsEnabledInstall = -1;
  if (/dangerously[-_]allow[-_]all[-_]scripts/iu.test(text)) {
    errors.push(`${label} must never bypass the dependency install-script allowlist`);
  }
  for (const [index, line] of lines.entries()) {
    if (line.includes("node scripts/validate-install-script-policy.mjs")) lastProof = index;
    if (!line.includes("npm ci") || !line.includes("--ignore-scripts=false")) continue;
    if (!line.includes("--strict-allow-scripts")) {
      errors.push(`${label}:${index + 1} scripts-enabled npm ci must explicitly enable strict allowlist enforcement`);
    }
    if (lastProof <= lastScriptsEnabledInstall) {
      errors.push(`${label}:${index + 1} must prove install-script enforcement before scripts-enabled npm ci`);
    }
    lastScriptsEnabledInstall = index;
  }
  return errors;
}

export function validateReleaseWorkflow(text) {
  const errors = [
    ...validateActionPins(text, "release.yml"),
    ...validateInstallScriptPolicy(text, "release.yml"),
  ];
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
  requireText(
    "node scripts/validate-install-script-policy.mjs",
    "independent builds must prove the pinned npm install-script policy before dependency installation",
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

// Without this, deleting the entire browser job — or quietly dropping the
// reproducibility or audit step — leaves `npm run validate` green, so the
// checks a release is gated on could disappear without anything noticing.
export function validateCiWorkflow(text) {
  const errors = [];
  // Comments must not satisfy a requirement: a commented-out step would
  // otherwise keep every check below green while doing nothing.
  const effective = text
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  const requireText = (fragment, message) => {
    if (!effective.includes(fragment)) errors.push(message);
  };
  // A blocking gate annotated continue-on-error still reports, but no longer
  // gates, and the substring checks below cannot see the difference.
  const AUDIT = "npm audit --omit=dev --audit-level=high";
  const steps = effective.split(/^ {6}- (?=name:|uses:|run:)/mu);
  const auditStep = steps.find((step) => step.includes(AUDIT));
  if (auditStep !== undefined && /continue-on-error:\s*true/u.test(auditStep)) {
    errors.push("the shipped-tree advisory gate must not be marked continue-on-error");
  }
  for (const step of steps) {
    if (/continue-on-error:\s*true/u.test(step) && !step.includes("npm audit")) {
      errors.push("continue-on-error is only permitted on the advisory-reporting step");
    }
  }
  requireText("permissions:\n  contents: read", "CI must run with read-only repository permissions");
  requireText("npm run validate", "CI must run the source and unit contract suite");
  requireText("npm run build", "CI must build the closed production artifact");
  requireText("npm run verify:reproducible", "CI must verify local byte reproducibility");
  requireText("npm run test:browser", "CI must run the production-serving browser suite");
  requireText("npx playwright install", "CI must install pinned browser binaries before the browser suite");
  requireText(
    "npm audit --omit=dev --audit-level=high",
    "CI must fail on known high-severity advisories in the shipped dependency tree",
  );
  requireText(
    "test \"$(npm --version)\" = '11.16.0'",
    "every CI job must assert the pinned npm runtime before installing",
  );
  if (occurrences(text, "test \"$(npm --version)\" = '11.16.0'") !== 2) {
    errors.push("both the validate and browser jobs must assert the pinned npm runtime");
  }
  // A push to main is the commit a release is cut from; cancelling its run
  // would leave that exact commit with no completed CI result.
  requireText(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "CI must not cancel in-progress runs for pushes to main",
  );
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
    errors.push(...validateInstallScriptPolicy(text, name));
    if (name === "release.yml") errors.push(...validateReleaseWorkflow(text).filter((error) => !errors.includes(error)));
    if (name === "ci.yml") errors.push(...validateCiWorkflow(text).filter((error) => !errors.includes(error)));
  }
  if (!names.includes("release.yml")) errors.push("release.yml is missing");
  if (!names.includes("ci.yml")) errors.push("ci.yml is missing");
  if (errors.length > 0) {
    errors.forEach((error) => process.stderr.write(`workflow validation: ${error}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write(`validated ${names.length} SHA-pinned workflows and the release invariants\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
