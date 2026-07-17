import { COPY } from "../copy";

export interface InstallGuidance {
  readonly heading: string;
  readonly body: string;
  readonly kind: "installed" | "ios" | "mac-safari" | "tested-browser" | "unavailable";
}

export function detectInstallGuidance(
  userAgent: string,
  alreadyInstalled: boolean,
): InstallGuidance {
  // An installed app window needs no install steps, and its user agent is
  // identical to the browser tab's, so the caller passes the display-mode
  // signal explicitly.
  if (alreadyInstalled) {
    return {
      heading: COPY.installInstalledHeading,
      body: COPY.installInstalled,
      kind: "installed",
    };
  }
  // Android WebViews advertise a browser user agent but expose no browser
  // menu or install UI, so browser guidance would be impossible to follow.
  if (/; wv\)/u.test(userAgent)) {
    return {
      heading: COPY.installUnavailableHeading,
      body: COPY.installUnavailable,
      kind: "unavailable",
    };
  }
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
