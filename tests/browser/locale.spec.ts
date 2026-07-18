import { expect, test } from "@playwright/test";

import { ES_COPY } from "../../src/copy/locales/es";
import { gotoControlled } from "./support";

const fixture = new URL("../corpus/url-review.png", import.meta.url).pathname;

test.use({ locale: "es-ES" });

test("renders the Spanish locale end to end at narrow mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 653 });
  await gotoControlled(page);
  await expect(
    page.getByRole("heading", { name: ES_COPY.primaryMessage }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe("es");

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: ES_COPY.reviewHeading }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ES_COPY.actualDestination)).toBeVisible();

  // Analyzer evidence renders language-of-parts: signal titles and field
  // labels translate, while parametric detail sentences stay English and
  // carry lang="en" for correct screen-reader pronunciation.
  await expect(
    page.locator(".signal-list").getByText("HTTP sin cifrar", { exact: true }),
  ).toBeVisible();
  const englishDetails = page.locator('.signal-list p[lang="en"]');
  await expect(englishDetails.first()).toBeVisible();
  await expect(
    englishDetails.filter({
      hasText: "The address uses HTTP rather than HTTPS.",
    }),
  ).toHaveCount(1);

  const hostRow = page.locator(".field-row").filter({ hasText: "Host de destino" });
  await expect(hostRow).toBeVisible();
  await expect(hostRow.locator('.field-heading span[lang="en"]')).toHaveCount(0);
  await expect(
    hostRow.getByRole("button", { name: "Copiar host de destino" }),
  ).toBeVisible();

  // Analyzer-synthesized field values translate too, while unknown registry
  // category names stay English and carry lang="en".
  const portRow = page.locator(".field-row").filter({ hasText: "Puerto" });
  await expect(portRow.locator(".field-value")).toHaveText("8080 (explícito)");
  const categoryRow = page
    .locator(".field-row")
    .filter({ hasText: "Categoría del destino" });
  await expect(categoryRow.locator('.field-value[lang="en"]')).toHaveText("Loopback");

  await page.getByRole("button", { name: ES_COPY.continueToLink }).click();
  const dialog = page.getByRole("dialog", { name: ES_COPY.confirmHeading });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText(ES_COPY.confirmFullUrlLabel);
  await expect(dialog.locator(".confirm-full-url bdi")).toHaveText(
    "http://127.0.0.1:8080/review?token=hidden#part",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
  await dialog.getByRole("button", { name: ES_COPY.cancel }).click();
  await expect(dialog).not.toBeVisible();

  // The About page states honestly that technical signal details remain
  // English for now.
  await page.getByRole("button", { name: ES_COPY.navAbout }).click();
  await expect(page.getByText(ES_COPY.aboutEnglishEvidenceNote)).toBeVisible();
  const installHeading = page.locator(".install-card h2");
  await expect(installHeading).toBeVisible();
  expect([
    ES_COPY.installInstalledHeading,
    ES_COPY.installIphoneHeading,
    ES_COPY.installMacHeading,
    ES_COPY.installTestedHeading,
    ES_COPY.installUnavailableHeading,
  ]).toContain(await installHeading.textContent());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
});

test("keeps the Spanish header inside a 401px viewport", async ({ page }) => {
  // The Spanish nav's minimum content width previously overflowed viewports
  // between 401 and 406 CSS pixels because header wrapping began at 400px.
  await page.setViewportSize({ width: 401, height: 800 });
  await gotoControlled(page);
  await expect(
    page.getByRole("heading", { name: ES_COPY.primaryMessage }),
  ).toBeVisible();
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement;
    return root === null ? -1 : root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBe(0);
});
