# UI Refresh · Plan & Status

> Working document. The visual north star lives in `refresh.html` (open it in
> a browser). This file tracks the *plan*, the *decisions made along the
> way*, and the *what's done / what's next* so a future session can pick up
> without re-deriving anything.

## Goal

Refresh NimbusImage's dataset-view UI from "opaque chrome with side panels"
to a "modular workspace" — the image is the hero, chrome floats over it as
glass palettes, panels are recombinant rather than fixed.

The home / list views stay essentially unchanged; only the **dataset view**
gets the new chrome.

## Direction

Four principles, in priority order:

1. **Image is the hero.** Chrome retreats. Transparency, no border on the bar.
2. **Recombinant by default.** Panels become palettes the scientist can show,
   hide, drag (drag/pin still pending — see Phase 3+).
3. **Single accent, used quietly.** The teal (`primary`, ~#26A69A) marks
   state — selection, active palette, confirmation. Nothing else.
4. **Nothing is lost.** The refresh is composition, not amputation. Every
   existing feature has a place.

## Surface taxonomy

Four surfaces, each with one job. When a feature lands on the wrong surface
the workspace feels noisy; when the surface matches the intent, the
interaction disappears.

| Surface | When | Behavior | Examples in NimbusImage |
|---|---|---|---|
| **Dock** | Mode switches you make constantly | Always-visible icon strip on an edge | (planned, Phase 4) Z + view controls bottom dock |
| **Palette** | Data you want to keep open while working | Floating glass panel, toggleable, dismissible | Right zone: Object Browser · Snapshots · Settings · Filters. Left zone: Navigator · Layers · Tools |
| **Popover** | Brief, ephemeral choice | Small transient menu near trigger | Dataset switcher · account menu · Data I/O · tool sub-options |
| **Drawer** | The task IS the workflow | Large overlay sheet, canvas dims behind | Upload · Help docs |

**Key rule:** circular icon buttons in the app bar should toggle *palettes*
only. *Drawer* launchers look similar but behave differently — mixing the
two semantics into one icon style is confusing. The app bar now has two such
clusters: a **left cluster** (Navigator / Layers / Tools) and a **right
cluster** (Object Browser / Filters / Snapshots / Settings).

## Phases

### ✅ Phase 0 · Type tokens

Type families established. Component audits land inline as later phases
touch components.

- `--nimbus-font` → Geist (UI default — applied app-wide)
- `--nimbus-font-mono` → Geist Mono (data, code, measurements)
- `--nimbus-font-display` → Instrument Serif (italic display moments)
- `.font-mono` and `.font-display` utility classes
- Tabular numbers + slashed zero on the mono stack

Commits: `c015779e`

### ✅ Phase 1 · Transparent app bar

The bar becomes fully transparent on dataset view — no background, no blur,
no border. Buttons float directly over the image, which extends to y=0
behind them. The left side panel gets a 64px top inset so its content
clears the floating buttons.

- `App.vue` binds `.datasetview-mode` on `<v-app>` when route is `datasetview`
- `style.scss` scopes the transparent bar + zero v-main top inset to that class
- `Viewer.vue` fills 100vh; side panel offset 64px

Commits: `8710f6d8`

**Decision:** the user chose fully transparent over frosted-glass/gradient.
"Make the buttons really appear to just float above the image."

### ✅ Phase 2 · Circular icon cluster + floating palettes

The three right-side text buttons (Object list / Snapshots / Settings) became
circular icon buttons in a pill-shaped cluster. The three matching
`v-navigation-drawer`s became `FloatingPalette`s.

- `src/components/FloatingPalette.vue` — new shared component: frosted-glass
  surface, grip + title + close header, fade transition. `v-show` (not
  `v-if`) so slot content stays mounted across open/close — necessary for
  watchers and preserved state (filters, scroll, snapshot bbox).
- `App.vue` — icon cluster markup + scoped `.palette-cluster` / `.palette-ibtn`
  styles with `.active` dot indicator under the active palette.
- Inner `v-card-title`s removed from `AnnotationBrowser`, `Snapshots`,
  `SettingsPanel` — the palette header carries the title.

Commits: `4d9c90fe` · `bdcadc78` · `a41bd51e`

### ✅ Phase 2.1 · Settings palette refactor

Settings flattened from `v-expansion-panels` accordion to inline sections.
Four sub-components (`AnnotationToggles`, `ViewerSettings`, `UISettings`,
`JobsLogs`) refactored to use a shared `<section class="settings-section">`
pattern with a small uppercase header.

Introduced `.settings-indent` (sub-toggle group with left-border accent that
dims when the parent toggle is off) and `.settings-inline` (label + control
on one row).

Commits: `3b110a17`

### ✅ Phase 2.2 · Global compact density

Pushed form-control sizing from per-palette scope up to global Vuetify
defaults so every palette, dialog, and form across the app shares one type
scale.

- `vuetify.ts` defaults: VSwitch · VCheckbox · VRadio · VSlider →
  `density="compact"`; VSelect · VAutocomplete · VCombobox · VTextField ·
  VTextarea → `density="compact"` + `variant="outlined"`; selects pass
  compact density into their menus via `menuProps`. All form controls
  default to `hideDetails="auto"`.
- `style.scss` globals: 13px labels for selection controls, sliders, fields;
  selection-control row height 28px; slider thumb 12px on a 3px track; menu
  list-item titles 13px, 32px min row height.

Commits: `adeee690`

### ✅ Phase 2.3 · Unclamp pan/zoom

Floating palettes overlay the canvas rather than push it, so part of the
image can be hidden behind a palette. GeoJS clamps Y pan + zoom-out to image
bounds by default, which prevented the user from panning the image to
reveal what's hidden.

Unclamped `clampBoundsX` / `clampBoundsY` / `clampZoom` on the GeoJS map —
both at create time and on bounds reconfigure.

### ✅ Phase 2.4 · Object Browser decomposition

The Object Browser was a four-section expansion-panel stack (Filters,
Actions, Properties, List). Each part needed its own home; nothing
deserved the modal it had become.

What moved:

- **Data I/O** → app-bar popover (`DataIOMenu.vue`, `mdi-swap-vertical-bold`).
  Houses Import JSON · Export JSON · Export CSV · Index conversions.
  The five dialog components forward a `#activator` slot so the popover
  list-items can drive them.
- **Delete connections** → bottom of the Annotation List "More Actions"
  menu (operation on annotations, not data I/O).
- **Filters** → its own palette (`FiltersPanel.vue`, `mdi-filter-variant`).
  Toggles **independently** of the Object Browser / Snapshots / Settings
  mutex — open alongside the list.
  - Tags section: search + Match select in a single row above the chip
    cloud (`TagFilterEditor.vue` reorganized; `TagCloudPicker.vue` now
    takes `searchText` as a prop).
  - Property values section: chevron-disclosure header with count chip;
    default-open if any property filters exist, default-closed otherwise.
  - Advanced disclosure: Scope (current frame / hidden layers), Object ID
    & region, **Selection** (use selection as filter — moved from the old
    Actions accordion).
  - `PropertyFilterHistogram.vue` reflowed: tight header row, CDF/log
    on their own controls row (was collapsing to one letter per line),
    full-width histogram bar, side-by-side Min/Max.
  - `PropertyFilterSelector.vue` deleted — Filters palette uses
    `PropertyPicker` directly via `mode="filter"`.
- **Properties** workflow split across three new homes:
  - `mdi-ruler-square` icon in the app bar opens `AnalyzeDialog.vue`
    (extracted from `AnnotationProperties.vue`). All measurement
    configuration / compute / batch progress lives here.
  - `PropertyPicker.vue` is the shared "pick which computed properties
    to use" component. Two view modes (tree default + Miller fallback
    via header toggle), Selected-list sidebar with × to unselect,
    count chip, search. Mode prop drives display vs filter behavior
    and is reused from both the annotation list and the Filters
    palette.
  - `PropertyTreeNode.vue` is the recursive tree node (chevron
    branch / checkbox leaf).
  - **+ Add property** lives in the Annotation List toolbar (primary
    flat button). **Show in annotation list…** lives at the bottom of
    the Measure dialog (primary flat button with ellipsis) and on
    Done auto-opens the Object Browser palette.
  - Column headers in the data table carry an × to remove the column.
- **Undo / Redo** → `UndoRedoButtons.vue`, two icon buttons in the app
  bar inside the dataset-view conditional. Tooltips name the pending
  action.
- **AnnotationActions accordion gone.** `AnnotationProperties.vue` gone.
  `PropertyFilterSelector.vue` gone. Object Browser is now a thin
  `<annotation-list />` — no expansion panels, no "Annotation List"
  heading (palette header carries the title).
- **Annotation list typography compacted** (12px headers / cells, 32px
  rows, hairline row dividers) and the table itself is now translucent
  so the palette's glass shows through. Property columns get
  `minWidth: 140` so long names like "DAPI blob metrics / Centroid / x"
  wrap sensibly instead of one word per line.

Known persistence gap surfaced and filed as
[#1177](https://github.com/arjunrajlaboratory/NimbusImage/issues/1177):
`displayedPropertyPaths` and `filterStore.filterPaths` are pure in-memory
mutations and don't survive a refresh. Pre-existing, not a regression
from this work, but worth fixing on `IDatasetView`.

### ✅ Phase 2.5 · Palette layout model + chrome polish

The palettes stopped being a flat list of independently-pinned drawers and
gained a small **declarative layout model** in `App.vue`. Plus a round of
canvas-overlay repositioning so the floating chrome stops fighting itself.

- **Declarative palette registry** (`App.vue`). Each palette has a `role`
  (`primary` | `companion`) and a `zone` (`left` | `right`). Replaces the old
  imperative `toggleRightPanel` / `lastModifiedRightPanel` bookkeeping.
  - Right zone is a mutually-exclusive column: Object Browser / Snapshots /
    Settings are primaries; **Filters** is a *companion* of the Object
    Browser — it stacks **above** the Browser when both are open and is
    evicted when another primary opens.
  - Stacked palettes flow vertically: a `ResizeObserver` measures the upper
    palette so the lower one sits flush beneath with no dead gap.
    `FloatingPalette` exposes its `rootEl` for this.
- **Canvas overlays repositioned.** Selection action panel → top-left (was
  top-right, hidden behind the palette column). Minimap (`ImageOverview`) →
  top-right, aligned with the palette column. Object Browser narrowed
  640 → 512.
- **Dataset breadcrumb pill.** The transparent bar left the dataset name hard
  to read, so `BreadCrumbs` gets a left-anchored glass pill (slimmed to button
  height, plain centered select).
- **Object Browser measure icon.** A ruler icon left of "+ Add property"
  opens the same Measure dialog as the app-bar ruler, via a shared
  `isAnalyzeDialogOpen` store flag.

Commits: `74651a1b` · `ead0a80d`

### ✅ Phase 3 · Dissolve the left sidebar

The left "Toolset / Layers / Z" sidebar is gone; the canvas is full-bleed and
its contents became three left-zone palettes toggled from a **left app-bar
cluster** (mirroring the right cluster — not the vertical edge-dock the
original plan sketched).

- **Navigator** (`NavigatorPanel.vue`) — XY / Z / Time sliders + unroll +
  timelapse controls + large-image dropdown.
- **Layers** (`LayersPanel.vue`) — layer-mode radios + Add layer +
  `DisplayLayers`.
- **Tools** — the existing `Toolset` (accordion removed; "Add new tool"
  left-aligned in the panel body).
- Left palettes **stack** (Navigator → Layers → Tools), independent of each
  other and of the right zone, each measured so it flows beneath the open
  ones above it.
- `FloatingPalette` gained a `left` anchor. `ViewerToolbar.vue` deleted (this
  also removed the duplicate tag-filter panel flagged below).
- **Layer grouping reworked.** The drag-only "Drag layer here to create
  group" landing pad is replaced by a **"Make group…" multi-select dropdown**
  (pick channels → new group) plus an **(×) to dissolve** a group. Dragging
  layers in/out of an existing group still works. New batched store actions
  `groupLayers` / `ungroupLayers` (one sync each). Layer rows made
  translucent; group-header switches aligned to the per-layer columns; row
  heights and palette spacing tightened.

Not done (deferred): a `workspace` Vuex module to persist palette
positions/visibility per user, palette dragging/pinning, and the `tab`-cycle /
`space`-peek keyboard gestures. These remain open for a later phase.

Commits: `5a8235b7` · `8b03c882` (+ grouping-rework commit)

### ⏳ Phase 4 · Bottom dock + motion + polish (NOT STARTED)

- Bottom dock: Z slider + frame indicator + view actions
- Move the bottom-left palette/lock icons into the bottom dock
- Workspace presets ("Annotate", "Review", "Measure")
- Spring motion on palette open/close
- "Peek" gesture: hold space → palettes fade to 12%
- Final typography sweep for any component no earlier phase touched

## Discussed but not committed

Surfaced during conversation, awaiting direction. None of these are
blocking:

### ~~Tag picker duplication in ViewerToolbar~~ (resolved, Phase 3)

`ViewerToolbar.vue` (and its duplicate `TagFilterEditor`) was deleted when
the left sidebar was dissolved. The Filters palette is the canonical home.

### Help / Account / Chat icons

Still loose icons next to the cluster, not in it. They are drawer / popover
surfaces in the taxonomy, so leaving them outside the palette cluster is
intentional. May want to give them their own visual treatment (a separate
group) once the cluster has been lived with.

### Per-dataset persistence (#1177)

Selected columns and active property filters reset on refresh. Not a
regression from this work — `togglePropertyPathVisibility` has always
been a pure Vuex mutation with no backend sync. The right home is
`IDatasetView`, alongside the existing per-user view state (contrast,
last location). See issue
[#1177](https://github.com/arjunrajlaboratory/NimbusImage/issues/1177)
for the proposed wiring.

## Decisions log

Things that aren't going to change without revisiting:

- **Transparent app bar (not glass/gradient).** "Buttons just float above
  the image." Phase 1.
- **Geist + Instrument Serif + Geist Mono.** Phase 0. Easy to swap by
  changing 3 CSS variables in `style.scss`.
- **FloatingPalette uses `v-show`, not `v-if`.** Required for child
  components that watch their `visible` prop or rely on persistent state.
  Phase 2.
- **Global compact density.** Phase 2.2. If a specific surface needs more
  breathing room it can opt out per-component, but the default is compact.
- **Always-float palettes (canvas full-bleed behind).** Aligned with Figma,
  not Lightroom. Required us to unclamp the canvas pan/zoom (Phase 2.3) so
  hidden areas are reachable.
- **Palettes have a `role` + `zone`.** Right zone is a mutex column with one
  companion (Filters↕Object Browser); left zone is an independent stack
  (Navigator → Layers → Tools). The two zones are independent. Phase 2.5/3.
- **Left tools became an app-bar cluster, not a vertical edge-dock.** The
  original Phase 3 sketch called for a `ToolDock.vue` on the left edge; we
  mirrored the right cluster instead so both edges share one mental model.
- **Layer grouping = dropdown + drag.** "Make group…" multi-select dropdown
  for discoverable creation, **plus** kept drag in/out of existing groups and
  an (×) to dissolve. Phase 3.
- **Don't re-render a vuedraggable list mid-drag.** The palette stacking
  `ResizeObserver` fired during a layer drag and re-rendered the draggable
  while SortableJS held the DOM → `emitsOptions` null crash. Drag state is
  mirrored to `store.isLayerDragging` and the observers pause during a drag.
- **Group aggregate state from data, not child refs.** A string `ref` inside
  a vuedraggable slot can't be collected into an array; `DisplayLayerGroup`
  computes its group switches from the layer data + store instead.

## File map

Where things live:

| What | Where |
|---|---|
| Visual north star (HTML) | `ui-mockups/refresh.html` |
| This plan | `ui-mockups/PLAN.md` |
| Type tokens | `src/style.scss` (`--nimbus-font` family) |
| Global form-control sizing | `src/style.scss` (.v-selection-control, etc.) |
| Vuetify defaults | `src/plugins/vuetify.ts` |
| Transparent-bar mode | `src/style.scss` (`.datasetview-mode` block) |
| Dataset-view route check | `src/App.vue` (`isDatasetView` computed) |
| Palette layout model (role/zone, stacking) | `src/App.vue` (`paletteRoles`, `openPalette`, `observePaletteHeight`) |
| Floating palette component (left/right anchor, `rootEl`) | `src/components/FloatingPalette.vue` |
| Palette cluster styles (left + right) | `src/App.vue` (scoped `.palette-cluster`) |
| Dataset breadcrumb pill | `src/layout/BreadCrumbs.vue` (`.datasetview-mode .breadcrumbs`) |
| Navigator palette (XY/Z/T + timelapse) | `src/components/NavigatorPanel.vue` |
| Layers palette (mode + DisplayLayers + Make-group) | `src/components/LayersPanel.vue`, `src/components/DisplayLayers.vue` |
| Layer group (header, dissolve ×) | `src/components/DisplayLayerGroup.vue` |
| Tools palette | `src/tools/toolsets/Toolset.vue` |
| Group/ungroup store actions | `src/store/index.ts` (`groupLayers`, `ungroupLayers`, `isLayerDragging`) |
| Selection action panel (top-left) | `src/components/AnnotationActionPanel.vue` |
| Minimap (top-right) | `src/components/ImageOverview.vue` |
| Settings section pattern | `src/components/SettingsPanel.vue` (scoped) |
| Filters palette wrapper | `src/components/FiltersPanel.vue` |
| Property picker (tree + miller) | `src/components/PropertyPicker.vue` |
| Property tree node (recursive) | `src/components/PropertyTreeNode.vue` |
| Analyze (measure) dialog | `src/components/AnalyzeDialog.vue` (`isAnalyzeDialogOpen` store flag) |
| Data I/O popover | `src/components/DataIOMenu.vue` |
| Undo/Redo app-bar buttons | `src/components/UndoRedoButtons.vue` |
| GeoJS pan/zoom unclamping | `src/components/ImageViewer.vue` (~line 800 + ~line 906) |

## Pointers for picking up cold

1. Read this file first (`ui-mockups/PLAN.md`).
2. Skim `ui-mockups/refresh.html` in a browser to remember the vision.
3. Check `git log --oneline ui-refresh` for the commit history.
4. The mockup file labels each phase with what's in scope — Section 04 of
   the HTML is the roadmap, Section 02b is the surface taxonomy, Section 03
   is the palette anatomy spec.
5. The mockup's hero (Section 02) predates the running app. Differences now:
   the left tools are an **app-bar cluster + floating palettes**, not the
   vertical edge-dock the mockup drew; the **minimap** sits top-right. The
   **bottom dock** (Z slider + view controls) is still unbuilt — Phase 4.
