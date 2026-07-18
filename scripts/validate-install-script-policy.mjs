import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const fixtureName = "qrwarden-install-policy-fixture";
const fixtureVersion = "1.0.0";
const fixtureArchive = `${fixtureName}-${fixtureVersion}.tgz`;
const markerName = "UNREVIEWED_SCRIPT_EXECUTED";
const strictInstallArguments = [
  "ci",
  "--ignore-scripts=false",
  "--strict-allow-scripts",
  "--no-audit",
  "--no-fund",
];

function isolatedEnvironment(temporaryDirectory) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];
  }
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_CACHE = path.join(temporaryDirectory, "cache");
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(temporaryDirectory, "global.npmrc");
  environment.NPM_CONFIG_LOGS_DIR = path.join(temporaryDirectory, "logs");
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  environment.NPM_CONFIG_USERCONFIG = path.join(temporaryDirectory, "user.npmrc");
  return environment;
}

function runNpm(arguments_, { cwd, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, arguments_, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function commandFailure(label, result) {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const outcome = result.signal === null ? `exit ${result.code}` : `signal ${result.signal}`;
  return new Error(`${label} (${outcome})${output === "" ? "" : `:\n${output}`}`);
}

function requireSuccess(label, result) {
  if (result.code !== 0 || result.signal !== null) throw commandFailure(label, result);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

const projectPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const npmrc = await readFile(path.join(root, ".npmrc"), "utf8");
const expectedNpm = projectPackage.engines?.npm;
const approvals = Object.values(projectPackage.allowScripts ?? {});

if (typeof expectedNpm !== "string" || !approvals.includes(true) || !approvals.includes(false)) {
  throw new Error("install-script policy requires one exact npm runtime plus approved and denied entries");
}
if (!npmrc.split("\n").includes("ignore-scripts=true")) {
  throw new Error(".npmrc must disable lifecycle scripts by default");
}
if (!npmrc.split("\n").includes("strict-allow-scripts=true")) {
  throw new Error(".npmrc must keep every scripts-enabled install in strict allowlist mode");
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "qrwarden-install-policy-"));
const dependencyDirectory = path.join(temporaryDirectory, "dependency");
const projectDirectory = path.join(temporaryDirectory, "project");
const markerPath = path.join(projectDirectory, markerName);
try {
  const environment = isolatedEnvironment(temporaryDirectory);
  await Promise.all([
    mkdir(dependencyDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    writeFile(path.join(temporaryDirectory, "global.npmrc"), ""),
    writeFile(path.join(temporaryDirectory, "user.npmrc"), ""),
  ]);

  const versionResult = await runNpm(["--version"], { cwd: projectDirectory, environment });
  if (versionResult.stdout.trim() !== expectedNpm) {
    throw commandFailure(`npm must be exactly ${expectedNpm}`, versionResult);
  }
  requireSuccess(`npm must be exactly ${expectedNpm}`, versionResult);

  await Promise.all([
    writeFile(
      path.join(dependencyDirectory, "package.json"),
      `${JSON.stringify({
        name: fixtureName,
        version: fixtureVersion,
        scripts: { install: "node hook.mjs" },
      }, null, 2)}\n`,
    ),
    writeFile(
      path.join(dependencyDirectory, "hook.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "",
        `writeFileSync(path.join(process.env.INIT_CWD, "${markerName}"), "executed\\n");`,
        "",
      ].join("\n"),
    ),
    writeFile(path.join(projectDirectory, ".npmrc"), npmrc),
  ]);

  const packResult = await runNpm(
    ["pack", "--ignore-scripts", "--pack-destination", projectDirectory],
    { cwd: dependencyDirectory, environment },
  );
  requireSuccess("the local lifecycle-hook fixture must pack without running scripts", packResult);
  if (!(await exists(path.join(projectDirectory, fixtureArchive))) || await exists(markerPath)) {
    throw new Error("packing the lifecycle-hook fixture must not execute its install script");
  }

  await writeFile(
    path.join(projectDirectory, "package.json"),
    `${JSON.stringify({
      name: "qrwarden-install-policy-test",
      version: "1.0.0",
      private: true,
      dependencies: { [fixtureName]: `file:${fixtureArchive}` },
    }, null, 2)}\n`,
  );
  const lockResult = await runNpm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: projectDirectory, environment },
  );
  requireSuccess("the local lifecycle-hook fixture lockfile must be generated with scripts disabled", lockResult);

  const unreviewedResult = await runNpm(
    ["ci", "--ignore-scripts=false", "--no-audit", "--no-fund"],
    { cwd: projectDirectory, environment },
  );
  const unreviewedOutput = `${unreviewedResult.stdout}\n${unreviewedResult.stderr}`;
  if (
    unreviewedResult.code === 0 ||
    unreviewedResult.signal !== null ||
    !unreviewedOutput.includes("ESTRICTALLOWSCRIPTS") ||
    !unreviewedOutput.includes("not covered by allowScripts") ||
    await exists(markerPath) ||
    await exists(path.join(projectDirectory, "node_modules"))
  ) {
    throw commandFailure(
      "an unreviewed lifecycle hook must fail before installation under committed .npmrc policy",
      unreviewedResult,
    );
  }

  const scriptsOffResult = await runNpm(["ci", "--no-audit", "--no-fund"], {
    cwd: projectDirectory,
    environment,
  });
  requireSuccess("a plain install must keep all dependency lifecycle scripts disabled", scriptsOffResult);
  if (await exists(markerPath)) throw new Error("a plain install executed the fixture lifecycle hook");

  const approveResult = await runNpm(["approve-scripts", fixtureName], {
    cwd: projectDirectory,
    environment,
  });
  requireSuccess("npm must approve the fixture through its native allowScripts command", approveResult);
  let fixturePackage = JSON.parse(await readFile(path.join(projectDirectory, "package.json"), "utf8"));
  if (
    Object.keys(fixturePackage.allowScripts ?? {}).length !== 1 ||
    !Object.values(fixturePackage.allowScripts ?? {}).includes(true)
  ) {
    throw new Error("npm approve-scripts must write one exact approved fixture identity");
  }

  const approvedResult = await runNpm(strictInstallArguments, { cwd: projectDirectory, environment });
  requireSuccess("an explicitly approved lifecycle hook must run under strict policy", approvedResult);
  if ((await readFile(markerPath, "utf8")) !== "executed\n") {
    throw new Error("the explicitly approved fixture lifecycle hook did not run");
  }

  await rm(markerPath, { force: true });
  const denyResult = await runNpm(["deny-scripts", fixtureName], {
    cwd: projectDirectory,
    environment,
  });
  requireSuccess("npm must deny the fixture through its native allowScripts command", denyResult);
  fixturePackage = JSON.parse(await readFile(path.join(projectDirectory, "package.json"), "utf8"));
  if (
    Object.keys(fixturePackage.allowScripts ?? {}).length !== 1 ||
    !Object.values(fixturePackage.allowScripts ?? {}).includes(false)
  ) {
    throw new Error("npm deny-scripts must write one exact denied fixture identity");
  }

  const deniedResult = await runNpm(strictInstallArguments, { cwd: projectDirectory, environment });
  requireSuccess("an explicitly denied lifecycle hook must remain skipped under strict policy", deniedResult);
  if (await exists(markerPath)) throw new Error("the explicitly denied fixture lifecycle hook executed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write(`npm ${expectedNpm} install-script policy blocks unreviewed hooks and honors exact decisions\n`);
