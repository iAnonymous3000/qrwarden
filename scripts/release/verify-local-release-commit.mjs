import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function verifyLocalReleaseCommit({ root, executeGit = runGit }) {
  try {
    executeGit(root, ["verify-commit", "HEAD"]);
  } catch (error) {
    throw new Error("release commit must have a locally verifiable signature", {
      cause: error,
    });
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  verifyLocalReleaseCommit({ root });
  process.stdout.write("release commit signature is locally verifiable\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
