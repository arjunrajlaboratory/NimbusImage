# Linear-Inspired Theme for NimbusImage

**Date:** 2026-04-07
**Branch:** `vuetify4-migration`
**Status:** Approved

## Overview

Replace NimbusImage's flat Material Design dark theme with a Linear-inspired design system. Dark-mode-native with layered surfaces, Inter Variable typography, and ghost/translucent component styling. Light theme gets basic cool-neutral treatment. All functionality and layout structure unchanged.

**Design reference:** [Linear Design System](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md/linear.app/)

## Scope

- **Dark theme:** Full Linear-inspired treatment (primary focus)
- **Light theme:** Basic cool neutrals defined in Vuetify config
- **Typography:** Inter Variable with OpenType `cv01`/`ss03`
- **Components:** Full restyling via theme tokens + global defaults + targeted CSS overrides
- **App bar:** Flat with border separation (no elevation shadow). Noted as adjustable if it doesn't work in practice.
- **Logo:** Keep coral (#E68A82) as-is — intentional warm splash against cool chrome

## Architecture

Three implementation layers, no new files:

1. **Vuetify theme config** (`src/plugins/vuetify.ts`) — All color tokens for dark and light themes via Vuetify's theme system. Component defaults via `defaults` config.
2. **Global CSS variables** (`src/style.scss`) — Non-Vuetify tokens (`--nimbus-*` namespace): borders, glass backgrounds, radius scale, shadows, font setup.
3. **Targeted overrides** (`src/style.scss` global + scoped component styles) — CSS overrides for structural components and third-party integrations (Girder, Shepherd tours).

**Font loading:** Inter Variable loaded via Google Fonts `<link>` in `index.html`.

## Design Tokens

### Dark Theme (Vuetify Colors)

| Token | Value | Usage |
|-------|-------|-------|
| `background` | `#08090a` | Page canvas, deepest layer |
| `surface` | `#0f1011` | Panels, header, nav drawers |
| `surface-bright` | `#191a1b` | Elevated cards, dropdowns, inputs |
| `surface-light` | `#28282c` | Hover states, active backgrounds |
| `primary` | `#26A69A` | Brand accent (unchanged) |
| `on-background` | `#f7f8f8` | Primary text on canvas |
| `on-surface` | `#f7f8f8` | Primary text on surfaces |
| `on-surface-variant` | `#8a8f98` | Muted/tertiary text |
| `secondary` | `#d0d6e0` | Secondary text color |
| `error` | `#e5534b` | Error states |
| `success` | `#27a644` | Success states |
| `warning` | `#d4a72c` | Warning states |
| `info` | `#5b9bd5` | Info states |

### Light Theme (Vuetify Colors)

| Token | Value | Usage |
|-------|-------|-------|
| `background` | `#f7f8f8` | Page canvas |
| `surface` | `#ffffff` | Cards, panels |
| `surface-bright` | `#f3f4f5` | Elevated/tinted areas |
| `primary` | `#26A69A` | Brand accent (same) |
| `on-background` | `#1a1a1a` | Primary text |
| `on-surface` | `#1a1a1a` | Primary text |
| `secondary` | `#4a5568` | Secondary text |

### CSS Custom Properties (`--nimbus-*`)

| Variable | Dark | Light | Usage |
|----------|------|-------|-------|
| `--nimbus-border` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.08)` | Default borders |
| `--nimbus-border-strong` | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.12)` | Emphasized borders |
| `--nimbus-glass` | `rgba(255,255,255,0.02)` | `rgba(0,0,0,0.02)` | Translucent backgrounds |
| `--nimbus-glass-hover` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.04)` | Hover translucent bg |
| `--nimbus-radius` | `8px` | `8px` | Standard radius (cards) |
| `--nimbus-radius-sm` | `6px` | `6px` | Buttons, inputs |
| `--nimbus-radius-lg` | `12px` | `12px` | Panels, featured cards |
| `--nimbus-shadow` | `none` | `0 1px 3px rgba(0,0,0,0.08)` | Subtle elevation (light only) |
| `--nimbus-font` | `'Inter Variable', Inter, ...system` | same | Font stack |

### Typography

- **Font:** Inter Variable with `font-feature-settings: 'cv01', 'ss03'`
- **Weights:** 400 (body), 500 (emphasis/UI), 600 (strong)
- **Letter-spacing:** `-0.02em` on headings, `normal` on body
- **Loading:** Google Fonts `<link>` in `index.html` — single variable font request
- Vuetify's built-in type scale remains; we override `font-family` globally

## Component Styling

### App Bar

- Background: `surface` (#0f1011)
- No elevation (remove `elevation-1` class)
- Bottom border: `1px solid var(--nimbus-border)`
- Title: Inter weight 500, letter-spacing -0.3px

### Navigation Drawers (Right Panels)

- Background: `surface` (#0f1011)
- Left border: `var(--nimbus-border)`
- No elevation shadow

### Cards (`v-card`)

- Background: `var(--nimbus-glass)` (translucent)
- Border: `1px solid var(--nimbus-border)`
- Radius: `var(--nimbus-radius)` (8px)
- No elevation

### Buttons (`v-btn`)

- Default (tonal): `var(--nimbus-glass)` bg, `var(--nimbus-border)` border, 6px radius
- Primary: `rgba(38,166,154,0.15)` bg, teal text, teal border at 0.2 opacity
- Hover: shift to `var(--nimbus-glass-hover)`
- Flat/text variants: transparent, lighten on hover

### Inputs (`v-text-field`, `v-select`, `v-combobox`)

- Background: `var(--nimbus-glass)`
- Border: `var(--nimbus-border)`
- Radius: 6px
- Focus: `var(--nimbus-border-strong)`

### Expansion Panels

- Background: transparent (inherit parent surface)
- Dividers: `var(--nimbus-border)`
- Header hover: `var(--nimbus-glass-hover)`

### Lists & List Items

- Background: transparent
- Hover: `var(--nimbus-glass-hover)`
- Active: `var(--nimbus-glass)` with teal left border or teal text

### Tabs (`v-tabs`)

- Indicator: teal underline
- Background: transparent
- Inactive text: `#8a8f98`
- Active text: `#f7f8f8`

### Chips/Tags (`v-chip`)

- Default: `var(--nimbus-glass)` bg, `var(--nimbus-border)` border, pill radius (9999px)
- Text: `#d0d6e0` (secondary)
- Close icon: `#8a8f98`, hover to `#f7f8f8`
- **Colored variants (annotation tags):** Apply assigned color as `rgba(color, 0.15)` background with solid color text — preserves color-coding for scientific annotation categories while matching the ghost aesthetic
- Hover: `var(--nimbus-glass-hover)`

### File Manager (Girder)

- Update existing `!important` overrides to use new tokens
- Table rows: transparent, hover with `var(--nimbus-glass-hover)`
- Breadcrumb dividers: `var(--nimbus-border)`

### Tour System (`tour.scss`)

- Update hardcoded colors (#1E1E1E, rgba values) to use CSS variables
- Overlay background: `surface` token
- Text: `on-surface` token

### Help Panel (HUD)

- Keep backdrop blur glass effect
- Update hardcoded rgba values to `--nimbus-*` variables

## Files Modified

| File | Changes |
|------|---------|
| `index.html` | Add Inter Variable font `<link>` |
| `src/plugins/vuetify.ts` | Full dark/light theme colors, component defaults |
| `src/style.scss` | `--nimbus-*` CSS variables, global component overrides, Inter font setup |
| `src/App.vue` | Remove `elevation-1` from app bar, update scoped/global styles |
| `src/plugins/tour.scss` | Replace hardcoded colors with CSS variables |
| `src/components/HelpPanel.vue` | Update rgba values to variables |
| `src/components/CustomFileManager.vue` | Update dark/light overrides to new tokens |
| `src/layout/UserMenu.vue` | Update link colors |

## Notes

- The flat app bar (no elevation shadow) is the primary approach but can be reverted to elevated or context-dependent if it doesn't work in practice.
- `@girder/components` still bundles Vuetify 3 CSS (un-layered), so `!important` remains necessary when overriding Girder component styles.
- Colored annotation chips use translucent backgrounds to maintain category color identity while fitting the ghost aesthetic.
- Light theme is intentionally basic — just color tokens, no component-level light-specific overrides beyond what the tokens provide.
