import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { COPY } from "../../src/copy";
import { gotoControlled } from "./support";

const fixture = new URL("../corpus/url-review.png", import.meta.url).pathname;

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];

// Rules that axe can only ever report as "incomplete", yet which flag a
// definite authoring error rather than a genuinely indeterminate result such
// as contrast measured over a modal backdrop. Because axe never escalates
// them to violations, a real defect here is otherwise invisible to CI: a
// name-prohibited container silently dropped its accessible name this way.
const DEFINITE_INCOMPLETE_RULES = new Set(["aria-prohibited-attr"]);

// A cold service-worker install, a real decode and a full axe pass in one test
// can exceed the 60s project timeout on a loaded machine.
test.beforeEach(() => {
  test.slow();
});

function describe(
  entries: readonly { id: string; impact?: string | null; nodes: readonly { target: unknown[] }[] }[],
): string[] {
  return entries.map(
    (entry) =>
      `${entry.id} (${entry.impact ?? "unknown impact"}): ${entry.nodes
        .map((node) => node.target.join(" "))
        .join(" | ")}`,
  );
}

async function expectNoWcagViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // The dist ships default-src 'none'; script-src 'self'. An injection that the
  // page rejected would report an empty violation list exactly like a clean
  // state, so a non-empty pass list is what proves axe actually ran.
  expect(results.passes.length).toBeGreaterThan(0);
  // Mapped to strings so a regression names the rule, its impact and the
  // failing selector in the run output instead of an opaque object diff.
  expect(describe(results.violations)).toEqual([]);
  expect(
    describe(results.incomplete.filter((entry) => DEFINITE_INCOMPLETE_RULES.has(entry.id))),
  ).toEqual([]);
}

async function openReview(page: Page): Promise<void> {
  await gotoControlled(page);
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: COPY.reviewHeading })).toBeVisible({
    timeout: 15_000,
  });
}

test("home view carries no WCAG violations", async ({ page }) => {
  await gotoControlled(page);
  await expect(page.getByRole("heading", { name: COPY.primaryMessage })).toBeVisible();

  await expectNoWcagViolations(page);
});

test("decoded URL review carries no WCAG violations", async ({ page }) => {
  await openReview(page);

  await expectNoWcagViolations(page);
});

test("open confirmation dialog carries no WCAG violations", async ({ page }) => {
  await openReview(page);
  await page.getByRole("button", { name: COPY.continueToLink }).click();
  const dialog = page.getByRole("dialog", { name: COPY.confirmHeading });
  await expect(dialog).toBeVisible();
  // showModal() makes the rest of the document inert; scanning before the
  // dialog is actually modal would grade a different tree.
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);

  await expectNoWcagViolations(page);
});

test("unsupported image recovery carries no WCAG violations", async ({ page }) => {
  await gotoControlled(page);
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from("not an image"),
    mimeType: "text/plain",
    name: "not-an-image.txt",
  });
  // Recovery views take keyboard focus as they mount. Scanning on visibility
  // alone can catch the view mid-transition, which grades a tree the user
  // never sees; wait for the focus handoff that marks the view settled.
  const heading = page.getByRole("heading", { name: COPY.unsupportedImageHeading });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();

  await expectNoWcagViolations(page);
});

test("privacy view carries no WCAG violations", async ({ page }) => {
  await gotoControlled(page);
  await page.getByRole("button", { name: COPY.navPrivacy }).click();
  await expect(page.getByRole("heading", { name: COPY.privacyTitle })).toBeVisible();

  await expectNoWcagViolations(page);
});
