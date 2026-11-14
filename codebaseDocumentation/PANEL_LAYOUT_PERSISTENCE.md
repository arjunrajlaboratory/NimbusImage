# Viewer Layout: Memory, Rearrangement and Workspaces (and the Panel Registry)

> **Status: Part 1 (the panel registry) implemented** in
> `src/utils/panelRegistry.ts`, shipped with the command palette. Parts 2–6
> are not started. Part of the "adaptive interface" effort alongside
> `COMMAND_PALETTE.md` (which reads the panel registry built here) and tool
> pinning/reordering (shipped separately).
>
> **Revised 2026-11.** The earlier version of this spec saved the open panels
> in the configuration, shared by everyone who opens the collection. That is
> replaced by per-browser memory plus an explicit, opt-in collection default.
> See _Why the layout is not saved in the configuration_ before changing it
> back.

## Goals

1. **Memory.** The viewer remembers how each person left it: which panels are
   open, and the small presentation state inside them (active tab, collapsed
   sections, column widths). Today every entry resets to a hard-coded default.
2. **Structured rearrangement.** Panels can be minimized, resized and
   reordered inside the existing zones. No free-floating windows.
3. **Workspaces.** Named layouts ("Annotate", "Analyze", "Review") that set
   the panels up in one step, plus an optional default a collection owner
   chooses on purpose.
4. **Relevance.** Panels that matter right now announce themselves. They do
   not open or move on their own.
5. **AI, outside the interaction loop.** A model may propose or compose a
   workspace; it never decides layout per click.

Each part ships on its own, in order. Parts 2 and 3 are the core; 4–6 build
on the layout shape they define.

## Design principles

These settle most of the judgment calls below. When a case is not covered,
apply them.

- **The canvas is the product.** A change that covers more image has to be
  something the user asked for.
- **Spatial stability.** A panel is where the user left it. Experienced users
  are fast because things do not move; nothing in this spec rearranges the
  screen without a direct user action.
- **Suggest, don't move.** Automation may highlight, badge, or offer. It opens
  a panel only as the direct, visible consequence of something the user just
  did (as the Timelapse palette already does when timelapse mode turns on).
- **User state and context state are different things.** A panel the user
  opened stays open and is remembered. A panel a context opened closes when
  the context ends and is never saved.
- **Presentation state is personal; analysis state is shared.** Open panels,
  tabs, widths and collapsed sections are per browser. Anything that changes
  which data is shown or measured (filters, layers, tools, columns) stays in
  the configuration or dataset view, where it already lives.

## Why the layout is not saved in the configuration

The earlier spec added `panelLayout` to the configuration and saved it,
debounced, on every toggle. Reasons this was dropped:

- **It is not shared state.** Whether Filters is open describes one person's
  screen and task, not the collection. Two people working in one collection
  would overwrite each other's layout, last write wins.
- **Every toggle becomes a configuration PUT**, on an object that also holds
  layers and tools.
- **It fails for the people who most need defaults to be sensible.** Anonymous
  and share-link viewers cannot save. Logged-in READ-only users get a failed
  PUT, and there is no configuration write-access getter to gate on (and a
  frontend-only permission check is not an acceptable substitute).
- **Most of that spec's edge cases existed only because of server
  persistence**: debounce, a configuration switch mid-debounce writing to the
  wrong configuration, and restore triggering a write-back.

What sharing is still worth having is covered by the explicit collection
default in Part 4: one deliberate write by someone who chose to make it.

## Current state (as of 2026-11, after Part 1)

All viewer chrome lives in `src/App.vue` (about 1,900 lines); the palette
definitions and rules live in `src/utils/panelRegistry.ts`.

- **Open/closed state** is a set of local `ref`s in App.vue, collected in its
  `paletteOpen` record (`Record<PanelId, Ref<boolean>>`).
- **Placement rules** are `PANELS` and `applyOpen()` in the registry; App.vue's
  `openPalette()`, `togglePalette()` and `closeAllPalettes()` apply them to
  the refs:
  - Right zone: one _primary_ at a time. Filters is a _companion_ that can
    share the column only with its listed `hosts` (Object Browser, Analysis).
  - Left zone (Navigator / Layers / Tools): an independent vertical stack.
- **Reset on every entry.** `datasetChanged()` closes everything when the
  route leaves `datasetview` or in embed mode. On entry it opens every panel
  marked `defaultOpen` (Navigator, Layers, Tools). Part 2 replaces this.
- **Opening from other components.** Components outside App.vue use
  `store.paletteOpenRequests` / `store.requestPaletteOpen([...])` (ids typed
  by `TRequestablePalette`, an alias of `PanelId`) and the older
  `store.isAnnotationPanelOpen` hatch. App.vue watches both.
- **Not in the registry:** the Timelapse palette (`timelapsePanel`) is a
  computed that mirrors `timelapseStore.showMode`. The AI panel is a separate
  `position: fixed` panel gated by an env flag and login.
- **Geometry is fixed.** Widths and clearances are constants in
  `src/utils/paletteGeometry.ts`, projected into CSS custom properties on
  `<v-app>`. Vertical stacking is measured with `ResizeObserver`s in App.vue.
- `FloatingPalette.vue` keeps its content mounted (`v-show`). Its grip icon is
  decorative. Position comes entirely from props.
- **Local persistence precedent:** `src/store/Persister.ts` (a thin
  `localStorage` wrapper), used by `toolSuggestions.ts` for its
  once-per-collection memory, with a most-recent cap.

## Part 1: the panel registry (implemented)

`src/utils/panelRegistry.ts` exports `PanelId`, `IPanelDefinition`, `PANELS`,
`PANEL_BY_ID`, `PANEL_IDS` and the pure rule function
`applyOpen(open, id)`. App.vue keeps the refs, because the template and the
`ResizeObserver` stacking bind to them, and reads everything else from the
registry. The Timelapse palette and the AI panel are deliberately absent:
their visibility is driven by other state. See the regression checklist at
the end.

## Part 2: local UI memory

### Storage module

Create `src/utils/uiState.ts`. It is not a Vuex module: nothing else needs to
observe it through the store, and `src/store/index.ts` is already too large.

```ts
// A reactive ref backed by localStorage. Reads once at creation; writes
// synchronously on change. `validate` returns the cleaned value or null, and
// null falls back to `defaultValue`.
export function usePersistedUiState<T>(
  key: string, // stored as `nimbus.ui.<key>`
  defaultValue: T,
  validate: (raw: unknown) => T | null,
): Ref<T>;
```

Requirements:

- **Never throw.** `Persister.get` calls `JSON.parse` on whatever is stored,
  and `localStorage` itself can throw (blocked site data, quota). Catch both;
  on failure behave as an in-memory ref for the session. The viewer must
  render correctly with no storage at all.
- **Validate on read.** Stored values come from older and newer clients.
  `validate` is required, not optional, so no caller trusts the shape.
- **Stay away from `nimbus.girderToken`.** That key is the user's live
  session. Use the `nimbus.ui.` prefix for everything here and never
  enumerate or clear keys outside it.
- **No `storage` event listener.** Two tabs are two workspaces; the last one
  to change a value wins on the next load, and neither tab's layout jumps
  because of the other.

### Layout shape

```ts
export interface IPanelLayout {
  version: 1;
  // The open set, not a boolean per panel, so a panel added later falls back
  // to its registry `defaultOpen`.
  open: PanelId[];
  // Part 3 adds: minimized, leftOrder, widths. All optional, so a layout
  // written before Part 3 still validates.
}
```

`validateLayout(raw)` lives next to the registry: it drops unknown ids
silently, and rebuilds the open set by feeding the ids through `applyOpen` one
at a time, so a stored or hand-edited layout can never produce an illegal
state such as two right-zone primaries.

### What is stored, and the restore order

Two local entries:

- `layout.last`: the layout the user most recently had, in any collection.
- `layout.byConfiguration`: a map from configuration id to layout, capped at
  the most recent 200 ids (same trimming as
  `rememberSuggestedConfigurationId` in `toolSuggestions.ts`).

On entry to the viewer, the first of these that exists wins:

1. my saved layout for this configuration;
2. the collection default, `configuration.defaultPanelLayout` (Part 4; until
   then, skip);
3. my `layout.last`;
4. the registry `defaultOpen` set.

The order matters: an owner's chosen default is what a first-time visitor
sees, and once that visitor changes anything their own layout for that
collection sticks.

### App.vue wiring

Put the restore/save loop in a composable, `usePanelLayoutPersistence`, that
takes the `paletteOpen` record and the configuration id. App.vue is too heavy
to mount in a test, and this logic needs tests.

1. **Restore once per configuration id.** The configuration can arrive after
   the route changes on a cold load; check the order and restore when
   `store.configuration?.id` becomes available. Do not restore on every
   configuration object replacement: syncs and `ressourceChanged` refetches
   replace the object, and re-applying then would undo panels the user just
   toggled.
2. **Save on change, synchronously.** Watch the open set serialized (sorted
   ids joined; see "Watching Getters That Rebuild Their Return Object" in the
   nimbus-frontend skill) and write both entries. No debounce is needed, which
   also removes the configuration-switch-mid-debounce race.
3. **Do not save while restoring.** Compare against the last restored value or
   use a flag.
4. **Leaving the viewer must not save.** `closeAllPalettes()` runs when the
   route leaves `datasetview`; saving that would turn every remembered layout
   into "all closed". Gate the watcher on `routeName === "datasetview"`.
5. **Embed mode neither restores nor saves.** An embedded viewer has its own
   fixed presentation.
6. **Only user opens are saved.** Give `openPalette` a source:

   ```ts
   function openPalette(id: PanelId, source: "user" | "context" = "user");
   ```

   Track the context-opened ids in a set and exclude them from what is
   saved. App-bar toggles, command palette commands and existing
   `paletteOpenRequests` callers are `"user"` (each of those is a click on a
   control that names the panel). Part 5 is the first `"context"` caller.
   A user toggling a context-opened panel promotes it to user state.

### State inside panels

Each panel declares its own remembered presentation state with
`usePersistedUiState`, in the panel's component, not in App.vue. Start by
inventorying what resets today; expected candidates are the Object Browser's
active tab, expanded/collapsed sections in Layers and Settings, and the
Analysis panel's last plot type.

Rules for what qualifies:

- Presentation only. If it changes which objects are shown, counted or
  measured, it belongs in the configuration or dataset view.
- Never ids of annotations, connections or datasets. Configurations are
  shared across datasets and local state outlives both; persist the choice
  (a tab name, a property path), not the things it selected.
- Panel content is always mounted (`v-show`), so a restored "open" state must
  not trigger fetches for a hidden panel. Gate fetches on visibility, as the
  existing panels do.

### Edge cases

- [ ] Stored layout names a panel that no longer exists → ignored.
- [ ] Stored layout has two right-zone primaries → resolved through
      `applyOpen`; the last one wins.
- [ ] Corrupt JSON, or `localStorage` throws → defaults, no error surfaced.
- [ ] Anonymous, share-link and READ-only users get the same memory as
      everyone else, with no network request and no notification.
- [ ] Opening or leaving a dataset issues no configuration PUT.
- [ ] Leaving the viewer does not save "all closed".
- [ ] The Transcripts panel is saved as open but the next dataset has no
      transcript store → it stays closed there (App.vue already gates the
      button) and the saved layout is not rewritten because of it.
- [ ] A second dataset in the same configuration restores the same layout.

## Part 3: structured rearrangement

All four features extend `IPanelLayout` with optional fields and are saved by
the Part 2 loop. Free-floating, drag-anywhere panels are a non-goal: they
bring occlusion, off-screen panels and overlap bugs, and
`paletteGeometry.ts` records two overlap bugs from the _fixed_ layout already.

**Minimize to a chip** (`minimized: PanelId[]`). Make the `FloatingPalette`
grip real: a minimize button collapses the panel to a small labeled chip
(icon + title) on its zone's edge, and clicking the chip restores it. A
minimized panel is still discoverable, unlike a closed one, and the chip is
where Part 5 puts badges. Minimizing must not unmount the content. A
minimized right-zone primary still owns the column for `applyOpen` purposes;
decide and test whether opening another primary closes it or replaces its
chip.

**Resizable columns** (`widths: { left?: number; right?: number }`). Drag the
inner edge of a zone to resize it. Constraints:

- Widths flow through `paletteGeometry.ts`, which is the single source for
  clearances. Turn the affected constants into functions of the current
  widths and keep projecting them into the CSS custom properties; do not add
  a second copy of any number.
- Clamp to a per-zone minimum and to the viewport, on restore as well as on
  drag, so a width saved on a large monitor cannot cover the canvas on a
  laptop.
- Width is per zone, not per panel: the right column keeps one width as its
  primary changes. If a panel needs more than the minimum (Analysis is 560
  today), its registry entry declares a `minWidth`.
- The canvas-anchored surfaces (selection action panels, progress bars, the
  bottom-left button cluster, the Timelapse palette) read these clearances.
  Check each after a resize.

**Reorder the left stack** (`leftOrder: PanelId[]`). Drag a left panel's
header to change the stack order. The `ResizeObserver` stacking in App.vue
currently assumes Navigator → Layers → Tools; generalize it to an ordered
list before adding the drag. Ids missing from a stored order append in
registry order.

**Hide all chrome.** One hotkey and command hides every panel and restores
exactly the previous set on the second press. The hidden state is session
only and is never saved as the layout. Register it through
`src/commands/` so it appears in the palette and the help overlay, and check
`src/commands/hotkeys.ts` for conflicts before choosing the key.

Deferred: moving a panel between the left and right zones. The right zone's
primary/companion rules make it more than a cosmetic change; revisit after
the above have been used for a while.

## Part 4: workspaces and the collection default

A **workspace** is a named `IPanelLayout`. Applying one is the same operation
as restoring a saved layout, so it reuses `validateLayout` and is then
remembered like any other user change.

- **Built-in workspaces** are a constant next to the registry
  (`WORKSPACES`). Starting set, to be tuned with real use:
  - _Annotate_: Navigator, Layers, Tools.
  - _Analyze_: Layers, Object Browser, Filters.
  - _Plot_: Layers, Analysis, Filters.
  - _Review_: Navigator, Snapshots.
- **Commands.** A `workspaceCommands` provider in `src/commands/providers.ts`
  yields "Workspace: Annotate" and so on, plus "Reset layout" (clears my
  saved layout for this configuration and re-runs the restore order).
- **Collection default.** One optional configuration field:

  ```ts
  // A layout the collection's owner chose for first-time visitors. Written
  // only by the explicit "Save layout as collection default" command.
  defaultPanelLayout?: IPanelLayout;
  ```

  - Written by a single `syncConfiguration("defaultPanelLayout")` when the
    user runs the command, and never as a side effect of toggling panels.
  - A failed write (READ-only user) surfaces through the normal
    `sync.setSaving(error)` path. Do not add a frontend permission check.
  - **Backend.** No change should be needed: `CollectionSchema` in
    `server/models/collection.py` lists `meta` properties but does not set
    `additionalProperties: false`, which is how `annotationBrowserConfig` and
    `visibilityConfig` persist. **Verify with a real save and reload**, not by
    reading the schema, and check that the `nimbusimage` Python package
    round-trips an unknown configuration key without dropping it.
  - A "Clear collection default" command removes it.
- **User-defined workspaces** ("Save current layout as…") are stored locally
  with `usePersistedUiState`. Do this last, and only if the built-ins prove
  too few.

## Part 5: relevance

The goal is that the right panel is one obvious click away, not that it
appears by itself.

Add optional fields to `IPanelDefinition`:

```ts
// Is this panel worth pointing at right now? Read inside a computed.
relevant?: (ctx: IPanelContext) => boolean;
// Short status shown on the app-bar toggle and the minimized chip,
// e.g. "2 active". Null hides it.
badge?: (ctx: IPanelContext) => string | null;
```

`IPanelContext` is a small object of facts App.vue already has or can read
cheaply: whether the dataset has time, Z, or a transcript store; the selected
tool's type; the selection count; the active filter count; whether any
properties exist; whether a job is running.

- **Predicates must be cheap.** They are read reactively. Use counts and
  flags the stores already expose; never iterate annotations or property
  values (datasets reach 700K objects).
- **Presentation.** A relevant, closed panel gets an accent on its app-bar
  toggle; a minimized one gets it on its chip. The existing
  `activeFilterCount` badge on Filters and the Transcripts button gating are
  the two cases that already exist; move them onto these fields so there is
  one mechanism.
- **Opening is the exception.** A context may open a panel only when it is
  the direct consequence of a user action that names the task (the Timelapse
  palette is the model). Such opens use `openPalette(id, "context")`, close
  when the context ends, and are never saved (Part 2, item 6). Any new
  auto-open needs a line in this document saying which action causes it.
- **No learned or usage-based reordering.** Anything that changes position
  based on history breaks spatial stability.

## Part 6: AI

A model is not in the interaction loop. A per-click layout decision from a
model is slow, nondeterministic, costs money, and is unavailable to logged-out
users; the rules in Part 5 are instant and predictable.

Two places it fits, both using machinery that exists:

- **First open of a collection.** `src/store/toolSuggestions.ts` already runs
  once per collection, on first open with no tools, and proposes tools from
  the dataset. Extend its response with an optional workspace name from
  `WORKSPACES`. It is offered alongside the tool suggestions and applied only
  if the user accepts.
- **Natural language.** "Set me up for counting spots" typed into the command
  palette goes to Ask Nimbus AI (`src/store/aiPanel.ts`), which answers by
  choosing from the command registry: a workspace command, panel commands,
  "add tool" commands. The command ids are the whole action space, so a small
  fast model is sufficient, and every step is a command the user could have
  run by hand and can undo the same way.

Constraints: nothing is sent while the user types (as today), both paths are
gated like the AI panel (env flag and login), and a model never writes a
layout directly. It names commands; the commands go through `applyOpen` and
the Part 2 save loop like any other user action.

## Non-goals

- Free-floating or tabbed docking windows.
- Syncing a personal layout across devices. If this is wanted later, the
  per-user `dataset_view` or a user-settings endpoint is the place, not the
  configuration.
- Layout decisions made by a model during normal interaction.
- Remembering layout for the Timelapse palette or the AI panel, whose
  visibility is owned by other state.

## Tests to write

Part 2:

- `uiState.test.ts`: round trip; corrupt JSON falls back; a throwing storage
  falls back and keeps working in memory; `validate` returning null uses the
  default; keys are prefixed.
- `panelRegistry.test.ts` additions for `validateLayout`: unknown ids dropped,
  two right-zone primaries resolved, missing optional fields accepted.
- `usePanelLayoutPersistence` tests: the restore order (all four levels);
  restore does not save; leaving the viewer does not save; embed mode neither
  restores nor saves; a replaced configuration object with the same id does
  not re-restore; context-opened panels are not saved, and are once the user
  toggles them; the per-configuration map is capped.

Part 3: geometry functions (clearances follow widths; clamping on restore),
left-stack order with missing and unknown ids, hide-all restores the exact
prior set and is not saved.

Part 4: applying a workspace goes through `validateLayout`; "Save layout as
collection default" issues exactly one configuration write; toggling panels
issues none. Dispatch the real store action, as `src/store/index.test.ts`
does.

Part 5: predicates against a table of contexts; a context-opened panel closes
when its context ends and leaves the saved layout unchanged.

Make each new test fail once against the unfixed code before trusting it
(nimbus-frontend skill, "Test mocks must model the real store's REPLACEMENT
semantics").

## Verification (in the browser)

Use the `in-browser-testing` skill. From a **fresh page load** on a real
collection:

1. Open Filters + Object Browser, close Layers, reload. The same layout comes
   back.
2. Open a second dataset in the same collection. Same layout.
3. Open a dataset in a collection never visited. The collection default if it
   has one, otherwise the layout from step 1.
4. Log out (or use a public dataset) and toggle panels, then reload. The
   layout is remembered, with no notification.
5. In the network tab, opening a dataset, toggling panels and leaving the
   viewer issue no configuration PUT.
6. Leave the viewer and come back. The layout is as it was, not all closed.
7. (Part 3) Resize the right column wide, shrink the window, reload. The
   column is clamped and the canvas-anchored surfaces do not overlap it.

Do not touch `nimbus.girderToken` while inspecting `localStorage`; read and
clear only `nimbus.ui.*` keys.

## Regression checklist

Part 1 (registry) only; extend as each later part ships. Run
`pnpm test src/utils/panelRegistry.test.ts src/App.test.ts`.

- [ ] **A right-zone primary evicts the other primaries.** — *"a primary evicts the other right-zone primary"*
- [ ] **Filters stays with a host and is evicted by a non-host.** — *"a primary keeps a companion that hosts with it"*, *"a primary evicts a companion that doesn't host with it"*, *"a companion joins its host"*, *"a companion evicts a primary that isn't its host"*
- [ ] **The left stack is independent of itself and of the right zone.** — *"left-zone palettes stack independently of each other and the right"*
- [ ] **An unknown id (from an older or newer client) is ignored.** — *"leaves the set unchanged for an unknown id"*
- [ ] **The defaults are the left stack only**, replacing the hard-coded `datasetChanged()` opens. — *"opens the left stack by default and nothing on the right"*
