// Same rules as upstage-cli's root eslint.config.mjs (pinned at
// vendor/upstage-cli), inlined so the harness lints with its own
// devDependencies instead of resolving plugins from a parent node_modules.
// Patterns resolve relative to harness/.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.mjs", "tests/**/*.mjs", "bin/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest", // import-attribute syntax (`with { type: "json" }`) needs this
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      "no-undef": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "runs/**"],
  },
];
