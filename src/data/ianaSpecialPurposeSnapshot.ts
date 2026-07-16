export interface Ipv4SpecialRange {
  readonly prefix: string;
  readonly bits: number;
  readonly category: string;
  readonly globallyReachable: boolean;
}

export interface Ipv6SpecialRange {
  readonly prefix: string;
  readonly bits: number;
  readonly category: string;
  readonly globallyReachable: boolean;
}

/**
 * Generated from IANA protocol registry data made available under CC0-1.0.
 * See data-src/iana/provenance.json. Do not edit manually.
 */
export const IANA_SPECIAL_PURPOSE_SNAPSHOT = Object.freeze({
  sourceV4: "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv",
  sourceV6: "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv",
  supplementalSourceV4: "https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv",
  supplementalSourceV6: "https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space-1.csv",
  sourceVersionV4: "2025-10-09",
  sourceVersionV6: "2025-10-09",
  sourceSha256V4: "e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73",
  sourceSha256V6: "775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139",
  sourceSetSha256: "30a9207bb7946ec8268982290044fd60e86b4ca7691235267b46662728b256ed",
  captured: "2026-07-15",
  completeness: "complete" as const,
  ipv4: Object.freeze([
    ["0.0.0.0", 32, "\"This host on this network\"", false],
    ["0.0.0.0", 8, "\"This network\"", false],
    ["10.0.0.0", 8, "Private-Use", false],
    ["100.64.0.0", 10, "Shared Address Space", false],
    ["127.0.0.0", 8, "Loopback", false],
    ["169.254.0.0", 16, "Link Local", false],
    ["172.16.0.0", 12, "Private-Use", false],
    ["192.0.0.0", 29, "IPv4 Service Continuity Prefix", false],
    ["192.0.0.0", 24, "IETF Protocol Assignments", false],
    ["192.0.0.8", 32, "IPv4 dummy address", false],
    ["192.0.0.9", 32, "Port Control Protocol Anycast", true],
    ["192.0.0.10", 32, "Traversal Using Relays around NAT Anycast", true],
    ["192.0.0.170", 32, "NAT64/DNS64 Discovery", false],
    ["192.0.0.171", 32, "NAT64/DNS64 Discovery", false],
    ["192.0.2.0", 24, "Documentation (TEST-NET-1)", false],
    ["192.31.196.0", 24, "AS112-v4", true],
    ["192.52.193.0", 24, "AMT", true],
    ["192.88.99.0", 24, "Deprecated (6to4 Relay Anycast)", false],
    ["192.88.99.2", 32, "6a44-relay anycast address", false],
    ["192.168.0.0", 16, "Private-Use", false],
    ["192.175.48.0", 24, "Direct Delegation AS112 Service", true],
    ["198.18.0.0", 15, "Benchmarking", false],
    ["198.51.100.0", 24, "Documentation (TEST-NET-2)", false],
    ["203.0.113.0", 24, "Documentation (TEST-NET-3)", false],
    ["224.0.0.0", 4, "Multicast", false],
    ["240.0.0.0", 4, "Reserved", false],
    ["255.255.255.255", 32, "Limited Broadcast", false],
  ] as const),
  ipv6: Object.freeze([
    ["::", 128, "Unspecified Address", false],
    ["::1", 128, "Loopback Address", false],
    ["::ffff:0:0", 96, "IPv4-mapped Address", false],
    ["64:ff9b::", 96, "IPv4-IPv6 Translat.", true],
    ["64:ff9b:1::", 48, "IPv4-IPv6 Translat.", false],
    ["100::", 64, "Discard-Only Address Block", false],
    ["100:0:0:1::", 64, "Dummy IPv6 Prefix", false],
    ["2001::", 32, "TEREDO", false],
    ["2001::", 23, "IETF Protocol Assignments", false],
    ["2001:1::1", 128, "Port Control Protocol Anycast", true],
    ["2001:1::2", 128, "Traversal Using Relays around NAT Anycast", true],
    ["2001:1::3", 128, "DNS-SD Service Registration Protocol Anycast", true],
    ["2001:2::", 48, "Benchmarking", false],
    ["2001:3::", 32, "AMT", true],
    ["2001:4:112::", 48, "AS112-v6", true],
    ["2001:10::", 28, "Deprecated (previously ORCHID)", false],
    ["2001:20::", 28, "ORCHIDv2", true],
    ["2001:30::", 28, "Drone Remote ID Protocol Entity Tags (DETs) Prefix", true],
    ["2001:db8::", 32, "Documentation", false],
    ["2002::", 16, "6to4", false],
    ["2620:4f:8000::", 48, "Direct Delegation AS112 Service", true],
    ["3fff::", 20, "Documentation", false],
    ["5f00::", 16, "Segment Routing (SRv6) SIDs", false],
    ["fc00::", 7, "Unique-Local", false],
    ["fe80::", 10, "Link-Local Unicast", false],
    ["ff00::", 8, "Multicast", false],
  ] as const),
});
