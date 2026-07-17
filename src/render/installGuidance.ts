import { COPY } from "../copy";

export interface InstallGuidance {
  readonly heading: string;
  readonly body: string;
  readonly kind: "ios" | "mac-safari" | "tested-browser" | "unavailable";
}

export function detectInstallGuidance(userAgent: string): InstallGuidance {
  if (/iPhone|iPad|iPod/u.test(userAgent) || /Macintosh.*Mobile/u.test(userAgent)) {
    return {
      heading: COPY.installIphoneHeading,
      body: COPY.installIphone,
      kind: "ios",
    };
  }
  if (
    /Macintosh/u.test(userAgent) &&
    /Safari/u.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR/u.test(userAgent)
  ) {
    return {
      heading: COPY.installMacHeading,
      body: COPY.installMac,
      kind: "mac-safari",
    };
  }
  if (/Android|Chrome|Chromium|CriOS|Edg(?:A|iOS)?\//u.test(userAgent)) {
    return {
      heading: COPY.installTestedHeading,
      body: COPY.installTested,
      kind: "tested-browser",
    };
  }
  return {
    heading: COPY.installUnavailableHeading,
    body: COPY.installUnavailable,
    kind: "unavailable",
  };
}
