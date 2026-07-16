import { describe, expect, it, vi } from "vitest";

import {
  parseTheme,
  ThemeController,
  type Theme,
  type ThemeEnvironment,
} from "../../src/render/theme";

interface HarnessOptions {
  readonly stored?: string | null;
  readonly system?: Theme;
  readonly loadError?: boolean;
  readonly saveError?: boolean;
  readonly systemError?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const applied: Theme[] = [];
  const saved: Theme[] = [];
  const stopWatching = vi.fn();
  let watchCount = 0;
  let systemListener: ((theme: Theme) => void) | null = null;
  const environment: ThemeEnvironment = {
    loadOverride: () => {
      if (options.loadError === true) throw new DOMException("Blocked", "SecurityError");
      return options.stored ?? null;
    },
    saveOverride: (theme) => {
      if (options.saveError === true) throw new DOMException("Blocked", "SecurityError");
      saved.push(theme);
    },
    systemTheme: () => {
      if (options.systemError === true) throw new TypeError("matchMedia unavailable");
      return options.system ?? "dark";
    },
    watchSystemTheme: (listener) => {
      watchCount += 1;
      systemListener = listener;
      return stopWatching;
    },
    applyTheme: (theme) => applied.push(theme),
  };
  const controller = new ThemeController(environment);
  return {
    applied,
    controller,
    emitSystem: (theme: Theme) => systemListener?.(theme),
    saved,
    stopWatching,
    watchCount: () => watchCount,
  };
}

describe("theme controller", () => {
  it("accepts only the two supported stored values", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("sepia")).toBeNull();
    expect(parseTheme(null)).toBeNull();
  });

  it("gives a stored override precedence over the system theme", () => {
    const harness = createHarness({ stored: "light", system: "dark" });

    expect(harness.controller.theme).toBe("light");
    expect(harness.controller.followsSystem).toBe(false);
    expect(harness.applied).toEqual(["light"]);
    expect(harness.watchCount()).toBe(0);
  });

  it("follows system changes until the user makes an explicit choice", () => {
    const harness = createHarness({ stored: "invalid", system: "dark" });
    const listener = vi.fn();
    const unsubscribe = harness.controller.subscribe(listener);

    expect(harness.controller.followsSystem).toBe(true);
    expect(harness.watchCount()).toBe(1);
    expect(listener).toHaveBeenLastCalledWith("dark");

    harness.emitSystem("light");
    expect(harness.controller.theme).toBe("light");
    expect(listener).toHaveBeenLastCalledWith("light");

    expect(harness.controller.toggle()).toBe("dark");
    expect(harness.saved).toEqual(["dark"]);
    expect(harness.stopWatching).toHaveBeenCalledOnce();
    expect(harness.controller.followsSystem).toBe(false);

    harness.emitSystem("light");
    expect(harness.controller.theme).toBe("dark");
    expect(harness.applied).toEqual(["dark", "light", "dark"]);

    unsubscribe();
  });

  it("falls back to dark and keeps toggling when browser APIs are blocked", () => {
    const harness = createHarness({
      loadError: true,
      saveError: true,
      systemError: true,
    });

    expect(harness.controller.theme).toBe("dark");
    expect(() => harness.controller.toggle()).not.toThrow();
    expect(harness.controller.theme).toBe("light");
    expect(harness.saved).toEqual([]);
    expect(harness.applied).toEqual(["dark", "light"]);
  });
});
