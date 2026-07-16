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
  readonly clearError?: boolean;
  readonly systemError?: boolean;
  readonly watchError?: boolean;
  readonly stopError?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const applied: Theme[] = [];
  const saved: Theme[] = [];
  const stopWatching = vi.fn();
  const systemListeners = new Set<(theme: Theme) => void>();
  let clearAttempts = 0;
  let cleared = 0;
  let watchCount = 0;
  const environment: ThemeEnvironment = {
    loadOverride: () => {
      if (options.loadError === true) throw new DOMException("Blocked", "SecurityError");
      return options.stored ?? null;
    },
    saveOverride: (theme) => {
      if (options.saveError === true) throw new DOMException("Blocked", "SecurityError");
      saved.push(theme);
    },
    clearOverride: () => {
      clearAttempts += 1;
      if (options.clearError === true) throw new DOMException("Blocked", "SecurityError");
      cleared += 1;
    },
    systemTheme: () => {
      if (options.systemError === true) throw new TypeError("matchMedia unavailable");
      return options.system ?? "dark";
    },
    watchSystemTheme: (listener) => {
      watchCount += 1;
      if (options.watchError === true) throw new TypeError("media query events unavailable");
      systemListeners.add(listener);
      return () => {
        stopWatching();
        if (options.stopError === true) {
          throw new TypeError("media query listener removal unavailable");
        }
        systemListeners.delete(listener);
      };
    },
    applyTheme: (theme) => applied.push(theme),
  };
  const controller = new ThemeController(environment);
  return {
    activeWatchCount: () => systemListeners.size,
    applied,
    clearAttempts: () => clearAttempts,
    cleared: () => cleared,
    controller,
    emitSystem: (theme: Theme) => {
      for (const listener of systemListeners) listener(theme);
    },
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

  it("clears an override and resumes system changes without duplicate watchers", () => {
    const harness = createHarness({ stored: "light", system: "dark" });

    expect(harness.controller.useSystemTheme()).toBe("dark");
    expect(harness.controller.followsSystem).toBe(true);
    expect(harness.clearAttempts()).toBe(1);
    expect(harness.cleared()).toBe(1);
    expect(harness.watchCount()).toBe(1);
    expect(harness.activeWatchCount()).toBe(1);

    harness.emitSystem("light");
    expect(harness.controller.theme).toBe("light");

    expect(harness.controller.useSystemTheme()).toBe("dark");
    expect(harness.clearAttempts()).toBe(2);
    expect(harness.cleared()).toBe(2);
    expect(harness.watchCount()).toBe(2);
    expect(harness.activeWatchCount()).toBe(1);

    harness.emitSystem("light");
    expect(harness.controller.theme).toBe("light");
    expect(harness.applied).toEqual(["light", "dark", "light", "dark", "light"]);
  });

  it("does not add a duplicate watcher when listener removal is blocked", () => {
    const harness = createHarness({ stopError: true, system: "dark" });

    expect(harness.controller.toggle()).toBe("light");
    expect(harness.activeWatchCount()).toBe(1);

    expect(() => harness.controller.useSystemTheme()).not.toThrow();
    expect(harness.controller.theme).toBe("dark");
    expect(harness.controller.followsSystem).toBe(true);
    expect(harness.watchCount()).toBe(1);
    expect(harness.activeWatchCount()).toBe(1);

    harness.emitSystem("light");
    expect(harness.controller.theme).toBe("light");
  });

  it("falls back to dark and keeps theme controls usable when browser APIs are blocked", () => {
    const harness = createHarness({
      loadError: true,
      saveError: true,
      clearError: true,
      systemError: true,
      watchError: true,
    });

    expect(harness.controller.theme).toBe("dark");
    expect(() => harness.controller.toggle()).not.toThrow();
    expect(harness.controller.theme).toBe("light");
    expect(() => harness.controller.useSystemTheme()).not.toThrow();
    expect(harness.controller.theme).toBe("dark");
    expect(harness.controller.followsSystem).toBe(true);
    expect(harness.clearAttempts()).toBe(1);
    expect(harness.watchCount()).toBe(2);
    expect(harness.saved).toEqual([]);
    expect(harness.applied).toEqual(["dark", "light", "dark"]);
  });
});
