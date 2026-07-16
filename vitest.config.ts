import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/browser/**", "tests/release/**"],
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
});
