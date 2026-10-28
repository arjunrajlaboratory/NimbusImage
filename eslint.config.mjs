import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import pluginVue from "eslint-plugin-vue";
import {
  defineConfigWithVueTs,
  vueTsConfigs,
} from "@vue/eslint-config-typescript";
import prettierConfig from "@vue/eslint-config-prettier";

const isProduction = process.env.NODE_ENV === "production";

export default defineConfigWithVueTs(
  includeIgnoreFile(fileURLToPath(new URL(".gitignore", import.meta.url))),
  {
    name: "app/files-to-lint",
    files: ["src/**/*.{js,ts,vue}"],
  },
  // CI lints with NODE_ENV=production, where `no-console` is on and the
  // `eslint-disable no-console` directives are used. In development the rule
  // is off, so those same directives would be reported as unused; the check
  // runs in production mode only (`NODE_ENV=production pnpm lint:ci`).
  {
    name: "app/linter-options",
    linterOptions: {
      reportUnusedDisableDirectives: isProduction ? "warn" : "off",
    },
  },
  pluginVue.configs["flat/essential"],
  // `base` only registers the parser and plugin, and `eslintRecommended`
  // adds the TS-file overrides (`no-var`, `prefer-const`, ...). Together
  // with the `no-unused-vars` rule below this matches what
  // @vue/eslint-config-typescript 12's `@vue/typescript` enabled; the v14
  // default, `vueTsConfigs.recommended`, is stricter.
  vueTsConfigs.base,
  vueTsConfigs.eslintRecommended,
  {
    name: "app/rules",
    rules: {
      "no-console": isProduction ? "error" : "off",
      "no-debugger": isProduction ? "error" : "off",
      // Required to access v-data-table scoped slots, see https://v2.vuetifyjs.com/en/components/data-tables/#slots
      "vue/valid-v-slot": ["error", { allowModifiers: true }],
      // Single-word component names are fine for route views (Home, Configuration, Project, etc.)
      "vue/multi-word-component-names": "off",
      // typescript-eslint 8 changed the `caughtErrors` default from "none"
      // to "all"; keep unused `catch (error)` bindings allowed as before.
      "@typescript-eslint/no-unused-vars": ["warn", { caughtErrors: "none" }],
      // The rules below were not in the ESLint 8 rule set; they stay off so
      // that the ESLint 10 migration does not change what is enforced.
      // Added by defineConfigWithVueTs to require `<script lang="ts">`.
      "vue/block-lang": "off",
      // Joined `flat/essential` in eslint-plugin-vue 10.
      "vue/no-deprecated-delete-set": "off",
      "vue/no-deprecated-model-definition": "off",
      "vue/valid-define-options": "off",
    },
  },
  {
    // `eslintRecommended` targets `*.ts`, and defineConfigWithVueTs widens it
    // to `*.vue`. Before, these rules applied to `.ts` files only.
    name: "app/ts-only-rules-off-for-vue",
    files: ["**/*.vue"],
    rules: {
      "no-var": "off",
      "prefer-const": "off",
      "prefer-rest-params": "off",
      "prefer-spread": "off",
    },
  },
  prettierConfig,
);
