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
export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
export const GH_CLI_VERSION = "2.96.0";
export const GH_CLI_SHA256 = "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60";

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function withoutInactiveComments(text) {
  return text.split("\n").map((line) => {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === '"') {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }
      if (quote === "'") {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
        return line.slice(0, index).trimEnd();
      }
    }
    return line;
  }).join("\n");
}

function indentation(line) {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

function indentedBlock(lines, start, parentIndent) {
  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end].trim() === "" || indentation(lines[end]) > parentIndent)
  ) {
    end += 1;
  }
  return lines.slice(start, end);
}

function namedReleaseStep(text, jobName, stepName) {
  const lines = text.split("\n");
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`);
  if (jobStart === -1) return [];
  const job = indentedBlock(lines, jobStart, 2);
  const stepStart = job.findIndex((line) => line === `      - name: ${stepName}`);
  return stepStart === -1 ? [] : indentedBlock(job, stepStart, 6);
}

function logicalShellCommands(step) {
  const runStart = step.findIndex((line) => /^ {8}run:\s*\|\s*$/u.test(line));
  if (runStart === -1) return [];
  const body = indentedBlock(step, runStart, 8).slice(1);
  const commands = [];
  let pending = "";
  for (const line of body) {
    const command = line.trim();
    if (command === "") continue;
    if (command.endsWith("\\")) {
      pending += `${command.slice(0, -1).trimEnd()} `;
      continue;
    }
    commands.push(`${pending}${command}`);
    pending = "";
  }
  if (pending !== "") commands.push(pending.trimEnd());
  return commands;
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
  // Comments are not workflow structure and shell comments are not commands.
  // Removing both before checking invariants prevents a disabled gate from
  // satisfying a policy check merely by retaining the expected text.
  text = withoutInactiveComments(text);
  const errors = [
    ...validateActionPins(text, "release.yml"),
    ...validateInstallScriptPolicy(text, "release.yml"),
  ];
  const requireText = (fragment, message) => {
    if (!text.includes(fragment)) errors.push(message);
  };
  if (/continue-on-error:\s*true/u.test(text)) {
    errors.push("release gates must not be marked continue-on-error");
  }
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
  if (occurrences(text, "attestations: read") !== 1) {
    errors.push("release attestation readback must have exactly one read-only attestation permission");
  }
  requireText("verify-attestations:", "release attestation readback job is missing");
  requireText(
    "scripts/release/verify-attestations.mjs",
    "release attestation readback verifier is missing",
  );
  const verifierCommands = logicalShellCommands(namedReleaseStep(
    text,
    "verify-attestations",
    "Require both replicas' provenance and CycloneDX attestations",
  ));
  const exactVerifierCommand =
    "node scripts/release/verify-attestations.mjs --artifacts attestation-candidate " +
    "--version '${{ inputs.release_version }}' --commit '${{ inputs.release_commit }}' " +
    "--run-id '${{ github.run_id }}' --run-attempt '${{ github.run_attempt }}'";
  if (
    verifierCommands.length !== 2 ||
    verifierCommands[0] !== "set -euo pipefail" ||
    verifierCommands[1] !== exactVerifierCommand
  ) {
    errors.push("release attestation readback must execute the exact verifier command");
  }
  requireText(
    "path: attestation-candidate",
    "attestation readback must use an isolated downloaded candidate",
  );
  requireText(
    `QRWARDEN_GH_VERSION: ${GH_CLI_VERSION}`,
    "attestation readback must install the reviewed GitHub CLI version",
  );
  requireText(
    `QRWARDEN_GH_SHA256: ${GH_CLI_SHA256}`,
    "attestation readback must checksum the reviewed GitHub CLI archive",
  );
  requireText(
    `releases/download/v\${QRWARDEN_GH_VERSION}/gh_\${QRWARDEN_GH_VERSION}_linux_amd64.tar.gz`,
    "attestation readback must download the pinned linux/amd64 GitHub CLI archive",
  );
  requireText("sha256sum --check --strict", "GitHub CLI archive verification must fail closed");
  requireText(
    `gh version ${GH_CLI_VERSION} (2026-07-02)`,
    "attestation readback must assert the installed GitHub CLI version",
  );
  requireText("GH_TOKEN: ${{ github.token }}", "attestation readback must use the job-scoped token");
  requireText(
    "--version '${{ inputs.release_version }}'",
    "attestation readback must verify the requested release version",
  );
  requireText(
    "--commit '${{ inputs.release_commit }}'",
    "attestation readback must verify the exact requested release commit",
  );
  requireText(
    "--run-id '${{ github.run_id }}'",
    "attestation readback must verify the current workflow run",
  );
  requireText(
    "--run-attempt '${{ github.run_attempt }}'",
    "attestation readback must verify the current workflow attempt",
  );
  requireText(
    "needs: [build, verify-attestations]",
    "candidate finalization must depend on successful attestation readback",
  );
  requireText("name: unsigned-release-${{ matrix.replica }}", "replica artifacts must have distinct names");
  if (occurrences(text, `uses: ${ACTIONS.download}`) !== 3) {
    errors.push("attestation readback and finalization must perform exactly three artifact downloads");
  }
  if (occurrences(text, "name: unsigned-release-first") !== 2) {
    errors.push("attestation readback and finalization must each download the first replica");
  }
  if (occurrences(text, "name: unsigned-release-second") !== 1) {
    errors.push("finalization must download the second replica exactly once");
  }
  requireText("path: candidates/first", "first replica must download to an isolated directory");
  requireText("path: candidates/second", "second replica must download to an isolated directory");
  if (occurrences(text, "digest-mismatch: error") !== 3) {
    errors.push("every workflow artifact download must reject digest mismatch");
  }
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
  if (occurrences(effective, `image: ${PLAYWRIGHT_IMAGE}`) !== 1) {
    errors.push("the browser job must use the reviewed digest-pinned Playwright image exactly once");
  }
  requireText(
    "options: --platform linux/amd64 --ipc=host",
    "the Playwright container must force linux/amd64 and Chromium host IPC",
  );
  requireText(
    "PLAYWRIGHT_BROWSERS_PATH: /ms-playwright",
    "the browser job must use the image's pinned browser path",
  );
  requireText(
    "HOME: /root",
    "the root-run Playwright container must use its root-owned home directory",
  );
  requireText(
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: \"1\"",
    "the browser job must forbid dependency installation from downloading browsers",
  );
  requireText(
    "npm run validate:playwright-runtime -- --installed-root \"$PLAYWRIGHT_BROWSERS_PATH\"",
    "CI must validate the installed Playwright runtime before the browser suite",
  );
  requireText(
    "if: ${{ !cancelled() }}",
    "CI must retain failed first-attempt browser evidence even when a retry passes",
  );
  if (/\bplaywright\s+install(?:-deps)?\b/u.test(effective)) {
    errors.push("CI must not download Playwright browsers or OS dependencies at runtime");
  }
  if (/PLAYWRIGHT_(?:DOWNLOAD|CHROMIUM_DOWNLOAD|FIREFOX_DOWNLOAD|WEBKIT_DOWNLOAD)_HOST/u.test(effective)) {
    errors.push("CI must not override Playwright browser download hosts");
  }
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
