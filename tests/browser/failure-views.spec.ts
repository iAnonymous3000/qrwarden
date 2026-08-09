import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { COPY } from "../../src/copy";
import { MAX_FILE_BYTES } from "../../src/image/controller";
import { gotoControlled } from "./support";

const noCodeFixture = new URL("../corpus/no-code.png", import.meta.url).pathname;
const reviewFixture = new URL("../corpus/url-review.png", import.meta.url).pathname;

/**
 * Every intake failure lands on the same recovery contract: an alert whose
 * heading takes keyboard focus, the explanation of what went wrong, and a
 * control that returns to the scanner.
 */
async function expectRecovery(
  page: Page,
  heading: string,
  body: string,
): Promise<void> {
  const recovery = page.getByRole("alert");
  const title = recovery.getByRole("heading", { name: heading });
  await expect(title).toBeVisible();
  await expect(title).toBeFocused();
  await expect(recovery.getByText(body, { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(`${COPY.titleError} · ${COPY.brand}`);

  const tryAnother = recovery.getByRole("button", { name: COPY.tryAnotherCode });
  await expect(tryAnother).toBeEnabled();
  await tryAnother.click();
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeFocused();
}

test("offers recovery from a photograph with no QR code", async ({ page }) => {
  await gotoControlled(page);

  await page.locator('input[type="file"]').setInputFiles(noCodeFixture);

  await expectRecovery(page, COPY.noQrHeading, COPY.noQrBody);
});

test("offers recovery from an image past the size limit", async ({ page }) => {
  await gotoControlled(page);

  // The byte ceiling is enforced twice at the same limit: at intake, and
  // again by the worker's header inspection. Both surface this view, and
  // neither reads past the size, so the bytes themselves never matter.
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.alloc(MAX_FILE_BYTES + 1),
    mimeType: "image/png",
    name: "oversized.png",
  });

  await expectRecovery(page, COPY.imageTooLargeHeading, COPY.imageTooLargeBody);
});

test("offers recovery from a truncated PNG", async ({ page }) => {
  await gotoControlled(page);

  // Keeping the PNG signature routes the file past the format sniff, so the
  // truncated chunk stream fails as unreadable rather than as an unsupported
  // type.
  const png = await readFile(reviewFixture);
  await page.locator('input[type="file"]').setInputFiles({
    buffer: png.subarray(0, Math.floor(png.byteLength / 2)),
    mimeType: "image/png",
    name: "truncated.png",
  });

  await expect(
    page.getByRole("heading", { name: COPY.imageUnreadableHeading }),
  ).toBeVisible();
  // The unsupported-type rejection is exercised in app.spec.ts; a file whose
  // magic bytes the format sniff accepts must never land there.
  await expect(
    page.getByRole("heading", { name: COPY.unsupportedImageHeading }),
  ).toHaveCount(0);
  await expectRecovery(page, COPY.imageUnreadableHeading, COPY.imageUnreadableBody);
});

test("offers recovery from a drop carrying several images", async ({ page }) => {
  await gotoControlled(page);

  // The file input is single-select, so more than one file can only arrive
  // through a drop or a paste.
  const dropped = await Promise.all(
    [noCodeFixture, reviewFixture].map(async (path) => ({
      base64: (await readFile(path)).toString("base64"),
      name: basename(path),
    })),
  );
  await page.evaluate((files) => {
    const transfer = new DataTransfer();
    for (const file of files) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      transfer.items.add(new File([bytes], file.name, { type: "image/png" }));
    }
    window.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, dropped);

  await expectRecovery(page, COPY.chooseOneImageHeading, COPY.chooseOneImageBody);
});
