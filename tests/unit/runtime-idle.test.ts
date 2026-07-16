import { describe, expect, it } from "vitest";

import { isRuntimeIdle, type RuntimeIdleSnapshot } from "../../src/app/runtimeIdle";

const IDLE: RuntimeIdleSnapshot = {
  viewKind: "home",
  hasActiveReport: false,
  hasOpenConfirmation: false,
  imageBusy: false,
  cameraAttached: false,
  cameraTaskBusy: false,
  clipboardBusy: false,
  hasRetainedResources: false,
};

describe("update idle predicate", () => {
  it("accepts only a resource-free home state", () => {
    expect(isRuntimeIdle(IDLE)).toBe(true);
  });

  it.each([
    ["viewKind", "result"],
    ["hasActiveReport", true],
    ["hasOpenConfirmation", true],
    ["imageBusy", true],
    ["cameraAttached", true],
    ["cameraTaskBusy", true],
    ["clipboardBusy", true],
    ["hasRetainedResources", true],
  ] as const)("rejects a non-idle %s", (field, value) => {
    expect(isRuntimeIdle({ ...IDLE, [field]: value })).toBe(false);
  });
});
