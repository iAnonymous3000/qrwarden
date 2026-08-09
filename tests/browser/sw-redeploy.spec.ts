import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import { COPY } from "../../src/copy";
import { gotoControlled } from "./support";

/**
 * A self-hosted rebuild runs a bare `npm run build`, so QRWARDEN_COMMIT keeps
 * its development default of forty zeros and two materially different builds
 * carry the same release id — and therefore the same precache name. Deploying
 * the second build while the first build's worker is still active used to fail
 * the new install on the sibling's cache keys, wipe the shared cache, and put
 * every navigation on net::ERR_FAILED until the last tab closed.
 *
 * Build A is whatever the Playwright web server built; build B is produced
 * here from a one-character change to Spanish copy, which moves the hashed
 * bundle without moving any string this suite asserts. Deploys are staged by
 * swapping the bytes under dist/, which scripts/serve-dist.mjs reads per
 * request. It parses _headers only at startup, and both builds emit identical
 * header rules, so a swap changes served bodies and nothing else.
 */

const runCommand = promisify(execFile);

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const distDirectory = path.join(repositoryRoot, "dist");
const spanishCopySource = path.join(
  repositoryRoot,
  "src/copy/locales/es.ts",
);

let workspace = "";
let buildA = "";
let buildB = "";
let scriptA = "";
let scriptB = "";
let siblingOnlyAsset = "";

async function moduleScript(build: string): Promise<string> {
  const document = await readFile(path.join(build, "index.html"), "utf8");
  const source = /<script type="module"[^>]*\ssrc="([^"]+)"/u.exec(document);
  const found = source?.[1];
  if (found === undefined) {
    throw new TypeError("Built index.html has no module script");
  }
  return found;
}

async function deploy(build: string): Promise<void> {
  await rm(distDirectory, { recursive: true, force: true });
  await cp(build, distDirectory, { recursive: true });
}

async function registrationState(page: Page): Promise<{
  readonly installing: boolean;
  readonly waiting: boolean;
  readonly active: boolean;
}> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) {
      return { installing: false, waiting: false, active: false };
    }
    return {
      installing: registration.installing !== null,
      waiting: registration.waiting !== null,
      active: registration.active !== null,
    };
  });
}

/**
 * Forces the update check a redeploy would otherwise get from an incidental
 * navigation, so the sibling worker's install is ordered against the test
 * rather than against the browser's own soft-update schedule, and reports how
 * that install ended.
 */
async function updateSibling(
  page: Page,
): Promise<"installed" | "redundant" | "none"> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) {
      throw new Error("Expected an existing registration");
    }
    // update() resolves as soon as the sibling worker starts installing, so
    // the outcome has to be read off that worker's own state instead.
    const settled = new Promise<"installed" | "redundant" | "none">(
      (resolve) => {
        const deadline = window.setTimeout(() => resolve("none"), 45_000);
        registration.addEventListener(
          "updatefound",
          () => {
            const worker = registration.installing;
            if (worker === null) return;
            const report = (): void => {
              if (worker.state === "installed" || worker.state === "activated") {
                window.clearTimeout(deadline);
                resolve("installed");
              } else if (worker.state === "redundant") {
                window.clearTimeout(deadline);
                resolve("redundant");
              }
            };
            worker.addEventListener("statechange", report);
            report();
          },
          { once: true },
        );
      },
    );
    await registration.update().catch(() => undefined);
    return settled;
  });
}

async function installSibling(page: Page): Promise<void> {
  expect(await updateSibling(page)).toBe("installed");
  await expect
    .poll(() => registrationState(page).then((state) => state.waiting), {
      timeout: 45_000,
    })
    .toBe(true);
}

/**
 * Playwright's Firefox never settles page.reload() on a service-worker
 * controlled document, so reloads are driven from inside the page. A failed
 * navigation still lands on an error document, which the serving assertions
 * then reject.
 */
async function reloadDocument(page: Page): Promise<void> {
  await Promise.all([
    page.waitForEvent("framenavigated"),
    page.evaluate(() => {
      location.reload();
    }),
  ]);
  await page.waitForLoadState("load");
}

async function expectServing(page: Page, script: string): Promise<void> {
  await expect(page.locator('script[type="module"]')).toHaveAttribute(
    "src",
    script,
  );
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible({ timeout: 20_000 });
}

async function expectOfflineReady(page: Page): Promise<void> {
  await expect(
    page.getByText(COPY.readyOfflineHeading, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  workspace = await mkdtemp(path.join(tmpdir(), "qrwarden-redeploy-"));
  buildA = path.join(workspace, "a");
  buildB = path.join(workspace, "b");
  await cp(distDirectory, buildA, { recursive: true });

  const original = await readFile(spanishCopySource, "utf8");
  const modified = original.replace(/\n {2}tagline: "/u, '\n  tagline: " ');
  if (modified === original) {
    throw new TypeError("Sibling build needs a content change to Spanish copy");
  }
  try {
    await writeFile(spanishCopySource, modified, "utf8");
    await runCommand("npm", ["run", "build"], { cwd: repositoryRoot });
    await cp(distDirectory, buildB, { recursive: true });
  } finally {
    await writeFile(spanishCopySource, original, "utf8");
  }

  scriptA = await moduleScript(buildA);
  scriptB = await moduleScript(buildB);
  if (scriptA === scriptB) {
    throw new TypeError("Both builds emitted the same bundle; nothing to swap");
  }
  const assetsA = new Set(await readdir(path.join(buildA, "assets")));
  const onlyInB = (await readdir(path.join(buildB, "assets"))).filter(
    (name) => !assetsA.has(name),
  );
  const candidate = onlyInB[0];
  if (candidate === undefined) {
    throw new TypeError("Sibling build shares every asset name with build A");
  }
  siblingOnlyAsset = candidate;
});

test.afterAll(async () => {
  if (buildA !== "") await deploy(buildA);
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await deploy(buildA);
});

test("serves the deployed build after a same-release redeploy", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await gotoControlled(page);
  await expectServing(page, scriptA);
  await expectOfflineReady(page);

  await deploy(buildB);
  await installSibling(page);

  await reloadDocument(page);
  await expectServing(page, scriptA);
  await expectOfflineReady(page);
});

test("serves a tab opened after a sibling deployment installs", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await gotoControlled(page);
  await deploy(buildB);
  await installSibling(page);

  const opened = await context.newPage();
  const navigation = await opened.goto("/");
  expect(navigation?.ok()).toBe(true);
  await expectServing(opened, scriptA);
  await expectOfflineReady(opened);
  await expectServing(page, scriptA);
});

test("cold-renders offline after a same-release redeploy", async ({
  browserName,
  context,
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName === "webkit",
    "Playwright WebKit cannot reliably emulate an offline navigation; physical Safari remains the release gate.",
  );
  await gotoControlled(page);
  await expectOfflineReady(page);

  await deploy(buildB);
  await installSibling(page);
  await context.setOffline(true);

  await reloadDocument(page);
  await expectServing(page, scriptA);
});

test("keeps the active deployment serving when a sibling install fails", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await gotoControlled(page);

  // A partially uploaded deployment: the sibling's shell and worker are live
  // but one of its hashed bundles is missing, so its precache fetch 404s.
  await deploy(buildB);
  await rm(path.join(distDirectory, "assets", siblingOnlyAsset));

  expect(await updateSibling(page)).toBe("redundant");
  await expect
    .poll(
      () =>
        registrationState(page).then(
          (state) => !state.installing && !state.waiting && state.active,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);

  await reloadDocument(page);
  await expectServing(page, scriptA);
  await expectOfflineReady(page);

  const opened = await context.newPage();
  const navigation = await opened.goto("/");
  expect(navigation?.ok()).toBe(true);
  await expectServing(opened, scriptA);
});

test("activates the sibling deployment and prunes build A once every tab closes", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await gotoControlled(page);
  await deploy(buildB);
  await installSibling(page);
  await page.close();

  const opened = await context.newPage();
  const navigation = await opened.goto("/");
  expect(navigation?.ok()).toBe(true);
  await expect
    .poll(
      () =>
        registrationState(opened).then(
          (state) => !state.installing && !state.waiting && state.active,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  await reloadDocument(opened);
  await expectServing(opened, scriptB);
  await expectOfflineReady(opened);

  const precached = await opened.evaluate(async () => {
    const names = (await caches.keys()).filter((name) =>
      name.startsWith("qrwarden-precache-"),
    );
    const paths: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        paths.push(new URL(request.url).pathname);
      }
    }
    return { names, paths };
  });
  expect(precached.names).toHaveLength(1);
  expect(precached.paths).toContain(scriptB);
  expect(precached.paths).not.toContain(scriptA);
});
