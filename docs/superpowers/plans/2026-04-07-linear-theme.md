# Linear-Inspired Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NimbusImage's flat Material Design theme with a Linear-inspired design system featuring layered dark surfaces, Inter Variable typography, and ghost/translucent component styling.

**Architecture:** Three layers — Vuetify theme config (color tokens), global CSS custom properties (`--nimbus-*` namespace for borders/glass/radius), and targeted component overrides. Inter Variable loaded via Google Fonts. No new files created.

**Tech Stack:** Vuetify 4 theming, CSS custom properties, Inter Variable font, SCSS

**Spec:** `docs/superpowers/specs/2026-04-07-linear-theme-design.md`

---

### Task 1: Load Inter Variable Font

**Files:**
- Modify: `index.html:5` (add font link in `<head>`)

- [ ] **Step 1: Add Inter Variable font link to index.html**

In `index.html`, add the Google Fonts link after the existing `<meta>` tags, before `<title>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300..700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Verify font loads**

Run: `pnpm run dev` (if not already running), open `http://localhost:5173` in browser, open DevTools > Network tab, confirm `Inter` font files are downloaded. Check Elements tab > computed styles on any text element to confirm `Inter` is in the font stack.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(theme): load Inter Variable font from Google Fonts"
```

---

### Task 2: Define Vuetify Theme Tokens

**Files:**
- Modify: `src/plugins/vuetify.ts`

- [ ] **Step 1: Replace the theme config in vuetify.ts**

Replace the entire `theme` block (lines 16-26) with the full dark and light theme definitions:

```typescript
  theme: {
    defaultTheme: Persister.get("theme", "dark") === "dark" ? "dark" : "light",
    themes: {
      dark: {
        colors: {
          background: "#08090a",
          surface: "#0f1011",
          "surface-bright": "#191a1b",
          "surface-light": "#28282c",
          primary: "#26A69A",
          secondary: "#d0d6e0",
          "on-background": "#f7f8f8",
          "on-surface": "#f7f8f8",
          "on-surface-variant": "#8a8f98",
          error: "#e5534b",
          success: "#27a644",
          warning: "#d4a72c",
          info: "#5b9bd5",
        },
      },
      light: {
        colors: {
          background: "#f7f8f8",
          surface: "#ffffff",
          "surface-bright": "#f3f4f5",
          "surface-light": "#e8e9eb",
          primary: "#26A69A",
          secondary: "#4a5568",
          "on-background": "#1a1a1a",
          "on-surface": "#1a1a1a",
          "on-surface-variant": "#6b7280",
          error: "#dc2626",
          success: "#16a34a",
          warning: "#ca8a04",
          info: "#2563eb",
        },
      },
    },
  },
```

- [ ] **Step 2: Update component defaults for ghost styling**

Replace the `defaults` block (lines 6-15) with:

```typescript
  defaults: {
    VBtn: { variant: "tonal", rounded: "lg" },
    VCard: { variant: "flat", rounded: "lg" },
    VAlert: { variant: "tonal", rounded: "lg" },
    VSwitch: { color: "primary" },
    VCheckbox: { color: "primary", density: "comfortable" },
    VCheckboxBtn: { density: "comfortable" },
    VList: { density: "comfortable" },
    VListItem: { density: "comfortable" },
    VChip: { rounded: "pill" },
    VTextField: { variant: "outlined", density: "comfortable", rounded: "lg" },
    VSelect: { variant: "outlined", density: "comfortable", rounded: "lg" },
    VCombobox: { variant: "outlined", density: "comfortable", rounded: "lg" },
    VAutocomplete: { variant: "outlined", density: "comfortable", rounded: "lg" },
    VExpansionPanels: { variant: "accordion" },
  },
```

- [ ] **Step 3: Verify the theme loads**

Open the app at `http://localhost:5173`. The background should now be near-black (#08090a) instead of #121212. Text should be #f7f8f8. Cards and surfaces should show the new darker palette. Some components may look rough — that's expected, we'll fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/vuetify.ts
git commit -m "feat(theme): define Linear-inspired dark and light theme tokens"
```

---

### Task 3: Add Global CSS Custom Properties and Font Setup

**Files:**
- Modify: `src/style.scss`

- [ ] **Step 1: Add nimbus CSS variables and Inter font setup at the top of style.scss**

Insert the following block at the very top of `src/style.scss`, before the existing `html, body` rule:

```scss
/* ── Linear-inspired theme tokens ────────────────────────────── */

/* Inter Variable font setup */
:root {
  --nimbus-font: "Inter", "Inter Variable", "SF Pro Display", -apple-system,
    system-ui, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans",
    "Helvetica Neue", sans-serif;
  --nimbus-radius: 8px;
  --nimbus-radius-sm: 6px;
  --nimbus-radius-lg: 12px;
}

/* Apply Inter globally with OpenType features */
body,
.v-application {
  font-family: var(--nimbus-font) !important;
  font-feature-settings: "cv01", "ss03";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Dark theme tokens */
.v-theme--dark {
  --nimbus-border: rgba(255, 255, 255, 0.06);
  --nimbus-border-strong: rgba(255, 255, 255, 0.10);
  --nimbus-glass: rgba(255, 255, 255, 0.02);
  --nimbus-glass-hover: rgba(255, 255, 255, 0.05);
  --nimbus-shadow: none;
  --nimbus-text-secondary: #d0d6e0;
  --nimbus-text-muted: #8a8f98;
  --nimbus-text-faint: #62666d;
}

/* Light theme tokens */
.v-theme--light {
  --nimbus-border: rgba(0, 0, 0, 0.08);
  --nimbus-border-strong: rgba(0, 0, 0, 0.12);
  --nimbus-glass: rgba(0, 0, 0, 0.02);
  --nimbus-glass-hover: rgba(0, 0, 0, 0.04);
  --nimbus-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  --nimbus-text-secondary: #4a5568;
  --nimbus-text-muted: #6b7280;
  --nimbus-text-faint: #9ca3af;
}
```

- [ ] **Step 2: Verify font and variables**

Open the app, inspect any text element in DevTools. Confirm:
- `font-family` shows Inter
- `font-feature-settings` shows `"cv01", "ss03"`
- Custom properties `--nimbus-border` etc. are visible on `.v-theme--dark`

- [ ] **Step 3: Commit**

```bash
git add src/style.scss
git commit -m "feat(theme): add nimbus CSS custom properties and Inter font setup"
```

---

### Task 4: Global Vuetify Component Overrides

**Files:**
- Modify: `src/style.scss` (append to end)

- [ ] **Step 1: Add global component overrides to style.scss**

Append the following at the end of `src/style.scss` (after the existing progress bar rules):

```scss
/* ── Linear-inspired component overrides ─────────────────────── */

/* App bar: flat with border, no elevation */
.v-app-bar {
  background: rgb(var(--v-theme-surface)) !important;
  border-bottom: 1px solid var(--nimbus-border) !important;
  box-shadow: none !important;
}

/* Navigation drawers: match panel surface */
.v-navigation-drawer {
  background: rgb(var(--v-theme-surface)) !important;
  border-color: var(--nimbus-border) !important;
}

/* Cards: translucent glass with subtle border */
.v-card--variant-flat {
  background: var(--nimbus-glass) !important;
  border: 1px solid var(--nimbus-border) !important;
  border-radius: var(--nimbus-radius) !important;
  box-shadow: var(--nimbus-shadow) !important;
}

/* Buttons: ghost styling */
.v-btn--variant-tonal {
  background: var(--nimbus-glass) !important;
  border: 1px solid var(--nimbus-border);

  &:hover {
    background: var(--nimbus-glass-hover) !important;
  }
}

/* Primary-colored buttons: translucent teal */
.v-theme--dark .v-btn--variant-tonal.text-primary,
.v-theme--dark .v-btn.bg-primary {
  background: rgba(38, 166, 154, 0.15) !important;
  border: 1px solid rgba(38, 166, 154, 0.2);
  color: #26A69A !important;

  &:hover {
    background: rgba(38, 166, 154, 0.25) !important;
  }
}

/* Inputs: ghost outline */
.v-field--variant-outlined .v-field__outline {
  --v-field-border-opacity: 0.06;
}

.v-field--focused .v-field__outline {
  --v-field-border-opacity: 0.10;
}

/* Expansion panels: transparent with subtle dividers */
.v-expansion-panels {
  .v-expansion-panel {
    background: transparent !important;
    border-bottom: 1px solid var(--nimbus-border);

    &::after {
      display: none; /* Remove default Vuetify divider */
    }
  }

  .v-expansion-panel-title {
    &:hover {
      background: var(--nimbus-glass-hover);
    }
  }
}

/* Lists: transparent with hover */
.v-list {
  background: transparent !important;
}

.v-list-item {
  &:hover {
    background: var(--nimbus-glass-hover);
  }
}

/* Tabs: transparent with muted inactive text */
.v-tab {
  color: var(--nimbus-text-muted) !important;
  letter-spacing: -0.01em;

  &.v-tab--selected {
    color: rgb(var(--v-theme-on-surface)) !important;
  }
}

/* Chips: ghost pill styling */
.v-chip {
  background: var(--nimbus-glass) !important;
  border: 1px solid var(--nimbus-border) !important;

  &:hover {
    background: var(--nimbus-glass-hover) !important;
  }
}

/* Chips with explicit background colors: make translucent */
.v-theme--dark .v-chip[style*="background-color"] {
  border: 1px solid var(--nimbus-border) !important;
}

/* Dialogs and menus: elevated surface */
.v-overlay__content > .v-card,
.v-menu > .v-overlay__content > .v-card,
.v-dialog > .v-overlay__content > .v-card {
  background: rgb(var(--v-theme-surface-bright)) !important;
  border: 1px solid var(--nimbus-border) !important;
  border-radius: var(--nimbus-radius-lg) !important;
}

/* Dividers: use nimbus border */
.v-divider {
  border-color: var(--nimbus-border) !important;
  opacity: 1;
}

/* Tooltips: elevated surface style */
.v-tooltip > .v-overlay__content {
  background: rgb(var(--v-theme-surface-bright)) !important;
  border: 1px solid var(--nimbus-border) !important;
  border-radius: var(--nimbus-radius-sm) !important;
}
```

- [ ] **Step 2: Remove the old card border and dark-mode overrides from style.scss**

Remove these existing rules that are now superseded (lines 602-622 of the current App.vue, but we'll handle App.vue in a later task — for style.scss there's nothing to remove since these rules live in App.vue).

Actually, no removals needed in style.scss — the new rules will take effect alongside the existing ones. We'll clean up App.vue's redundant rules in Task 6.

- [ ] **Step 3: Verify component styling**

Open the app. Check:
- App bar should be dark (#0f1011) with subtle bottom border, no shadow
- Cards should be translucent with subtle borders
- Buttons should have ghost/translucent backgrounds
- Navigation drawers should match the header panel color
- Lists should be transparent

- [ ] **Step 4: Commit**

```bash
git add src/style.scss
git commit -m "feat(theme): add global Linear-inspired component overrides"
```

---

### Task 5: Update Tour System Styles

**Files:**
- Modify: `src/plugins/tour.scss`

- [ ] **Step 1: Replace tour.scss with theme-aware styles**

Replace the entire contents of `src/plugins/tour.scss` with:

```scss
.shepherd-theme-custom {
  background: rgb(var(--v-theme-surface-bright, 25, 26, 27)) !important;
  border-radius: var(--nimbus-radius, 8px);
  border: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
  color: rgb(var(--v-theme-on-surface, 247, 248, 248));
  max-width: 320px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
  overflow: visible;
  z-index: 100000 !important;
  font-family: var(--nimbus-font, Inter, sans-serif);
  font-feature-settings: "cv01", "ss03";

  .shepherd-header {
    padding: 16px 16px 0;
    background: transparent !important;
    border-radius: var(--nimbus-radius, 8px) var(--nimbus-radius, 8px) 0 0;
    display: flex;

    .shepherd-title {
      font-size: 20px;
      font-weight: 500;
      margin: 0;
      color: rgb(var(--v-theme-on-surface, 247, 248, 248)) !important;
      background: transparent !important;
      flex: 1;
      word-wrap: break-word;
      padding-right: 16px;
      line-height: 1.3;
      letter-spacing: -0.02em;
    }

    .shepherd-cancel-icon {
      color: var(--nimbus-text-muted, #8a8f98);
      padding: 4px;
      margin: -4px;
      font-size: 18px;

      &:hover {
        color: rgb(var(--v-theme-on-surface, 247, 248, 248));
      }
    }
  }

  .shepherd-text {
    padding: 16px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--nimbus-text-secondary, #d0d6e0);
    background: transparent !important;
  }

  .shepherd-footer {
    padding: 8px 16px;
    border-top: 1px solid var(--nimbus-border, rgba(255, 255, 255, 0.06));
    background: transparent !important;
    display: flex;
    align-items: center;
    justify-content: space-between;

    .v-btn {
      text-transform: none;
      letter-spacing: -0.01em;
      font-weight: 500;
      font-size: 14px;
    }

    .shepherd-progress {
      font-size: 12px;
      color: var(--nimbus-text-muted, #8a8f98);
      margin-right: 16px;
    }
  }
}

.shepherd-modal-overlay-container {
  z-index: 99999 !important;
  background: rgba(0, 0, 0, 0.6);
}

.shepherd-target {
  box-shadow: 0 0 0 2px rgb(var(--v-theme-primary, 38, 166, 154));
  border-radius: 3px;
  z-index: 99998 !important;
}
```

- [ ] **Step 2: Verify tour styling**

Open the app, click the help menu (?) and start any tour. Confirm:
- Tour popup uses the new dark surface (#191a1b)
- Text uses Inter font
- Border uses subtle `--nimbus-border` style
- Target highlight uses teal instead of white

- [ ] **Step 3: Commit**

```bash
git add src/plugins/tour.scss
git commit -m "feat(theme): update tour styles to use nimbus theme tokens"
```

---

### Task 6: Update App.vue Styles

**Files:**
- Modify: `src/App.vue:12` (template — remove elevation class)
- Modify: `src/App.vue:527-623` (global style block)

- [ ] **Step 1: Remove elevation-1 from the app bar**

In `src/App.vue`, line 12, change:

```html
    <v-app-bar class="elevation-1">
```

to:

```html
    <v-app-bar>
```

- [ ] **Step 2: Replace the dark-mode overrides in the global style block**

In `src/App.vue`, remove the now-redundant dark-mode rules (lines 602-622) and replace with updated versions. Replace this block:

```scss
/* Flat cards get a subtle line border for section discrimination */
.v-card--variant-flat {
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* Improve secondary text contrast in dark mode */
.v-theme--dark .text-grey {
  color: rgba(255, 255, 255, 0.5);
}

/* More breathing room in list rows */
.v-theme--dark .v-list-item {
  padding-top: 4px;
  padding-bottom: 4px;
}

/* Better type-indicator chip legibility in dark mode */
.v-theme--dark .type-indicator.v-chip {
  background-color: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.7);
}
```

with:

```scss
/* Secondary text uses nimbus muted token */
.text-grey {
  color: var(--nimbus-text-muted);
}

/* Type-indicator chips use ghost styling */
.type-indicator.v-chip {
  background: var(--nimbus-glass) !important;
  color: var(--nimbus-text-secondary);
}
```

The card border and list-item padding rules are removed because they're now handled by the global overrides in `style.scss`.

- [ ] **Step 3: Verify app bar and overrides**

Open the app. Confirm:
- App bar has no elevation shadow, just a subtle bottom border
- Cards still have borders (now via global style.scss rule)
- Grey text uses the new muted token color
- Type-indicator chips use ghost styling

- [ ] **Step 4: Commit**

```bash
git add src/App.vue
git commit -m "feat(theme): update App.vue for flat app bar and nimbus tokens"
```

---

### Task 7: Update HelpPanel.vue Styles

**Files:**
- Modify: `src/components/HelpPanel.vue:118-244` (scoped style block)

- [ ] **Step 1: Replace hardcoded colors with nimbus tokens**

Replace the entire scoped style block (lines 118-244) in `src/components/HelpPanel.vue` with:

```scss
<style lang="scss" scoped>
.hud-overlay {
  width: 100%;
  height: 100%;
  display: flex;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}

.hud-content {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: rgb(var(--v-theme-surface));
  opacity: 0.95;
  overflow: hidden;
}

.hud-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 32px;
  border-bottom: 1px solid var(--nimbus-border);
  flex-shrink: 0;
}

.hud-title {
  font-size: 1.1rem;
  font-weight: 500;
  color: rgb(var(--v-theme-on-surface));
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.hud-subtitle {
  font-size: 0.8rem;
  color: var(--nimbus-text-muted);

  a {
    color: rgb(var(--v-theme-primary));
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }
}

.hud-close {
  margin-left: auto;
  opacity: 0.5;
  &:hover {
    opacity: 1;
  }
}

.hud-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.hud-divider {
  height: 1px;
  background: var(--nimbus-border);
  margin: 20px 0;
}

.section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.section-columns {
  column-width: 320px;
  column-gap: 32px;
  column-fill: balance;
}

.section-group {
  break-inside: avoid;
  margin-bottom: 16px;
}

.group-title {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--nimbus-text-secondary);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--nimbus-border);
}

.hotkey-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 0;
}

kbd {
  display: inline-block;
  min-width: 28px;
  padding: 2px 7px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono",
    Consolas, monospace;
  font-size: 0.75rem;
  font-weight: 500;
  color: rgb(var(--v-theme-on-surface));
  background: var(--nimbus-glass-hover);
  border: 1px solid var(--nimbus-border-strong);
  border-radius: 4px;
  text-align: center;
  white-space: nowrap;
  line-height: 1.4;
  flex-shrink: 0;
}

.hotkey-desc {
  font-size: 0.8rem;
  color: var(--nimbus-text-muted);
}
</style>
```

- [ ] **Step 2: Verify HUD styling**

Open the app, press Tab to open the HUD. Confirm:
- Background uses the surface color with opacity
- Section titles use teal (primary) instead of hardcoded blue
- Links use teal instead of hardcoded blue
- Borders and kbd elements use nimbus tokens
- Text hierarchy follows the muted/secondary/primary pattern

- [ ] **Step 3: Commit**

```bash
git add src/components/HelpPanel.vue
git commit -m "feat(theme): update HelpPanel to use nimbus theme tokens"
```

---

### Task 8: Update CustomFileManager.vue Styles

**Files:**
- Modify: `src/components/CustomFileManager.vue:668-764` (dark theme overrides in unscoped block)
- Modify: `src/components/CustomFileManager.vue:807-832` (scoped theme overrides)

- [ ] **Step 1: Update the dark theme overrides in the unscoped style block**

In `src/components/CustomFileManager.vue`, find the `.v-theme--dark` block (around line 668) within the unscoped `<style>` block. Replace the color values inside that block to use nimbus tokens. The `!important` flags must stay because these override `@girder/components` bundled styles.

Replace:
```scss
    background-color: rgba(255, 255, 255, 0.05) !important;
```
with:
```scss
    background-color: var(--nimbus-glass-hover) !important;
```

Replace all instances of:
```scss
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
```
with:
```scss
    border: 1px solid var(--nimbus-border-strong) !important;
```

Replace all instances of:
```scss
    color: rgba(255, 255, 255, 0.87) !important;
```
with:
```scss
    color: rgb(var(--v-theme-on-surface)) !important;
```

Replace all instances of:
```scss
    color: rgba(255, 255, 255, 0.38) !important;
```
with:
```scss
    color: var(--nimbus-text-faint) !important;
```

Replace all instances of:
```scss
    color: rgba(255, 255, 255, 0.6) !important;
```
with:
```scss
    color: var(--nimbus-text-muted) !important;
```

Replace all instances of:
```scss
    background-color: rgba(255, 255, 255, 0.08) !important;
```
with:
```scss
    background-color: var(--nimbus-glass-hover) !important;
```

Replace all instances of:
```scss
    border-color: rgba(255, 255, 255, 0.24) !important;
```
with:
```scss
    border-color: var(--nimbus-border-strong) !important;
```

- [ ] **Step 2: Update the scoped theme overrides**

In the scoped style block (around lines 807-832), update the `.v-theme--dark` and `.v-theme--light` rules similarly:

Replace the `.v-theme--dark` block:
```scss
  .v-theme--dark & {
    border-color: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.7);

    &:hover, &:focus-within {
      background-color: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.24);
      color: rgba(255, 255, 255, 0.87);
    }
  }
```

with:
```scss
  .v-theme--dark & {
    border-color: var(--nimbus-border);
    color: var(--nimbus-text-secondary);

    &:hover, &:focus-within {
      background-color: var(--nimbus-glass-hover);
      border-color: var(--nimbus-border-strong);
      color: rgb(var(--v-theme-on-surface));
    }
  }
```

Replace the `.v-theme--light` block:
```scss
  .v-theme--light & {
    border-color: rgba(0, 0, 0, 0.12);
    color: rgba(0, 0, 0, 0.7);

    &:hover, &:focus-within {
      background-color: rgba(0, 0, 0, 0.04);
      border-color: rgba(0, 0, 0, 0.24);
      color: rgba(0, 0, 0, 0.87);
    }
  }
```

with:
```scss
  .v-theme--light & {
    border-color: var(--nimbus-border);
    color: var(--nimbus-text-secondary);

    &:hover, &:focus-within {
      background-color: var(--nimbus-glass-hover);
      border-color: var(--nimbus-border-strong);
      color: rgb(var(--v-theme-on-surface));
    }
  }
```

- [ ] **Step 3: Verify file manager styling**

Open the app, browse the file manager on the home page. Confirm:
- Input fields use nimbus border tokens
- Dark mode text colors match the new hierarchy
- Hover states use glass-hover backgrounds
- No visual regressions in the file table

- [ ] **Step 4: Commit**

```bash
git add src/components/CustomFileManager.vue
git commit -m "feat(theme): update CustomFileManager to use nimbus tokens"
```

---

### Task 9: Update UserMenu.vue Link Color

**Files:**
- Modify: `src/layout/UserMenu.vue:106`

- [ ] **Step 1: Replace hardcoded link color**

In `src/layout/UserMenu.vue`, line 106, replace:

```scss
  color: #64b5f6; // A lighter blue that works well with dark themes
```

with:

```scss
  color: rgb(var(--v-theme-primary));
```

- [ ] **Step 2: Verify**

Open the app, click the user icon to open the menu. Confirm links display in teal (primary color) instead of the old light blue.

- [ ] **Step 3: Commit**

```bash
git add src/layout/UserMenu.vue
git commit -m "feat(theme): update UserMenu link color to use primary token"
```

---

### Task 10: Visual Verification and Polish

**Files:**
- Potentially modify: any file from previous tasks if issues found

- [ ] **Step 1: Full visual walkthrough — Home page**

Open `http://localhost:5173`. Check:
- [ ] Background is near-black (#08090a)
- [ ] App bar is flat with subtle border
- [ ] Logo coral color unchanged
- [ ] Upload card has translucent glass background
- [ ] Recent datasets tab area matches theme
- [ ] File manager table is styled correctly
- [ ] Browse tabs (Datasets/Collections/Projects) use muted/active text pattern

- [ ] **Step 2: Full visual walkthrough — Dataset view**

Open any dataset. Check:
- [ ] Left sidebar (ViewerToolbar) matches panel surface
- [ ] Image viewer canvas area is the darkest background
- [ ] Right panel drawers (Object list, Snapshots, Settings) use panel surface
- [ ] Expansion panels in drawers are transparent with border dividers
- [ ] Buttons throughout use ghost styling

- [ ] **Step 3: Full visual walkthrough — Dialogs and menus**

Test:
- [ ] Help menu dropdown uses elevated surface
- [ ] User menu / login dialog uses elevated surface
- [ ] Any v-dialog uses elevated surface with border
- [ ] Tooltips are styled with nimbus tokens

- [ ] **Step 4: Test light theme**

Toggle theme to light (via settings or browser). Check:
- [ ] Background is #f7f8f8
- [ ] Surfaces are white
- [ ] Text is dark (#1a1a1a)
- [ ] Primary color still teal
- [ ] Borders are subtle dark rgba
- [ ] No broken layouts or invisible text

- [ ] **Step 5: Fix any issues found**

Address any visual issues discovered in steps 1-4. Common things to watch for:
- Text that becomes invisible on the new backgrounds
- Borders that are too subtle or too strong
- Components that didn't pick up the new theme tokens
- Girder components that need additional !important overrides

- [ ] **Step 6: Run type checking and linting**

```bash
pnpm tsc
pnpm lint
```

Fix any errors.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(theme): visual polish and fixes for Linear-inspired theme"
```
