/**
 * Brave on iOS masquerades as Safari in its user agent but injects an async
 * `navigator.brave.isBrave()` marker. iOS grants the camera to the Brave app
 * as a whole, and Brave has no per-site permission UI, so a denied app-level
 * permission is the dominant "camera never prompts" failure there. Detection
 * only ever adds one guidance sentence; it grants no capability.
 */

interface BraveMarker {
  readonly isBrave?: () => Promise<unknown>;
}

export interface BraveNavigatorLike {
  readonly userAgent: string;
  readonly brave?: BraveMarker;
}

export function isIosUserAgent(userAgent: string): boolean {
  return /iPhone|iPad|iPod/u.test(userAgent) || /Macintosh.*Mobile/u.test(userAgent);
}

export async function detectBraveIos(
  navigatorLike: BraveNavigatorLike,
): Promise<boolean> {
  const isBrave = navigatorLike.brave?.isBrave;
  if (typeof isBrave !== "function" || !isIosUserAgent(navigatorLike.userAgent)) {
    return false;
  }
  try {
    return (await isBrave.call(navigatorLike.brave)) === true;
  } catch {
    return false;
  }
}
