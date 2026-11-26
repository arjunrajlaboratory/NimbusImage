# Viewer Layout: Memory, Rearrangement and Workspaces (and the Panel Registry)

> **Status: implemented**, on branch
> `claude/viewer-ui-state-management-88f607`: the panel registry, local
> memory, rearrangement (pointer and keyboard), workspaces and the collection
> default, badges, availability and relevance accents, and the AI agent's
> `set_panels` tool. Not built: a workspace suggestion at a collection's
> first open, context-opened panels, and moving a panel between zones (each
> is described where it would go). Part of the "adaptive interface" effort
> alongside `COMMAND_PALETTE.md`.
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
| Close button, resize handle, reorder grip, tour-done marker      | `src/components/FloatingPalette.vue`             |
| Wiring, chips, stacking, commands                                | `src/App.vue`                                    |
| A tour step whose goal is already met (`tourStepAlreadyDone`)    | `src/plugins/tour.ts`                            |
| Workspace / reset / collection-default commands                  | `layoutCommands` in `src/commands/providers.ts`  |
| Collection default (the only server write)                       | `saveDefaultPanelLayout` in `src/store/index.ts` |

## Goals

1. **Memory.** The viewer remembers how each person left it: which panels are
   open, and the small presentation state inside them (active tab, collapsed
   sections, column widths). Today every entry resets to a hard-coded default.
2. **Structured rearrangement.** Panels can be resized and reordered inside
   the existing zones, and a closed panel waits as a labeled chip beside
   where it opens. No free-floating windows.
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
  one question with several sources). Which panels are open lives in one
  `IPanelLayout`, order and widths in one `IPanelArrangement`, both owned by
  one composable (`usePanelLayout`).
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
- **No remount to hide.** Closing and hide-all change visibility only. A
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
// Which panels are open. Remembered per collection.
interface IPanelLayout {
  version: 1;
  open: PanelId[]; // in the order opened
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

An earlier format also stored `minimized`, a subset of `open` shown as chips.
There is no minimized state now (Part 3). Such a layout still validates: the
field is ignored, so those panels come back open, as palettes.

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
  embed) AND "hide all" is off AND it is available for this dataset. Leaving the viewer therefore changes nothing in the
  layout, so there is no "all closed" to save by mistake, and nothing is
  refused silently except opening outside the viewer.
- **Restore when the (user, collection) token changes.** The watcher's source
  is a string of the two, so replacing the configuration object with the
  same id does nothing. It is not "once per collection", though: another view
  of the same collection takes the token A → unknown → A, and the restore
  runs again. So **a restore must be idempotent and must do nothing but
  replace the layout.** It once also cleared "hide all", which brought every
  panel back on a view switch.
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

Each panel declares its own with `usePersistedUiState`, or
`useSharedPersistedUiState` when several instances of a component share one
value. What is remembered:

| State                                                     | Key                    | Where                   |
| --------------------------------------------------------- | ---------------------- | ----------------------- |
| Object Browser's active tab                               | `objectBrowser.tab`    | `AnnotationBrowser.vue` |
| Expanded Layers rows (by layer id, most recent 200)       | `layers.expandedIds`   | `DisplayLayer.vue`      |
| "Advanced layer options" open (one setting for every row) | `layers.advancedOpen`  | `DisplayLayer.vue`      |
| Filters panel's Advanced section                          | `filters.advancedOpen` | `AnnotationFilters.vue` |

Already remembered elsewhere, so not here: an Analysis plot's display type
(with the plot, in the configuration) and the Settings panel's advanced
section (`Persister`, not per user).

Deliberately not remembered: the Filters panel's Property values section. It
opens itself whenever filters arrive, so a remembered "closed" would not
last.

Rules:

- **Presentation only.** If it changes which objects are shown, counted or
  measured, it belongs in the configuration or dataset view.
- **Remembered state is in effect from page load, in a palette nobody may
  have opened. Gate its work on the palette being on screen.** Found three
  times: the Connections and Measurements tabs (by review), and an expanded
  layer row, which requests its layer's histogram on every frame change. A
  component deep in a palette reads `usePanelVisible()`
  (`src/utils/panelVisibility.ts`), which the palette's content root
  provides from the `visible` prop App.vue passes it.
- **A list shared by many instances needs one ref.** With a ref per row,
  each row holds its own copy of the list and the last to write drops the
  others' changes. `useSharedPersistedUiState` returns the same ref for a
  key.
- **Ids only as "this one was open".** The expanded-rows list holds layer
  ids; one that matches no layer here does nothing. Never ids of
  annotations, connections or datasets.

## Part 3: structured rearrangement (implemented)

Free-floating, drag-anywhere panels remain a non-goal.

**A closed panel is a chip.** A panel is open (a palette on screen) or
closed; there is no third state. Every closed panel that is available for
the dataset is a labeled chip in a row at the top of its zone: the left row
in the user's stack order (`arrangement.leftOrder`), the right in registry
order. Clicking a chip opens the panel through `panelLayout.open`, so the
placement rules apply; a palette's X closes it and it is a chip again. The
chips are not rendered outside the viewer or in the embed.

The chip is the panel's only control. The viewer used to have two: a small
icon toggle per panel in the app bar, and a chip for a _minimized_ panel.
They said the same thing, and the chip said it better: it is labeled, and it
sits next to where the panel opens, while the icons were small, unlabeled
and across the screen. The nine app-bar toggles were removed (3D and
montage stay there), and with them the minimize button: closing a panel is
what leaves a chip behind. A chip carries what the toggle did: the panel's
icon and title, its badge, the relevance dot, a tooltip (the registry's
`description`; for Filters and Analysis, what the count means), an
accessible label that includes the count and the accent,
`data-command-id="panel.toggle.<id>"`, and the tour anchors and triggers
for the four panels tours point at.

**Chip rows wrap, and both zones always keep a row's height for them.** A
row has a max-width and wraps: the left column's width in use; on the right
the Object Browser's width (or the zone's width once resized), not the widest
palette showing, which would re-wrap the row whenever a panel opens. Each
row's width and height are measured (`chipRowSizes`, a `ResizeObserver`).

A zone's palettes start below `PALETTE_TOP` + the row's height + `STACK_GAP`
**whether or not the row has chips just now** (one line,
`PALETTE_CHIP_HEIGHT`, for an empty or unmeasured row). The first version
gave the space back when a row emptied, so closing one left panel moved the
other two down and reopening it moved them back, and the two columns started
at different heights. Keeping the space costs 36px and nothing moves.

The Timelapse palette sits between the columns, in the rows' band, so it
starts below whichever row is taller.

**The rows are a band, and everything else starts below it.** The rows sit
at the top of the canvas at the palettes' z-index, which is where the
selection panels, the montage and the Timelapse palette used to start.
Those now start below the band (`belowChipRows` in App.vue: below whichever
row is taller), through `--nimbus-action-panel-top` and
`--nimbus-below-chip-rows`; the image overview starts below the right row
(`--nimbus-overview-top`); and the AI panel, which is anchored to the bottom
and 680px tall, is capped so it stops short of the band on a short window.

The first version cleared the rows sideways instead, by their measured
width, the way surfaces clear a palette. That cost the canvas the rows'
whole width for 28px of height: with the right column closed (the default)
the montage lost about 520px. Clearing by height costs 36px.

The right row may be up to 640px wide (within the space beside the left
column), enough for its six chips and their badges on one line, so a count
appearing does not wrap the row and move the column. The Transcripts chip is
not offered during a dataset's first lookup (`transcriptsChipOffered`): most
datasets have none, and a chip that came and went on every load would shift
its neighbors. Once the lookup has answered it stays through a retry.

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
- **Content that sizes itself must follow the palette, not the window.**
  Plotly's `responsive` listens for window resizes only, so Analysis plots
  kept their old width; `AnalysisScatterPlot` now observes its plot element.
  `ContrastHistogram` already did. Check any new chart or canvas in a panel.

**Reorder the left stack.** Drag a left palette by its grip. It follows the
pointer and, on release, takes the place its center was carried to among the
palettes that are showing (`leftOrderAfterDrop`). The stack's positions are
`leftStack` in App.vue, built from the order and the measured heights.

**From the keyboard.** The resize handle is a focusable separator: Left and
Right resize by 16px (64 with Shift), Enter resets. A left palette's grip is
a focusable slider over its place in the stack: Up and Down move it one
place among the palettes showing (`leftOrderAfterStep`). Each press is one
complete change sent through the events a finished drag sends. The keys are
stopped at the element, because the arrows are also viewer hotkeys.

**A resize starts from the zone's width, not the palette's.** While a zone
is unresized its palettes have different widths; starting from the focused
one's, a step toward "wider" from Navigator (380) made Layers (420)
narrower. `zoneResizeRange` in App.vue gives each palette the zone's base
(its remembered width, or the widest palette showing) and the limits, which
are also the handle's `aria-valuemin` / `aria-valuemax`.

**Gestures.** Resize and reorder share one state object in
`FloatingPalette.vue` (`null | {kind, pointerId, start, moved, ...}`):

- a press that travels less than 3px is a click and changes nothing;
- pointer-up ends it once (the lost capture that follows finds nothing);
- pointer-cancel, lost capture, Escape and unmounting cancel it.

**Hide all panels.** `Cmd/Ctrl+.` and the "Hide all panels" command. It is a
view of the layout (`chromeHidden`), not a change to it: not remembered, and
ended by leaving the viewer or by opening any panel. It also masks the
Timelapse palette, the AI panel and the Analyze drawer, which keep their own
open state; opening any of those ends it too, and the AI button shows a
masked AI panel rather than closing it. While it is on, both chip rows are
replaced by one "Show panels" chip at the top left (in the left row, so it
is measured and cleared like the row), so a hidden interface always shows
how to undo it.

Deferred: moving a panel between the left and right zones.

## Part 4: workspaces and the collection default (implemented)

**Workspaces** are named sets of open panels in `WORKSPACES`
(`panelRegistry.ts`): Annotate, Analyze, Plot, Review. Each is a
"Workspace: …" command. Applying one sets the open set and nothing else;
widths and order stay the user's own. Each set must already satisfy the
placement rules (tested).

**"Reset panel layout"** returns to the collection default, or the app's
when the collection has none. With a collection default it _forgets_ the
user's own layout for the collection instead of storing a copy of the
default, so a default the owner changes later still reaches them.

**"Reset panel widths and order"** restores the default arrangement. It is
also the keyboard route to what double-clicking a column's edge does.

**The collection default** is `defaultPanelLayout?: IPanelLayout | null` on
the configuration.

- Written only by "Save panel layout as collection default" (one
  `syncConfiguration("defaultPanelLayout")`) and cleared by "Clear collection
  default panel layout" (writes null, which the server drops from the
  metadata). Opening and closing panels never writes it.
- It stores only which panels are open: not widths, not order. It is read
  from the layout, not from the screen, so saving while "hide all" is on
  does not save an empty default.
- The commands are offered only when logged in and when the collection on
  screen is the one in the store.
- A refused write (a read-only or share-link user) puts the previous value
  back in the store. Without that the app offered, described and reset to a
  default the collection did not have.
- A new configuration is created without the key: null is how an update
  clears it, and the create path stores metadata as given.
- No backend change: `CollectionSchema` does not restrict `meta` keys, and
  the `nimbusimage` Python package only reads the keys it knows.
- It must be in `exampleConfigurationBase()`: `configurationBaseKeys` is
  derived from it, and a key missing there is neither sent nor read back.

User-defined workspaces ("Save current layout as…") are not built. Do this
only if the built-ins prove too few.

## Part 5: status and relevance (implemented)

`IPanelDefinition` has three optional rules over one small `IPanelContext`
that App.vue builds:

```ts
badge?: (context: IPanelContext) => string | null;
available?: (context: IPanelContext) => boolean;
relevant?: (context: IPanelContext) => boolean;
```

The chip, the command and the palette all read the same rules.

- **Badge**: a short status (Filters: active filter count; Analysis: active
  gate count), on the chip, capped at "9+", and in the chip's accessible
  label with what it counts.
- **Available**: whether the panel exists for this dataset (Transcripts). An
  unavailable panel is hidden with its chip and command; the layout that
  says it is open is left alone.
- **Relevant**: the panel holds something new the user has not looked at.
  While it is not on screen, its chip carries a dot and its label says so.
  It only points; nothing opens by itself.

**There is one relevance rule, on purpose.** The Object Browser is accented
when a job that adds objects or measurements (`leavesResults` on the job,
set by the annotation and property stores and the agent) succeeds for the
open dataset while the browser is not showing. It is cleared when the
browser is shown and when the dataset changes. A job that finishes while
another dataset is open raises nothing.

Before adding a rule, check it against these:

- The user did something and its result is in this panel. Not "this panel
  might be useful now".
- It is off most of the time. An accent that is often on is not read.
- It is cheap. Context fields are read reactively: counts and flags the
  stores already keep, never something computed over the annotations
  (datasets reach 700K objects).
- It has a clear end, and that end does not depend on a second flag being
  right. (The accent's watcher observes the flag itself as well as the
  browser's visibility: the store's "is the browser showing" mirror was once
  stale on a restored layout, which left "new results" on a panel the user
  was looking at.)

**Not built: context-opened panels.** Automation may open a panel only as
the direct, visible consequence of a user action that names the task (the
Timelapse palette is the model). When the first such registry panel exists,
give `open` a source, keep the context-opened ids in the layout state, close
them when the context ends and never save them.

**No learned or usage-based reordering.** Anything that changes position
based on history breaks spatial stability.

## Part 6: AI (implemented, except the first-open suggestion)

A model is not in the interaction loop. A per-click layout decision from a
model is slow, nondeterministic, costs money, and is unavailable to
logged-out users.

**`set_panels`** is an agent tool (`src/agent/executors.ts`; schema in
`girder-claude-chat/agent_tools.json`; when to use it in
`agent_system_prompt.txt`):

```
set_panels({ workspace?, open?: PanelId[], close?: PanelId[] })
```

- A workspace is applied first, then `open`, then `close`. Everything is
  validated before anything is applied.
- It goes through `panelLayoutController` (`src/utils/panelLayoutController.ts`),
  which App.vue registers while mounted: the same `open` / `close` /
  `applyOpenSet` as a click, so the placement rules and the saving apply.
  A model never writes a layout.
- **The result says what is open, not what was asked for**, plus `notOpen`
  for anything the placement rules displaced. Without that the model
  reports panels open that are not.
- `get_interface_state` has a `panels` section (open, all hidden,
  available, workspaces).
- It is not gated: visible at once and reversible. It is in the AI panel's
  `VIEW_STATE_TOOLS`, and the per-turn view snapshot carries the layout and
  whether everything was hidden, so "revert view changes" puts the panels
  back.
- The schema's enums and description are checked against `WORKSPACES` and
  `PANELS` by a test, since nothing else keeps the two repositories of the
  same names in step.
- The backend plugin is baked into the Girder image: a schema or prompt
  change needs a rebuild (or, for a local check, copying the two files into
  the running container and restarting it).

**Not built: a workspace suggestion at a collection's first open.**
`src/store/toolSuggestions.ts` already runs once per collection, on first
open with no tools, and proposes tools from the dataset. Its response could
carry an optional workspace id from `WORKSPACES`, offered with the tools and
applied only if the user accepts.

## Tours

Before layouts were remembered, every visit opened the left stack, so tours
could assume their anchors were showing. Now a step's anchor can be mounted
inside a palette that is closed or hidden. Each palette carries
`data-panel-id`; when a step's target is inside one that is not displayed,
`plugins/tour.ts` emits `TOUR_REVEAL_PANEL_EVENT` on the tour bus and App.vue
opens it.

**A step whose goal is already met moves on.** Steps such as
`object-list-button-tourstep` ("Click here to open the object list") anchor
to a panel's chip and wait for its trigger event. The chip exists only while
the panel is closed, so with a remembered layout that already has the panel
open there is nothing to point at, and the step would wait out its timeout
and show "This step isn't available". The palette carries the chip's anchor
as `data-tour-done` (`tourDoneAnchor` on `FloatingPalette`, set from
`PANEL_TOUR_HOOKS` in App.vue). `tourStepAlreadyDone` says a step is done
when it waits for a trigger event, its element is `[data-tour="X"]`, no `X`
anchor exists, and a _displayed_ element with `data-tour-done="X"` does
(asked with `getComputedStyle(el).display`, since a fixed element has no
`offsetParent`). `showCurrentStep` asks before waiting and again when the
wait times out, and advances instead of showing the step.

Under "hide all panels" neither the chip nor the open palette shows, so such
a step still waits and then offers to skip.

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
5. Close every left palette. The chips appear, and
   `--nimbus-left-palette-clear-x` on `#inspire` is the chip row's width plus
   its insets. Narrow the window, or open nothing on the right: the right row
   wraps onto a second line, and the right palettes and the minimap start
   below it.
6. Drag a zone's edge to its minimum and look at every panel in it.
7. With Tools closed, start the "Add first object creation tool" tour.
   Tools opens and the popover points at "Add new tool". With the Object
   Browser open, start "Calculate Blob Metrics": the "Object List" step is
   skipped, not shown as unavailable.
8. Focus a column's edge (Tab to it) and press the arrow keys; focus a left
   palette's grip and press Up and Down.
9. Add an Analysis plot, then drag the right column's edge: the plot's
   `.main-svg` width follows the palette.
10. Ask Nimbus AI to "set the interface up for annotating", then to open
    the Object Browser and Settings together: it should say only one of
    them is open. Then "revert view changes" puts the panels back.

Things this pass proved about testing it:

- Do not touch `nimbus.girderToken` while inspecting `localStorage`; read and
  clear only `nimbus.ui.*` keys.
- `App.test.ts` must clear `localStorage` in `beforeEach` and unmount every
  App it mounts: each mounted App watches the one mocked store and writes
  the one localStorage, so a leftover App answers the next test's store
  changes and overwrites its layout.
- A fixed element has no `offsetParent`; use `getComputedStyle(el).display`
  to ask whether a palette or chip row is showing.
- The automation's `cmd+.` key press reaches the page as a keydown with no
  key code (captured: `key: "."`, `code: ""`), which Mousetrap cannot match.
  The binding was checked with a dispatched `keydown` carrying `keyCode: 190`
  and through the command; a hardware key press is still worth one look.
- To make an accent appear without running a worker, commit
  `setAnnotationPanelBadge` on the store. That tests the display, not the
  rule that raises it (`jobs.test.ts` holds that).

## Regression checklist

Run `pnpm test src/utils src/plugins src/components/FloatingPalette.test.ts src/App.test.ts src/App.commands.test.ts src/store/defaultPanelLayout.test.ts src/components/AnnotationBrowser/AnnotationBrowser.test.ts`.

### Placement rules (registry)

- [ ] **A right-zone primary evicts the other primaries.** — _"a primary evicts the other right-zone primary"_
- [ ] **Filters stays with a host and is evicted by a non-host.** — _"a primary keeps a companion that hosts with it"_, _"a primary evicts a companion that doesn't host with it"_, _"a companion joins its host"_, _"a companion evicts a primary that isn't its host"_
- [ ] **The left stack is independent of itself and of the right zone.** — _"left-zone palettes stack independently of each other and the right"_
- [ ] **An unknown id (from an older or newer client) is ignored.** — _"leaves the set unchanged for an unknown id"_
- [ ] **The defaults are the left stack only.** — _"opens the left stack by default and nothing on the right"_
- [ ] **A stored layout cannot produce an illegal state.** — _"resolves two right-zone primaries to the last one"_, _"keeps a companion only with a host"_, _"drops ids it does not know and repeats"_, _"reads a panel minimized in the earlier format as open"_
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
- [ ] **The layout survives a page load.** — _"remembers the layout for the next page load"_, _"a closed panel leaves the layout, and stays closed on the next page load"_

### Visibility

- [ ] **A closed panel is a chip in its zone that opens it by the placement rules; an open one has none.** — _"a closed panel is a chip in its zone, and clicking it opens the panel"_, _"a closed panel leaves the layout, and stays closed on the next page load"_
- [ ] **Left chips follow the user's stack order.** — _"left chips follow the user's stack order"_
- [ ] **An unavailable panel has no chip.** — _"an unavailable panel has no chip"_, _"keeps the Transcripts control reachable after schema failure and during retry"_
- [ ] **The chips are the only panel controls, and only in the viewer.** — _"the app bar has no panel toggles"_, _"there are no chips outside the viewer or in the embed"_
- [ ] **An unavailable panel is hidden without changing the layout.** — _"hides an unavailable panel without changing or rewriting the layout"_
- [ ] **Hide-all is not stored, restores the same set, and ends with the visit.** — _"hide-all hides every panel, restores the same set, and is not stored"_, _"hide-all does not carry into the next visit"_
- [ ] **Hide-all leaves a way back and covers the non-registry panels.** — _"the hide-all hotkey hides every palette and leaves one chip to bring them back"_, _"hide-all also hides the Timelapse palette and the Analyze drawer, and brings them back"_
- [ ] **A chip carries its badge, capped, and says what it counts.** — _"a chip carries its badge, and its label says what the count means"_, _"caps the badge at 9+ so it stays small"_, _"keeps the two badges independent"_, _"a chip's tooltip says what its panel is for, and what its count means"_
- [ ] **A tour step's palette is opened for it.** — _"a tour step inside a palette that is not showing gets it opened"_
- [ ] **A "click here to open it" step moves on when the panel is already open, and only then.** — _"is done when the anchor is gone and its palette is open"_, _"is not done while the anchor is there to click"_, _"is not done for a step that does not wait for a click"_, _"is not done when the palette that would show it is not displayed"_, _"is not done for another anchor's palette"_, _"skips a click-to-open step whose panel is already open"_, _"shows a click-to-open step whose chip is there"_
- [ ] **A step whose anchor is missing asks for the panels back before waiting.** — _"asks for the panels back before waiting for an anchor that is not there"_, _"asks for nothing when the anchor is there"_
- [ ] **The chips carry the tour anchors and the palettes the matching done marker.** — _"the chips the tours point at carry their anchors"_, _"names the tour step it completes when given an anchor"_, _"announces nothing without a trigger"_
- [ ] **A remembered tab does no work in a closed palette.** — _"a remembered tab does no work while the palette is closed"_

### Geometry

- [ ] **A stored width is clamped where it is used.** — _"clamps a stored width when it is used, not only when it is dragged"_
- [ ] **A zone cannot go narrower than its panels were laid out for.** — _"never lets a zone go narrower than its palettes were laid out for"_
- [ ] **Unresized, the functions equal the constants.** — _"matches the unresized constants when no width is set"_
- [ ] **Everything that clears the left column follows its width.** — _"a resized left column moves the surfaces that clear it"_, _"moves both left clearances with a resized column"_
- [ ] **Surfaces at the top of the canvas start below the chip rows; the rows take no width from it; both rows are measured.** — _"surfaces at the top of the canvas start below the chip rows instead of beside them"_
- [ ] **Both zones keep a row's height for their chips, so toggling a panel moves no other; a wrapped row pushes its zone and the minimap down.** — _"both zones keep a row's height for their chips, so toggling a panel moves no other"_, _"a wrapped chip row pushes its zone's palettes and the overview down"_
- [ ] **The right row holds all its chips on one line where there is room, and the Timelapse palette stays below the rows.** — _"the right chip row is wide enough for all its chips, within the space beside the left column"_, _"the Timelapse palette starts below the taller chip row"_
- [ ] **Every chip's command exists.** — _"every chip's command id names a registered command"_
- [ ] **Starting a tour ends hide-all.** — _"starting a tour ends hide-all, so its steps have something to point at"_
- [ ] **A cancelled resize leaves no trace; a drop is stored; reset clears it.** — _"dragging a zone's edge resizes every palette in it, clamped to the viewport"_

### Gestures

- [ ] **A click is not a drag.** — _"a click on the handle, or a press that barely moves, changes nothing"_, _"a click on the grip does not reorder"_
- [ ] **A drag ends once.** — _"ends once: the lost capture that follows pointerup does nothing"_
- [ ] **Every other exit cancels.** — _"Escape cancels the drag and is not passed on"_, _"unmounting mid-drag cancels it"_, _"a cancelled drag puts the palette back and reports nothing"_
- [ ] **Escape is only taken during a drag.** — _"Escape with no drag in progress is left alone"_
- [ ] **The handle does not cover the scrollbar.** — _"keeps the body, and its scrollbar, out from under the handle"_
- [ ] **Reordering places among the palettes that are showing.** — _"places relative to the palettes that are showing only"_

### Found by the second review round

- [ ] **A restore replaces the layout and nothing else.** — _"hide-all outlasts a restore within the visit"_
- [ ] **A request that changes nothing is not a change.** — _"a request that changes nothing while the collection loads does not override its layout"_
- [ ] **After a reset the user follows the collection default.** — _"after a reset I follow the collection default, including one changed later"_
- [ ] **Opening a masked panel ends hide-all.** — _"opening a panel that hide-all masks ends hide-all"_, _"the AI button shows a masked AI panel instead of closing it"_
- [ ] **A tour anchor hidden any way is revealed.** — _"names the palette that holds a hidden anchor"_, _"asks for the panels back when the anchor is hidden outside any palette"_, _"a tour step hidden only by hide-all gets the panels back"_
- [ ] **A plot follows its palette's width.** — _"redraws at the new width when its palette's column is resized"_
- [ ] **A stored value from a later format reads as nothing.** — _"reads a later format as nothing stored"_
- [ ] **Widths and order can be reset without the pointer.** — _"resetting the arrangement returns to default widths and order"_

### Memory inside panels

- [ ] **An expanded layer row is remembered, per row, in one shared list.** — _"an expanded row is expanded again on the next page load"_, _"rows share one list, so expanding one keeps the others"_
- [ ] **A remembered row does nothing while its palette is not on screen.** — _"a remembered row stays collapsed while its palette is not on screen"_, _"tells the rows inside it whether the palette is on screen"_, _"tells the Layers panel whether it is on screen"_
- [ ] **A shared ref is one ref.** — _"a shared ref is one ref for everyone using the key, until the page reloads"_
- [ ] **The Filters Advanced section is remembered.** — _"the Advanced section is open again on the next page load"_

### Keyboard

- [ ] **The handle and grip work from the keyboard and keep their keys from the viewer.** — _"arrows resize toward and away from the canvas, more with Shift"_, _"up and down on the grip move the palette one place"_, _"keeps the keys it uses from the viewer's hotkeys, and passes on the rest"_
- [ ] **A resize starts from the zone's width.** — _"a resize starts from the zone's width, not this palette's"_, _"a resize of an unresized zone starts from its widest palette showing"_
- [ ] **A step moves a palette one visible place.** — _"steps past a palette that is not showing, so every press moves it on screen"_, _"the arrow keys on a left palette's grip move it one place"_
- [ ] **The controls say what they are.** — _"the handle can be focused and says how wide the palette is and can be"_, _"tells each left palette its place among those showing"_, _"a grip that cannot reorder stays decoration"_

### Relevance accent

- [ ] **Only a job that left results on this dataset raises it, and only when it worked.** — _"marks unseen results only for a job that worked, with the Object Browser not showing"_
- [ ] **It shows on the chip, and ends when the browser is shown or the dataset changes.** — _"a closed panel with unseen job results is accented until it is shown"_, _"another dataset clears the accent"_
- [ ] **Results that arrive while the browser is showing are not unseen.** — _"results that arrive while the Object Browser is showing are not unseen"_
- [ ] **There is one rule.** — _"only the Object Browser is accented, and only for unseen job results"_

### AI tool

- [ ] **It applies workspace, open, close, and reports what is open.** — _"applies a workspace, then opens and closes, and reports what is open"_, _"says which requested panels the placement rules displaced"_, _"does not call a panel displaced when the same call closed it"_
- [ ] **Nothing is applied by a refused request.** — _"refuses outside the viewer, an unknown name, an unavailable panel and an empty request"_, _"rejects a name every object inherits"_
- [ ] **Null means absent.** — _"takes a null workspace as no workspace"_
- [ ] **A revert puts the panels back, hidden state included.** — _"the view snapshot carries the panels, and restoring it puts them back"_, _"gives the AI agent's tools the layout's owner while mounted"_
- [ ] **The schema names what the registry names.** — _"the schema the model is given names every workspace and panel"_

### The collection default (the only server write)

- [ ] **A refused write is rolled back, on the collection it was for.** — _"a refused save or clear leaves the default as it was"_, _"a refused save does not touch a collection opened meanwhile"_
- [ ] **A new configuration carries no null key.** — _"a new configuration is created without the null key"_

- [ ] **Saving is one configuration write; toggling panels is none.** — _"saving stores the layout and writes that one key once"_
- [ ] **Clearing writes null.** — _"clearing writes null, which the server drops from the metadata"_
- [ ] **The key is sent and read back, and absent on older configurations.** — _"is a configuration key, so it is sent and read back"_, _"a configuration saved before this existed has no default"_
- [ ] **It saves the panels open as palettes, even while all are hidden.** — _"saving the collection default takes the panels shown as palettes, even while all are hidden"_
- [ ] **It is what a first visit opens with, until I change something.** — _"the collection default is what a first visit opens with, until I change it"_
