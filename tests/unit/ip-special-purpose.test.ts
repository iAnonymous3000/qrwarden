import { describe, expect, it } from "vitest";

import { classifyIp } from "../../src/analyzer/ip";
import { IANA_SPECIAL_PURPOSE_SNAPSHOT } from "../../src/data/ianaSpecialPurposeSnapshot";

describe("complete IANA special-purpose snapshot", () => {
  it("pins the complete IPv4 and IPv6 registries", () => {
    expect(IANA_SPECIAL_PURPOSE_SNAPSHOT).toMatchObject({
      sourceVersionV4: "2025-10-09",
      sourceVersionV6: "2025-10-09",
      sourceSha256V4: "e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73",
      sourceSha256V6: "775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139",
      completeness: "complete",
    });
    expect(IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv4).toHaveLength(27);
    expect(IANA_SPECIAL_PURPOSE_SNAPSHOT.ipv6).toHaveLength(26);
  });

  it.each([
    ["192.0.0.8", "IPv4 dummy address", false],
    ["192.0.0.9", "Port Control Protocol Anycast", true],
    ["192.0.0.171", "NAT64/DNS64 Discovery", false],
    ["192.31.196.1", "AS112-v4", true],
    ["100:0:0:1::1", "Dummy IPv6 Prefix", false],
    ["2001:30::1", "Drone Remote ID Protocol Entity Tags (DETs) Prefix", true],
    ["224.1.2.3", "Multicast", false],
    ["ff02::1", "Multicast", false],
  ] as const)("classifies %s using the longest matching pinned prefix", (address, category, reachable) => {
    expect(classifyIp(address)).toMatchObject({
      special: true,
      category,
      globallyReachable: reachable,
    });
  });

  it("leaves ordinary globally reachable addresses outside the special registries", () => {
    expect(classifyIp("8.8.8.8")).toMatchObject({
      special: false,
      globallyReachable: true,
    });
  });
});
