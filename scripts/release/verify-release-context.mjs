import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertCommit, assertReleaseVersion } from "./release-contract.mjs";

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

async function githubJson(url, token, expectedStatus = 200) {
  const response = await fetch(url, {
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status !== expectedStatus) {
    throw new Error(`GitHub API ${new URL(url).pathname} returned ${response.status}, expected ${expectedStatus}`);
  }
  return expectedStatus === 204 || expectedStatus === 404 ? null : response.json();
}

export function assertGitHubRepository(repository, releaseConstants) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is not an owner/repository identity");
  }
  const expectedRepository = `${releaseConstants.github?.owner ?? ""}/${releaseConstants.github?.repository ?? ""}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)) {
    throw new Error("release constants GitHub repository identity is invalid");
  }
  if (repository !== expectedRepository) {
    throw new Error(
      "GITHUB_REPOSITORY must exactly match release/constants.json GitHub owner/repository",
    );
  }
  return repository;
}

export async function verifyReleaseContext({ root, environment = process.env }) {
  const commit = assertCommit(required(environment, "QRWARDEN_RELEASE_COMMIT"));
  const version = assertReleaseVersion(required(environment, "QRWARDEN_RELEASE_VERSION"));
  if (required(environment, "GITHUB_EVENT_NAME") !== "workflow_dispatch") {
    throw new Error("release candidates may only be built by workflow_dispatch");
  }
  if (required(environment, "GITHUB_REF") !== "refs/heads/main") {
    throw new Error("release candidate dispatch must target main");
  }
  if (required(environment, "GITHUB_REF_PROTECTED") !== "true") {
    throw new Error("main must be protected for a release candidate");
  }
  if (required(environment, "GITHUB_SHA") !== commit) {
    throw new Error("release commit must equal the workflow dispatch commit");
  }
  const releaseConstants = JSON.parse(
    await readFile(path.join(root, "release/constants.json"), "utf8"),
  );
  const repository = assertGitHubRepository(
    required(environment, "GITHUB_REPOSITORY"),
    releaseConstants,
  );
  const api = new URL(required(environment, "GITHUB_API_URL"));
  if (api.protocol !== "https:" || api.username !== "" || api.password !== "") {
    throw new Error("GITHUB_API_URL must be an authenticated HTTPS API origin");
  }
  const token = required(environment, "GITHUB_TOKEN");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (metadata.version !== version) throw new Error("release input version differs from package.json");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (head !== commit) throw new Error("checked-out HEAD differs from the release commit");
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (dirty !== "") throw new Error("release context worktree is not clean");

  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const commitData = await githubJson(
    new URL(`/repos/${encodedRepository}/commits/${commit}`, api).href,
    token,
  );
  if (
    commitData?.sha !== commit ||
    commitData.commit?.verification?.verified !== true ||
    typeof commitData.commit.verification.signature !== "string" ||
    typeof commitData.commit.verification.payload !== "string"
  ) {
    throw new Error("GitHub does not verify the exact release commit signature");
  }
  const tag = encodeURIComponent(`v${version}`);
  await githubJson(new URL(`/repos/${encodedRepository}/git/ref/tags/${tag}`, api).href, token, 404);
  await githubJson(new URL(`/repos/${encodedRepository}/releases/tags/${tag}`, api).href, token, 404);
  return { commit, version };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { commit, version } = await verifyReleaseContext({ root });
  process.stdout.write(`verified protected release-candidate context v${version} at ${commit}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
