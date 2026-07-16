import { afterEach, describe, expect, it, vi } from "vitest";

import { registrableDomain } from "../../src/analyzer/publicSuffix";
import { PUBLIC_SUFFIX_SNAPSHOT } from "../../src/data/publicSuffixSnapshot";

afterEach(() => {
  vi.doUnmock("../../src/data/publicSuffixSnapshot");
  vi.resetModules();
});

describe("complete Public Suffix List snapshot", () => {
  it("pins the complete canonical snapshot and canonicalizes Unicode rules", () => {
    expect(PUBLIC_SUFFIX_SNAPSHOT).toMatchObject({
      sourceVersion: "2026-07-14_09-26-39_UTC",
      sourceCommit: "f8d153aafe2dd6aa1c27cfdabaeb41b90ece3d48",
      sourceSha256: "bd9a62671db32654cfdc5a1eaf57f4c410943d81a7edb1e876f91c0b642e23d8",
      completeness: "complete",
    });
    expect(PUBLIC_SUFFIX_SNAPSHOT.icannRules).toHaveLength(6_923);
    expect(PUBLIC_SUFFIX_SNAPSHOT.privateRules).toHaveLength(3_034);
    expect(PUBLIC_SUFFIX_SNAPSHOT.wildcardRules).toHaveLength(16);
    expect(PUBLIC_SUFFIX_SNAPSHOT.privateWildcardRules).toHaveLength(267);
    expect(PUBLIC_SUFFIX_SNAPSHOT.exceptionRules).toHaveLength(8);
    expect(PUBLIC_SUFFIX_SNAPSHOT.privateExceptionRules).toHaveLength(0);
    expect(PUBLIC_SUFFIX_SNAPSHOT.icannRules).toContain("xn--55qx5d.cn");
  });

  it("resolves exact, wildcard, and exception rules with the correct section", () => {
    expect(registrableDomain("www.example.com")).toEqual({
      registrableDomain: "example.com",
      publicSuffix: "com",
      section: "icann",
    });
    expect(registrableDomain("a.foo.ck")).toEqual({
      registrableDomain: "a.foo.ck",
      publicSuffix: "foo.ck",
      section: "icann",
    });
    expect(registrableDomain("a.www.ck")).toEqual({
      registrableDomain: "www.ck",
      publicSuffix: "ck",
      section: "icann",
    });
    expect(registrableDomain("foo.github.io")).toEqual({
      registrableDomain: "foo.github.io",
      publicSuffix: "github.io",
      section: "private",
    });
    expect(registrableDomain("app.tenant.compute.amazonaws.com")).toEqual({
      registrableDomain: "app.tenant.compute.amazonaws.com",
      publicSuffix: "tenant.compute.amazonaws.com",
      section: "private",
    });
  });

  it("keeps unknown suffixes on the prevailing default rule", () => {
    expect(registrableDomain("www.example.invalid-local-tld")).toEqual({
      registrableDomain: "example.invalid-local-tld",
      publicSuffix: "invalid-local-tld",
      section: "default",
    });
  });
});

describe("PRIVATE exception behavior", () => {
  it("returns the PRIVATE section for synthetic private wildcard and exception rules", async () => {
    vi.resetModules();
    vi.doMock("../../src/data/publicSuffixSnapshot", () => ({
      PUBLIC_SUFFIX_SNAPSHOT: {
        icannRules: ["test"],
        privateRules: [],
        wildcardRules: [],
        privateWildcardRules: ["private.test"],
        exceptionRules: [],
        privateExceptionRules: ["city.private.test"],
      },
    }));
    const mocked = await import("../../src/analyzer/publicSuffix");

    expect(mocked.registrableDomain("app.tenant.private.test")).toEqual({
      registrableDomain: "app.tenant.private.test",
      publicSuffix: "tenant.private.test",
      section: "private",
    });
    expect(mocked.registrableDomain("app.city.private.test")).toEqual({
      registrableDomain: "city.private.test",
      publicSuffix: "private.test",
      section: "private",
    });
  });
});
