import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildIanaSpecialPurposeSnapshot,
  parseCsv,
  parseRegistryUpdated,
  parseSpecialPurposeRegistry,
} from "../../scripts/build-data/iana-special-purpose.mjs";
import {
  buildPublicSuffixSnapshot,
  parsePublicSuffixList,
} from "../../scripts/build-data/public-suffix.mjs";
import { writeGeneratedFile } from "../../scripts/build-data/shared.mjs";
import { buildUnicodeSnapshot } from "../../scripts/build-data/unicode.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function pslFixture(privateRules = "private.test\n*.private.test\n!city.private.test") {
  return [
    "// VERSION: 2026-07-15_00-00-00_UTC",
    `// COMMIT: ${"a".repeat(40)}`,
    "// ===BEGIN ICANN DOMAINS===",
    "com",
    "*.ck",
    "!www.ck",
    "公司.cn",
    "// ===END ICANN DOMAINS===",
    "// ===BEGIN PRIVATE DOMAINS===",
    privateRules,
    "// ===END PRIVATE DOMAINS===",
    "",
  ].join("\n");
}

const specialHeader = [
  "Address Block",
  "Name",
  "RFC",
  "Allocation Date",
  "Termination Date",
  "Source",
  "Destination",
  "Forwardable",
  "Globally Reachable",
  "Reserved-by-Protocol",
].join(",");

describe("pinned data generation", () => {
  it("verifies the current generated snapshots without changing them", async () => {
    const pslUrl = new URL("../../src/data/publicSuffixSnapshot.ts", import.meta.url);
    const ianaUrl = new URL("../../src/data/ianaSpecialPurposeSnapshot.ts", import.meta.url);
    const unicodeUrl = new URL("../../src/data/unicodeSnapshot.ts", import.meta.url);
    const before = await Promise.all([
      readFile(pslUrl),
      readFile(ianaUrl),
      readFile(unicodeUrl),
    ]);

    const [psl, iana, unicode] = await Promise.all([
      buildPublicSuffixSnapshot({ check: true }),
      buildIanaSpecialPurposeSnapshot({ check: true }),
      buildUnicodeSnapshot({ check: true }),
    ]);

    expect(psl).toMatchObject({
      sourceVersion: "2026-07-14_09-26-39_UTC",
      sourceCommit: "f8d153aafe2dd6aa1c27cfdabaeb41b90ece3d48",
    });
    expect(psl.provenance.license).toMatchObject({
      expression: "MPL-2.0",
      sha256: "66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172",
    });
    expect(iana.ipv4).toHaveLength(27);
    expect(iana.ipv6).toHaveLength(26);
    expect(iana.provenance).toMatchObject({
      sourceSetSha256: "30a9207bb7946ec8268982290044fd60e86b4ca7691235267b46662728b256ed",
      license: {
        expression: "CC0-1.0",
        sha256: "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
      },
    });
    expect(unicode).toMatchObject({
      sourceSetSha256: "0b98ba743b2ad8b628ca0366802653154ecd7f528125641dadec73f6b0b4aa35",
      packedByteLength: 149_508,
    });
    const after = await Promise.all([
      readFile(pslUrl),
      readFile(ianaUrl),
      readFile(unicodeUrl),
    ]);
    expect(after).toEqual(before);
  });

  it("makes check mode fail without rewriting a stale output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qrwarden-data-check-"));
    temporaryDirectories.push(directory);
    const output = pathToFileURL(path.join(directory, "snapshot.ts"));
    await writeFile(output, "stale\n");

    await expect(writeGeneratedFile(output, "expected\n", true)).rejects.toThrow(
      "is not the deterministic generated output",
    );
    await expect(readFile(output, "utf8")).resolves.toBe("stale\n");
  });
});

describe("Public Suffix List parser", () => {
  it("separates ICANN and PRIVATE exact, wildcard, and exception rules", () => {
    const parsed = parsePublicSuffixList(pslFixture());

    expect(parsed.icannRules).toEqual(["com", "xn--55qx5d.cn"]);
    expect(parsed.wildcardRules).toEqual(["*.ck"]);
    expect(parsed.exceptionRules).toEqual(["!www.ck"]);
    expect(parsed.privateRules).toEqual(["private.test"]);
    expect(parsed.privateWildcardRules).toEqual(["*.private.test"]);
    expect(parsed.privateExceptionRules).toEqual(["!city.private.test"]);
  });

  it("fails closed on duplicate, malformed, or truncated source data", () => {
    expect(() => parsePublicSuffixList(pslFixture("private.test\nprivate.test"))).toThrow(
      "duplicates private.test",
    );
    expect(() => parsePublicSuffixList(pslFixture("bad domain"))).toThrow(
      "invalid rule syntax",
    );
    expect(() => parsePublicSuffixList(pslFixture("_bad.private.test"))).toThrow(
      "invalid label",
    );
    expect(() => parsePublicSuffixList(pslFixture(" private.test"))).toThrow(
      "surrounding whitespace",
    );
    expect(() => parsePublicSuffixList(pslFixture("!orphan.private.test"))).toThrow(
      "has no matching wildcard rule",
    );
    expect(() =>
      parsePublicSuffixList(pslFixture().replace("// ===END PRIVATE DOMAINS===\n", "")),
    ).toThrow("missing or truncates a required section");
  });
});

describe("IANA registry parser", () => {
  it("parses quoted commas/newlines and rejects malformed CSV quoting", () => {
    expect(parseCsv('one,two\r\n"a,b","line 1\r\nline 2"\r\n')).toEqual([
      ["one", "two"],
      ["a,b", "line 1\nline 2"],
    ]);
    expect(() => parseCsv('one,two\r\n"unterminated,value\r\n')).toThrow(
      "ends inside a quoted field",
    );
    expect(() => parseCsv("one,two\rbare")).toThrow("bare carriage return");
  });

  it("expands multi-prefix rows and preserves the registry name and reachability", () => {
    const source = [
      specialHeader,
      '"192.0.0.170/32, 192.0.0.171/32",NAT64/DNS64 Discovery,[RFC7050],2013-02,N/A,True,True,False,False [1],False',
      "",
    ].join("\r\n");

    expect(parseSpecialPurposeRegistry(source, 4)).toEqual([
      {
        prefix: "192.0.0.170",
        bits: 32,
        numeric: 3_221_225_642n,
        category: "NAT64/DNS64 Discovery",
        globallyReachable: false,
      },
      {
        prefix: "192.0.0.171",
        bits: 32,
        numeric: 3_221_225_643n,
        category: "NAT64/DNS64 Discovery",
        globallyReachable: false,
      },
    ]);
  });

  it("fails closed on invalid booleans, unaligned prefixes, and ambiguous XML versions", () => {
    const invalidBoolean = [
      specialHeader,
      "192.0.2.0/24,Documentation,[RFC5737],2010-01,N/A,True,True,True,Maybe,False",
      "",
    ].join("\r\n");
    expect(() => parseSpecialPurposeRegistry(invalidBoolean, 4)).toThrow(
      "invalid boolean value",
    );

    const unaligned = [
      specialHeader,
      "192.0.2.1/24,Documentation,[RFC5737],2010-01,N/A,True,True,True,False,False",
      "",
    ].join("\r\n");
    expect(() => parseSpecialPurposeRegistry(unaligned, 4)).toThrow("not network-aligned");
    expect(() =>
      parseRegistryUpdated(
        "<registry><updated>2025-01-01</updated><updated>2025-01-02</updated></registry>",
        "fixture",
      ),
    ).toThrow("exactly one updated date");
  });
});
