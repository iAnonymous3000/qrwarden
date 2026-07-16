import { expect, test, type Page } from "@playwright/test";

import { COPY } from "../../src/copy";

const fixture = new URL("../corpus/url-review.png", import.meta.url).pathname;

/**
 * Brave iOS is system WebKit plus page-world instrumentation: an async
 * navigator.brave marker, wrapped fetch/XHR, and farbled navigator fields.
 * Brave also ships configurations where service workers are unavailable or
 * registration is denied (private tabs, blocked storage). Every scenario here
 * must leave the app unlocked with image decoding working.
 */

async function expectImageDecodeWorks(page: Page): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await expect(input).toBeEnabled({ timeout: 20_000 });
  await input.setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: COPY.reviewHeading }),
  ).toBeVisible({ timeout: 15_000 });
}

test("decodes with Brave-style page instrumentation active", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "brave", {
      configurable: true,
      value: { isBrave: () => Promise.resolve(true) },
    });
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 3,
    });
    const realFetch = window.fetch.bind(window);
    window.fetch = (...args: Parameters<typeof fetch>) => realFetch(...args);
    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function wrappedOpen(
      this: XMLHttpRequest,
      ...args: unknown[]
    ) {
      return (realOpen as (...inner: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible();
  await expectImageDecodeWorks(page);
});

test("stays unlocked and decodes without any service worker API", async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker;
  });

  await page.goto("/");
  await expect(
    page.getByText(COPY.offlineIncompleteHeading, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expectImageDecodeWorks(page);
});

test("stays unlocked and decodes when registration is denied", async ({ page }) => {
  await page.addInitScript(() => {
    const container = Object.getPrototypeOf(navigator.serviceWorker) as {
      register?: unknown;
      getRegistration?: unknown;
    };
    Object.defineProperty(container, "register", {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException("Storage denied", "SecurityError")),
    });
    Object.defineProperty(container, "getRegistration", {
      configurable: true,
      value: () => Promise.resolve(undefined),
    });
  });

  await page.goto("/");
  await expect(
    page.getByText(COPY.offlineIncompleteHeading, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expectImageDecodeWorks(page);
});

test("shows Brave-specific camera guidance when iOS Brave denies access", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "brave", {
      configurable: true,
      value: { isBrave: () => Promise.resolve(true) },
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        enumerateDevices: () => Promise.resolve([]),
        getUserMedia: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });

  await page.goto("/");
  const scan = page.getByRole("button", { name: "Scan with camera" });
  await expect(scan).toBeEnabled({ timeout: 20_000 });
  await scan.click();
  await expect(
    page.getByRole("heading", { name: COPY.cameraAccessHeading }),
  ).toBeVisible();
  await expect(page.getByText(COPY.braveIosCameraBody)).toBeVisible();
});
