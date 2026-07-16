import { afterEach, describe, expect, it, vi } from "vitest";

const SNAPSHOT_MODULE = "../../src/data/ianaSpecialPurposeSnapshot";

function installSnapshot(
  ipv4: readonly (readonly [string, number, string, boolean])[],
  ipv6: readonly (readonly [string, number, string, boolean])[],
): void {
  vi.doMock(SNAPSHOT_MODULE, () => ({
    IANA_SPECIAL_PURPOSE_SNAPSHOT: Object.freeze({
      ipv4: Object.freeze(ipv4),
      ipv6: Object.freeze(ipv6),
    }),
  }));
}

afterEach(() => {
  vi.doUnmock(SNAPSHOT_MODULE);
  vi.resetModules();
});

describe("invalid pinned IANA prefixes", () => {
  it("rejects an invalid IPv4 prefix instead of treating it as 0.0.0.0", async () => {
    installSnapshot(
      [["not-an-ipv4-address", 32, "Invalid IPv4 range", false]],
      [["::1", 128, "Loopback Address", false]],
    );

    await expect(import("../../src/analyzer/ip")).rejects.toThrow(
      "Invalid pinned IANA IPv4 prefix",
    );
  });

  it("rejects an invalid IPv6 prefix instead of treating it as ::", async () => {
    installSnapshot(
      [["127.0.0.0", 8, "Loopback", false]],
      [["not-an-ipv6-address", 128, "Invalid IPv6 range", false]],
    );

    await expect(import("../../src/analyzer/ip")).rejects.toThrow(
      "Invalid pinned IANA IPv6 prefix",
    );
  });
});
