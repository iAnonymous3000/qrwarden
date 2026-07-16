import { describe, expect, it } from "vitest";

import { detectBraveIos, isIosUserAgent } from "../../src/render/braveGuidance";

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPADOS_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

describe("Brave iOS detection", () => {
  it("classifies iOS-family user agents including desktop-mode iPadOS", () => {
    expect(isIosUserAgent(IOS_SAFARI_UA)).toBe(true);
    expect(isIosUserAgent(IPADOS_DESKTOP_UA)).toBe(true);
    expect(isIosUserAgent(MAC_SAFARI_UA)).toBe(false);
  });

  it("detects Brave only when the async marker resolves true on an iOS agent", async () => {
    await expect(
      detectBraveIos({
        userAgent: IOS_SAFARI_UA,
        brave: { isBrave: () => Promise.resolve(true) },
      }),
    ).resolves.toBe(true);

    await expect(
      detectBraveIos({
        userAgent: MAC_SAFARI_UA,
        brave: { isBrave: () => Promise.resolve(true) },
      }),
    ).resolves.toBe(false);

    await expect(
      detectBraveIos({ userAgent: IOS_SAFARI_UA }),
    ).resolves.toBe(false);
  });

  it("fails closed when the marker rejects, throws, or returns a non-boolean", async () => {
    await expect(
      detectBraveIos({
        userAgent: IOS_SAFARI_UA,
        brave: { isBrave: () => Promise.reject(new Error("blocked")) },
      }),
    ).resolves.toBe(false);

    await expect(
      detectBraveIos({
        userAgent: IOS_SAFARI_UA,
        brave: {
          isBrave: () => {
            throw new Error("sync failure");
          },
        },
      }),
    ).resolves.toBe(false);

    await expect(
      detectBraveIos({
        userAgent: IOS_SAFARI_UA,
        brave: { isBrave: () => Promise.resolve("yes") },
      }),
    ).resolves.toBe(false);
  });
});
