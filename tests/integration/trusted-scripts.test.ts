import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("Trusted Types worker-script boundary", () => {
  it("uses the same exact-path allowlist when Trusted Types is unavailable", async () => {
    vi.stubGlobal("location", { origin: "https://qrwarden.test" });
    vi.stubGlobal("window", {});
    const { initializeTrustedWorkerScripts } = await import(
      "../../src/app/trustedScripts"
    );

    expect(initializeTrustedWorkerScripts()).toEqual({
      decoder: "/decoder-worker.js",
      serviceWorker: "/sw.js",
      trustedTypes: "unsupported",
    });
  });

  it("creates one named policy and rejects every non-allowlisted URL", async () => {
    vi.stubGlobal("location", { origin: "https://qrwarden.test" });
    let validate!: (input: string) => string;
    const createPolicy = vi.fn(
      (
        _name: string,
        rules: { readonly createScriptURL: (input: string) => string },
      ) => {
        validate = rules.createScriptURL;
        return {
          createScriptURL(input: string) {
            return Object.freeze({ trusted: rules.createScriptURL(input) });
          },
        };
      },
    );
    vi.stubGlobal("window", { trustedTypes: { createPolicy } });
    const { initializeTrustedWorkerScripts } = await import(
      "../../src/app/trustedScripts"
    );

    const scripts = initializeTrustedWorkerScripts();

    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy.mock.calls[0]?.[0]).toBe("qrwarden-script-url");
    expect(scripts).toEqual({
      decoder: { trusted: "/decoder-worker.js" },
      serviceWorker: { trusted: "/sw.js" },
      trustedTypes: "enforced",
    });
    for (const candidate of [
      "/decoder-worker.js?x=1",
      "/sw.js#fragment",
      "https://evil.invalid/sw.js",
      "//evil.invalid/sw.js",
      "/assets/app.js",
      "",
    ]) {
      expect(() => validate(candidate)).toThrow("Rejected worker script path");
    }
  });
});
