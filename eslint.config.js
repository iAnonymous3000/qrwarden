import tseslint from "typescript-eslint";

// Application and worker source get type-aware linting from the committed
// project references; tests are not part of a tsconfig project, so they get
// the syntactic TypeScript ruleset only.
const TYPED_FILES = ["src/**/*.ts", "src/**/*.tsx", "decoder-worker/**/*.ts"];
const TEST_FILES = ["tests/**/*.ts"];

export default [
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "release-output/**",
      "test-results/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-console": "error",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPED_FILES,
  })),
  {
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Camera and worker plumbing forwards upstream rejection values
      // (DOMException instances, AbortSignal reasons) unwrapped so that
      // instanceof-based problem mapping keeps seeing the original value.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: TEST_FILES,
  })),
  {
    files: TEST_FILES,
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
];
