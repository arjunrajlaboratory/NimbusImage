# Package Updates

Snapshot taken 2026-02-26 on branch `claude/vue3-migration-planning-tS4Hx` after Vue 3 migration (Batches A-F complete).

## Update Command (Safe Packages)

```bash
pnpm update vue axios lodash js-yaml sortablejs papaparse qs p-limit p-retry patch-package pug prettier tslib @types/d3-array @types/sortablejs @types/lodash @types/papaparse @types/qs
```

After running, verify with:
```bash
pnpm tsc && pnpm test
```

## Safe to Update Now

Minor/patch bumps within semver range. Low risk of breakage.

| Package | Current | Latest | Notes |
|---------|---------|--------|-------|
| vue | 3.5.28 | 3.5.29 | Patch bump |
| axios | 1.6.8 | 1.13.5 | Minor bumps, backwards compatible |
| lodash | 4.17.21 | 4.17.23 | Patch bump |
| js-yaml | 4.1.0 | 4.1.1 | Patch bump |
| sortablejs | 1.15.2 | 1.15.7 | Patch bump (vuedraggable dependency) |
| papaparse | 5.4.1 | 5.5.3 | Minor bump, CSV parsing |
| qs | 6.11.2 | 6.15.0 | Minor bump, query string parsing |
| p-limit | 7.1.1 | 7.3.0 | Minor bump |
| p-retry | 7.0.0 | 7.1.1 | Minor/patch bump |
| patch-package | 8.0.0 | 8.0.1 | Patch bump |
| pug (dev) | 3.0.2 | 3.0.3 | Patch bump |
| prettier (dev) | 3.2.2 | 3.8.1 | Minor bump, formatting only |
| tslib (dev) | 2.6.2 | 2.8.1 | Minor bump, TS runtime helpers |
| @types/d3-array | 3.2.1 | 3.2.2 | Patch bump |
| @types/sortablejs | 1.15.7 | 1.15.9 | Patch bump |
| @types/lodash | 4.14.202 | 4.17.24 | Minor bump |
| @types/papaparse (dev) | 5.3.14 | 5.5.2 | Minor bump |
| @types/qs | 6.9.11 | 6.14.0 | Minor bump |

## Completed Major Updates

### ESLint Toolchain (migrated to ESLint 10 flat config, 2026-10)

`.eslintrc.cjs` was replaced by `eslint.config.mjs` (flat config) and the
lint script became `eslint src`; `.gitignore` is honored through
`includeIgnoreFile` from `@eslint/compat`, replacing `--ignore-path`.

| Package | Before | After | Notes |
|---------|--------|-------|-------|
| eslint (dev) | 8.56.0 | 10.13.0 | Flat config. Unused `eslint-disable` comments in script code are reported in production mode (template `<!-- eslint-disable -->` comments are not). |
| eslint-plugin-vue (dev) | 9.20.1 | 10.12.0 | `flat/essential`. |
| @vue/eslint-config-typescript (dev) | 12.0.0 | 14.9.0 | `defineConfigWithVueTs` with `vueTsConfigs.base` + `eslintRecommended` (not the much stricter `recommended`). |
| @vue/eslint-config-prettier (dev) | 9.0.0 | 10.2.0 | Flat config; `prettier/prettier` stays a warning. |
| @eslint/compat (dev) | — | 2.1.1 | New: `includeIgnoreFile`. |
| @typescript-eslint/eslint-plugin, @typescript-eslint/parser (dev) | 6.19.0 | removed | Now typescript-eslint 8, pulled in by @vue/eslint-config-typescript. |
| eslint-plugin-prettier (dev) | 5.1.3 | removed | Now a dependency of @vue/eslint-config-prettier. |

The rule set is the ESLint 8 one plus these additions, each of which
`src/` was brought into line with:

- eslint-plugin-vue 10's new `flat/essential` rules
  (`vue/no-deprecated-delete-set`, `vue/no-deprecated-model-definition`,
  `vue/valid-define-options`) and `vue/block-lang` (added by
  `defineConfigWithVueTs`; every `<script>` must be `lang="ts"`).
- `no-var`, `prefer-const`, `prefer-rest-params` and `prefer-spread` now
  apply to `.vue` files, not only `.ts`.
- `@typescript-eslint/no-unused-vars` uses typescript-eslint 8's default
  `caughtErrors: "all"`: write `catch {}` when the error is unused. It also
  reports values used only as types (`const x = {...}; type T = typeof x`),
  which has no option to turn off.
- **Unused directives fail CI.** ESLint 9+ reports them by default, and
  `lint:ci` runs with `--max-warnings=0` under `NODE_ENV=production`.

Not adopted: `vueTsConfigs.recommended` (about 6,000 problems, nearly all
`no-explicit-any`) is a separate follow-up.

## Do NOT Update Yet

Major version bumps or packages with known breaking changes. Each needs its own migration effort.

### Core Framework (wait for stability)

| Package | Current | Latest | Reason to Wait |
|---------|---------|--------|----------------|
| vuetify | 3.12.0 | 4.0.0 | Just completed Vue 3 / Vuetify 3 migration. Vuetify 4 is a major rewrite. |
| vue-router | 4.6.4 | 5.0.3 | Major version, API changes. Needs dedicated migration. |
| vite (dev) | 6.4.1 | 7.3.1 | Major version, may break build config. |
| vitest (dev) | 3.2.4 | 4.0.18 | Major version, may break test config. |
| vue-tsc (dev) | 2.2.12 | 3.2.5 | Major version, tied to TypeScript tooling. |

### D3 Ecosystem (pinned to legacy versions)

| Package | Current | Latest | Reason to Wait |
|---------|---------|--------|----------------|
| d3 | 3.5.17 | 7.9.0 | Massive API rewrite (v3 → v7). Used by geojs internals. |
| d3-array | 2.12.1 | 3.2.4 | Major version, breaking API changes. |
| d3-drag | 1.2.5 | 3.0.0 | Major version, breaking API changes. |
| d3-selection | 1.4.2 | 3.0.0 | Major version, breaking API changes. |
| d3-shape | 1.3.7 | 3.2.0 | Major version, breaking API changes. |
| @types/d3-color | 1.4.5 | 3.1.3 | Must match d3-color version. |
| @types/d3-drag | 1.2.8 | 3.0.7 | Must match d3-drag version. |
| @types/d3-scale | 3.3.5 | 4.0.9 | Must match d3-scale version. |
| @types/d3-selection | 1.4.2 | 3.0.11 | Must match d3-selection version. |
| @types/d3-shape | 1.3.12 | 3.1.8 | Must match d3-shape version. |
| @types/d3-zoom | 1.8.7 | 3.0.8 | Must match d3-zoom version. |

Note: d3 packages are tightly coupled with geojs. Update them together only if geojs requires it.

### ML / Image Processing (pinned for compatibility)

| Package | Current | Latest | Reason to Wait |
|---------|---------|--------|----------------|
| onnxruntime-common | 1.17.0-dev.20240109 | 1.24.2 | Pinned dev versions for SAM model compatibility. |
| onnxruntime-web | 1.19.0-dev.20240801 | 1.24.2 | Pinned dev versions for SAM model compatibility. |
| itk-wasm | 1.0.0-b.166 | 1.0.0-b.196 | Pre-release; needs testing with WASM pipelines. |

Note: ONNX Runtime versions are pinned to specific dev builds that work with the SAM2 model weights. Updating may break model loading.

### Icons

| Package | Current | Latest | Reason to Wait |
|---------|---------|--------|----------------|
| @mdi/font | 5.9.55 | 7.4.47 | Major version. Some icon names were renamed/removed in v6 and v7. Need to audit icon usage. |

### Other Major Bumps

| Package | Current | Latest | Reason to Wait |
|---------|---------|--------|----------------|
| shepherd.js | 8.3.1 | 15.2.1 | Huge major jump. Tour/onboarding library, API likely very different. |
| uuid | 3.4.0 | 13.0.0 | Major version. v3 uses `uuid.v4()`, newer versions use named exports. |
| marked | 14.1.2 | 17.0.3 | Major version. Markdown rendering, may have API changes. |
| fs-extra | 10.1.0 | 11.3.3 | Major version. Dropped Node <14 support, minor API changes. |
| jsdom (dev) | 24.0.0 | 28.1.0 | Major version. Test environment, may affect Vitest. |
| fflate | 0.7.4 | 0.8.2 | Minor version but pre-1.0, so 0.7→0.8 may break. |
| reflect-metadata | 0.1.14 | 0.2.2 | Used by vuex-module-decorators. Pre-1.0 minor bump may break. |
| rollup-plugin-visualizer (dev) | 5.12.0 | 7.0.0 | Major version. Bundle analysis tool, low risk but needs testing. |
| yaml-loader (dev) | 0.8.1 | 0.9.0 | Pre-1.0 minor bump. |
| @types/jquery | 3.5.29 | 4.0.0 | Major version. Used by geojs types. |
| @types/node (dev) | 20.19.33 | 25.3.1 | Major version. Should match target Node version. |
| @types/uuid | 8.3.4 | 11.0.0 | Must match uuid version. |
