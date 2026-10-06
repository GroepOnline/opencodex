import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { I18N_DATA_FILES, I18N_UI_FILES } from "./.eslint/i18n-file-groups.ts";
import localI18nPlugin from "./.eslint/local-i18n-plugin.ts";
import localDesignTokenPlugin from "./.eslint/local-design-token-plugin.mjs";

export default defineConfig([
  globalIgnores([
    "dist",
    "src/i18n/**",
    "**/*.test.ts",
    "**/*.test.tsx",
    "src/api.ts",
    "src/format*.ts",
    "src/icons.tsx",
    "src/provider-icons.ts",
    ".eslint/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: I18N_UI_FILES,
    plugins: {
      "local-i18n": localI18nPlugin,
    },
    rules: {
      "local-i18n/no-hardcoded-ui-strings": "error",
    },
  },
  {
    files: I18N_DATA_FILES,
    plugins: {
      "local-i18n": localI18nPlugin,
    },
    rules: {
      "local-i18n/no-hardcoded-data-copy": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "local-design-token": localDesignTokenPlugin,
    },
    rules: {
      "local-design-token/no-depas-dialect": "error",
      "local-design-token/no-inline-visual-values": "warn",
    },
  },
]);
