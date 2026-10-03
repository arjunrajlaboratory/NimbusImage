# Command Palette (⌘K)

> **Status: Phase 1 implemented** (branch `feature/command-palette`). See
> _Implementation notes_ below for where the code ended up and where it
> departs from this spec, and the _Regression checklist_ at the end. Phase 2
> ("Ask AI") is not started. Part of the "adaptive interface" effort alongside
> `PANEL_LAYOUT_PERSISTENCE.md`, whose panel registry (Part 1, shipped with
> this feature) it reads.

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
  id: string; // stable, e.g. "panel.open.filtersPanel",
  // "tool.select.<toolId>", "tool.add.worker:<image>"
  title: string; // what the row shows
  group: TCommandGroup; // "Tools" | "Add tool" | "Panels" | "Layers" |
  // "Snapshots" | "Actions" | "Help"
  keywords?: string[]; // extra match terms (synonyms, tags, channel)
  description?: string; // secondary line; also matched, at lower weight
  icon?: string; // mdi name, checked against @mdi/font 5.9.55
  hotkey?: string; // shown as a hint, never re-bound by the palette
  enabled?: () => boolean; // e.g. requires login, requires a dataset
  run: () => void | Promise<void>;
}

// A provider derives commands from live state. Providers are plain functions
// read inside a `computed`, so the list re-derives whenever its inputs change.
export type TCommandProvider = () => ICommand[];
```

## Where commands come from (the self-updating part)

| Provider           | Source of truth                                                                                                                                                                              | Example                              | Updates on its own?                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| `toolCommands`     | `store.tools` (current configuration)                                                                                                                                                        | "Use tool: Nuclei" (shows hotkey)    | ✅                                    |
| `addToolCommands`  | `buildCatalog()` in `src/tools/creation/toolFromCatalog.ts`, which reads worker-image Docker labels (`interfaceName`, `description`) from `properties.workerImageList` plus `MANUAL_CATALOG` | "Add Cellpose-SAM tool…"             | ✅ registering a worker image adds it |
| `templateCommands` | `store.toolTemplateList` (`public/config/templates.json`)                                                                                                                                    | "Add tool: Snap to circle…"          | ✅                                    |
| `panelCommands`    | The panel registry from `PANEL_LAYOUT_PERSISTENCE.md` Part 1                                                                                                                                 | "Open Filters", "Close Layers"       | ✅ once the registry exists           |
| `layerCommands`    | `store.layers`                                                                                                                                                                               | "Toggle layer: DAPI"                 | ✅                                    |
| `snapshotCommands` | `configuration.snapshots`                                                                                                                                                                    | "Go to snapshot: Fig 2"              | ✅                                    |
| `tourCommands`     | The tour list App.vue's Help menu already builds                                                                                                                                             | "Tour: Calculate blob metrics"       | ✅                                    |
| `propertyCommands` | Properties store                                                                                                                                                                             | "Color by: Area"                     | ✅                                    |
| Static actions     | `useCommand()` registrations next to the feature                                                                                                                                             | "Export CSV", "Undo", "Switch to 3D" | ⚠️ one line per feature               |

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
directly. Use it only to _annotate_ commands with their hotkey hint. Don't
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
  a reactive store mock that _replaces_ `workerImageList`, as the real store
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

## Implementation notes

Where things live:

| Piece                                            | File                                                            |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Command model, group order                       | `src/commands/types.ts`                                         |
| Registry, `useCommand`, `useCommandProvider`     | `src/commands/registry.ts`                                      |
| Store-derived providers                          | `src/commands/providers.ts`                                     |
| Scorer / synonym table                           | `src/commands/scorer.ts`, `src/commands/synonyms.ts`            |
| Recently used (session)                          | `src/commands/recent.ts`                                        |
| Escape-hatch requests                            | `src/commands/requests.ts`                                      |
| Hotkey display                                   | `src/commands/hotkeys.ts`                                       |
| Palette UI                                       | `src/components/CommandPalette.vue` (mounted once in `App.vue`) |
| Card builder extracted from the tool-type dialog | `src/tools/creation/toolTypeCatalog.ts`                         |
| Panel registry                                   | `src/utils/panelRegistry.ts`                                    |

Who registers what:

- `CommandPalette.vue` registers the store-derived providers: tools, the
  Add-tool catalog, layers, snapshots and Color-by properties.
- `App.vue` registers the panel provider (it owns the open/closed refs), the
  tour provider and the app-bar actions.
- `UndoRedoButtons.vue`, `DataIOMenu.vue` and `Toolset.vue` register their own
  actions next to their controls, so these exist only while those controls are
  mounted (the dataset view).

Departures from the spec, and why:

- **One "Add tool" provider, not two.** `addToolCommands` lists every card of
  the Add-new-tool dialog (worker images _and_ template tools) from the
  extracted `buildToolTypeSubmenus`, instead of `buildCatalog()` plus a
  separate `templateCommands`. `buildCatalog()` is the AI flows' catalog and
  has no template tools, and running a command needs the dialog's own
  selection value. Sharing the dialog's builder means a card and its command
  can't disagree. Hidden cards (snap and edit tools) stay hidden in both.
- **Requests live in `src/commands/requests.ts`, not the main store.** The
  shape is the same as `paletteOpenRequests` (the owner watches, acts, clears),
  but plain module refs keep `src/store/index.ts` from growing and avoid the
  HMR breakage that store edits cause. Three requests exist: tool creation
  (`Toolset.vue`), snapshot load (`Snapshots.vue`) and Color-by pre-selection
  (`ColorByPropertyDialog.vue`).
- **The request carries the built selection** rather than a catalog id, so
  `Toolset.vue` doesn't have to rebuild the catalog to resolve it.
- **The data dialogs moved out of the Data I/O menu.** The import, export, CSV
  and index-conversion dialogs used to live inside the lazily rendered
  `v-menu`, so nothing could open them with the menu closed. They now sit
  beside it, take `v-model:open`, and **mount the first time they are
  opened**, so a viewer load still pays for none of them. Mounted eagerly,
  the CSV dialog would read the filtered-annotation list on every render.
- **Every app-bar and Tools-palette button has a command**, including "Add new
  tool…" (browse every tool type), alongside the per-card "Add tool: X…".
- **The worker list is refreshed when the palette opens** in the viewer.
  Before this, only mounting the Add-tool dialog fetched it, so
  "Add tool: Cellpose-SAM…" would have been missing until the user had opened
  that dialog once.
- **The hotkey is `mod+k`** (⌘K / Ctrl+K), bound with v-mousetrap's
  `allowInInputs` flag so it works from inside any text field too (and claims
  Ctrl+K from the browser's search-bar shortcut everywhere). The palette's own
  field handles the key itself and stops it, so the global binding doesn't
  toggle the palette straight back open.
- **Focus stays in the search field** (Tab is swallowed, the list prevents
  mousedown, rows are `tabindex="-1"`): app hotkeys are muted only while a text field has focus,
  and would otherwise act on the viewer behind the palette.

## Verified in the browser

On the HCR dataset (`6a5a8f6a7cb263929b47ece2`), from a fresh load, with real
key presses (Playwright; the Chrome-extension tab was occluded, which stalls
every Vuetify transition at 0 rAF, so it can't verify a dialog):

1. ⌘K opens the palette focused; ⌘K and Esc in the field close it, and focus
   returns to the page.
2. "gauss" → "Add tool: Gaussian Blur…" + Enter opens tool creation
   pre-selected, identical to picking the card in "Add new tool". (This
   server has no Cellpose worker.)
3. Replacing `workerImageList` without the Gaussian Blur image removes its
   command from the open palette, and restoring the list brings it back, with
   no reload.
4. "open analysis", then "filters": both stay open (companion rule).
5. "dapi" toggles the DAPI layer (and was toggled back).
6. "color by area" opens Color by with Area pre-selected.
7. "export csv" / "index conversions" open their dialogs, with the dimension
   labels loaded on the first open; the Data I/O menu path still works.
8. On the home route only global commands show (home, upload, AI, tours,
   help).
9. The Tab overlay lists `mod+k  Command palette: search every command`.

Not exercised live: "Go to snapshot" (the test collection has no snapshots,
and creating one would write to a shared configuration). It is covered by
*"loads a snapshot requested from the command palette, then clears it"*.

## Regression checklist

Each line names an invariant and the test that holds it, so a change here means
re-checking the list rather than rediscovering it.

Run `pnpm test src/commands src/components/CommandPalette.test.ts src/components/DataIOMenu.test.ts src/utils/v-mousetrap.test.ts src/App.commands.test.ts src/App.test.ts src/utils/panelRegistry.test.ts src/tools/creation/toolTypeCatalog.test.ts src/tools/toolsets/Toolset.test.ts src/components/Snapshots.test.ts src/components/AnnotationBrowser/ColorByPropertyDialog.test.ts`.

### Self-updating

- [ ] **A newly registered worker image becomes a command with no reload.** The store _replaces_ `workerImageList`; the provider must re-derive. — _"picks up a newly registered worker image without a reload"_
- [ ] **A provider's reactive inputs re-derive the list; a registration goes away with its component.** — _"re-derives a getter registration when its reactive input changes"_, _"useCommand registers for the component's lifetime"_
- [ ] **Commands are hidden while `enabled()` is false**, reactively. — _"hides commands whose enabled() is false, reactively"_, _"is disabled outside the viewer and when logged out"_
- [ ] **Every app-bar control names a registered command.** — _"registers a command for every data-command-id in the template"_, _"gives every app-bar palette toggle a data-command-id"_, _"name a command registered by the same component"_

### Matching

- [ ] **Letters of any script stay searchable** ("α-tubulin", µ ↔ μ); an ASCII-only normalizer erased them. — _"keeps non-Latin letters searchable (α-tubulin, µ)"_
- [ ] **Name, initials, description, synonym and diacritics matches.** — _"ranks the worker first for its name"_, _"matches a run of the title's word initials ('cs' → Cellpose-SAM)"_, _"matches a description word ('segment nuclei' finds Cellpose)"_, _"matches through a synonym (spots → puncta)"_, _"matches ignoring diacritics in either direction"_
- [ ] **Every query word must match**, and results are capped. — _"requires every query word to match"_, _"returns nothing for an empty query and caps results"_

### Running commands

- [ ] **A command runs only after the dialog has left**, so a dialog it opens doesn't fight the closing one for focus or the scrim. The test's dialog stub emits after-leave only when the test says so; an automatic one can't tell "after leave" from "a tick later". — _"does not run the command until the dialog has left"_
- [ ] **Reopening mid-close still runs the chosen command** (after-leave never comes once the leave is cancelled). — _"still runs the chosen command if reopened before it finished closing"_
- [ ] **The highlight follows the command, not the row number**, so a list that re-derives under the user (the worker list landing) can't make Enter run something else, and a vanished command falls back to the first row. — _"keeps the highlighted command when the list re-derives under it"_, _"falls back to the first row when the highlighted command disappears"_
- [ ] **⌘K / Ctrl+K typed in the search field closes the palette.** v-mousetrap ignores keys in inputs, so the field handles it (and claims Ctrl+K from the browser). — _"closes on its own toggle key typed in the search field"_
- [ ] **⌘K / Ctrl+K opens the palette from inside any text field**, and only that binding fires there. — *"fires an allowInInputs hotkey from inside a text field, and only that one"*
- [ ] **The field's own toggle key is stopped**, so the app-wide binding can't immediately reopen it. — *"stops its own toggle key, so the app-wide binding can't reopen it"*
- [ ] **Focus can't leave the field, by keyboard or pointer**, so viewer hotkeys (⌘⌫ delete included) stay muted behind the palette. — *"keeps focus in the search field on Tab"*, *"keeps focus in the search field when the list is pressed"*
- [ ] **Enter that confirms an IME composition runs nothing.** — *"ignores Enter that confirms an IME composition"*
- [ ] **Only real pointer movement moves the highlight**; a list scrolling under a resting pointer doesn't. — *"moves the highlight on real pointer movement only"*
- [ ] **Hotkey hints render the plus key and sequences** instead of throwing in the row render. — *"keeps the plus key instead of throwing on it"*, *"keeps the steps of a sequence apart"*
- [ ] **Import from JSON needs a login in the menu and the palette alike**, through one shared rule (Codex P2 on #1365). — *"offers Import only to logged-in users, in the menu and the palette alike"*
- [ ] **Data dialogs mount closed, then open.** Their on-open work (CSV preview, dimension labels) is a non-immediate watcher, which a dialog created already open never fires. — _"opens each dialog after mounting it, so its on-open watcher fires the first time"_
- [ ] **The data dialogs render no activator of their own.** An empty `#activator` template rendered each dialog's fallback "Export CSV"-style button into the app bar once it mounted. — *"its dialogs render no activator of their own"*
- [ ] **Same-named layers show their own hotkey**, read by position, not looked up by name. — _"gives same-named layers their own key, not the first one's"_
- [ ] **Closing without choosing runs nothing.** — _"closing without choosing runs nothing"_
- [ ] **Keyboard: arrows wrap, Enter runs the active row and records it as recent.** — _"arrow keys move the active row and Enter runs it after closing"_
- [ ] **Empty query shows recents first, not duplicated below.** — _"shows recent commands first on an empty query"_
- [ ] **"Add tool" opens creation pre-selected, never builds a tool silently**, and the selection matches what clicking the card produces. — _"asks for tool creation pre-selected instead of building a tool"_, _"opens tool creation pre-selected for an Add-tool request, then clears it"_
- [ ] **Selecting a shape card doesn't write into the shared template list.** — _"selecting a shape card does not write into the shared template"_
- [ ] **Requests are cleared once honoured, and a logged-out request is dropped.** — _"drops the request without opening when logged out"_, _"loads a snapshot requested from the command palette, then clears it"_, _"selects it when the dialog is already open"_
- [ ] **Panel commands go through the owner's toggle**, so the companion rules apply. — _"flips Open/Close with the palette's state and toggles through the owner"_

### Cost

- [ ] **No per-keystroke list rebuild**: providers are read inside `allCommands` (a `computed`); typing only re-scores. No provider reads per-annotation state. — _"re-scores on each keystroke without re-running the providers"_
- [ ] **The palette refreshes the worker list each time it opens in the viewer, and a failed refresh is logged, not leaked.** — _"resets the query and refreshes the worker list each time it opens"_, _"logs, rather than leaks, a failed worker-list refresh"_
- [ ] **A once-opened CSV dialog doesn't keep the Data I/O menu reading the filtered list**, but keeps it until its leave transition ends (no "(0)" flash while closing). — *"hands the CSV dialog the filtered list only while it is open"*

### Process

- Test files whose component watches a module-level request must unmount every
  wrapper (`enableAutoUnmount(afterEach)`). A wrapper left mounted by an
  earlier test answers the next test's request first, so the test under
  scrutiny sees an already-cleared request and fails, or passes for the wrong
  reason.
