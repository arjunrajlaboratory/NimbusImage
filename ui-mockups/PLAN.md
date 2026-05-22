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
| **Dock** | Mode switches you make constantly | Always-visible icon strip on an edge | (planned) drawing tools left edge; Z + view controls bottom dock |
| **Palette** | Data you want to keep open while working | Floating glass panel, toggleable, dismissible | Object Browser · Snapshots · Settings (planned: Layers, Tool Inspector, Filters) |
| **Popover** | Brief, ephemeral choice | Small transient menu near trigger | Dataset switcher · account menu · tool sub-options |
| **Drawer** | The task IS the workflow | Large overlay sheet, canvas dims behind | Upload · (planned) Data import/export · Help docs |

**Key rule:** circular icon buttons in the app bar should toggle *palettes*
only. *Drawer* launchers look similar but behave differently — mixing the
two semantics into one icon style is confusing.

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

### ⏳ Phase 3 · Dissolve side panels (NOT STARTED)

The big move. Left "Toolset / Layers" and right side panel become palettes.

- Extract Toolset selector into a vertical `ToolDock.vue` on the left edge
- Move Layers / Channels block into a Layers palette opened via dock button
- (Object Browser already a palette — done in Phase 2)
- Add a `workspace` Vuex module that persists palette positions per user
- Decide always-float vs pin-pushes-canvas. **Current lean: always-float**
- Keyboard: `tab` cycles palettes; `space` peeks the canvas (hide all)
- Recommend behind a "New workspace" toggle in Settings; keep classic for
  ~2 releases

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

### Data import/export

Currently lives in an Actions accordion inside Object Browser, mixed with
unrelated things (Undo/Redo, selection filter, CSV export, Index
conversion, Delete connections).

**Recommendation:** decompose. Conservative version (recommended first):
pull `Import / Export / CSV / Index conversion / Delete connections` into a
new "Data" icon → modal (drawer surface). Full version (deferred to Phase
4): also move Undo/Redo to the bottom dock and convert selection filter to
an inline chip in Object Browser.

### Tag browser / Filters palette

Currently duplicated — appears inside Object Browser AND on the left side
panel toolbar.

**Recommendation:** consolidate into a **Filters** palette (not just Tags
— there's TagPicker + Property filter + Annotation ID filter + Region
filter, all the same question of "what subset am I looking at"). Toggleable
via a new icon in the cluster. Default position bottom-left. Remove from
left side panel and from inside Object Browser.

Alternative considered: always-visible bottom-left palette that can't be
hidden. Rejected — burns pixels even when not needed. Palette toggle is
consistent with everything else.

### Help / Account / Chat icons

Still loose icons next to the cluster, not in it. They are drawer / popover
surfaces in the taxonomy, so leaving them outside the palette cluster is
intentional. May want to give them their own visual treatment (a separate
group) once the cluster has been lived with.

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
| Floating palette component | `src/components/FloatingPalette.vue` |
| Palette cluster styles | `src/App.vue` (scoped) |
| Settings section pattern | `src/components/SettingsPanel.vue` (scoped) |
| GeoJS pan/zoom unclamping | `src/components/ImageViewer.vue` (~line 800 + ~line 906) |

## Pointers for picking up cold

1. Read this file first (`ui-mockups/PLAN.md`).
2. Skim `ui-mockups/refresh.html` in a browser to remember the vision.
3. Check `git log --oneline ui-refresh` for the commit history.
4. The mockup file labels each phase with what's in scope — Section 04 of
   the HTML is the roadmap, Section 02b is the surface taxonomy, Section 03
   is the palette anatomy spec.
5. The mockup's hero (Section 02) shows palette positions that don't yet
   match the running app (vertical tool dock, bottom dock, minimap) —
   those are Phase 3 / Phase 4 work.
