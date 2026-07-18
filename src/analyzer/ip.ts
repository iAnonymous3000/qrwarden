import { IANA_SPECIAL_PURPOSE_SNAPSHOT } from "../data/ianaSpecialPurposeSnapshot";

export interface IpClassification {
  readonly version: 4 | 6;
  readonly canonical: string;
  readonly special: boolean;
  readonly globallyReachable: boolean;
  readonly category?: string;
  readonly mappedIpv4?: IpClassification;
}

// Pinned from the IANA Special-Use Domain Names registry captured 2026-05-22.
// The registry designates each listed name and all of its subdomains. More
// specific local names below retain their plain-language category labels.
const IANA_SPECIAL_USE_SUFFIXES: readonly string[] = Object.freeze([
  "alt",
  "6tisch.arpa",
  "eap.arpa",
  "eap-noob.arpa",
  "10.in-addr.arpa",
  ...Array.from({ length: 16 }, (_, index) => `${index + 16}.172.in-addr.arpa`),
  "254.169.in-addr.arpa",
  "170.0.0.192.in-addr.arpa",
  "171.0.0.192.in-addr.arpa",
  "168.192.in-addr.arpa",
  "8.e.f.ip6.arpa",
  "9.e.f.ip6.arpa",
  "a.e.f.ip6.arpa",
  "b.e.f.ip6.arpa",
  "ipv4only.arpa",
  "resolver.arpa",
  "service.arpa",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "onion",
  "test",
]);
function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function parseIpv6(input: string): bigint | null {
  let value = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  if (zone >= 0) return null;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const v4 = parseIpv4(value.slice(lastColon + 1));
    if (lastColon < 0 || v4 === null) return null;
    value = `${value.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(
      v4 & 0xffff
    ).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function matches(value: bigint, prefix: bigint, bits: number, width: number): boolean {
  if (bits === 0) return true;
  const shift = BigInt(width - bits);
  return value >> shift === prefix >> shift;
}

function parsePinnedIpv4(prefix: string): bigint {
  const parsed = parseIpv4(prefix);
  if (parsed === null) {
    throw new TypeError(`Invalid pinned IANA IPv4 prefix: ${prefix}`);
  }
  return BigInt(parsed);
}

function parsePinnedIpv6(prefix: string): bigint {
  const parsed = parseIpv6(prefix);
  if (parsed === null) {
    throw new TypeError(`Invalid pinned IANA IPv6 prefix: ${prefix}`);
  }
  return parsed;
}

const IPV4_RANGES = IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv4
  .map(([prefix, bits, category, globallyReachable]) => ({
    prefix: parsePinnedIpv4(prefix),
    bits,
    category,
    globallyReachable,
  }))
  .sort((left, right) => right.bits - left.bits);

const IPV6_RANGES = IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv6
  .map(([prefix, bits, category, globallyReachable]) => ({
    prefix: parsePinnedIpv6(prefix),
    bits,
    category,
    globallyReachable,
  }))
  .sort((left, right) => right.bits - left.bits);

const NAT64_WELL_KNOWN_PREFIX = parsePinnedIpv6("64:ff9b::");

function classifyIpv4(value: number): IpClassification {
  const match = IPV4_RANGES.find((range) => matches(BigInt(value), range.prefix, range.bits, 32));
  return {
    version: 4,
    canonical: ipv4Text(value),
    special: match !== undefined,
    globallyReachable: match?.globallyReachable ?? true,
    ...(match === undefined ? {} : { category: match.category }),
  };
}

export function classifyIp(hostname: string): IpClassification | null {
  const unbracketed = hostname.replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(unbracketed);
  if (v4 !== null) return classifyIpv4(v4);

  const v6 = parseIpv6(unbracketed);
  if (v6 === null) return null;
  const mappedPrefix = v6 >> 32n;
  if (mappedPrefix === 0xffffn) {
    const mapped = classifyIpv4(Number(v6 & 0xffff_ffffn));
    return {
      version: 6,
      canonical: unbracketed,
      special: mapped.special,
      globallyReachable: mapped.globallyReachable,
      ...(mapped.category === undefined
        ? {}
        : { category: `IPv4-mapped: ${mapped.category}` }),
      mappedIpv4: mapped,
    };
  }

  // RFC 6052's well-known /96 prefix carries an IPv4 address in the low
  // 32 bits. Preserve the IPv6 registry classification for ordinary public
  // destinations, but let a non-global embedded IPv4 address make the
  // translated destination non-global as well.
  if (matches(v6, NAT64_WELL_KNOWN_PREFIX, 96, 128)) {
    const mapped = classifyIpv4(Number(v6 & 0xffff_ffffn));
    return {
      version: 6,
      canonical: unbracketed,
      special: true,
      globallyReachable: mapped.globallyReachable,
      category:
        mapped.category === undefined
          ? "IPv4-IPv6 Translat."
          : `NAT64: ${mapped.category}`,
      mappedIpv4: mapped,
    };
  }

  const match = IPV6_RANGES.find((range) => matches(v6, range.prefix, range.bits, 128));
  return {
    version: 6,
    canonical: unbracketed,
    special: match !== undefined,
    globallyReachable: match?.globallyReachable ?? true,
    ...(match === undefined ? {} : { category: match.category }),
  };
}

export function classifyLocalHostname(hostname: string): string | null {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  if (value === "") return null;
  if (value === "localhost" || value.endsWith(".localhost")) return "Localhost";
  if (value === "local" || value.endsWith(".local")) return "Multicast DNS .local";
  if (value === "home.arpa" || value.endsWith(".home.arpa")) return "Home network home.arpa";
  const specialUse = IANA_SPECIAL_USE_SUFFIXES.find(
    (suffix) => value === suffix || value.endsWith(`.${suffix}`),
  );
  if (specialUse !== undefined) return `IANA special-use ${specialUse}`;
  if (!value.includes(".")) return "Dotless hostname";
  return null;
}
