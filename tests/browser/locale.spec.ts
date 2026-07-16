import { expect, test } from "@playwright/test";

import { ES_COPY } from "../../src/copy/locales/es";

const fixture = new URL("../corpus/url-review.png", import.meta.url).pathname;

test.use({ locale: "es-ES" });

test("renders the Spanish locale end to end for a review flow", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: ES_COPY.primaryMessage }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang))
    .toBe("es");

  const input = page.locator('input[type="file"]').first();
  await expect(input).toBeEnabled({ timeout: 20_000 });
  await input.setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: ES_COPY.reviewHeading }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(ES_COPY.actualDestination)).toBeVisible();

  await page.getByRole("button", { name: ES_COPY.continueToLink }).click();
  const dialog = page.getByRole("dialog", { name: ES_COPY.confirmHeading });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: ES_COPY.cancel }).click();
  await expect(dialog).not.toBeVisible();
});
