import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { COPY } from "../../src/copy";
import { THEME_STORAGE_KEY } from "../../src/render/theme";

const fixture = new URL("../corpus/url-review.png", import.meta.url).pathname;
const canaryFixture = new URL("../corpus/canary-url.png", import.meta.url).pathname;
const multiFixture = new URL("../corpus/multi-selection.png", import.meta.url).pathname;
const permissionsRegistry = JSON.parse(
  await readFile(
    new URL("../../release/permissions-policy.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly directives: readonly {
    readonly name: string;
    readonly allow: "self" | "none";
  }[];
};
const releaseConstants = JSON.parse(
  await readFile(new URL("../../release/constants.json", import.meta.url), "utf8"),
) as {
  readonly github: {
    readonly owner: string;
    readonly repository: string;
  };
};
const expectedSourceRepository =
  `https://github.com/${releaseConstants.github.owner}/${releaseConstants.github.repository}`;
const expectedPermissionsPolicy = permissionsRegistry.directives
  .map(({ name, allow }) => `${name}=(${allow === "self" ? "self" : ""})`)
  .join(", ");

test("follows the system theme and persists an explicit choice", async ({
  context,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  const root = page.locator("html");
  const toggle = page.getByRole("button", { name: "Dark mode" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#fffdf8",
  );

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY))
    .toBe("light");

  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(reopened.getByRole("button", { name: "Dark mode" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("keeps theme controls usable when preference storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await page.goto("/");

  const root = page.locator("html");
  const toggle = page.getByRole("button", { name: "Dark mode" });
  await expect(root).toHaveAttribute("data-theme", /^(?:dark|light)$/u);
  const initialTheme = await root.getAttribute("data-theme");
  expect(initialTheme === "dark" || initialTheme === "light").toBe(true);
  await toggle.click();
  await expect(root).toHaveAttribute(
    "data-theme",
    initialTheme === "dark" ? "light" : "dark",
  );
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible();
});

test("scans an image locally and requires two-step review", async ({ page }) => {
  const destinationRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).port === "8080") {
      destinationRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: COPY.primaryMessage,
    }),
  ).toBeVisible();
  await expect(page.getByText("Scans stay in this browser.")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: "Review before opening." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("127.0.0.1", { exact: true }).first()).toBeVisible();
  const queryField = page.locator(".field-row").filter({ hasText: "Query names" });
  await expect(queryField).toBeVisible();
  await queryField.getByText("Show details", { exact: true }).click();
  await expect(queryField.getByText("token", { exact: true })).toBeVisible();
  await expect(page.getByText("hidden", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="127.0.0.1:8080"]')).toHaveCount(0);
  expect(destinationRequests).toEqual([]);

  const continueButton = page.getByRole("button", { name: COPY.continueToLink });
  const resultButtons = await page.getByRole("button").allTextContents();
  const continueIndex = resultButtons.indexOf(COPY.continueToLink);
  const scanAnotherIndex = resultButtons.indexOf(COPY.scanAnother);
  expect(continueIndex).toBeGreaterThanOrEqual(0);
  expect(scanAnotherIndex).toBeGreaterThanOrEqual(0);
  expect(continueIndex).toBeLessThan(scanAnotherIndex);
  await continueButton.click();
  const dialog = page.getByRole("dialog", { name: "Open this link?" });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => ({
      focusInside: element.contains(document.activeElement),
      modal: element.matches(":modal"),
      open: (element as HTMLDialogElement).open,
    })),
  ).toEqual({ focusInside: true, modal: true, open: true });
  expect(
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".brand-button")?.focus();
      return document.querySelector("dialog")?.contains(document.activeElement) ?? false;
    }),
  ).toBe(true);
  await expect(dialog.getByRole("button", { name: COPY.openLink })).toHaveClass(
    /secondary-button/u,
  );
  await expect(dialog.getByRole("button", { name: COPY.cancel })).toHaveClass(
    /primary-button/u,
  );
  await expect(page.locator('a[href*="127.0.0.1:8080"]')).toHaveCount(0);
  expect(destinationRequests).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(continueButton).toBeFocused();

  await continueButton.click();
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(continueButton).toBeFocused();
});

test("drops a result on a non-persisted pagehide", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: "Review before opening." }),
  ).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  await expect(
    page.getByRole("heading", { name: "Review before opening." }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review before opening." }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: COPY.continueToLink })).toHaveCount(0);
});

test("clears link confirmation while the update gate is locked", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Ready offline.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const continueButton = page.getByRole("button", { name: COPY.continueToLink });
  await expect(continueButton).toBeVisible({ timeout: 15_000 });
  await continueButton.click();
  await expect(page.getByRole("dialog", { name: "Open this link?" })).toBeVisible();

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });
  await expect(page.getByRole("dialog", { name: "Open this link?" })).toHaveCount(0);
  await expect(continueButton).toBeEnabled({ timeout: 20_000 });

  await continueButton.click();
  await expect(page.getByRole("dialog", { name: "Open this link?" })).toBeVisible();
});

test("keeps information views in-memory and exposes privacy limits", async ({
  page,
  browserName,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Privacy" }).click();
  await expect(page.getByRole("button", { name: "Privacy" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("button", { name: "About" })).not.toHaveAttribute(
    "aria-current",
  );
  await expect(page.getByRole("heading", { name: "What stays on your device" })).toBeVisible();
  await expect(page.getByText("No destination lookup")).toBeVisible();
  await expect(page.getByRole("heading", { name: "App hosting traffic" })).toBeVisible();
  await expect(page.getByText(/hosting provider.*IP address/u)).toBeVisible();
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.getByRole("button", { name: "Privacy" })).not.toHaveAttribute(
    "aria-current",
  );
  await expect(page.getByRole("button", { name: "About" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("heading", { name: "Built to show evidence, not a verdict." }),
  ).toBeVisible();
  await expect(page.getByText("AGPL-3.0-or-later").first()).toBeVisible();
  await expect(page.getByText("MPL-2.0 · CC0-1.0 · Unicode-3.0", { exact: true })).toBeVisible();
  const expectedInstallCopy =
    browserName === "chromium"
      ? COPY.installTested
      : browserName === "webkit"
        ? COPY.installMac
        : COPY.installUnavailable;
  await expect(page.getByText(expectedInstallCopy, { exact: true })).toBeVisible();
  await expect(page.getByText(expectedSourceRepository, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Not configured in this development build", { exact: true }),
  ).toHaveCount(3);
  await expect(page.locator("body")).not.toContainText("<SET_");
});

test("offers a real camera restart after background suspension", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "The deterministic canvas-backed camera fixture is a Chromium contract.",
  );
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    context?.fillRect(0, 0, canvas.width, canvas.height);
    const state = { calls: 0, canvas };
    Object.assign(window, { __qrwardenFakeCamera: state });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        enumerateDevices: () => Promise.resolve([]),
        getUserMedia: () => {
          state.calls += 1;
          return Promise.resolve(canvas.captureStream(1));
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  await expect(page.getByRole("heading", { name: "Hold the QR code inside the frame" })).toBeVisible();
  await expect(page.getByText(COPY.lookingForCode, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __qrwardenFakeCamera: { calls: number } })
      .__qrwardenFakeCamera.calls,
  )).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("heading", { name: COPY.cameraPausedHeading })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const resume = page.getByRole("button", { name: COPY.resumeScanning });
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(page.getByRole("heading", { name: "Hold the QR code inside the frame" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __qrwardenFakeCamera: { calls: number } })
      .__qrwardenFakeCamera.calls,
  )).toBe(2);
});

test("shows and switches from the camera that is actually active", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "The deterministic canvas-backed camera fixture is a Chromium contract.",
  );
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    context?.fillRect(0, 0, canvas.width, canvas.height);
    const calls: string[] = [];
    let releaseConstraint: (() => void) | null = null;
    const devices: MediaDeviceInfo[] = [
      {
        deviceId: "front",
        groupId: "phone",
        kind: "videoinput",
        label: "Front camera",
        toJSON: () => ({}),
      },
      {
        deviceId: "rear",
        groupId: "phone",
        kind: "videoinput",
        label: "Rear camera",
        toJSON: () => ({}),
      },
    ];
    const streamFor = (deviceId: string): MediaStream => {
      const stream = canvas.captureStream(1);
      const track = stream.getVideoTracks()[0];
      if (track === undefined) throw new Error("Missing fixture video track");
      const getSettings = track.getSettings.bind(track);
      let zoom = 1;
      let torch = false;
      Object.defineProperty(track, "getSettings", {
        configurable: true,
        value: () => ({ ...getSettings(), deviceId, torch, zoom }),
      });
      Object.defineProperty(track, "getCapabilities", {
        configurable: true,
        value: () => ({ torch: true, zoom: { min: 1, max: 3, step: 1 } }),
      });
      Object.defineProperty(track, "applyConstraints", {
        configurable: true,
        value: (constraints: MediaTrackConstraints) => new Promise<void>((resolve) => {
          const advanced = constraints.advanced?.[0] as
            | (MediaTrackConstraintSet & { torch?: boolean; zoom?: number })
            | undefined;
          releaseConstraint = () => {
            if (typeof advanced?.zoom === "number") zoom = advanced.zoom;
            if (typeof advanced?.torch === "boolean") torch = advanced.torch;
            releaseConstraint = null;
            resolve();
          };
        }),
      });
      window.setTimeout(() => {
        context?.fillRect(0, 0, 1, 1);
        const requestFrame = (track as MediaStreamTrack & { requestFrame?: () => void })
          .requestFrame;
        requestFrame?.call(track);
      }, 0);
      return stream;
    };
    Object.assign(window, {
      __qrwardenCameraChoices: {
        calls,
        releaseConstraint: () => releaseConstraint?.(),
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        enumerateDevices: () => Promise.resolve(devices),
        getUserMedia: (constraints: MediaStreamConstraints) => {
          let deviceId = "rear";
          const video = constraints.video;
          if (typeof video === "object" && video !== null) {
            const requested = video.deviceId;
            if (typeof requested === "object" && requested !== null) {
              const exact = requested.exact;
              if (typeof exact === "string") deviceId = exact;
            }
          }
          calls.push(deviceId);
          return Promise.resolve(streamFor(deviceId));
        },
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  const camera = page.getByRole("combobox", { name: "Camera", exact: true });
  await expect(camera).toBeEnabled();
  await expect(camera).toHaveCSS("font-size", "16px");
  await expect(camera).toHaveValue("rear");
  await expect(camera.locator("option:checked")).toHaveText("Rear camera");

  const zoom = page.getByRole("slider", { name: "Zoom" });
  const torch = page.getByRole("button", { name: "Turn torch on" });
  await zoom.evaluate((input: HTMLInputElement) => {
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(camera).toBeDisabled();
  await expect(zoom).toBeDisabled();
  await expect(torch).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as {
      __qrwardenCameraChoices: { releaseConstraint: () => void };
    }).__qrwardenCameraChoices.releaseConstraint(),
  );
  await expect(camera).toBeEnabled();
  await expect(zoom).toBeEnabled();
  await expect(torch).toBeEnabled();

  await camera.selectOption("front");

  await expect(camera).toBeEnabled();
  await expect(camera).toHaveValue("front");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __qrwardenCameraChoices: { calls: string[] } })
      .__qrwardenCameraChoices.calls,
  )).toEqual(["rear", "front"]);
});

test("does not contact a decoded DNS or HTTP canary during inspection", async ({
  page,
}) => {
  const canaryRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "canary.invalid") {
      canaryRequests.push(request.url());
    }
  });

  await page.goto("/");
  await page.evaluate(() => {
    const violations: string[] = [];
    const liveAttributes = [
      "href",
      "src",
      "action",
      "poster",
      "data",
      "srcset",
      "style",
    ];
    const payload = /(?:canary\.invalid|should-stay-local)/iu;
    const inspectElement = (element: Element): void => {
      for (const name of liveAttributes) {
        const value = element.getAttribute(name);
        if (value !== null && payload.test(value)) {
          violations.push(`payload-attribute:${element.tagName}:${name}`);
        }
      }
      if (
        ["FORM", "IFRAME", "IMG", "LINK", "OBJECT", "SCRIPT", "SOURCE"].includes(
          element.tagName,
        )
      ) {
        violations.push(`node:${element.tagName}`);
      } else if (element.tagName === "A") {
        const href = element.getAttribute("href");
        if (href !== null && !href.startsWith("#")) {
          violations.push(`node:A:${href}`);
        }
      }
    };
    const inspect = (node: Node): void => {
      if (!(node instanceof Element)) return;
      inspectElement(node);
      for (const descendant of node.querySelectorAll("*")) inspectElement(descendant);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const name = record.attributeName ?? "";
          if (liveAttributes.includes(name) && record.target instanceof Element) {
            inspectElement(record.target);
          }
        }
        for (const node of record.addedNodes) inspect(node);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    Object.assign(window, { __qrwardenMutationViolations: violations });
  });
  await page.locator('input[type="file"]').setInputFiles(canaryFixture);
  await expect(page.getByText("canary.invalid", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('a[href*="canary.invalid"]')).toHaveCount(0);
  expect(canaryRequests).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __qrwardenMutationViolations: readonly string[] })
          .__qrwardenMutationViolations,
    ),
  ).toEqual([]);
});

test("enforces Trusted Types string sinks in Chromium", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Trusted Types enforcement is currently a Chromium browser contract.",
  );
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(
    "require-trusted-types-for 'script'",
  );

  const assertion = await page.evaluate(() => {
    if (window.trustedTypes === undefined) {
      return { outcome: "unsupported", supported: false } as const;
    }
    const target = document.createElement("div");
    try {
      target.innerHTML = "<b>forbidden string sink</b>";
      return { outcome: "allowed", supported: true } as const;
    } catch {
      return { outcome: "blocked", supported: true } as const;
    }
  });
  expect(assertion).toEqual({ outcome: "blocked", supported: true });
});

test("labels selection positions and drops canvas geometry when hidden", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(multiFixture);
  await expect(page.getByRole("heading", { name: "Choose a QR code" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "QR code 1, left, Web link" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "QR code 2, right, Wi-Fi details" }),
  ).toBeVisible();

  const canvas = page.locator(".selection-canvas");
  await expect(canvas).toBeVisible();
  const retainedCanvas = await canvas.elementHandle();
  expect(retainedCanvas).not.toBeNull();
  expect(await retainedCanvas?.evaluate((element) => [element.width, element.height])).not.toEqual([
    0,
    0,
  ]);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(
    page.getByRole("heading", {
      name: COPY.primaryMessage,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a QR code" })).toHaveCount(0);
  await expect(canvas).toHaveCount(0);
  expect(await retainedCanvas?.evaluate((element) => [element.width, element.height])).toEqual([
    0,
    0,
  ]);
});

test("fails closed when a selection canvas cannot acquire a 2D context", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(
        this: HTMLCanvasElement,
        contextId: string,
        ...args: unknown[]
      ): RenderingContext | null {
        if (contextId === "2d" && this.classList.contains("selection-canvas")) {
          return null;
        }
        return Reflect.apply(original, this, [contextId, ...args]) as RenderingContext | null;
      },
    });
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(multiFixture);
  await expect(
    page.getByRole("heading", { name: COPY.readerStoppedHeading }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Choose a QR code" })).toHaveCount(0);
  await expect(page.locator(".selection-canvas")).toHaveCount(0);
});

test("renders a locked shell while service-worker startup is still pending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), "getRegistration", {
      configurable: true,
      value: () => new Promise<ServiceWorkerRegistration | undefined>(() => undefined),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: COPY.primaryMessage }),
  ).toBeVisible();
  await expect(page.getByText(COPY.preparingOfflineHeading, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan with camera" })).toBeDisabled();
  await expect(page.locator('input[type="file"]')).toBeDisabled();
});

test("keeps scanner controls usable when service-worker storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), "getRegistration", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Storage blocked", "SecurityError")),
    });
  });

  await page.goto("/");

  await expect(page.getByText("Offline setup incomplete.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan with camera" })).toBeEnabled();
  await expect(page.locator('input[type="file"]')).toBeEnabled();
});

test("reports a blocked decoder worker instead of hanging", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), "getRegistration", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Storage blocked", "SecurityError")),
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: function BlockedWorker(): never {
        throw new DOMException("Worker blocked", "SecurityError");
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Scan with camera" }).click();

  await expect(
    page.getByRole("heading", { name: COPY.readerStoppedHeading }),
  ).toBeVisible();
});

test("serves the closed production response contract", async ({ page, request }) => {
  const root = await page.goto("/");
  expect(root?.status()).toBe(200);
  const headers = root?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["content-security-policy"]).toContain(
    "require-trusted-types-for 'script'",
  );
  expect(headers["permissions-policy"]).toBe(expectedPermissionsPolicy);
  expect(headers["x-qrwarden-release"]).toMatch(
    /^v0\.1\.0\+[0-9a-f]{40}$/,
  );

  const canonical = await request.get("/index.html", { maxRedirects: 0 });
  expect(canonical.status()).toBe(307);
  expect(canonical.headers().location).toBe("/");
  expect((await request.get("/not-in-contract")).status()).toBe(404);
  expect((await request.get("/_headers")).status()).toBe(404);
});

test("reaches a controlled offline-ready shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Ready offline.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
});

test("cold-launches the verified shell while offline", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit cannot reliably emulate an offline navigation; physical Safari remains the release gate.",
  );
  await page.goto("/");
  await expect(page.getByText("Ready offline.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.close();
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  await offlinePage.goto("http://127.0.0.1:4173/");
  await expect(
    offlinePage.getByRole("heading", {
      name: COPY.primaryMessage,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    offlinePage.getByText("Ready offline.", { exact: true }),
  ).toBeVisible();
});
