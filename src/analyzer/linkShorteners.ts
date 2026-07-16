import { registrableDomain } from "./publicSuffix";

/**
 * Registrable domains whose primary function is redirecting visitors to an
 * arbitrary destination chosen by whoever created the short link. The list is
 * first-party pinned data: only widely documented general-purpose shortening
 * services (including QR-focused ones) qualify, never domains that merely
 * happen to be short. Matching is evidence, not reputation — the signal states
 * that the destination is hidden, not that it is harmful.
 */
const LINK_SHORTENER_DOMAINS: ReadonlySet<string> = new Set([
  "bit.do",
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "dlvr.it",
  "goo.gl",
  "is.gd",
  "j.mp",
  "lnkd.in",
  "me-qr.com",
  "ow.ly",
  "qrco.de",
  "rb.gy",
  "rebrand.ly",
  "s.id",
  "shorturl.at",
  "t.co",
  "t.ly",
  "tiny.cc",
  "tinyurl.com",
  "trib.al",
  "v.gd",
]);

/**
 * Returns the matched shortener domain for an ASCII hostname, or null. The
 * exact host is checked as well as its registrable domain so a missing or
 * incomplete public-suffix entry fails toward still recognizing the service.
 */
export function matchLinkShortener(asciiHostname: string): string | null {
  const host = asciiHostname.replace(/\.$/, "").toLowerCase();
  if (LINK_SHORTENER_DOMAINS.has(host)) {
    return host;
  }
  const registrable = registrableDomain(host).registrableDomain;
  if (registrable !== null && LINK_SHORTENER_DOMAINS.has(registrable)) {
    return registrable;
  }
  return null;
}
