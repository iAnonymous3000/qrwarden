import { describe, expect, it, vi } from "vitest";

import { hasTrustedUserActivation } from "../../src/action/userActivation";

describe("trusted user activation policy", () => {
  it("always rejects synthetic events", () => {
    vi.stubGlobal("navigator", {});

    expect(hasTrustedUserActivation({ isTrusted: false })).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["null", { userActivation: null }],
  ])("keeps the trusted-event compatibility path when activation is %s", (_label, value) => {
    vi.stubGlobal("navigator", value);

    expect(hasTrustedUserActivation({ isTrusted: true })).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
  ])("maps userActivation.isActive=%s to %s", (isActive, expected) => {
    vi.stubGlobal("navigator", { userActivation: { isActive } });

    expect(hasTrustedUserActivation({ isTrusted: true })).toBe(expected);
  });
});
