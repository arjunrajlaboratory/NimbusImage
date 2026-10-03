# Panel Layout Persistence (and the Panel Registry)

> **Status: spec, not yet implemented.** Written so an agent can pick this up
> cold. Part of the "adaptive interface" effort alongside
> `COMMAND_PALETTE.md` (which depends on the panel registry built here) and
> tool pinning/reordering (shipped separately).

## Goal

Remember which viewer panels are open, per **collection** (configuration),
so that reopening a dataset restores the layout instead of resetting to the
hard-coded default. Collection-wide is a deliberate product decision: the
layout is shared by everyone who opens the collection, the same way tools,
layers and the Object Browser's columns already are. Per-user layouts are out
of scope for now.

Secondary goal: turn the hand-written palette bookkeeping in `App.vue` into a
small **panel registry** module that other features (the command palette, a
future minimize-to-chip mode) can read.

## Current state (as of 2026-10)

All viewer chrome lives in `src/App.vue`.

- **Open/closed state** is a set of local `ref`s (`annotationPanel`,
  `filtersPanel`, `analysisPanel`, `snapshotPanel`, `settingsPanel`,
  `navigatorPanel`, `toolsPanel`, `layersPanel`). They are collected in the
  `paletteOpen` record, next to `paletteRoles` (search App.vue for
  `const paletteRoles`).
- **Placement rules** are in `paletteRoles`, `openPalette()`,
  `togglePalette()` and `closeAllPalettes()`:
  - Right zone: one *primary* at a time. Filters is a *companion* that can
    share the column only with its listed `hosts` (Object Browser, Analysis).
  - Left zone (Navigator / Layers / Tools): an independent vertical stack.
- **Reset on every entry.** `datasetChanged()` closes everything when you
  leave the viewer. On entry it forces Navigator, Tools and Layers open. This
  hard-coded default is what we're replacing.
- **Opening from other components.** Components outside App.vue use
  `store.paletteOpenRequests` / `store.requestPaletteOpen([...])` (ids typed by
  `TRequestablePalette` in `src/store/model.ts`) and the older
  `store.isAnnotationPanelOpen` hatch. App.vue watches both.
- **Not in the registry:** the Timelapse palette (`timelapsePanel`) is a
  computed that mirrors `timelapseStore.showMode`. The AI panel is a separate
  `position: fixed` panel gated by an env flag.
- `FloatingPalette.vue` keeps its content mounted (`v-show`). Its grip icon is
  decorative. Position comes entirely from props.

## Design

### Part 1: extract the panel registry (no behavior change)

Create `src/utils/panelRegistry.ts`. The name is up to you, but keep it out of
`src/store/index.ts`, which is already 2000+ lines. It holds:

```ts
export type PanelId =
  | "annotationPanel" | "filtersPanel" | "analysisPanel" | "snapshotPanel"
  | "settingsPanel" | "navigatorPanel" | "toolsPanel" | "layersPanel";

export interface IPanelDefinition {
  id: PanelId;
  title: string;          // same string FloatingPalette shows
  icon: string;           // the app-bar toggle's mdi icon (check it exists in
                          // @mdi/font 5.9.55; see nimbus-frontend skill)
  zone: "left" | "right";
  role: "primary" | "companion";
  hosts?: PanelId[];      // companions only
  defaultOpen: boolean;   // replaces the hard-coded datasetChanged() defaults
}

export const PANELS: readonly IPanelDefinition[];
// Pure: given the current open set and an id to open, return the new open set
// (applies the primary/companion eviction rules). App.vue's openPalette()
// becomes a thin wrapper around this, so the rules become unit-testable.
export function applyOpen(open: ReadonlySet<PanelId>, id: PanelId): Set<PanelId>;
```

- Make `TRequestablePalette` in `model.ts` an alias of (or a subset derived
  from) `PanelId`, so a renamed panel is a compile error everywhere.
- App.vue keeps its refs, since the template and the ResizeObserver code bind
  to them. It reads roles from the registry instead of its local
  `paletteRoles`.
- Leave the Timelapse palette and the AI panel out of the registry. Their
  visibility is driven by other state.

Ship Part 1 on its own if it gets large. It should be a pure refactor, and
existing App.vue behavior and tests must not change.

### Part 2: persist the layout in the configuration

**Data model.** Add to `IDatasetConfigurationBase` in `src/store/model.ts`:

```ts
// Which viewer panels are open, shared by everyone who opens this
// collection. Optional for compatibility with configurations created before
// this was persisted (absent → registry defaults).
panelLayout?: IPanelLayout;

export interface IPanelLayout {
  open: PanelId[];   // store the open set, not a boolean per panel, so a
                     // panel added later falls back to its defaultOpen
  version: 1;
}
```

**Backend.** No change should be needed: `CollectionSchema` in
`server/models/collection.py` lists `meta` properties but does not set
`additionalProperties: false`, which is how `annotationBrowserConfig`,
`visibilityConfig` and the others persist today. **Verify this** with a real
save and reload, not by reading the schema. Also check that the `nimbusimage`
Python package round-trips an unknown configuration key without dropping it.

**Store.** Follow the `visibilityConfig` / `annotationBrowserConfig` pattern
in `src/store/index.ts`:

- a mutation `setConfigurationPanelLayout(layout)`;
- a **debounced** `schedulePanelLayoutSave()` modeled on
  `scheduleAnnotationBrowserSave()`. Copy its `isLoggedIn` early return:
  anonymous or public viewers can still open and close panels, but those
  changes stay session-only and must not raise the "must be logged in"
  notification on every click;
- the save goes through `syncConfiguration("panelLayout")`, which is one
  write per logical change (see the "One Logical Change → One Config Write"
  section of the nimbus-frontend skill).

**App.vue wiring.**

1. **Restore.** In `datasetChanged()`, on entry to the viewer, read
   `store.configuration?.panelLayout`. If it's absent or invalid (unknown ids
   or a malformed shape), use each panel's registry `defaultOpen`. Apply the
   set through the same rule function (`applyOpen`), so a stored layout can
   never produce an illegal state such as two right-zone primaries. Drop
   unknown ids silently; they come from a newer or older client.
2. **The configuration may arrive after the route changes.** Check the order
   in which `routeName` and `store.configuration` become ready on a cold page
   load. If the configuration isn't loaded when `datasetChanged()` runs, also
   restore when `store.configuration?.id` changes. Restore once per
   configuration id, not on every configuration object replacement: syncs and
   `ressourceChanged` refetches replace the object, and re-applying then would
   undo panels the user just toggled.
3. **Save.** Watch the open set, serialized (for example the sorted ids
   joined; see the "Watching Getters That Rebuild Their Return Object"
   section of the nimbus-frontend skill), and call
   `schedulePanelLayoutSave()`. Do **not** save while restoring. Use a
   `isRestoring` flag or compare against the last restored value, otherwise
   every dataset open writes the configuration back.
4. **Configuration switch mid-debounce.** The pending save must write the
   layout to the configuration it was captured for, or be dropped. It must
   never write to whichever configuration is current when the timer fires.
   `syncConfiguration` captures `configuration.id` before its await for the
   same reason; read the comment there.
5. **Leaving the viewer.** `closeAllPalettes()` runs when the route leaves
   `datasetview`. That close must **not** be saved, or every collection's
   saved layout becomes "all closed". Gate the save watcher on
   `routeName === "datasetview"`, or suspend it around the close.

Opens that come through `paletteOpenRequests` are user-intent and should
save. The Timelapse palette is not in the set, so its auto-open never saves.

### Part 3 (optional, separate PR): minimize to a chip

Make the `FloatingPalette` grip real: a minimize button collapses the panel to
a small labeled chip (title + icon) docked on its zone's edge, and clicking
the chip restores it. A minimized panel stays visible as a chip, unlike a
closed one, which keeps it discoverable. Extend `IPanelLayout` with
`minimized: PanelId[]` (bump `version`). Panels are always mounted
(`v-show`), so minimizing must not unmount the content; see the
"Palette content is always mounted" note in the project memory and gate any
fetches on visibility.

## Edge cases checklist

- [ ] Stored layout names a panel that no longer exists → ignored.
- [ ] Stored layout has two right-zone primaries (hand-edited or a race) →
      resolved through `applyOpen`; the last one wins.
- [ ] Anonymous viewer toggles panels → no notification, no PUT.
- [ ] Logged-in user with READ-only access → the PUT fails. Existing
      tool/layer edits have the same failure mode (`sync.setSaving(error)`).
      Decide whether to skip the save when the user can't write. There is no
      configuration write-access getter today; don't add a frontend-only
      permission check as a substitute for the backend's.
- [ ] Opening a dataset does not trigger a configuration PUT (watch the
      network tab).
- [ ] Leaving the viewer does not save "all closed".
- [ ] Switching to a different dataset that shares the configuration
      restores the same layout.

## Tests to write

- `panelRegistry.test.ts`: `applyOpen` truth table, covering primary evicts
  primary, companion with host, companion without host, left-zone
  independence, and an unknown id.
- A store test that `schedulePanelLayoutSave` debounces to one
  `syncConfiguration("panelLayout")` and no-ops when logged out. Dispatch the
  real action, as `src/store/index.test.ts` does.
- An App-level or extracted-composable test for the restore/save loop: restore
  doesn't save, leaving doesn't save, and a configuration switch
  mid-debounce writes to the right configuration. If App.vue is too heavy to
  mount, put the restore/save logic in a composable
  (`usePanelLayoutPersistence`) and test that instead.

Make each new test fail once against the unfixed code before trusting it
(nimbus-frontend skill, "Test mocks must model the real store's REPLACEMENT
semantics").

## Verification (in the browser)

Use the `in-browser-testing` skill. From a **fresh page load** on a real
collection:

1. Open Filters + Object Browser, close Layers, then reload. The same layout
   comes back.
2. Open a second dataset in the same collection. Same layout.
3. Open a dataset in a different collection. That collection's own layout, or
   the defaults.
4. Log out (or use a public dataset) and toggle panels. No notification, no
   PUT.
5. In the network tab, opening a dataset issues no configuration PUT.

## Regression checklist

When this ships, add a regression checklist here: one line per invariant,
each naming its test (see `CONNECTION_LIST.md` for the format).
