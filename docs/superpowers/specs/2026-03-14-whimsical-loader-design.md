# Whimsical Loader Design Spec

## Overview

Replace all indeterminate progress spinners across the NimbusImage app with fun, science-themed CSS animations. One component (`WhimsicalLoader.vue`) handles all sizes.

## Component: `WhimsicalLoader.vue`

**Location:** `src/components/WhimsicalLoader.vue`

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Controls animation selection, dimensions, and text display |
| `text` | `string \| undefined` | `undefined` | Override text displayed below animation (md/lg only). At lg size with no text prop, a random fun message is shown. |
| `color` | `'auto' \| 'light' \| 'dark'` | `'auto'` | Animation color scheme. `auto` uses CSS `currentColor`. `light` forces white (for dark backgrounds). `dark` forces dark (for light backgrounds). |

### Size Behavior

| Size | Pixels | Animation Pool | Text |
|------|--------|---------------|------|
| `sm` | 16-24px | Tiny atom only | None |
| `md` | 48px | Full set (DNA helix, bubbling beaker, Newton's cradle, orbiting atom) | Only if `text` prop provided |
| `lg` | 64px | Full set | Random fun message (unless `text` prop overrides) |

### CSS Animations

All animations are pure CSS (no external dependencies). Target animation duration ~2-3s, infinite loop, ease-in-out easing.

1. **DNA Helix** (md/lg) - Two strands of dots that twist around each other using sinusoidal motion. ~2.5s loop.
2. **Bubbling Beaker** (md/lg) - Flask/beaker outline with circles rising and fading out. ~3s loop.
3. **Newton's Cradle** (md/lg) - Row of balls where the end balls swing alternately. ~2s loop.
4. **Orbiting Atom** (md/lg) - Central nucleus dot with 2-3 elliptical electron orbits at different angles. ~2s loop.
5. **Tiny Atom** (sm only) - Simplified single-dot nucleus with one orbiting electron. ~1.5s loop. Optimized for readability at 16px.

Animation is selected randomly on component mount and remains fixed for that instance's lifetime.

### Fun Text Messages (lg size, random on mount)

- "Crunching pixels with extra enthusiasm..."
- "Teaching the computer to see..."
- "Consulting the literature..."
- "Sprinkling some digital magic..."
- "Doing science..."
- "Peer-reviewing your request..."
- "Running the gel... digitally..."
- "Calibrating the microscope..."

### Accessibility

- Component renders with `role="status"` and `aria-label="Loading"`.
- Respects `prefers-reduced-motion`: when active, all animations replaced with a simple opacity pulse (0.3 to 1.0, 1.5s loop) on a single dot at the appropriate size.

## Integration Points

### 1. ProgressBarGroup.vue

**Current behavior:** Shows `v-progress-linear indeterminate` for items with `total === 0`.

**New behavior:**
- Indeterminate single/grouped progress items show `WhimsicalLoader` (md) inline alongside the progress title text, replacing the indeterminate `v-progress-linear`. Fits within the existing 400px-wide dark overlay layout. The animation sits left, title text sits right, same row height (~32px).
- When progress becomes determinate (total > 0), hard swap to the existing `v-progress-linear` with percentage (no animated transition needed).
- When multiple indeterminate groups exist simultaneously, each gets its own row with an md animation + title, stacked vertically as they are today.
- Notifications section unchanged.

### 2. Large Overlay Spinners (lg, with descriptive text)

Replace `v-progress-circular` (size >= 64) with `WhimsicalLoader size="lg"`, passing the existing descriptive text via the `text` prop.

| File | Current | New |
|------|---------|-----|
| `Home.vue` | 128px spinner + "Loading dataset information..." | `WhimsicalLoader size="lg" text="Loading dataset information..."` |
| `Dataset.vue` | 128px spinner + "Loading dataset information..." | `WhimsicalLoader size="lg" text="Loading dataset information..."` |
| `ProjectInfo.vue` | 64px spinner + "Loading project..." | `WhimsicalLoader size="lg" text="Loading project..."` |

### 3. Medium Card/Container Spinners (md, no text)

Replace standalone `v-progress-circular indeterminate` in card/container contexts.

| File | Line | Context |
|------|------|---------|
| `AnnotationWorkerMenu.vue` | 39 | Fetching worker interface |
| `Snapshots.vue` | ~410 | Download spinner |
| `Property.vue` | ~20 | Property computation |

### 4. Small Button Spinners (sm, tiny atom)

Replace small inline `v-progress-circular indeterminate` (size <= 24) inside buttons.

| File | Line | Context |
|------|------|---------|
| `AnnotationWorkerMenu.vue` | 106 | 16px spinner in Cancel button |
| `ImageViewer.vue` | ~87 | 18px SAM overlay spinner |

### 5. Other Spinners (deferred)

The following files also contain `v-progress-circular indeterminate` but are lower priority. They can be converted in a follow-up pass after the core component is working:

- `FileManagerOptions.vue`, `ConfigurationSelect.vue`, `ShareProject.vue`, `ShareDataset.vue`
- `NewDataset.vue`, `AddDatasetToCollection.vue`, `AnnotationImport.vue`, `AnnotationCSVDialog.vue`
- `PropertyList.vue`, `ChatComponent.vue`, `SharingStatusIcon.vue`, `MultiSourceConfiguration.vue`
- `PropertyWorkerMenu.vue`, `HotkeySelection.vue`, `ToolItem.vue`

## What Does NOT Change

- All determinate progress bars (with percentage/count tracking)
- Descriptive text on overlay loaders (preserved via `text` prop)
- Notification system in ProgressBarGroup
- Progress bar styling/colors for determinate states
- Deferred spinner locations (section 5 above)

## Technical Notes

- No new dependencies. Pure CSS animations.
- Component uses Vue 3 `<script setup>` with TypeScript.
- Animation and text selection use `Math.random()` on mount, stored in a ref so they don't change during the component's lifetime.
- Animation colors use `currentColor` by default so they inherit from parent context. The `color` prop provides explicit overrides for cases where inheritance doesn't work (e.g., white on dark overlays).
