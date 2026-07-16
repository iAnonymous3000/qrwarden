import { IANA_SPECIAL_PURPOSE_SNAPSHOT } from "../data/ianaSpecialPurposeSnapshot";

export interface IpClassification {
  readonly version: 4 | 6;
  readonly canonical: string;
  readonly special: boolean;
  readonly globallyReachable: boolean;
  readonly category?: string;
  readonly mappedIpv4?: IpClassification;
}
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

const IPV4_RANGES = IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv4
  .map(([prefix, bits, category, globallyReachable]) => ({
    prefix: BigInt(parseIpv4(prefix) ?? 0),
    bits,
    category,
    globallyReachable,
  }))
  .sort((left, right) => right.bits - left.bits);

const IPV6_RANGES = IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv6
  .map(([prefix, bits, category, globallyReachable]) => ({
    prefix: parseIpv6(prefix) ?? 0n,
    bits,
    category,
    globallyReachable,
  }))
  .sort((left, right) => right.bits - left.bits);

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
  if (value === "localhost" || value.endsWith(".localhost")) return "Localhost";
  if (value === "local" || value.endsWith(".local")) return "Multicast DNS .local";
  if (value === "home.arpa" || value.endsWith(".home.arpa")) return "Home network home.arpa";
  return null;
}
