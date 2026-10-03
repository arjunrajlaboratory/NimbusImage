# Command Palette (⌘K)

> **Status: spec, not yet implemented.** Written so an agent can pick this up
> cold. Part of the "adaptive interface" effort alongside
> `PANEL_LAYOUT_PERSISTENCE.md`, whose panel registry this feature reads, and
> tool pinning/reordering (shipped separately).

## Goal

A single search box (⌘K / Ctrl+K) that can reach **everything the viewer can
do**, so the interface can get less crowded without features getting lost.
Typing "cellpose" should offer **"Add Cellpose-SAM tool…"**, typing "filter"
should offer **"Open Filters"**, and typing "dapi" should offer **"Toggle
layer DAPI"**.

The key requirement: **the palette updates itself as tools and features are
added.** It does not read source code. It builds its command list at runtime
from data the app already loads, plus one small explicit registration for
static actions.

## Command model

New module `src/commands/` (a directory, since it will grow):

```ts
export interface ICommand {
  id: string;               // stable, e.g. "panel.open.filtersPanel",
                            // "tool.select.<toolId>", "tool.add.worker:<image>"
  title: string;            // what the row shows
  group: TCommandGroup;     // "Tools" | "Add tool" | "Panels" | "Layers" |
                            // "Snapshots" | "Actions" | "Help"
  keywords?: string[];      // extra match terms (synonyms, tags, channel)
  description?: string;     // secondary line; also matched, at lower weight
  icon?: string;            // mdi name, checked against @mdi/font 5.9.55
  hotkey?: string;          // shown as a hint, never re-bound by the palette
  enabled?: () => boolean;  // e.g. requires login, requires a dataset
  run: () => void | Promise<void>;
}

// A provider derives commands from live state. Providers are plain functions
// read inside a `computed`, so the list re-derives whenever its inputs change.
export type TCommandProvider = () => ICommand[];
```

## Where commands come from (the self-updating part)

| Provider | Source of truth | Example | Updates on its own? |
|---|---|---|---|
| `toolCommands` | `store.tools` (current configuration) | "Use tool: Nuclei" (shows hotkey) | ✅ |
| `addToolCommands` | `buildCatalog()` in `src/tools/creation/toolFromCatalog.ts`, which reads worker-image Docker labels (`interfaceName`, `description`) from `properties.workerImageList` plus `MANUAL_CATALOG` | "Add Cellpose-SAM tool…" | ✅ registering a worker image adds it |
| `templateCommands` | `store.toolTemplateList` (`public/config/templates.json`) | "Add tool: Snap to circle…" | ✅ |
| `panelCommands` | The panel registry from `PANEL_LAYOUT_PERSISTENCE.md` Part 1 | "Open Filters", "Close Layers" | ✅ once the registry exists |
| `layerCommands` | `store.layers` | "Toggle layer: DAPI" | ✅ |
| `snapshotCommands` | `configuration.snapshots` | "Go to snapshot: Fig 2" | ✅ |
| `tourCommands` | The tour list App.vue's Help menu already builds | "Tour: Calculate blob metrics" | ✅ |
| `propertyCommands` | Properties store | "Color by: Area" | ✅ |
| Static actions | `useCommand()` registrations next to the feature | "Export CSV", "Undo", "Switch to 3D" | ⚠️ one line per feature |

**Static actions** (app-bar buttons, menus) register where they live with a
composable that unregisters itself on unmount:

```ts
// in DataIOMenu.vue
useCommand({
  id: "data.export.csv",
  title: "Export annotations as CSV…",
  group: "Actions",
  keywords: ["download", "spreadsheet"],
  run: () => openCsvExport(),
});
```

Because the registration sits next to the button, adding a feature and its
command is the same edit. Add a **coverage test** so nothing gets forgotten:
give each app-bar control a `data-command-id` attribute and assert that every
id in `App.vue`'s template exists in the registry.

**Hotkeys.** `boundKeys` in `src/utils/v-mousetrap.ts` records only
`{ section, description }`, not the handler, so it can't drive commands
directly. Use it only to *annotate* commands with their hotkey hint. Don't
extend the directive to store handlers: element-bound bindings
(`v-mousetrap.element`) expect the element as the handler's first argument and
would misbehave when invoked from the palette.

## "Add X tool…" flow

The tool-creation dialog lives in `Toolset.vue`. It's opened by
`handleToolTypeSelected(toolType)` with a `TToolTypeSelectionValue` that
`ToolTypeSelection.vue` builds internally when the user clicks a card.

1. Extract that card → `{ template, defaultValues, selectedItem }` builder out
   of `ToolTypeSelection.vue` into a util, so it can be called without the
   dialog.
2. Add a store request, the same escape-hatch shape as `paletteOpenRequests`:
   `store.requestToolCreation(catalogEntryId)`. Toolset.vue watches it, opens
   the Tools panel (via the panel registry), and opens `ToolCreation`
   pre-selected.
3. **Don't silently add a fully-built tool.** Worker tools need channel and
   parameter choices; the dialog is where the user makes them. (The AI
   tool-suggestion flow can skip the dialog only because Claude picks the
   channels; see `AUTO_TOOL_SUGGESTIONS.md`.)

## Matching ("semantic awareness")

Phase 1 is local, synchronous and fast, with no network:

- Score each command against the query, in priority order: an exact or prefix
  match on the title, then word-start matches ("cs" → "Cellpose-SAM"), then a
  subsequence match, then keywords, then description at a lower weight.
  Normalize case, hyphens and diacritics. Write a small scorer (about 50
  lines, unit-tested); don't add a dependency unless the scorer proves
  inadequate. If you do add one (e.g. `fuse.js`), call it out in the PR.
- Worker `description` labels are the main source of "semantic" matches:
  "segment nuclei" finds Cellpose-SAM through its description. Improving those
  Docker labels improves search for free.
- Add a hand-written synonym table for domain vocabulary (`spots ↔ puncta ↔
  dots`, `cells ↔ nuclei ↔ segment`, `measure ↔ property ↔ metric`). Keep it
  short and in one file.
- **Empty query** shows recently used commands (session memory, at most 8),
  then each group's top items, so opening the palette also shows what exists.
- Results are grouped under group headers, capped at about 50 rows, with the
  hotkey hint on the right.

Phase 2 (separate PR, optional): when nothing scores well, a final row
**"Ask AI: <query>"** opens the AI panel (`src/store/aiPanel.ts`) with the
query pre-filled. Gate it the same way the AI panel itself is gated (env flag
and login). Never send keystrokes to the network while the user types.

## UI

- `CommandPalette.vue`: a `v-dialog` (`max-width="640px"`, top-anchored), a
  `v-text-field` with autofocus, and a `v-list`. Arrow keys move, Enter runs,
  Esc closes. Follow `codebaseDocumentation/BUTTON_CONVENTIONS.md` for any
  buttons.
- **Discoverability:**
  - a visible search button in the app bar with the tooltip "Search commands
    (⌘K)";
  - a line in the Tab help overlay (`HelpPanel.vue`);
  - an anchor so a tour can point at it (`src/tours/anchors.ts`).
- Bind ⌘K/Ctrl+K with `v-mousetrap` (not a raw `keydown` listener), with
  `data: { section: "General", description: "Command palette" }` so it shows
  up in the help overlay.
- Mount it once, in App.vue. Only the viewer route has the full set of
  providers; on other routes show only the commands whose `enabled()` returns
  true.
- **Running a command closes the palette first, then runs.** If the command
  opens a dialog, opening it while the palette dialog is still closing can
  leave focus or the scrim stuck.

## Traps to respect (from repo skills)

- Providers must not rebuild a large list on every keystroke. Compute the
  command list in a `computed` over its sources, and do only scoring per
  keystroke. Layers and tools are small; don't add a provider over
  annotations.
- If a provider reads `properties.workerImageList`: it fills in after login,
  because `fetchWorkerImageList` early-returns until then. The palette must
  update when it arrives, which works for free when the provider is read in a
  `computed`.
- Icons: verify every mdi name against
  `node_modules/@mdi/font/css/materialdesignicons.css`.
  `src/__tests__/mdiIconNames.test.ts` enforces this.
- No `console.*`; use `logWarning` / `logError`.

## Tests to write

- Scorer: ranking table tests ("cellpose" → Cellpose-SAM first; "cs" word-start;
  a synonym hit; diacritics).
- Providers: each returns the expected ids from a fixture state, and
  `addToolCommands` reflects a newly added worker image without a reload. Use
  a reactive store mock that *replaces* `workerImageList`, as the real store
  does (nimbus-frontend skill, mock replacement semantics).
- `useCommand` unregisters on unmount.
- The app-bar coverage test described above.
- CommandPalette component: keyboard navigation, Enter runs and closes, Esc
  closes without running.

## Verification (in the browser)

Use the `in-browser-testing` skill and **real clicks/keys** (not synthetic
`dispatchEvent`):

1. ⌘K opens the palette, and "cellpose" + Enter opens tool creation with
   Cellpose-SAM preselected.
2. Register or remove a worker image (or edit `workerImageList`). The command
   appears or disappears without a reload.
3. "filters" opens the Filters panel and respects the companion rules.
4. Typing a layer name toggles that layer.
5. On a non-viewer route, only the global commands show.

## Regression checklist

When this ships, add a regression checklist here: one line per invariant,
each naming its test (see `CONNECTION_LIST.md` for the format).
