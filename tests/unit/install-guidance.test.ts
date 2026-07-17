import { describe, expect, it } from "vitest";

import { COPY } from "../../src/copy";
import { detectInstallGuidance } from "../../src/render/installGuidance";

describe("install guidance", () => {
  it.each([
    [
      "iOS takes precedence over its embedded Chromium token",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1",
      "ios",
      COPY.installIphoneHeading,
      COPY.installIphone,
    ],
    [
      "iPadOS desktop mode still uses Home Screen guidance",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.6 Mobile/15E148 Safari/604.1",
      "ios",
      COPY.installIphoneHeading,
      COPY.installIphone,
    ],
    [
      "Mac Safari uses the Dock guidance",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15",
      "mac-safari",
      COPY.installMacHeading,
      COPY.installMac,
    ],
    [
      "desktop Chromium uses the tested install path",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      "tested-browser",
      COPY.installTestedHeading,
      COPY.installTested,
    ],
    [
      "Android uses the tested install path",
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) Gecko/20100101 Firefox/132.0",
      "tested-browser",
      COPY.installTestedHeading,
      COPY.installTested,
    ],
    [
      "Android WebViews have no install UI, so guidance fails closed",
      "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
      "unavailable",
      COPY.installUnavailableHeading,
      COPY.installUnavailable,
    ],
    [
      "unsupported desktop browsers stay explicit",
      "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      "unavailable",
      COPY.installUnavailableHeading,
      COPY.installUnavailable,
    ],
  ] as const)("%s", (_label, userAgent, kind, heading, body) => {
    expect(detectInstallGuidance(userAgent, false)).toEqual({ kind, heading, body });
  });

  it("says already installed regardless of the user agent", () => {
    const userAgents = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ];
    for (const userAgent of userAgents) {
      expect(detectInstallGuidance(userAgent, true)).toEqual({
        kind: "installed",
        heading: COPY.installInstalledHeading,
        body: COPY.installInstalled,
      });
    }
  });

  it("names the macOS Sonoma requirement instead of promising the menu", () => {
    // Safari's frozen user agent cannot distinguish macOS versions, so the
    // Dock guidance must state its requirement rather than assert the menu
    // exists (docs/BROWSER_SUPPORT.md floors Safari at 16.4, pre-Sonoma).
    expect(COPY.installMac).toContain("macOS Sonoma or later");
  });
});
