/**
 * Requires both a browser-trusted event and a currently active user gesture.
 * Browsers without User Activation v2 retain the trusted-event compatibility
 * path used by both action brokers.
 */
export function hasTrustedUserActivation(
  event: Pick<Event, "isTrusted">,
): boolean {
  if (!event.isTrusted) return false;
  if (!("userActivation" in navigator) || navigator.userActivation === null) {
    return true;
  }
  return navigator.userActivation.isActive;
}
