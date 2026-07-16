import { describe, expect, it } from "vitest";

import { COPY } from "../../src/copy";
import { presentUpdateInstall } from "../../src/render/updateInstallPresentation";

const READY = {
  offlineState: "update-ready" as const,
  locked: false,
  home: true,
  serviceWorkerAvailable: true,
  feedback: null,
};

describe("update install presentation", () => {
  it("enables an explicit install request only on the idle screen", () => {
    expect(presentUpdateInstall(READY)).toEqual({
      visible: true,
      disabled: false,
      message: null,
    });
  });

  it("disables install during active work and tells the user to choose it later", () => {
    expect(presentUpdateInstall({ ...READY, home: false })).toEqual({
      visible: true,
      disabled: true,
      message: COPY.updateBusyBody,
    });
    expect(COPY.updateBusyBody).toContain(COPY.installUpdate);
  });

  it.each([
    ["started", COPY.updateStartingBody],
    ["unavailable", COPY.updateUnavailableBody],
  ] as const)("keeps %s feedback visible while disabling repeat activation", (feedback, message) => {
    expect(presentUpdateInstall({ ...READY, feedback })).toEqual({
      visible: true,
      disabled: true,
      message,
    });
  });

  it("defers to the global lock explanation during a version check", () => {
    expect(presentUpdateInstall({ ...READY, locked: true })).toEqual({
      visible: true,
      disabled: true,
      message: null,
    });
  });
});
