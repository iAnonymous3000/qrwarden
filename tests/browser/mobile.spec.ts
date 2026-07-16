import { expect, test, type Page } from "@playwright/test";

import { COPY } from "../../src/copy";

const reviewFixture = new URL("../corpus/url-review.png", import.meta.url).pathname;
const multiFixture = new URL("../corpus/multi-selection.png", import.meta.url).pathname;

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const documentClientWidth = document.documentElement.clientWidth;
    const viewportWidth = Math.min(window.innerWidth, documentClientWidth);
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width === 0 ||
          rect.height === 0 ||
          (rect.left >= -1 && rect.right <= viewportWidth + 1)
        ) {
          return [];
        }
        return [{
          className: element.className,
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          tag: element.tagName,
          text: (element.textContent ?? "").trim().slice(0, 80),
        }];
      })
      .slice(0, 8);
    return {
      clientWidth: viewportWidth,
      documentClientWidth,
      innerWidth: window.innerWidth,
      offenders,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(
    result.scrollWidth,
    `${label} overflowed horizontally: ${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(result.clientWidth);
  expect(result.offenders, `${label} painted outside the viewport`).toEqual([]);
}

async function expectTouchTargets(page: Page, label: string): Promise<void> {
  const undersized = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>("button, label.source-card, summary"),
    )
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width === 0 ||
          rect.height === 0 ||
          (rect.width >= 44 && rect.height >= 44)
        ) {
          return [];
        }
        return [{
          height: Math.round(rect.height * 10) / 10,
          label: element.getAttribute("aria-label") ?? (element.textContent ?? "").trim(),
          width: Math.round(rect.width * 10) / 10,
        }];
      }),
  );

  expect(undersized, `${label} had undersized touch targets`).toEqual([]);
}

test("keeps home and information views usable on mobile touch screens", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "home");
  await expectTouchTargets(page, "home");
  const viewport = page.viewportSize();
  if (viewport !== null && viewport.width <= 400 && viewport.height <= 650) {
    const firstSourceCard = page.getByRole("button", { name: "Scan with camera" });
    const cardTop = await firstSourceCard.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(
      cardTop,
      "At least one full-size tap row of the first scan action should be visible initially",
    ).toBeLessThanOrEqual(viewport.height - 44);
  }

  const theme = page.getByRole("button", { name: "Dark mode" });
  await theme.click();
  await expectNoHorizontalOverflow(page, "home after theme change");

  await page.getByRole("button", { name: "Privacy" }).click();
  await expect(
    page.getByRole("heading", { name: "What stays on your device" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, "privacy");
  await expectTouchTargets(page, "privacy");

  await page.getByRole("button", { name: "About" }).click();
  await expect(
    page.getByRole("heading", { name: "Built to show evidence, not a verdict." }),
  ).toBeVisible();
  await page.getByText("Technical and release details", { exact: true }).click();
  await expectNoHorizontalOverflow(page, "about");
  await expectTouchTargets(page, "about");
});

test("reflows review, confirmation, and multi-code selection at mobile widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(COPY.readyOfflineHeading, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const imageInput = page.locator('input[type="file"]');
  await expect(imageInput).toBeEnabled({ timeout: 20_000 });
  await imageInput.setInputFiles(reviewFixture);
  await expect(
    page.getByRole("heading", { name: "Review before opening." }),
  ).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalOverflow(page, "review result");
  await expectTouchTargets(page, "review result");
  const statusSymbol = page.locator(".result-status .status-symbol");
  await expect(statusSymbol).toHaveText("!");
  const statusGeometry = await statusSymbol.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      borderRadius: getComputedStyle(element).borderRadius,
      height: rect.height,
      width: rect.width,
    };
  });
  expect(statusGeometry.width).toBeCloseTo(42, 1);
  expect(statusGeometry.height).toBeCloseTo(42, 1);
  expect(Math.abs(statusGeometry.width - statusGeometry.height)).toBeLessThanOrEqual(.1);
  expect(statusGeometry.borderRadius).toBe("50%");

  await page.getByRole("button", { name: COPY.continueToLink }).click();
  const dialog = page.getByRole("dialog", { name: "Open this link?" });
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page, "confirmation dialog");
  expect(await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom <= innerHeight + 1,
      left: rect.left >= -1,
      right: rect.right <= innerWidth + 1,
      top: rect.top >= -1,
    };
  })).toEqual({ bottom: true, left: true, right: true, top: true });
  await dialog.getByRole("button", { name: COPY.cancel }).click();

  await page.getByRole("button", { name: COPY.scanAnother }).click();
  await expect(imageInput).toBeEnabled();
  await imageInput.setInputFiles(multiFixture);
  await expect(
    page.getByRole("heading", { name: COPY.chooseQrHeading }),
  ).toBeVisible({ timeout: 15_000 });
  const selectionCanvas = page.locator(".selection-canvas");
  await expect(selectionCanvas).toBeVisible();
  const canvasGeometry = await selectionCanvas.evaluate((element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect();
    const documentClientWidth = document.documentElement.clientWidth;
    return {
      height: rect.height,
      intrinsicHeight: element.height,
      intrinsicWidth: element.width,
      left: rect.left,
      parentWidth: element.parentElement?.clientWidth ?? 0,
      right: rect.right,
      viewportWidth: Math.min(innerWidth, documentClientWidth),
      width: rect.width,
    };
  });
  expect(canvasGeometry.width).toBeGreaterThan(0);
  expect(canvasGeometry.height).toBeGreaterThan(0);
  expect(canvasGeometry.intrinsicWidth).toBeGreaterThan(0);
  expect(canvasGeometry.intrinsicHeight).toBeGreaterThan(0);
  expect(canvasGeometry.parentWidth).toBeGreaterThan(1);
  expect(canvasGeometry.width).toBeCloseTo(canvasGeometry.parentWidth, 0);
  expect(canvasGeometry.left).toBeGreaterThanOrEqual(-1);
  expect(canvasGeometry.right).toBeLessThanOrEqual(canvasGeometry.viewportWidth + 1);
  expect(canvasGeometry.width / canvasGeometry.height).toBeCloseTo(
    canvasGeometry.intrinsicWidth / canvasGeometry.intrinsicHeight,
    2,
  );
  await expectNoHorizontalOverflow(page, "multi-code selection");
  await expectTouchTargets(page, "multi-code selection");
});

test("keeps the camera surface reachable in portrait and short landscape", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        enumerateDevices: () => Promise.resolve([]),
        getUserMedia: () => new Promise<MediaStream>(() => undefined),
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  await expect(
    page.getByRole("heading", { name: "Hold the QR code inside the frame" }),
  ).toBeVisible();
  await expect(page.getByText(COPY.startingCamera, { exact: true })).toBeVisible();
  const cancel = page.getByRole("button", { name: COPY.cancel });
  await expect(cancel).toBeVisible();
  const frame = page.locator(".video-frame");
  await expect(frame).toBeVisible();
  const portraitGeometry = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: innerWidth };
  });
  expect(portraitGeometry.left).toBeGreaterThanOrEqual(-1);
  expect(portraitGeometry.right).toBeLessThanOrEqual(portraitGeometry.viewportWidth + 1);
  await expectNoHorizontalOverflow(page, "portrait camera");
  await expectTouchTargets(page, "portrait camera");

  await page.setViewportSize({ width: 667, height: 375 });
  const cancelGeometry = await cancel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, top: rect.top, viewportHeight: innerHeight };
  });
  expect(cancelGeometry.top).toBeGreaterThanOrEqual(-1);
  expect(cancelGeometry.bottom).toBeLessThanOrEqual(cancelGeometry.viewportHeight + 1);
  await expect(frame).toBeVisible();
  const frameGeometry = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  });
  const geometryLabel = `camera frame geometry: ${JSON.stringify(frameGeometry)}`;
  expect(frameGeometry.top, geometryLabel).toBeGreaterThanOrEqual(-1);
  expect(frameGeometry.left, geometryLabel).toBeGreaterThanOrEqual(-1);
  expect(frameGeometry.right, geometryLabel).toBeLessThanOrEqual(
    frameGeometry.viewportWidth + 1,
  );
  expect(frameGeometry.bottom, geometryLabel).toBeLessThanOrEqual(
    frameGeometry.viewportHeight + 1,
  );
  await expect(page.locator(".video-frame video")).toHaveCSS("object-fit", "contain");
  await expectNoHorizontalOverflow(page, "landscape camera");
  await expectTouchTargets(page, "landscape camera");
});
