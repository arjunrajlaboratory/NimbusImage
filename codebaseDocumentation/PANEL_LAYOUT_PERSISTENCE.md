# Viewer Layout: Memory, Rearrangement and Workspaces (and the Panel Registry)

> **Status: Parts 1–5 implemented.** Part 1 (the panel registry) shipped
> with the command palette; Parts 2–5 (local memory, rearrangement,
> workspaces and the collection default, badges and availability) are on
> branch `claude/viewer-ui-state-management-88f607`. Part 6 (AI) is not
> started, and two pieces of Part 5 are deliberately deferred (see there).
> Part of the "adaptive interface" effort alongside `COMMAND_PALETTE.md`.
>
> **Revised 2026-11.** The earlier version of this spec saved the open panels
> in the configuration, shared by everyone who opens the collection. That is
> replaced by per-browser memory plus an explicit, opt-in collection default.
> See _Why the layout is not saved in the configuration_ before changing it
> back.
>
> The Parts below describe the code **as built**. Where the code and this
> document disagree, the regression checklist at the end and its tests are
> the authority.

## Where the code is

| What                                                             | File                                             |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| Panels, zones, placement rules, workspaces, badges, availability | `src/utils/panelRegistry.ts`                     |
| Layout and arrangement as data (pure)                            | `src/utils/panelLayout.ts`                       |
| The reactive owner: restore, save, visibility, hide-all          | `src/utils/usePanelLayout.ts`                    |
| Per-user localStorage                                            | `src/utils/uiState.ts`                           |
| Widths and clearances                                            | `src/utils/paletteGeometry.ts`                   |
| Minimize button, resize handle, reorder grip                     | `src/components/FloatingPalette.vue`             |
| Wiring, chips, stacking, commands                                | `src/App.vue`                                    |
| Workspace / reset / collection-default commands                  | `layoutCommands` in `src/commands/providers.ts`  |
| Collection default (the only server write)                       | `saveDefaultPanelLayout` in `src/store/index.ts` |

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

## What the state-machine audit changes here

`IMPLICIT_STATE_MACHINES.md` (PR #1469) audited the UI's state flags and found
four recurring shapes. The panel layout is exactly such a machine, and this
feature adds state to it, so the audit's rules apply directly:

- **One state object, not parallel refs** (shape 4, partial reset; shape 3,
  one question with several sources). Open, minimized, order and widths live
  in a single `IPanelLayout` owned by one composable (`usePanelLayout`).
  App.vue's per-panel refs become writable computeds over it, so "is this
  panel showing" has one answer and a reset cannot clear part of it.
- **The Object Browser's store mirror is derived.** The audit listed
  `App.vue`'s `annotationPanel` ref against `store.isAnnotationPanelOpen` as
  two sources that disagree in embed mode. The mirror follows the panel's
  _visible_ state, and a refused open puts the store back.
- **Local state outlives the login session.** Logout now reloads the page,
  which discards every store, but `localStorage` survives the reload. The
  audit's rule is "dropped at logout, or keyed by user"; a layout should
  survive, so every `nimbus.ui.` key is scoped by user id (`anonymous` when
  logged out). The next account at the same browser gets its own layout.
- **Restore is a claimed token, not an equality check.** Restore runs once per
  configuration id, and a late-arriving configuration must not overwrite a
  panel the user toggled in the meantime (the audit's "equality skip reads
  committed state" finding).
- **Every gesture needs a cancel exit.** Column resize and stack reorder are
  drags: each holds its state as one `null | {...}` object and ends on
  pointer-up, pointer-cancel, lost capture, and Escape (which reverts).
- **No remount to hide.** Minimizing and hide-all change visibility only. A
  `:key` or `v-if` would discard the panel's in-flight flags.
- **No second source for "why is it open" until one is needed.** The
  user/context distinction below is a rule for the first context-opened
  registry panel. Until one exists, nothing tracks it.

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

## State before Parts 2–5 (context)

What the viewer did when this work started. Kept because it explains the
design; the Parts below say what replaced each item.

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

## Part 2: local UI memory (implemented)

### Storage: `src/utils/uiState.ts`

`readUiState` / `writeUiState` / `removeUiState`, and
`usePersistedUiState(key, defaultValue, validate)` for a ref a component
owns.

- **Keys are `nimbus.ui.<userId | "anonymous">.<key>`.** `setUiStateScope` is
  called from App.vue with `store.girderUser?._id`. A persisted ref reloads
  when the scope changes and never writes the loaded value back.
- **Never throws.** A failed read gives the caller's default. A failed write
  is kept in memory (`unsavedValues`) and is what later reads return, so a
  change made with storage blocked or full lasts for the session.
- **Every read is validated** by a caller-supplied function.
- **No `storage` listener.** Two tabs are two workspaces.
- Never touch `nimbus.girderToken`, and never enumerate keys outside the
  prefix.

### Two state objects: `src/utils/panelLayout.ts`

```ts
// Which panels are open or minimized. Remembered per collection.
interface IPanelLayout {
  version: 1;
  open: PanelId[]; // in the order opened; includes minimized panels
  minimized: PanelId[]; // always a subset of `open`
}

// How the zones are arranged. One per user, the same in every collection:
// it describes the person's screen and habits, not a task.
interface IPanelArrangement {
  version: 1;
  leftOrder: PanelId[]; // every left-zone panel, top to bottom
  widths: { left?: number; right?: number }; // absent: default widths
}
```

Both are replaced whole on every change, never mutated in place.
`validateLayout` drops unknown ids and re-applies the placement rules by
opening the ids one at a time through `applyOpen`, so a stored layout cannot
produce an illegal state.

### What is stored, and the restore order

| Key                      | Value                                                          |
| ------------------------ | -------------------------------------------------------------- |
| `layout.last`            | the layout most recently used, in any collection               |
| `layout.byConfiguration` | `[configurationId, layout][]`, most recent last, capped at 200 |
| `layout.arrangement`     | the `IPanelArrangement`                                        |

On entry to the viewer, and again when the collection is known, the first of
these that exists is shown:

1. my layout for this collection;
2. the collection default (`configuration.defaultPanelLayout`, Part 4);
3. my last layout anywhere;
4. the registry `defaultOpen` set.

### The rules `usePanelLayout` enforces

- **Visibility is derived, the layout is not mutated to hide things.** A
  palette is on screen when it is open AND the route is the viewer (not the
  embed) AND it is not minimized AND "hide all" is off AND it is available
  for this dataset. Leaving the viewer therefore changes nothing in the
  layout, so there is no "all closed" to save by mistake, and nothing is
  refused silently except opening outside the viewer.
- **Restore once per (user, collection).** The watcher's source is a token
  string of the two; replacing the configuration object with the same id
  does nothing.
- **The collection is not always known.** While it is unknown nothing is
  restored: a fresh visit shows the last layout, a switch keeps what is on
  screen, and a change made in that time wins over the layout that arrives
  and is saved for the new collection (`changedBeforeConfiguration`).
- **"The collection" is `viewedConfiguration` in App.vue, not
  `store.configuration`.** The store keeps the previous configuration while
  the next one loads and while the user is on another page. The route names
  the dataset view, the store loads the view, and the view names its
  collection; only when all three agree is the collection known.
- **Saving is synchronous and compares against what storage holds**
  (`persisted`), so restoring never writes the layout back.
- **Opening is refused outside the viewer.** The Object Browser's store
  mirror (`store.isAnnotationPanelOpen`) follows the palette's visible state
  and is put back when an open is refused.

### State inside panels

Each panel declares its own with `usePersistedUiState`. Done so far: the
Object Browser's active tab (`objectBrowser.tab`). The store stays the one
live value; the persisted ref only seeds it and records what it becomes.

A remembered tab is active from page load, in a palette nobody may have
opened, so **every tab's work must be gated on the palette's `visible` as
well as on the tab** (Connections and Measurements were not, and were found
by review).

Rules for what qualifies:

- Presentation only. If it changes which objects are shown, counted or
  measured, it belongs in the configuration or dataset view.
- Never ids of annotations, connections or datasets.
- Not yet done, and worth doing next: collapsed sections in Layers and
  Settings, the Analysis panel's plot type.

## Part 3: structured rearrangement (implemented)

Free-floating, drag-anywhere panels remain a non-goal.

**Minimize to a chip.** Each registry palette has a minimize button. A
minimized panel stays in `open` and is shown as a chip in a row at the top of
its zone; the zone's palettes start below the row. Clicking the chip, the
app-bar toggle or the panel's command restores it. Placement rules treat a
minimized panel like any open one, so opening another right-zone primary
closes it.

**Chip rows hold their edge.** A chip row sits at the top corner of its zone
at the palettes' z-index, which is where the selection panels and the montage
start. The rows are measured (`chipRowWidths`) and count in the clearances:
the left row sets `any-left-palette-open` and feeds
`--nimbus-left-palette-clear-x`, the right row is an entry in the
`rightEdgeClearX` list.

**Resizable zones.** Drag a zone's inner edge; double-click resets. A zone
keeps each palette's own default width until it is resized, then every
palette in it uses the zone's width.

- Clamped where it is used, not only while dragging
  (`paletteWidth` → `clampZoneWidth`), to at most 45% of the viewport and at
  least `ZONE_MIN_WIDTH`.
- `ZONE_MIN_WIDTH` is the narrowest default among the zone's palettes. A
  smaller minimum was tried: at 320 the Layers mode radios ran under "Add
  layer". Do not lower it without checking every panel in the zone.
- The drag in progress is `draggedZoneWidths` in App.vue: shown, not stored
  until the drop, so cancelling leaves no trace.
- Everything that clears the left column reads `leftColumn` (the width in
  use), through `rightOfLeftColumn` / `leftPaletteClearX`. The constants in
  `paletteGeometry.ts` are the unresized case only.
- The handle lies over the palette's edge, so the palette body is inset
  under it; otherwise grabbing a scrollbar's outer edge resized the zone.

**Reorder the left stack.** Drag a left palette by its grip. It follows the
pointer and, on release, takes the place its center was carried to among the
palettes that are showing (`leftOrderAfterDrop`). The stack's positions are
`leftStack` in App.vue, built from the order and the measured heights.

**Gestures.** Resize and reorder share one state object in
`FloatingPalette.vue` (`null | {kind, pointerId, start, moved, ...}`):

- a press that travels less than 3px is a click and changes nothing;
- pointer-up ends it once (the lost capture that follows finds nothing);
- pointer-cancel, lost capture, Escape and unmounting cancel it.

**Hide all panels.** `Cmd/Ctrl+.` and the "Hide all panels" command. It is a
view of the layout (`chromeHidden`), not a change to it: not remembered, and
ended by leaving the viewer or by opening any panel. It also masks the
Timelapse palette, the AI panel and the Analyze drawer, which keep their own
open state. While it is on, one "Show panels" chip remains, so a hidden
interface always shows how to undo it.

Deferred: moving a panel between the left and right zones.

## Part 4: workspaces and the collection default (implemented)

**Workspaces** are named sets of open panels in `WORKSPACES`
(`panelRegistry.ts`): Annotate, Analyze, Plot, Review. Each is a
"Workspace: …" command. Applying one sets the open set and nothing else;
widths and order stay the user's own. Each set must already satisfy the
placement rules (tested).

**"Reset panel layout"** returns to the collection default, or the app's
when the collection has none.

**The collection default** is `defaultPanelLayout?: IPanelLayout | null` on
the configuration.

- Written only by "Save panel layout as collection default" (one
  `syncConfiguration("defaultPanelLayout")`) and cleared by "Clear collection
  default panel layout" (writes null, which the server drops from the
  metadata). Opening and closing panels never writes it.
- It stores only the panels open as palettes: not the minimized ones, not
  widths, not order. It is read from the layout, not from the screen, so
  saving while "hide all" is on does not save an empty default.
- The commands are offered only when logged in and when the collection on
  screen is the one in the store.
- No backend change: `CollectionSchema` does not restrict `meta` keys, and
  the `nimbusimage` Python package only reads the keys it knows.
- It must be in `exampleConfigurationBase()`: `configurationBaseKeys` is
  derived from it, and a key missing there is neither sent nor read back.

User-defined workspaces ("Save current layout as…") are not built. Do this
only if the built-ins prove too few.

## Part 5: status and relevance (partly implemented)

**Implemented: one mechanism for a panel's status.** `IPanelDefinition` has

```ts
badge?: (context: IPanelContext) => string | null;
available?: (context: IPanelContext) => boolean;
```

and App.vue builds one `panelContext` (active filter count, active gate
count, whether transcripts are reachable). The app-bar toggle, the command,
the palette and the minimized chip all read the same rules, so a minimized
Filters chip shows the filter count.

- **Context fields must be cheap.** They are read reactively. Use counts and
  flags the stores already keep; never iterate annotations or property
  values (datasets reach 700K objects).
- An unavailable panel is hidden with its toggle, command and chip; the
  layout that says it is open is left alone.

**Deferred: `relevant` (an accent on a closed panel that matters now).** The
mechanism is a third optional field on the same context. It is not built
because the rules are product decisions (which signals are worth an accent)
that have not been made, and an accent with poorly chosen rules is noise.

**Deferred: context-opened panels.** Automation may open a panel only as the
direct, visible consequence of a user action that names the task (the
Timelapse palette is the model). When the first such registry panel exists,
give `open` a source, keep the context-opened ids in the layout state, close
them when the context ends and never save them. Until then nothing tracks
"why is it open".

**No learned or usage-based reordering.** Anything that changes position
based on history breaks spatial stability.

## Part 6: AI (not started)

A model is not in the interaction loop. A per-click layout decision from a
model is slow, nondeterministic, costs money, and is unavailable to logged-out
users; the rules in Part 5 are instant and predictable.

Two places it fits, both using machinery that exists:

- **First open of a collection.** `src/store/toolSuggestions.ts` already runs
  once per collection, on first open with no tools, and proposes tools from
  the dataset. Extend its response with an optional workspace id from
  `WORKSPACES`, offered with the tool suggestions and applied only if the
  user accepts.
- **Natural language.** "Set me up for counting spots" typed into the command
  palette goes to Ask Nimbus AI (`src/store/aiPanel.ts`), which answers by
  choosing from the command registry. The workspace and panel commands are
  already there, so this is mostly a matter of the agent's command coverage.

Constraints: nothing is sent while the user types, both paths are gated like
the AI panel (env flag and login), and a model never writes a layout
directly. It names commands; the commands go through the same rules and the
same save as any other user action.

## Tours

Before layouts were remembered, every visit opened the left stack, so tours
could assume their anchors were showing. Now a step's anchor can be mounted
inside a palette that is closed, minimized or hidden. Each palette carries
`data-panel-id`; when a step's target is inside one that is not displayed,
`plugins/tour.ts` emits `TOUR_REVEAL_PANEL_EVENT` on the tour bus and App.vue
opens it.

## Non-goals

- Free-floating or tabbed docking windows.
- Syncing a personal layout across devices. If this is wanted later, the
  per-user `dataset_view` or a user-settings endpoint is the place, not the
  configuration.
- Layout decisions made by a model during normal interaction.
- Remembering layout for the Timelapse palette or the AI panel, whose
  visibility is owned by other state.

## Verification (in the browser)

Use the `in-browser-testing` skill. From a **fresh page load** on a real
collection:

1. Open Filters + Object Browser, close Layers, reload. The same layout comes
   back.
2. Open a dataset in a collection never visited. The collection default if it
   has one, otherwise the layout from step 1.
3. In the network tab, opening a dataset, toggling panels and leaving the
   viewer issue no configuration PUT. "Save panel layout as collection
   default" issues exactly one.
4. Leave the viewer and come back. The layout is as it was, not all closed.
5. Minimize every left palette. The chips appear, and
   `--nimbus-left-palette-clear-x` on `#inspire` is the chip row's width plus
   its insets.
6. Drag a zone's edge to its minimum and look at every panel in it.
7. With Tools minimized, start the "Add first object creation tool" tour.
   Tools opens and the popover points at "Add new tool".

Things this pass proved about testing it:

- Do not touch `nimbus.girderToken` while inspecting `localStorage`; read and
  clear only `nimbus.ui.*` keys.
- `App.test.ts` must clear `localStorage` in `beforeEach` and unmount every
  App it mounts: each mounted App watches the one mocked store and writes
  the one localStorage, so a leftover App answers the next test's store
  changes and overwrites its layout.
- A fixed element has no `offsetParent`; use `getComputedStyle(el).display`
  to ask whether a palette or chip row is showing.
- The automation's `cmd+.` key press did not reach the page; the binding was
  checked with a dispatched `keydown` and through the command.

## Regression checklist

Run `pnpm test src/utils src/components/FloatingPalette.test.ts src/App.test.ts src/store/defaultPanelLayout.test.ts src/components/AnnotationBrowser/AnnotationBrowser.test.ts`.

### Placement rules (registry)

- [ ] **A right-zone primary evicts the other primaries.** — _"a primary evicts the other right-zone primary"_
- [ ] **Filters stays with a host and is evicted by a non-host.** — _"a primary keeps a companion that hosts with it"_, _"a primary evicts a companion that doesn't host with it"_, _"a companion joins its host"_, _"a companion evicts a primary that isn't its host"_
- [ ] **The left stack is independent of itself and of the right zone.** — _"left-zone palettes stack independently of each other and the right"_
- [ ] **An unknown id (from an older or newer client) is ignored.** — _"leaves the set unchanged for an unknown id"_
- [ ] **The defaults are the left stack only.** — _"opens the left stack by default and nothing on the right"_
- [ ] **A stored layout cannot produce an illegal state.** — _"resolves two right-zone primaries to the last one"_, _"keeps a companion only with a host"_, _"drops ids it does not know and repeats"_, _"keeps minimized only for panels that are open"_
- [ ] **Every workspace shows all the panels it names.** — _"every workspace is a set of panels the placement rules allow as is"_

### Storage

- [ ] **Storage never throws, and a bad value reads as nothing.** — _"does not throw when storage is unavailable"_, _"reads corrupt JSON and a rejected shape as nothing stored"_, _"survives a corrupt stored list"_
- [ ] **A change made with storage blocked or full lasts for the session.** — _"a value whose write failed still reads back for the session"_, _"a persisted ref keeps working in memory when storage throws"_
- [ ] **State is per user; a user's value is not overwritten when another logs in.** — _"round-trips a value under its own prefix, scoped to the user"_, _"a persisted ref reloads for a new user without overwriting their value"_, _"keeps each user's layout apart, and restores when the user changes"_
- [ ] **Only keys under the prefix are touched.** — _"removes only the named key"_
- [ ] **The remembered-collection list is bounded and ordered by recency.** — _"keeps only the most recent collections"_, _"moves a revisited collection to most recent instead of repeating it"_

### Restore and save

- [ ] **The restore order is: mine for the collection, its default, my last, the app's.** — _"prefers my own layout for the collection over its default"_, _"prefers the collection default over my last layout"_, _"uses my last layout in a collection I have not visited"_, _"falls back to the registry defaults when nothing is stored"_
- [ ] **Restoring never writes.** — _"restoring writes nothing"_
- [ ] **Leaving the viewer hides everything, saves nothing, and the layout is back on return.** — _"leaving the viewer hides every panel and stores nothing"_, _"shows no palette outside the viewer and brings the layout back on return"_
- [ ] **Nothing opens outside the viewer.** — _"refuses to open or apply a layout outside the viewer"_
- [ ] **A re-read of the same collection does not restore again.** — _"does not restore again when the same collection is re-read"_
- [ ] **While the collection is unknown the screen is left alone, and a change made then wins and goes to the new collection.** — _"keeps what is on screen while the next collection loads"_, _"keeps a change I made while it was loading, and stores it for the collection"_, _"a change made while the next collection loads goes to it, not the previous one"_
- [ ] **A switch gives the same layout a reload there would.** — _"a switch to an unvisited collection uses my last layout, as a reload there would"_
- [ ] **The previous collection's configuration is never read as the current one.** — _"does not take the previous collection's layout while the next one loads"_, _"waits for the view the route names before reading its collection"_
- [ ] **The layout survives a page load.** — _"remembers the layout for the next page load"_, _"remembers a minimized panel"_

### Visibility

- [ ] **A minimized panel is open, shown as a chip, and comes back by its chip or toggle.** — _"a minimized panel is open but not shown, and toggling brings it back"_, _"a minimized palette becomes a chip in its zone that restores it"_
- [ ] **An unavailable panel is hidden without changing the layout.** — _"hides an unavailable panel without changing or rewriting the layout"_
- [ ] **Hide-all is not stored, restores the same set, and ends with the visit.** — _"hide-all hides every panel, restores the same set, and is not stored"_, _"hide-all does not carry into the next visit"_
- [ ] **Hide-all leaves a way back and covers the non-registry panels.** — _"the hide-all hotkey hides every palette and leaves one chip to bring them back"_, _"hide-all also hides the Timelapse palette and the Analyze drawer, and brings them back"_
- [ ] **A panel's chip carries its badge.** — _"a minimized panel's chip carries its badge"_
- [ ] **A tour step's palette is opened for it.** — _"a tour step inside a palette that is not showing gets it opened"_
- [ ] **A remembered tab does no work in a closed palette.** — _"a remembered tab does no work while the palette is closed"_

### Geometry

- [ ] **A stored width is clamped where it is used.** — _"clamps a stored width when it is used, not only when it is dragged"_
- [ ] **A zone cannot go narrower than its panels were laid out for.** — _"never lets a zone go narrower than its palettes were laid out for"_
- [ ] **Unresized, the functions equal the constants.** — _"matches the unresized constants when no width is set"_
- [ ] **Everything that clears the left column follows its width.** — _"a resized left column moves the surfaces that clear it"_, _"moves both left clearances with a resized column"_
- [ ] **A chip row holds its edge.** — _"a chip row holds its edge, so canvas surfaces clear it like a palette"_, _"the hide-all chip also holds the left edge"_
- [ ] **A zone's palettes start below its chip row only.** — _"the palettes of a zone start below its chip row, the other zone does not move"_
- [ ] **A cancelled resize leaves no trace; a drop is stored; reset clears it.** — _"dragging a zone's edge resizes every palette in it, clamped to the viewport"_

### Gestures

- [ ] **A click is not a drag.** — _"a click on the handle, or a press that barely moves, changes nothing"_, _"a click on the grip does not reorder"_
- [ ] **A drag ends once.** — _"ends once: the lost capture that follows pointerup does nothing"_
- [ ] **Every other exit cancels.** — _"Escape cancels the drag and is not passed on"_, _"unmounting mid-drag cancels it"_, _"a cancelled drag puts the palette back and reports nothing"_
- [ ] **Escape is only taken during a drag.** — _"Escape with no drag in progress is left alone"_
- [ ] **The handle does not cover the scrollbar.** — _"keeps the body, and its scrollbar, out from under the handle"_
- [ ] **Reordering places among the palettes that are showing.** — _"places relative to the palettes that are showing only"_

### The collection default (the only server write)

- [ ] **Saving is one configuration write; toggling panels is none.** — _"saving stores the layout and writes that one key once"_
- [ ] **Clearing writes null.** — _"clearing writes null, which the server drops from the metadata"_
- [ ] **The key is sent and read back, and absent on older configurations.** — _"is a configuration key, so it is sent and read back"_, _"a configuration saved before this existed has no default"_
- [ ] **It saves the panels open as palettes, even while all are hidden.** — _"saving the collection default takes the panels shown as palettes, even while all are hidden"_
- [ ] **It is what a first visit opens with, until I change something.** — _"the collection default is what a first visit opens with, until I change it"_
