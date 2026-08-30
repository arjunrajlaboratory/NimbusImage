# Connection List Feature Documentation

> **Status:** Implemented.
> **Issue:** [#554 — Probably need some sort of list view for connections](https://github.com/arjunrajlaboratory/NimbusImage/issues/554)

## Overview

Connections between annotations are currently write-mostly: tools create them, the
viewer draws them, and the only way to remove one is a bulk-delete dialog that
operates on whole categories (all / current location / selected objects). There is no
way to see what is connected to what, and no way to delete a single bad link.

This feature adds a **Connections tab** to the Object Browser with a flat/grouped list
of connections, per-row and bulk deletion, and a "Connect selected" action for joining
broken tracks. It also makes connection lines **clickable in the image viewer** — in
both normal and timelapse mode — so a bad link can be selected and cut where you see
it.

**This is a pure frontend feature.** Every endpoint it needs already exists and is
already `@recordable`, so undo/redo works with no backend change.

---

## Background: current state

| Concern | Where it lives today |
|---|---|
| Connection data | `annotationStore.annotationConnections` (`src/store/annotation.ts:93`) — **all** connections for the dataset are fetched client-side on `fetchAnnotations` |
| Only UI | `AnnotationBrowser/DeleteConnections.vue` — bulk-delete dialog in the Object Browser "More Actions" menu |
| Normal-mode drawing | `drawGeoJSAnnotationFromConnection` (`AnnotationViewer.vue:1740`) — one GeoJS line per connection, tagged `isConnection: true` + `girderId` |
| Timelapse drawing | `drawTimelapseTrack` (`AnnotationViewer.vue:1448`) — also one GeoJS line **per connection**, but **untagged** |
| Track grouping | `findConnectedComponents` (`AnnotationViewer.vue:1233`) — private to the viewer |
| Click hit-testing | Explicitly **skips** connections: `if (!girderId || isConnection …) continue` (`AnnotationViewer.vue:1997`, `:2056`) |

Two facts make this cheaper than it looks:

1. Timelapse tracks are **not** a single polyline per track — they are one line
   annotation per connection. Per-link hit resolution needs no segment math.
2. `shouldSelectGeoJSAnnotation` (`AnnotationViewer.vue:2090`) already handles
   `AnnotationShape.Line` via `pointNearLine`. No new geometry code is required.

Scale: the largest local dataset has ~5,000 connections. `IAnnotationConnection` is
compact (`model.ts:1717`), so unlike annotations there is **no need for stubs or
server-side pagination** — the client already holds them all, and a client-paginated
table is sufficient.

---

## User Guide

### Finding it

The Object Browser palette gains a tab strip. Objects is the default; the Connections
tab shows a count badge and is otherwise out of the way for the majority of users who
never use connections.

```
┌─ Object Browser ───────────────────────── ✕ ┐
│  [ Objects ] [ Connections • 412 ]          │
├─────────────────────────────────────────────┤
│  Scope: [ All connections      ▾ ]  412     │
│  [ Flat | By track ]   [⧉ Connect selected] │
│                              [🗑 Delete (2)] │
│  ┌────┬──────────────┬──────────────┬─────┐ │
│  │ ☑  │ Parent       │ Child        │ Tags│ │
│  ├────┼──────────────┼──────────────┼─────┤ │
│  │ ☑  │ #a2f  T0     │ #b71  T1     │ Ti… │ │
│  │ ☐  │ #b71  T1     │ #c04  T2     │ Ti… │ │
│  │ ☐  │ #b71  T1     │ #c19  T2     │ Ti… │ │ ← branch
│  └────┴──────────────┴──────────────┴─────┘ │
└─────────────────────────────────────────────┘
```

### Scope selector

Four scopes. A connection is in scope when **either** endpoint qualifies — one
predicate for all four, so the rule is easy to hold in your head. The tab labels this
explicitly ("Connections touching …") rather than leaving it implied.

| Scope | Shows |
|---|---|
| **All connections** (default) | Every connection in the dataset |
| **Current location** | Connections touching an object at the current XY/Z/T |
| **Selected objects** | Connections touching anything selected in the Objects tab |
| **Objects passing filters** | Connections touching an object that passes the active tag/property/ROI filters |

"Either endpoint" matches the existing `DeleteConnections.vue:105-116` semantics for
location and selected. For the filter scope it deliberately surfaces links *leaving*
the filtered set — which is exactly where mis-tracked objects hide.

### Flat vs. By track

**Flat** is one row per connection. **By track** groups rows by connected component —
the same grouping timelapse mode already uses — and each track expands to its member
links:

```
▾ Track a2f    6 objects   T0–T5           [🗑 delete track]
    #a2f T0 ──▶ #b71 T1                 ☐  [🗑]
    #b71 T1 ──▶ #c04 T2                 ☐  [🗑]
    #c04 T2 ──▶ #d55 T3                 ☐  [🗑]
▸ Track e12    3 objects   T2–T4
▸ Track f88    2 objects   T0–T1
```

Components are computed over the **scoped** set, not the whole dataset, so narrowing
the scope can split one track into several. That is the correct reading of the
question being asked ("what are the tracks *among these objects*"), and the member
count plus time range on each track row makes a truncated track obvious.

Track ids are the smallest member annotation id, so expansion state survives
re-renders.

### Track filters

*User request: "Filter by track length/number of connections would be huge for me."*

The toolbar's filter button opens a menu of optional min/max bounds on three
**dataset-wide track metrics**:

| Metric | Definition |
|---|---|
| Connections in track | `component.connections.length` over the full graph |
| Objects in track | endpoint count, dangling endpoints included |
| Duration (timepoints) | max member `Time` − min + 1, over the members that resolve |

A connection whose track falls outside any active bound is hidden from the
list **and from both viewer draw paths** — normal-mode lines and timelapse
tracks — because all three read one store predicate,
`connectionListStore.connectionPassesTrackFilters`. In timelapse mode a hidden
track disappears entirely (segments and centroid dots); its members are *not*
recast as gray orphan dots, since the graph didn't change, only the view.

Design decisions worth knowing before changing this:

- **Metrics are dataset-wide** (keyed by `colorKey` via
  `trackKeyByAnnotationId`), never computed on the scoped fragment — narrowing
  the scope must not make a long track read as short. Same rule as track
  colouring and duplicate-ID detection.
- **Unknown duration is excluded.** A track whose every endpoint dangles
  (points at a *deleted* annotation — data rot, not "ends at the last
  timepoint") has no computable duration; under an active duration bound it
  is hidden, and **Clean up dangling** (below) is the remedy for the rot
  itself. Count bounds are always known and still apply. Tracks with *some*
  surviving members get their duration from those.
- **"Also hide these tracks' objects in the image"** extends the filter to
  the filtered-out tracks' objects — an opt-in checkbox in the same menu,
  off by default, because filtering the connections list must not silently
  make cells vanish from the canvas. It is a display lens only (the Objects
  tab, exports and analysis are untouched), unconnected objects are never
  hidden, and while it narrows, the render-coverage HUD counts it as an
  active constraint ("1 track filter hiding whole tracks' objects") whose
  click opens the Object Browser directly on the Connections tab (via
  `openAnnotationBrowserTab`, the "Show tracks" mechanism — the browser
  otherwise reopens on whatever tab it last showed) — unless an Analysis gate
  is also active: those two are mutually-evicting right-zone primaries, so
  Analysis wins the click and the tooltip names only what actually opens. The HUD's "passing
  filters" figure reads `displayedPassingCount` (filters ∩ lens), never the
  raw `filteredAnnotations.length`. It narrows both display twins — the drawn
  set (`displayableAnnotations`) and the visibility refresh
  (`updateVisibility`'s `filteredIds`), which drives the stub-mode budget and
  the HUD's viewport counts. The zoomed-out **raster overview** on huge
  datasets is exempt, exactly as it is from every client display filter
  (`filteredDraw` included): the raster renders the complete frame by design,
  and the lens applies where vectors take over.

### Clean up dangling connections

When the dataset contains connections whose endpoints point at deleted
annotations, the Connections tab toolbar shows **Clean up dangling (N)** —
hidden entirely on healthy datasets. It deletes those connections from the
whole dataset (not the current scope) behind a confirm dialog, in one batched
request, and participates in undo like every other connection delete. Stubs
count as resolvable endpoints, so lazy mode never mistakes an unhydrated live
annotation for a deleted one.
- **With no filter active the predicate is a stable `() => true` constant**,
  so the common case adds zero cost and zero reactive dependencies to the draw
  paths. The metrics map is only ever computed when a filter is active, cached
  against the connection graph.
- The count readout becomes **"N of M"** while filters narrow, the empty state
  says "No connections match the track filters", and the button carries a
  badge — three cues that the list is narrowed (see the count-cue rule in the
  nimbus-frontend skill).
- Filters are **session-only view state**, reset when the dataset actually
  changes — numeric ranges don't transfer between datasets with different
  track scales, but a same-dataset refresh (e.g. an unroll toggle re-running
  `setSelectedDataset` with the same id) keeps them, like the ordinary
  filters. Scope and grouping survive dataset switches; filters deliberately
  don't.
- Changing a bound clears the connection selection and resets the page,
  matching `setScope`'s rationale; the bulk-delete intersection additionally
  picks the filter up by construction because `scopedConnections` applies it.

### Track ID property

*Issue [#1330](https://github.com/arjunrajlaboratory/NimbusImage/issues/1330).*

By default a track row is titled `Track #<short id>`. The By-track view adds a
**Track ID property** select that instead labels each track with a computed
property value — typically the `trackId` the *Parent-Child Connection IDs*
worker writes (with "Add track IDs" checked), so a track flagged during
post-processing (`trackId = 42` in an exported CSV) can be found here as
`Track 42`.

The worker cannot be hardcoded: the property carries a user-chosen name, and
its integer ids are assigned by fetch order, so they are only meaningful as
stored values. The select therefore offers every computed property path
(`propertyStore.computedPropertyPaths`), plus the persisted selection even when
its values have since disappeared, so it can be seen and cleared.

Resolution per track (`resolveTrackLabelValue` in `@/utils/connections`), over
all member annotation ids:

| Members' values | Title | Badge |
|---|---|---|
| all share one value, unique among displayed tracks | the value | — |
| all share one value, also on another displayed track | the value | `duplicate ID` (warning) |
| one value, some members without | the value | `partial` (warning) |
| differing values | short id | `mixed IDs` (warning) |
| none | short id | `no ID` |

The badges are staleness signals, not error states: the worker assigned values
against the connection graph at compute time, so `partial` (members added
since), `mixed` (tracks joined since) and `duplicate ID` (a track split since —
both halves keep the old id unanimously, which per-track resolution alone
cannot see; `findDuplicateTrackLabelValues` compares across the displayed
rows) flag exactly the tracks whose connections changed after the property
ran — the ones worth a second look. Dangling endpoints count as members
without values, which is deliberate for the same reason. Duplicate detection
runs over the displayed, scope-narrowed rows but is keyed by `colorKey`, the
dataset-wide track identity: a narrow scope can expose one intact track as
two disconnected fragments, which share a value legitimately and must not
read as a split. The default "All connections" scope makes the displayed rows
the whole dataset, while a narrower scope can hide a duplicate's twin.

Value lookup is mode-split: wholesale mode reads `propertyStore.propertyValues`
directly; lazy (stub-only) mode fetches the members' values once per
path/revision with a single batched `getPropertyValuesForIds` call, cached in
the component (the store's value cache is pruned to the viewport on every pan,
so it cannot hold track members). A `propertyValuesRevision` bump — recompute
or import — invalidates and refetches.

In lazy mode, a member id absent from the fetch cache is **unknown**, not
missing: a track with uncovered members renders unresolved (default short-id
title, no badge) rather than claiming `no ID` about values that may exist on
the server. Ids resolve to "confirmed missing" only from a successful
response. A failed fetch flags a compact warning with a Retry button, since
nothing else necessarily re-fires the watcher after a failure.

The chosen path is persisted per **configuration** in
`annotationBrowserConfig.trackLabelPath` (a property id only means something
within one configuration), hydrated through `hydrateTrackLabelPath` with the
same schedule-on-change / silent-hydration contract as the displayed property
columns, and validated by `resolveAnnotationBrowserConfig` so a path whose
property left the configuration falls back to default labels. A **live**
property deletion clears it immediately too:
`reconcileTrackLabelPathForPropertyIds`, called from
`properties.setProperties` alongside the analysis-plot reconciliation, drops
the path (and persists the drop) the moment its property id leaves the
configuration.

### Row labelling

Annotation ObjectIds are 24 hex characters and unreadable, and the Objects tab's index
column is derived from that list's own filter/sort (`AnnotationList.vue:668`), so it is
not meaningful here. Each endpoint therefore renders as:

**name (if set), else `#` + last 6 characters of the id — plus its `T` / `Z` / `XY`.**

Endpoints resolve through `getAnnotationFromId(id) ?? getStub(id)`. Stubs carry
`location` and `tags` (`model.ts:1565`), so rows render correctly at scale with no
hydration.

### Actions

| Action | Behavior |
|---|---|
| **Click a row** | Navigates to the connection (framing both endpoints) and **highlights** it — it does not select. Mirrors the Objects tab, where a row click navigates + hovers and the checkbox is what selects; selecting on a row click would silently arm the bulk delete and the viewer action panel. |
| **Row checkbox** | Selects the connection for bulk actions |
| **Row trash icon** | Deletes that one connection |
| **Delete selected** | Deletes all checked connections in a single batched request |
| **Connect selected** | Chains the annotations selected in the Objects tab into connections (see below) |

### Connect selected

Reads `annotationStore.selectedAnnotationIds`, resolves each endpoint, sorts ascending
by `location.Time`, chains consecutive pairs, and issues **one**
`createMultipleConnections` call.

```
Objects tab: #c04 (T2), #f31 (T5) selected
   → creates  #c04 T2 ──▶ #f31 T5

N selected → chained by ascending Time:
   #a2f T0 ▶ #b71 T1 ▶ #c04 T2 ▶ #f31 T5
```

Guards:

- Fewer than 2 selected → the action is disabled.
- **More than `MAX_CONNECT_SELECTED` (500) selected → the action is disabled**, with an
  inline note saying so. Without this, a select-all in the Objects tab (routinely tens
  of thousands of objects) followed by one click would POST that many connections in a
  single request; the backend's `multipleCreate` has no cap of its own. A real track
  spans timepoints, not thousands of objects, so the cap is well clear of legitimate
  use.
- Pairs already connected in **either** direction are skipped, never duplicated.
- Created connections carry `tags: [TIMELAPSE_CONNECTION_TAG]`.

### Selection safety

Two rules keep a selection from feeding a destructive action it was never meant for:

- **The list's bulk delete acts on `selectedInScopeConnectionIds`** — the intersection
  of the selection with the rows currently in scope — not on the raw selection. This is
  the load-bearing rule, because a dynamic scope's *inputs* change without `setScope`
  ever firing: scrubbing XY/Z/Time under "current location", changing the object
  selection under "selected objects", editing filters under "passing filters". Each
  silently replaces the visible rows. Deriving the delete set from the intersection
  makes "you can only bulk-delete rows the list is showing" true by construction rather
  than dependent on catching every input change. The button's count shows the same
  number, so it never promises more than it will do.

  The viewer's action panel deliberately uses the **raw** selection instead
  (`deleteSelectedConnections` vs. `deleteSelectedInScopeConnections`): there, deleting
  the link you just clicked is the intent whether or not it is in the list's scope.

- **Changing the scope also clears the connection selection.** Belt to the intersection's
  braces, and better UX: an explicit scope switch is a deliberate change of context.
  Changing the flat/track grouping does **not** clear it — grouping re-arranges the same
  set rather than redefining it.
- **The header checkbox counts selected rows that are actually visible**, not the total
  selection size. A viewer click can select a connection outside the current scope, and
  a naive size comparison would then read as "all selected" while no visible row is.

---

## Connection direction

This is the part most likely to be got backwards, so it is stated explicitly.

**`parentId` = the earlier annotation. `childId` = the later annotation.**

The later object is the *child*, pointing back to its earlier *parent* — standard cell
lineage semantics. This is already what `createTimelapseConnection` normalizes to
(`annotation.ts:1141-1144`), and `Connect selected` must match it or it would produce
links inverted relative to every existing connection in existing datasets.

### Within a single frame

When two annotations share a timepoint there is **no information in the data from which
to infer a direction**. The codebase already acknowledges this: the same-frame path (the
connection tool) does not infer anything — direction comes from the tool's
`parentAnnotation` / `childAnnotation` tag+layer templates, declared by the user
(`AnnotationViewer.vue:2217-2223`).

For `Connect selected`, ties are broken by **selection order: first selected becomes the
parent.**

Implementation note: build the array in `selectedAnnotationIds` iteration order and
sort by `Time`. `Array.prototype.sort` is stable (guaranteed since ES2019), so ties
retain selection order for free — no explicit tiebreaker.

**Known limitation, surfaced rather than hidden.** Selection order is only meaningful
when objects are clicked one at a time (`annotation.ts:511` appends). Drag-select
rebuilds the set from an array in spatial-index order, so "first selected" is
effectively arbitrary there. When the pending chain contains a tie, the toolbar shows
an inline caption:

> ⚠ 2 selected objects are both at T=4 — they will be chained in the order you
> selected them.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Frontend                                 │
├──────────────────────────────────────────────────────────────────┤
│  Components                        │  Store                       │
│  AnnotationBrowser.vue  (tab host) │  connectionList.ts  (NEW)    │
│   ├─ AnnotationList.vue            │   └─ view state ONLY         │
│   └─ ConnectionList.vue     (NEW)  │      scope, grouping, page,  │
│       └─ ConnectionListRow  (NEW)  │      selectedConnectionIds   │
│                                    │                              │
│  AnnotationViewer.vue              │  annotation.ts  (unchanged)  │
│   ├─ ConnectionActionPanel  (NEW)  │   └─ annotationConnections   │
│   └─ connection hit-test / style   │      + all connection CRUD   │
├──────────────────────────────────────────────────────────────────┤
│  Utils                                                            │
│  utils/connections.ts  (NEW — pure, unit-testable)                │
│   ├─ findConnectedComponents()   ← moved out of AnnotationViewer  │
│   ├─ buildConnectionRows()                                        │
│   └─ chainAnnotationsByTime()                                     │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│              Backend — NO CHANGES REQUIRED                        │
│  /api/v1/annotation_connection            (already @recordable)   │
│  POST   /multiple   batch create                                  │
│  DELETE /multiple   batch delete                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Why connection data stays in `annotation.ts`

A full extraction into a `connections` store module was considered and rejected.
Connection data is entangled with the annotation lifecycle:
`addConnectionsForNewAnnotation` fires on every annotation creation, `fetchAnnotations`
loads both in one pass, and the timelapse draw path reads connections directly. Moving
it would touch the viewer, the connection tool, import/export, and
`DeleteConnections.vue` for zero user-visible gain.

Instead, `connectionList.ts` holds **view state only, no server data** — roughly 150
lines. That boundary is the thing to preserve: if server data starts accumulating in
`connectionList.ts`, the split has failed and the full extraction should be revisited.

### New files

**`src/store/connectionList.ts`** — Vuex module (`vuex-module-decorators`), view state only:

- `scope: "all" | "location" | "selected" | "filtered"`
- `grouping: "flat" | "track"`
- `selectedConnectionIds: Set<string>` (`markRaw`, mirroring `annotation.ts:98`)
- `hoveredConnectionId: string | null`
- `page`, `itemsPerPage`, `expandedTrackIds: Set<string>`
- Actions: `toggleConnectionSelection`, `setSelectedConnectionIds`,
  `deleteSelectedConnections` (delegates to the already-batched
  `annotationStore.deleteConnections`), `connectSelectedAnnotations`
- Resets on dataset change, mirroring `annotation.ts:427-432`

**`src/utils/connections.ts`** — pure functions, testable without a store:

- `findConnectedComponents(connections)` — moved from `AnnotationViewer.vue:1233`
- `buildConnectionRows(connections, resolveEndpoint)` → row view models
- `chainAnnotationsByTime(annotations)` → `IAnnotationConnectionBase[]`

**`src/components/AnnotationBrowser/ConnectionList.vue`** — tab body: scope selector,
flat/track toggle, toolbar, `v-data-table`.

**`src/components/AnnotationBrowser/ConnectionListRow.vue`** — one row, mirroring
`AnnotationListRow.vue`.

**`src/components/ConnectionActionPanel.vue`** — viewer overlay, sibling to
`AnnotationActionPanel`.

### Modified files

**`AnnotationBrowser.vue`** — grows from a 14-line pass-through into a `v-tabs` host
(Objects | Connections + count badge), keeping the existing `clickedTag` forwarding.
This is the right home: it currently does nothing, and `AnnotationList.vue` at 1,338
lines must not absorb a second table.

**`src/store/constants.ts`** — the `"Time lapse connection"` magic string currently
appears in three places (`AnnotationViewer.vue:2239`, `:2257`, `annotation.ts:1103`).
`Connect selected` needs to emit the same tag, so it becomes
`TIMELAPSE_CONNECTION_TAG` and all four call sites use it.

**`AnnotationViewer.vue`** — four narrow edits, below.

`DeleteConnections.vue` is **unchanged** and stays in More Actions as the bulk escape
hatch.

---

## Viewer integration

### 1. Tag timelapse lines

`drawTimelapseTrack` (`AnnotationViewer.vue:1511`) builds one line per connection but
attaches no options. Add `girderId: connection.id` and `isConnection: true` — the
normal-mode path already sets both (`:1751-1754`).

### 2. Hit test

Three rules:

- **Click only.** Drag/lasso selection continues to skip connections. Lasso is for
  objects; letting it grab lines would make every box-select ambiguous.
- **Annotations win.** Connections are tested only when no annotation was hit, so a
  line crossing an object never steals its click.
- **Both layers.** `findConnectionIdAtPoint` scans `timelapseLayer` first when timelapse
  mode is on (those are the lines the user sees), then `annotationLayer`.

All of this hangs off the existing `selectAnnotations` entry point, so connections use
the **same gestures as objects** — there is no connection-specific interaction:

| Gesture | Effect |
|---|---|
| **Plain click** on a line | Highlights it (`hoveredConnectionId`) — the line widens and its list row gets `is-hovered`. Mirrors what a plain click already does to an object. |
| **Shift+click**, or a click with the select tool active | *Selects* it — cyan line, `is-selected` row, the connection action panel, Delete key. |
| Drag / lasso | Never touches connections (see "Click only" above). |

The plain-click case exists because without it the feature reads as broken: the hover
handler (`setHoveredAnnotationFromCoordinates`) skipped `isConnection` features, so a
plain click highlighted an object but did *nothing at all* on a connection line, and
nothing in the UI hinted that shift was required. Objects still win — connections are
only considered when the click hit no object.

Selection proper still requires shift because `ImageViewer`'s `isMouseStartEvent`
(`shiftKey && buttons !== 0`) gates the whole mouse-capture path; a plain drag pans the
map. Changing that is a global interaction decision, not a connections one.

**Hit geometry uses a dedicated `pointNearConnectionLine`, not `pointNearLine`.** The
existing helper compares a *squared* distance against an unsquared width
(`AnnotationViewer.vue:1829`), so its effective tolerance shrinks as you zoom out —
fine for the callers that depend on it, but it would make connection lines
progressively unclickable. Connections get a correct squared comparison against an
explicit `CONNECTION_CLICK_TOLERANCE_PX = 6`.

In timelapse mode this means clicking a track segment selects exactly that link, and
Delete cuts the track in two:

```
  T0  T1  T2  T3  T4
  ●───●───●═══●───●
          ⤴ click this segment
            → selects the T2→T3 connection
            → Delete splits the track
```

### 2b. Drawing under lazy loading (stub-only mode)

`drawNewConnections` gates on the **centroids it actually draws from**, not on
`getAnnotationFromId`. This matters enormously on lazily-loaded datasets and was a live
bug before this branch:

> On the 709K-object Xenium dataset, `getAnnotationFromId` returns `undefined` for every
> unhydrated non-point annotation. Only 4 of 12 connection endpoints resolved through
> it, so only the single connection whose *both* endpoints happened to be hydrated was
> drawn — **1 of 11 lines**, even though all 12 centroids were present and all 12
> endpoints were displayed on screen. Zooming in far enough hydrated the rest and the
> lines appeared, which made it look like a zoom bug rather than a hydration one.

`drawGeoJSAnnotationFromConnection` therefore takes two `IGeoJSPosition` centroids
rather than two `IAnnotation`s — the line only ever needed the positions, and taking
annotations coupled drawing to hydration for no reason. Keep it that way.

**`clearOldAnnotations`' connection branch must use the same criteria.** It had the
identical `getAnnotationFromId` coupling, so fixing only the draw path left every draw
removing the lines it had just created: measured at 4/12 endpoints hydrated,
`clearOldAnnotations` dropped **10 of 11** lines, which `drawNewConnections` then rebuilt
on the next pass — pure GeoJS churn that scales with connection count. Draw and
retention are a pair; change them together.

Connection lines are also **styled at construction**, not only by `restyleAnnotations`.
A selected connection that is torn down and rebuilt (panning away and back, toggling
connection rendering) would otherwise return default-blue and stay that way until the
next selection or hover event, because the restyle watcher only fires on *changes*.

### 3. Styling

`restyleAnnotations` (`:1774`) grows a connection branch: selected → cyan
(`CONNECTION_SELECTED_COLOR`) at width 6, hovered → width 5, otherwise
`CONNECTION_BASE_STYLE`. The timelapse layer's rebuild pass reads
`selectedConnectionIds` while computing each segment's desired state; the pass
is a keyed **diff** (see the Cost checklist), so a kept feature is updated in
place when its desired style changed and left untouched when it didn't.

Two traps worth keeping in mind if you touch `getConnectionStyle`:

- **Every branch must set both `strokeColor` and `strokeWidth`.** Restyle merges over
  the feature's existing style, so a branch that omits `strokeColor` leaves a
  deselected line stuck on the cyan highlight.
- **`CONNECTION_BASE_STYLE` reproduces GeoJS's own line-annotation defaults** (blue
  `#0000ff`, width 3). Connections previously had no explicit style at all, so matching
  those values keeps an untouched line looking exactly as it did before.

### 4. Action panel

`AnnotationActionPanel` mounts when `selectedAnnotationIds.size > 0`
(`AnnotationViewer.vue:11`). A sibling `ConnectionActionPanel` mounts when
`selectedConnectionIds.size > 0`, offering Delete selected / Deselect. This is where
the Delete key lands, matching the object flow.

### List ↔ viewer sync

Both directions go through `connectionList.selectedConnectionIds`. The list writes it
on row click; the viewer writes it on line click; both read it for styling.

When the selection becomes a single connection — which is what a viewer click produces —
`ConnectionList.revealConnection` pages the flat list to the row (or expands the
containing track) and scrolls it into view via its `data-connection-id`. It deliberately
does **not** open the Object Browser or switch tabs: a click on the canvas should not
throw a palette over the image. It only puts the row where it can be found once the user
looks.

---

## Error handling

- **Not logged in** → Delete and Connect are disabled, matching `DeleteConnections.vue:10`.
- **Dangling endpoint** (annotation deleted out from under a connection) → the row
  renders `⚠ missing` for that side and remains deletable. This must never throw —
  cleaning up exactly this kind of bad data is the point of the feature.

  This is not hypothetical. The first real timelapse dataset checked
  (`69f4eb65aaba948c2d7b9b24`) has **2,616 of 5,230 connection endpoints pointing at
  annotations that no longer exist** — verified identically from the client store and
  from MongoDB. Expect `⚠ missing` rows to be common in older datasets, and do not
  mistake them for a rendering bug.
- **Batch failures** surface through the existing `logError` / `sync` saving-state
  path. The store mutation is the source of truth; the list does not refetch.
- **Dataset switch** resets `connectionList` state (mirroring `annotation.ts:427-432`)
  so scope and selection cannot leak between datasets.

---

## Regression checklist

Every item below was a real defect in this feature, and several were
**reintroduced while fixing something else** — the construction-time styling
undid itself on the next redraw, the retention predicate kept a coupling the
draw path had just dropped, and a per-viewer mount reappeared as duplicate
delete requests. Each line names the invariant and the test that holds it, so
changing this code means re-checking the list rather than rediscovering it.

Run `pnpm test src/utils/__tests__/connections.test.ts src/utils/__tests__/camera.test.ts src/utils/__tests__/annotationNavigation.test.ts src/store/__tests__/connectionList.test.ts src/store/annotationBrowserConfig.test.ts src/components/AnnotationBrowser src/components/ConnectionActionPanel.test.ts src/components/AnnotationViewer.test.ts src/components/TimelapsePanel.test.ts src/utils/__tests__/paletteGeometry.test.ts`.

### Drawing

- [ ] **Draw and retention agree.** `drawNewConnections` and `clearOldAnnotations`' connection branch must gate on the *same* thing (displayed ids + centroids). If they diverge, every pass deletes what the last one drew. — *"retains stub-backed connection lines through clearOldAnnotations"*
- [ ] **Nothing in the draw path depends on hydration.** `getAnnotationFromId` returns `undefined` for unhydrated annotations; gate on centroids. — *"still draws when the endpoints are unhydrated stubs"*
- [ ] **Styles are renderable, not just coloured.** `options("style", …)` replaces; every branch must carry `stroke: true`. — *"styles a selected connection at construction"*, *"draws a line for a connection…"*
- [ ] **The retained-feature restyle loop skips `isConnection`.** Connection features carry a `girderId`, so they land in `drawnGeoJSAnnotations` and get object styling. — *"keeps a selected connection cyan through a redraw"*
- [ ] **Equal-time and self links.** A same-time pair must draw exactly once; a self-connection must not draw. — *"draws an equal-time link exactly once"*, *"does not draw a self-connection as a track segment"*
- [ ] **Duplicate pairs pick the right representative:** selected, then hovered, then first. — *"renders the selected duplicate…"*, *"renders the hovered duplicate…"*
- [ ] **Timelapse segments can be repainted without a rebuild.** They bake their appearance in at draw time, so every segment carries `timelapseBaseStyle` (its track colour, width and dash minus the highlight) and `connectionIds` (every document sharing its endpoint pair, not just the representative). Drop either and the hover highlight either cannot be recomputed or misses duplicates. — *"widens a hovered track segment in place…"*, *"restores a time-jump segment's base styling…"*, *"widens the segment when a non-representative duplicate is hovered"*

### Interaction

- [ ] **Objects win; lasso never selects connections; empty space clears.** — viewer selection tests
- [ ] **Closest line wins**, not the first within tolerance. — *"selects the closest connection when several are within tolerance"*
- [ ] **Plain click highlights, shift+click selects.** A plain click must do *something* on a line. — *"hovers a connection on a plain click…"*
- [ ] **BOTH click paths share every precedence rule.** Highlighting goes through `setHoveredAnnotationFromCoordinates`, selection through `selectAnnotations`. A rule added to one and not the other leaves shift+click and the select tool behaving differently from a plain click. — *"selects the connection over an object in timelapse mode"*, *"still selects the object outside timelapse mode"*
- [ ] **Timelapse inverts the objects-win rule.** Track segments are the visual there and the annotation dots sit under them, so a segment almost always crosses a dot; without the inversion, clicking a track did nothing at all. Normal mode keeps objects winning. — *"prefers the connection over an object in timelapse mode"*, *"still prefers the object outside timelapse mode"*
- [ ] **A row click navigates + highlights, never selects.** — *"navigates and highlights without selecting"*
- [ ] **Reveal reacts to hover as well as selection**, and selection wins — but only an *existing* selection. Selection deliberately keeps ids for connections deleted elsewhere, so priority based on the raw set let one deleted selection block hover reveal forever. — *"reveals on hover, not only on selection"*, *"ignores a deleted selection when revealing on hover"*
- [ ] **Navigation frames both endpoints, with the signed delta.** — *"passes the SIGNED endpoint delta…"*

### Cost

- [ ] **Row building is gated on the tab being visible.** `connectionRows` depends on hydration through `resolveAnnotation`, so every pan invalidates it. `FloatingPalette` uses `v-show` and `v-window-item` keeps both tabs mounted, so an ungated read makes a user who opened the tab once rebuild all rows on every pan for the rest of the session — ~6.7 ms at 4,983 connections, scaling linearly, with none of the rows rendered. — *"does not read the row getters while the tab is hidden"*
- [ ] **Hover never runs the timelapse rebuild pass — but it must still repaint.** One feature per connection (5,217 measured here) and hover changes continuously as the pointer runs down the list, so selection triggers the rebuild pass and hover restyles the drawn segments in place. Skipping the repaint entirely was the first attempt, and it silently broke the feature's main gesture: a row click *highlights* rather than selects, so clicking a connection did nothing visible in timelapse mode while it worked everywhere else. Measured on 2,364 segments: 0.8 ms to scan, 6.6 ms median to redraw, throttled to 100 ms. Rebuild passes are counted by the exposed `timelapseRebuildCount` — `removeAllAnnotations` no longer runs in the mode-on path, so it is not a rebuild observable. — *"does not rebuild the timelapse layer on hover"*, *"widens a hovered track segment in place, without rebuilding"*, *"does not redraw when the hovered connection is not on the layer"*
- [ ] **Watcher-driven timelapse rebuilds coalesce (trailing throttle).** The displayedAnnotations watcher fires 2-3 times per frame change (two-phase visibility update); reaching the rebuild directly on each fire bundled 2-3 full passes into ONE main-thread task per time-scrub step (measured 157 ms at 9,965 connections; a single pass was ~57 ms). `drawTimelapseThrottled` is trailing-only so every fire in the window becomes one pass against the final state; mode toggles and selection changes keep their direct, immediate path, and the throttle is cancelled on unmount like every other one. — *"coalesces displayed-set changes in one throttle window into one timelapse rebuild"*
- [ ] **A direct rebuild drops the queued trailing one.** `onTimelapseModeChanged` cancels `drawTimelapseThrottled` before its immediate pass: a track-filter change with a non-empty selection fires the primary watcher (queues a trailing pass) AND clears the selection (an immediate direct pass), so without the cancel the same ~100 ms pass ran twice per keystroke (Codex round 2 on PR #1341). — *"rebuilds exactly once when a filter change also clears a selection"*
- [ ] **The across-time id scan resolves slice indexes once per layer.** `store.layerSliceIndexes(layer)` computes a fresh result per call and is invariant per layer; calling it per annotation measured ~67 ms of a ~490 ms rebuild at 45K annotations. — *"resolves layer slice indexes once per layer, not per annotation"*
- [ ] **The orphan pass reuses the displayed-id set and resolves only unconnected ids.** Re-scanning every annotation a second time and resolving every displayed id measured ~86 ms per rebuild at 45K annotations; connected members are already resolved by the component loop. — *"resolves only unconnected ids for orphan dots, and still draws them"*
- [ ] **The timelapse rebuild is a DIFF, not a teardown.** Features are keyed (`tlKey`: `c|<pairId>` / `p|<annotationId>`) and carry their raw geometry (`tlGeom`); a pass claims matching features, updates only the options that changed (options() marks the layer modified, so an untouched feature costs nothing), and adds/removes only the churn — full reconstruction measured ~250 ms per scrub step at 51,665 connections against churn-proportional cost after. Consequence: any NEW option baked into a segment or dot must also be in the materializer's desired-options object, or kept features go stale on it. — *"keeps unchanged features across rebuilds instead of reconstructing them"*, *"restyles a kept feature in place when the current time flips its styling"*
- [ ] **Every throttled/debounced callback is cancelled in `onBeforeUnmount`.** A trailing fire after teardown runs against a dead GeoJS view. The guard records the wrappers at construction (a `lodash` mock delegating to the real implementation), because both hand-maintained alternatives failed: naming them left two uncancelled while green, and scanning the exposed surface just moved the list to `defineExpose`, where an unexposed throttle is invisible. — *"cancels every pending debounced/throttled callback so none fire after teardown"*
- [ ] **Scoping resolves connections, never scans all annotations.** `connectionInScope` is a per-connection predicate; building a set of qualifying annotation ids meant scanning `annotationsForIteration`, which materializes all 709K stubs in stub-only mode — on every scrub. — *"scopes by location without scanning every annotation"*
- [ ] **The Connect-selected cap checks the raw id count first.** Resolving the selection to apply a cap that exists to prevent that resolution is self-defeating; a server-mode select-all is hundreds of thousands of ids. Tie detection skips oversized selections too. — *"rejects an oversized selection without resolving it"*
- [ ] **Every scope-derived computed is gated, not just the rows.** `scopedConnections` resolves `scopeAnnotationIds`, which scans all annotations for the dynamic scopes — an ungated count is a full-dataset scan per scrub from a hidden tab. — *"does not read the scope getters while the tab is hidden"*
- [ ] **Counts don't allocate.** The tab badges use `annotationStore.annotationCount`, never `annotationsForIteration.length`, which materializes an array from the 700K-entry stub map. — *"badges both tabs with dataset-wide totals"*
- [ ] **EVERY O(N) read in the Timelapse panel is gated, not just the expensive-looking one.** `trackCount` was gated and `timelapseTaggedCount` — a filter over the whole connection array added right beneath it — was not, so it ran on load and on every connection create/delete anyway. `connectionCount` needs no gate because it reads `.length`. Check each read, not the component. — *"does not scan connections for tagged links while the mode is off"*
- [ ] **The Timelapse panel gates its reads on the mode, not on being rendered.** It lives in a `v-show` `FloatingPalette` too, so it is mounted from dataset load onward whether or not timelapse is ever switched on. `connectionListStore.trackCount` runs a union-find over every connection, so an ungated read pays it at load for every dataset with connections, and again on every connection create/delete — doubling what the draw path already does, during the one gesture that creates connections one at a time. Same rule as the rows and the scope getters above; this is the third component to need it. — *"does not read trackCount while timelapse mode is off"*
- [ ] **Global track identity is derived once per connection-set change.** `trackAnalysis` owns the dataset-wide union-find used by `trackCount`, list swatches, and viewer colors. Scope/filter/location changes and time scrubs must reuse the same cached object; immutable connection CRUD is the invalidation boundary that handles merges and splits. Do not add persistent track entities or run a second global traversal in each consumer. — *"is cached across scope changes and invalidated by connection changes"*

### Track colouring

- [ ] **Every colouring input is in the timelapse watch list.** Track colour is baked into each line feature at draw time and there is no restyle-in-place path for it (unlike hover), so a field of `@/store/timelapse` missing from that `watch([...])` in `AnnotationViewer.vue` changes nothing until an unrelated redraw. Silent: tsc, lint and every draw-path test stay green. — *"rebuilds the timelapse layer when %s changes"* (it.each over trackColoring/colorSeed)
- [ ] **The timelapse store mock stays `reactive()`.** `@/store/timelapse` is mocked in `AnnotationViewer.test.ts`, and the draw path is driven entirely by watchers on it — a plain-object mock lets every timelapse test assert against a layer that was never rebuilt. Confirmed load-bearing: dropping `reactive()` fails 6 tests, including both colouring-watch tests, while 295 others stay green. Same rule as the `@/store` and `@/store/annotation` mocks beside it.
- [ ] **Viewer and list colour from the dataset-wide key.** Their local components come from different subsets: the list is scope-filtered and the viewer is display-filtered. Both resolve any local member through `trackAnalysis.trackKeyByAnnotationId`; hashing the smallest member of either local subset makes the swatch change with scope and lets it disagree with the rendered line. Keep scoped `track.id` separate from `track.colorKey`. — *"keeps a displayed track fragment on its dataset-wide color"*, *"keeps scoped row identity separate from its global color key"*, *"colors a scoped track from its dataset-wide color key"*
- [ ] **Hue only; never luminance.** Saturation and lightness are fixed in `trackColor`. Deriving `#rrggbb` from hash digits put luminance under the hash and made roughly a third of tracks near-black or near-white against the image. — *"keeps every channel in a readable mid band for any id"*
- [ ] **Adjacent ObjectIds must not give adjacent hues**, and the hue STEP is what guarantees it — a measured value, not a named constant. Do **not** "improve" this by swapping in `hashString` from `@/utils/annotation`: its murmur finalizer exists to destroy the sequential correlation the step needs (9.2° with it, 3.0° with a plain `% 360`, 1.0° for the original bug). And do **not** reach for 1/φ on the theory that its multiples are best spread: that theory is about `frac(i·φ)` for consecutive integers, while the input here is a polynomial hash whose delta jumps at every hex carry. Under that structure 1/φ hits a resonance and measures **4.2°** on the real dataset's 248 consecutive keys, worse than every alternative tried. Two metrics must hold together — worst neighbour gap across many id batches AND all-pairs gap for a small nearby group — because optimising either alone picks a step that fails the other (√2−1 scores 44.4° / 19.4°). — *"keeps neighbouring ids far apart in every palette"*, *"holds that separation across id batches and sizes"*, *"separates ids that differ by a single trailing character"*
- [ ] **A colour re-roll re-permutes, it does not rotate.** The seed selects the hue STEP. Folding it into the hash accumulator instead adds a constant `31^n · seed` to every hash, which rotates the wheel: every colour changes, so it looks like it worked, but the sorted gap multiset is *identical* at every seed and the closest pair stayed pinned at 2.927° — the one thing the button exists for was the one thing it could not do. A test asserting "the per-id shift isn't constant" passes under rotation; assert the **gap multiset** and the **identity of the closest pair** instead. — *"re-permutes rather than rotating when the seed changes"*
- [ ] **Track-colour claims must be measured at the scale they degrade.** The original 77.3° figure came from a 40-id fixture starting at offset 0x0000, which never crosses the carry that triggers the bad case; the same step measures 4.2° on 248 consecutive keys. Fixtures for this property need several start offsets and sizes, not one. — *"holds that separation across id batches and sizes"*
- [ ] **Timelapse dots reflect OBJECT selection and hover, not just connections.** `restyleAnnotations` only ever touches `annotationLayer`, so the timelapse centroid dots need their own route: a `timelapsePointBaseStyle` on each point and a branch in `restyleTimelapseFeatures`, driven by a `watch([selectedAnnotationIds, hoveredAnnotationId])`. Without it, selecting a whole track's objects changed nothing on screen while its links lit up — a correct object selection read as "it selected the connections instead". Restyle in place, not a rebuild: a selection can be hundreds of objects, and unlike a connection duplicate's representative, a dot's identity is not a draw-time choice. — *"highlights a selected object's centroid dot in place"*, *"restores a dot's base styling when it is deselected"*, *"leaves unselected dots alone"*
- [ ] **Selecting a track excludes dangling endpoints.** `annotationIds` comes from connection endpoints, which outlive the annotation they point at — the list keeps dangling links visible on purpose. Phantom ids inflate every "(N)" counter and nothing can clear them, because no row or feature exists to click. — *"excludes endpoints that no longer resolve"*, *"counts nothing selectable when every endpoint is dangling"*
- [ ] **Expanding a track frames it; collapsing does not.** `toggleTrack` calls `goToTrack` only on the open. Framing on both would yank the camera back every time the user tidied the list, including after a deliberate pan. — *"expanding a track frames it, collapsing leaves the camera alone"* (verified live: camera moved 0.00 units on collapse)
- [ ] **Track framing uses the box support function, not one signed vector.** `frameCameraInfoToExtent`, not `frameCameraInfo`: a track is a 2D extent and projecting `(w, h)` alone fits only one of its two diagonals, so under rotation the other falls outside the viewport. It also zooms IN, which `frameCameraInfo` deliberately never does. Clamp to the live map's `zoomRange` — a track whose members share a centroid has a degenerate box that otherwise asks for infinite zoom, and GeoJS would clamp `map.zoom()` silently, leaving the store's zoom and `gcsBounds` describing a viewport that never existed. — *"accounts for BOTH box dimensions, not just one diagonal"*, *"recenters without zooming for a degenerate box"*, *"clamps to maxZoom and keeps gcsBounds consistent with it"*
- [ ] **Framing moves XY/Z to the anchor member's slice, and moves Time only when NO member is actually drawn.** A track on another XY/Z is not drawn at all, so those must follow — and the anchor's slice is what the bounding box and the time check use, since a track can span slices (`Connect selected` chains by time with no slice constraint). For Time, the test must be the one the draw path makes: `drawTimelapseConnectionsAndCentroids` filters members to `[time − modeWindow, time + modeWindow]`, so the half-width is `modeWindow` in timelapse mode and 0 outside it, and Time moves to the nearest member only when nothing falls inside. Checking the track's overall RANGE instead failed three ways: with the mode off it left Time on T3 for a T1/T5 track where one frame is drawn and neither member is; for a sparse T1→T100 track viewed at T50 with the default window of 10 it left Time alone although every member was filtered out, framing an empty view; and it moved Time gratuitously when members were already on screen (T0, members T1/T5, window 10). One rule replaces both former branches. — *"navigates XY/Z to the track, since it is not drawn elsewhere"*, *"frames only the anchor slice for a cross-slice track"*, *"frames only the anchor slice in timelapse mode as well"*, *"leaves Time alone when a member is inside the drawn window"*, *"snaps Time to the nearest member outside timelapse mode"*, *"snaps Time when every member is outside the drawn window"*, *"leaves Time alone when a wide window reaches a member"*, *"snaps Time to the nearest end when the window reaches no member"*, *"does not move Time outside the mode when already on a member"*
- [ ] **The selection action panels clear the Timelapse palette.** Both slide to `--nimbus-left-palette-clear-x` (446) when a left palette is open, which is exactly where the Timelapse palette sits (444–744) — they were drawn underneath it. `timelapse-palette-open` on `<v-app>` re-anchors them to the right edge. Verified live: overlap true before, false after.
- [ ] **The right-edge placement has to clear the LEFT footprint too, and cannot on a narrow viewport.** Moving the panels right to escape the Timelapse palette works only while there is room: at 1280px with the Object Browser open — exactly what "Show tracks" produces — a panel anchored 544px from the right spans x 561–736, inside the palette's 444–744, which wins on z-index. Below roughly 1500px (so 1280 AND 1440, both common) no horizontal placement clears both, and the panels drop BELOW the palette using its measured height, with the stacked connection panel following. Verified live at 1280: `--nimbus-action-panel-top` 366px (palette bottom 358 + gap), both panels 0 blocked; and at 1684 it returns to 72px on resize. — *"reports no clearance at 1280px with the Object Browser open"*, *"reports no clearance at 1440px…"*, *"measures against the palette's right edge"*
- [ ] **The right-edge offset resolves over EVERY overlay that FLOATS, and none that shifts layout.** `rightEdgeClearX` takes a list, and `src/components/__tests__/rightEdgeOverlays.test.ts` scans App.vue to check that every `<floating-palette>` without `:left` appears in it — the unit tests for the helper all pass against a caller that forgets four of them, which is why the guard has to read the source. The **Analyze drawer stays out**: a `v-navigation-drawer location="right"` shifts the layout, and the action panels are `position: absolute` inside `.image`, which the drawer narrows — so a clearance for it double-counts and moves them LEFT, back under the Timelapse palette (measured: container 0–1204, panel 533–708 = 1204 − 496 − 175, palette 444–744). — *"passes every right-anchored palette to rightEdgeClearX"*, *"does not give the layout-shifting Analyze drawer a clearance"*
- [ ] **The right-edge offset resolves over EVERY right-edge overlay, not one.** The first version keyed off an `object-browser-open` class alone, which moved the panels from under the Timelapse palette to under the *AI panel* — `.ai-panel` is `z-index: 2001` against their 1000, and it is mutually exclusive with neither timelapse mode nor the Object Browser. Measured live at 1684×857: **6 of the two panels' 8 buttons failed `elementFromPoint`**, including `Deselect All`, the only non-destructive way to dismiss them. `rightEdgeClearX()` in `@/utils/paletteGeometry` takes the max over the open overlays and App.vue projects it as `--nimbus-right-edge-clear-x`, so a new overlay is one term rather than a new class and 2ⁿ rules. Max, not sum — they share the edge rather than queueing along it. — *"clears the AI panel, which uses its own larger inset"*, *"takes the largest clearance when several are open, never their sum"*
- [ ] **Palette geometry has exactly one source.** Widths and the clearances derived from them live in `@/utils/paletteGeometry`; App.vue binds the `:width`/`:left` props from it and projects the clearances onto `<v-app>` as custom properties. `style.scss` declares neither. Both former copies had already gone wrong: a stale transcription of the Layers width (420, not the Navigator's 380) drew the Timelapse palette 32px over Layers, and 444 landing 2px from 446 is what put the panels under it. — *"takes the widest left palette, not the first one"*, *"derives both clearances from the widest palette, not just each other"*
- [ ] **The track swatch is gated on the MODE, not only the colouring option.** `trackColor` is reached only from the timelapse draw path, so with the mode off the swatch names a colour nothing on the canvas uses — measured, 248 swatches in 248 hues against zero drawn connection features, because a timelapse link's endpoints sit on different timepoints and normal mode never co-displays them. Gating on the option alone also made them unturnoffable, since that toggle lives in the Timelapse palette, which *is* the mode. — *"hides the track swatches while timelapse mode is off"*
- [ ] **Object and link selection stay separate.** They feed different actions (`Connect selected` reads the object selection, `Delete selected` the connection one), so a per-track Select action must touch only the one it names. — *"Objects selects the track's objects and no connections"*, *"Links selects the track's connections and no objects"*, *"Both selects each side exactly once"*
- [ ] **Tour anchors travel with the controls they annotate.** `timelapse-tags` and `timelapse-labels` moved from `NavigatorPanel.vue` to `TimelapsePanel.vue`; `testTimelapseTour.yaml` targets them by `data-tour` and breaks at step 2 if either is dropped or is not hit-testable once the mode is on. No unit test covers this — verify in the browser, with the panel open.

- [ ] **A guard must count what its action operates on — on every axis.** Two separate misses on one button: it was disabled on the total connection count while the action deletes only `TIMELAPSE_CONNECTION_TAG` ones, AND it ignored login while `deleteAllTimelapseConnections` returns immediately for a signed-out user, so on a public dataset the click silently did nothing. Not a security check (the backend owns that) — just not offering an action that provably no-ops, which the Connection List's delete controls already did. — *"disables delete-all for a signed-out viewer with tagged connections"*
- [ ] **"Delete all timelapse connections" is guarded on the tagged count, not the total.** The readout beside it counts every connection on purpose (the timelapse view draws any connection whose endpoints are both displayed, tag or no tag), but the action deletes only `TIMELAPSE_CONNECTION_TAG` ones. Guarding on the total left the button enabled on a dataset whose connections are all hand-made or from Connect-to-nearest, where the click deleted nothing and reported nothing. — *"enables delete-all only when tagged connections exist"*

- [ ] **A time jump keeps its track's colour.** It was forced to `#ff6b6b`, which broke both colouring controls: "uniform" left those segments red among white ones, and per-track showed a hue swatch against a red line for any track whose drawn segments are all jumps. The dash (`[5, 5]`) and the reduced opacity (0.7) are two cues no other segment has, so the colour was the redundant third one — dropping it makes "the swatch matches the line" true unconditionally. — *"keeps a time-jump segment on the %s track colour"* (it.each over uniform/track)

### Track labels from a property

- [ ] **A value of 0 is a value.** The parent_child worker's track ids start at 0, so any falsy check in the resolution or the fetch-cache read (`??` vs `||`) silently relabels track 0 as "missing". — *"does not confuse a value of 0 with a missing value"*
- [ ] **Partial coverage keeps the value AND badges it.** A member without a value means the graph changed since the property ran; folding that case into "mixed" loses the findable id, and hiding it loses the staleness signal. — *"keeps the shared value but flags partial coverage"*, *"keeps the shared value but badges a partially-covered track"*
- [ ] **Lazy mode fetches member values itself, in ONE batched request.** The store's value cache is pruned to the viewport on every pan, so track members are structurally absent from it; and a confirmed miss (id absent from the response) must be cached as `null` or every tracks-change refetches it. Each request captures its cache key and merges only while that key is still current, so a response for a superseded path/revision can never land under the new key. — *"fetches member values in lazy mode with one batched request"*
- [ ] **Re-entries coalesce while a fetch is in flight, and same-key responses always merge.** The tracks rebuild on every pan, re-entering the fetcher; without a pending-id set each re-entry resends every still-missing id, and a latest-only guard discards the earlier valid response — identical queries pile up and labels never settle until interaction stops. Values are immutable per path/revision, so any current-key response may merge (coverage only grows). A failed request releases its pending ids so the next run or Retry can resend them. — *"coalesces fetches while one is in flight and merges its response"*
- [ ] **The failure warning keys off uncovered displayed members, not off any request's fate — converging on EVERY settle.** An obsolete request can fail after a newer one covered everything (flag must not set), Retry can find nothing missing (early return must clear a moot flag), and the covering request can succeed after the failure landed (the successful merge must recompute the flag). Miss any of the three and a "Couldn't load" warning strands over fully resolved tracks. The inactive/wholesale early return clears the flag too: the component outlives dataset switches, and a failure recorded in a lazy dataset must not show over a wholesale one where the fetcher (and Retry) is out of play. — *"clears a stale failure once every displayed member is covered"*, *"clears the failure when the covering request succeeds after it"*, *"clears a lazy-mode failure when wholesale mode takes over"*
- [ ] **A settling request releases pending ids from ITS OWN captured set.** After a key change the current pending set belongs to the new key's request, which may have re-added the same member ids; deleting from it strands them as neither cached nor pending and the next pan resends an identical batch. — *"a key change mid-flight does not strand the new request's pending ids"*
- [ ] **The lazy fetch waits for the dataset's property refresh.** During a load, `stubOnlyMode` flips before `fetchPropertyValues` bumps the revision; a batch launched in that gap is superseded and re-sent — one duplicated large query per dataset open. Gate on `propertyStore.propertyValuesDatasetId` matching the open dataset (set in the same tick as the bump, which is a watch source), and cleared by `resetPropertyState` — `refreshDataset()` resets state while the dataset id stays the same, which would otherwise reopen the window. — *"waits for the dataset's property refresh before fetching"*, *"records the dataset id alongside the revision bump"*, *"clears the readiness id on a property-state reset"* (properties store)
- [ ] **Label resolution stays linear for all-distinct tracks.** The picker offers per-annotation paths (annotationId), where every member of a large track is unique, and resolution reruns on every scoped-tracks rebuild (each pan); a `distinct.includes` scan is quadratic and freezes the tab. The test's implicit timeout is the cost guard (quadratic: minutes at 100K members; linear: milliseconds). — *"resolves a large all-distinct track in linear time"*
- [ ] **The fetcher reacts to `stubOnlyMode` itself.** The mode is settled by the annotation fetch and the tracks by the connection fetch, in parallel; if the mode flips to lazy after the last tracks/path change, only the labels computed would notice — every track would read "no ID" with no fetch ever issued. — *"fetches when lazy mode is determined after the tracks arrive"*
- [ ] **A failed fetch is not "confirmed missing".** Uncovered members leave their track unresolved (short-id title, no badge) — never a false `no ID` — and an error flag with a Retry button surfaces, because nothing else necessarily re-fires the watcher after a failure. — *"does not confuse a failed fetch with confirmed missing values"*, *"retries after a failed fetch"*
- [ ] **A split's two halves badge `duplicate ID` — and scoped fragments of one track never do.** Each split half unanimously keeps the old id, so per-track resolution marks both clean; only comparing resolved labels across displayed tracks sees it. But displayed rows are scoped components, and a narrow scope shows one intact dataset-wide track as two fragments sharing a value — detection must key on `colorKey` (the dataset-wide identity), and distinct values must never badge. — *"badges tracks sharing one value after a split"*, *"does not badge scoped fragments of one dataset-wide track"*, *"does not badge distinct values as duplicates"*
- [ ] **A long string label cannot displace the row's actions — and a short one never ellipsizes.** `.track-title` caps at 200px with ellipsis via `flex-shrink: 0`, NOT `min-width: 0`: the cap must bind only the title's own content. `min-width: 0` puts the title in the flex shrink pool, so a badge tightening the row squeezed "Track 0" to "Tra…" while `.track-meta` (the designated shrinker) still had width to give — caught live on the first attempt at this fix. CSS is not unit-testable — re-verify live, both with a long string value and with a badged short one, when touching the header layout.
- [ ] **Wholesale mode never fetches.** `propertyValues` already holds every computed value; a fetch there is a duplicate request per tracks change. — *"never fetches in wholesale mode"*
- [ ] **The persisted path stays pickable after its values disappear**, so it can be seen and cleared instead of rendering as a raw path key. — *"keeps a persisted path listed after its values disappear"*
- [ ] **User picks schedule a configuration save; hydration never does.** Same contract as displayedPropertyPaths — a violation makes every dataset open dirty the shared configuration. — *"schedules a configuration save when the user picks a property"*, *"does not schedule a save when hydrating from a configuration"*
- [ ] **The path resets on dataset switch and re-hydrates from the configuration** (it names a property id from the outgoing configuration), and resolve drops a path whose property left the configuration. — *"clears the path on a dataset switch"*, *"drops a path whose property left the configuration"*, *"survives a build/resolve round trip"*
- [ ] **A live property deletion clears the path immediately and persists the drop.** The persisted resolver only runs at hydration; without the live twin (`reconcileTrackLabelPathForPropertyIds`, wired in `properties.setProperties` like the analysis-plot reconcile) the panel keeps labelling from the deleted property until reload and a later browser save persists the orphan. — *"clears the path and persists when its property is deleted"*, *"keeps the path and stays silent while its property exists"*

### Track metric filters

- [ ] **Metrics are dataset-wide, never fragment-local.** The predicate resolves a connection's track through `trackKeyByAnnotationId` (the global analysis), so a scope-narrowed fragment is judged by its full track. — *"uses dataset-wide metrics even when the scope shows a fragment"*, *"keys each track by its dataset-wide track key"*
- [ ] **The inactive predicate is a free constant.** The viewer reads it on every draw pass and `scopedConnections` on every list read; with no bound set it must be the stable `PASSES_EVERY_CONNECTION` and never touch `trackMetrics`, which resolves every connected annotation. — *"does not resolve annotations while no filter is active"*, *"returns the scope's own array identity while no filter is active"*
- [ ] **List and viewer read ONE predicate, and draw/retention stay a pair under it.** `drawNewConnections` skips failing connections and `clearOldAnnotations`' connection branch removes them by the same test — a filter added to only one path either leaves stale lines or churns them every pass. — *"skips a connection whose track fails the track filters"*, *"removes a drawn line once its track fails the track filters"*
- [ ] **A filter change alone redraws both draw paths — via the PRIMARY watcher only, exactly once — and tests assert layer CONTENT, not a draw spy.** `connectionPassesTrackFilters` sits in the primary watch list alone: `drawAnnotationsAndTooltips` already rebuilds the timelapse layer directly, so a second entry in the timelapse watch list reconstructed every track feature twice per filter keystroke — three times with the selection-clearing watcher, which is why `setTrackFilters` and `setScope` replace the selection Set only when it is non-empty (the Set's identity is a viewer watcher source). A draw-called spy still passes vacuously when a selection exists, so assert content. — *"redraws normal-mode connections when the track filters change"*, *"rebuilds the timelapse layer when the track filters change"*, *"rebuilds the timelapse layer exactly once per filter change"*, *"keeps the empty selection's identity when filters change"*
- [ ] **A hidden track's members do not become orphan dots.** The timelapse path skips a filtered-out component but still counts its members as connected — they vanish from the overlay entirely, since the graph didn't change, only the view. — *"hides a filtered-out track without recasting its members as orphans"*
- [ ] **Unknown duration is excluded, because a remedy exists.** Duration comes from the members that resolve (dangling endpoints must not poison it); a track where NONE resolve is pure data rot with `null` duration and is hidden under an active duration bound. This flipped twice: first to fail-open ("hiding real rows is worse"), then back once "Clean up dangling" gave the rot an actual fix — do not flip it again without moving that remedy. Count bounds are always known and apply either way. — *"derives duration from the members that still resolve"*, *"reports null duration when no member resolves"*, *"hides a track of unknown duration under an active duration bound"*, *"resolves durations from stubs, not only hydrated annotations"*
- [ ] **The narrowed count carries its cue, and the empty state names the filter.** "N of M" beside the number while filters narrow; "No connections match the track filters" instead of the scope's message when they hide every row (but the scope's own message when the scope itself is empty). — *"says how many connections the track filters are hiding"*, *"uses a filtered empty message when the filters hide every row"*, *"keeps the scope's empty message when the scope itself is empty"*
- [ ] **Bulk delete respects the filters by construction.** `scopedConnections` applies the predicate, so `selectedInScopeConnectionIds` cannot include a filtered-out row; a bound change also clears the selection and resets the page, matching `setScope`. — *"bulk delete acts only on rows passing the filters"*, *"clears the selection and resets the page when filters change"*
- [ ] **`scopeOnlyConnections` is gated like every other scope getter.** It filters the whole connection array per read for the dynamic scopes, and the "of M" readout is the only consumer — a hidden tab must never touch it. — *"does not read scopeOnlyConnections while the tab is hidden"*
- [ ] **Filters reset only on an ACTUAL dataset switch.** Numeric ranges are dataset-scale-specific, but the unconditional connection-list reset runs on every `setSelectedDataset` — including `refreshDataset()` with the same id (unroll toggles) — and the bounds are unrecoverable user state, so their reset (`resetConnectionTrackFilters`) is gated on `datasetChanged`, exactly like `resetFilterState`. — *"keeps the track filters through a same-dataset refresh"*, *"resets the filters on a dataset switch"*, *"resets the opt-in on a dataset switch"*
- [ ] **Metric and dangling scans are hydration-churn stable — with NO hydrated fallback.** They resolve STUB-ONLY (`resolveStub`): the stub map is authoritative in both modes and replaced only by load/CRUD, while `hydratedAnnotations` is replaced on every pan. A "fail-safe" hydrated fallback is self-defeating here: a genuinely dangling endpoint always misses the stub map, so the fallback fires on every rot-bearing dataset and re-registers exactly the churn dep the resolver removes — and a churn test whose fixture has no rot passes against it, which is why the fixture MUST contain a dangling endpoint. The location scope uses the same resolver; row labels keep hydrated-first `resolveAnnotation` (they need `name`). — *"resolves metrics and dangling from stubs, not the hydration cache"*, *"keeps the metric scan cached when the hydration resolver churns"*
- [ ] **Object hiding is opt-in, and the checkbox alone narrows nothing.** The default must stay "filter the list, not the canvas"; the opt-in only bites while a bound is live (`trackFilterHidesObjects` is the conjunction). — *"hides an object of a failing track only when opted in"*, *"hides nothing when the opt-in is set but no filter is active"*, *"hides a filtered-out track's objects only when opted in"*, *"resets the opt-in on a dataset switch"*
- [ ] **Unconnected objects are never hidden.** They have no track, so a track filter says nothing about them — without this rule, any min-bound would blank every untracked object in the dataset. — *"never hides unconnected objects"*
- [ ] **The object predicate is a stable constant while the opt-in is off**, same contract as the connection predicate: `displayableAnnotations` reads it on every rebuild, and hiding is filtered at THAT single source so every display surface (per-channel maps, layer maps, displayed ids, timelapse sets, connection gating and retention) stays symmetric by construction. — *"is a stable pass-all constant while the opt-in is off"*, *"removes drawn objects when the opt-in is switched on live"*
- [ ] **The visibility refresh is the drawn set's twin.** `updateVisibility`'s `filteredIds` drives the stub-mode budget, hydration, and the HUD's viewport counts; the opt-in must narrow it exactly as it narrows `displayableAnnotations` (and toggling the opt-in must itself trigger a refresh), or budget slots are spent on objects the draw path then discards and the HUD counts hidden objects. Found by this feature's own branch review — the third instance of the draw↔twin shape on one branch. — *"excludes hidden-track objects from the visibility refresh"*
- [ ] **Hidden objects register as an active constraint.** Every count the HUD shows shrinks while the opt-in narrows, and this repo's rule is that a narrowed count carries its cue — the constraint is counted in the one shared list (never on the Filters badge, whose panel can't show it), and its HUD click opens the Object Browser ON THE CONNECTIONS TAB when no Analysis gate is active — a palette-only open lands on whatever tab the browser last showed, which does not expose the constraint's controls. — *"counts the connections tab's object hiding as a constraint"*, *"names it in the HUD summary"*, *"does not count it while the opt-in is not narrowing"*, *"opens the Object Browser for the track filter alone"*, *"keeps the Filters companion alongside the Connections tab"*
- [ ] **The HUD's passing count composes the lens.** `displayedPassingCount` (filters ∩ object lens), never `filteredAnnotations.length` — with only the track constraint active the raw length claims every annotation "passes filters" while whole tracks are hidden. A plain length read while the lens is off. — *"counts hidden-track objects out while the lens narrows"*, *"is the plain filtered count while the lens is off"*, *"prints the lens-aware passing count"*
- [ ] **The HUD click requests at most one right-zone primary.** Analysis and the Object Browser evict each other (`App.vue` paletteRoles), so requesting both opens the first and immediately evicts it — the click's outcome would contradict its own tooltip. Analysis wins; the tooltip derives from the request list, so it stays honest by construction. — *"requests only one right-zone primary when analysis and track constraints coexist"*
- [ ] **Dangling means deleted, and stubs are alive.** A connection is dangling when EITHER endpoint misses the stub map — the map every create/update/delete path maintains; treating an unhydrated annotation as dead would let lazy mode mass-delete live tracks. — *"identifies a connection as dangling when EITHER endpoint is gone"*, *"counts a stub-backed endpoint as resolvable"*
- [ ] **Cleanup is whole-dataset, batched, confirmed, and offered only when needed.** One request, never a loop; the button appears only when something dangles; the dialog is the only path to the delete and closes even on failure (a stuck saving dialog was the connect-selected bug one feature over). — *"deletes every dangling connection in one batched request"*, *"does not call the backend when nothing dangles"*, *"offers the cleanup only when something dangles"*, *"deletes dangling connections only through the confirm"*, *"closes the dialog even when the delete rejects"*
- [ ] **`danglingConnectionIds` is gated like every other scope-derived getter.** It resolves both endpoints of every connection, invalidated by connection or stub-map changes (deliberately not hydration churn — see the stub-only row above); the scan is still O(connections) per recompute, so a hidden tab must never read it. — *"does not read danglingConnectionIds while the tab is hidden"*
- [ ] **Bound parsing keeps min/max independent.** An emptied field becomes an unbounded side without touching its partner, and each change dispatches a *replaced* filters object (watchers fire by identity). — *"parses a bound and dispatches a rebuilt filters object"*, *"turns an emptied field into an unbounded side"*, *"clears every bound at once"*

### Destructive actions

- [ ] **Bulk delete acts only on rows in scope.** Scope *inputs* change without `setScope` firing. — *"stale selection when scope INPUTS change"* (3 tests)
- [ ] **Selection ignores connections that no longer exist.** Other code deletes without going through this module. — *"ignores selected ids whose connection no longer exists"*
- [ ] **Connect selected is capped** and refuses above it. — *"refuses a selection larger than the cap"*
- [ ] **Only one keydown handler, and only bare Delete/Backspace.** `mod+backspace` already deletes objects. — *"ignores the modified object-delete shortcut"*, *"does not mount the connection action panel per viewer"*
- [ ] **An empty result is not reported as dedupe.** The API layer turns failures into `[]`. — *"flags dedupe only when the chain was empty…"*
- [ ] **Saving state clears on failure.** — *"clears the saving state when the create request rejects"*
- [ ] **Per-dataset state resets**, including the dedupe flag. — *"clears the dedupe flag on a dataset switch"*

### Symmetric pairs — change one, check the other

Four separate review rounds flagged the same shape: a rule applied to one path
and not its twin. Before considering any change here done, check the pair.

| Path | Twin |
|---|---|
| `drawNewConnections` gating | `clearOldAnnotations`' connection branch |
| styling at construction | the retained-feature restyle loop in `drawNewAnnotations` |
| `setHoveredAnnotationFromCoordinates` (highlight) | `selectAnnotations` (select) |
| `selectedConnectionIds` pruning | `hoveredConnectionId` pruning |
| timelapse **selection** (runs the diff rebuild pass) | timelapse **hover** (restyles in place) |
| normal-mode restyle (`restyleAnnotations`) | timelapse restyle (`restyleTimelapseConnections`) |
| creating a throttled/debounced callback | cancelling it in `onBeforeUnmount` |
| flat rendering | track/grouped rendering |
| normal-mode connection styling | the inline style in `drawTimelapseTrack` |
| a track's colour in the viewer | its swatch in the Connections tab |
| a new timelapse draw input | its entry in the timelapse `watch` list |
| the Navigator's mode checkbox | the Timelapse palette's close button |
| an overlay that holds a viewport edge | every surface that must clear that edge |
| the count a guard is disabled on | the set the action actually operates on |
| a behaviour gated on timelapse mode | the same view reached with the mode off |
| an overlay that floats over the canvas | one that shifts the layout instead |
| the list's scoped rows | the viewer's drawn connections (one shared track-filter predicate) |
| a control that narrows a count | the "of M" cue beside that count |
| a new option baked into a timelapse feature | its entry in the diff materializer's desired-options object |

- [ ] **This checklist is machine-checked, so keep it checkable.** `src/__tests__/regressionChecklist.test.ts` asserts that every test name cited below resolves in `src/` and that no two invariants share a heading. Both failure modes have already happened: a round renamed two tests and left the citations dangling, and a superseded row was added ABOVE its replacement instead of replacing it, leaving two contradictory rules for one behaviour that no change could satisfy at once. **Replace a row when you supersede it; never stack the new rule on top of the old one.** Abbreviate a long test name with a trailing `…` and cite `%s` templates verbatim — the guard understands both.

### Before claiming done

- [ ] `pnpm tsc`, `pnpm lint:ci`, `pnpm test`, and `python3 plugins/nimbusimage/scripts/sync_skills.py --check` if any skill changed.
- [ ] Each new fix has a test **confirmed to fail without it** — use `git stash`, never a `cp` round-trip (an interrupt between revert and restore silently drops the fix).
- [ ] Verified from a **fresh page load** on a dataset that actually has the property under test (stub-only for hydration, >1 timepoint for timelapse, duplicates for representative selection).

---

## Testing

**Unit — `src/utils/__tests__/connections.test.ts`** (24 tests)

`findConnectedComponents` (chains, disjoint sets, branching, cycles, self-loops),
`buildConnectionRows` (name vs. short-id label, stub endpoints, missing endpoints),
`buildTrackRows` (grouping, time range, ordering, stable ids), `chainAnnotationsByTime`
(ordering, `parentId` = earlier, tie → selection order, skip pairs already connected in
either direction), `findTimeTies`.

**Store — `src/store/__tests__/connectionList.test.ts`** (14 tests)

Exercises the real module against mocked neighbours. **The mocks must be `reactive()`**:
these are Vuex getters, so against plain objects they compute once against empty state
and never recompute — every assertion then passes or fails for the wrong reason. Covers
the scope predicates, the two selection-safety rules above, batched delete, and the
Connect-selected cap.

**Component — `ConnectionList.test.ts`** (14 tests), **`ConnectionListRow.test.ts`** (10)

`vi.mock` factories are hoisted above every `const`, so the shared store mock is built
inside `vi.hoisted` and each test mounts fresh rather than driving a reactive mock.
Between them: per-scope empty messages, navigation (including the dangling-endpoint
fallback), batched delete, select-all incl. the out-of-scope case, the tie caption, all
three `connectSelected` outcomes, endpoint labelling, `⚠ missing` rendering, and that
deleting or clicking a tag does not also fire row navigation.

**Regression — `AnnotationViewer.test.ts`**

The six pre-existing `findConnectedComponents` tests call the viewer's exposed binding,
which now delegates to the shared util — they are the regression guard for the move. A
new test asserts each timelapse track segment is tagged with its `girderId`; it was
confirmed to fail when the tagging is removed.

**Browser verification performed** (`tsc`/lint/vitest green does not mean the UI works):

| Check | Result |
|---|---|
| 54-connection dataset: rows, labels, 1-based locations, direction | correct |
| 4,983-connection dataset: `connectionRows` / `trackRows` build time | 6.7 ms / 6.1 ms |
| Click a connection line (normal mode) | selects that link, 0 annotations |
| Click a track segment (timelapse mode) | selects that link, highlights cyan |
| Annotations win (click an endpoint object) | 2 objects, 0 connections |
| Lasso over a connection | 48 objects, 0 connections |
| Click empty space | connection selection cleared |
| Deselect restores line style | back to `#0000ff` / 3 |
| Connect selected → delete (round trip) | 54 → 55 → 54, confirmed in MongoDB |
| Panel stacking with objects + connection selected | no overlap |
| Scope change with 500 connections selected | selection cleared to 0 |
| Connect selected with all 3,796 objects selected | refused, 0 created |

**Lazy-loading (stub-only) verification — Xenium, 708,983 objects, 11 connections:**

| Check | Result |
|---|---|
| Fresh load, only 4/12 endpoints hydrated | 11/11 lines drawn, no NaN coordinates |
| Zoom sweep 0 → 6 → 0 (budget 18,040 ↔ 5,000) | 11/11 lines at every step, no drift |
| List rows built entirely from stubs | 11 rows, 0 `⚠ missing`, 1 track of 12 |
| Click tolerance across zoom | 0 missed clicks at any zoom |

**Caveat for dense datasets.** Clicking a connection line is less reliable here, not
because of tolerance but because of the deliberate *annotations win* rule: at Xenium
density a line's midpoint frequently sits on top of an unrelated object, so the click
selects that object instead. Measured at the midpoint of all 11 lines: 10/11 resolved to
the connection zoomed out, 7/11 at zoom 4, and **nothing was ever missed entirely** —
every failed click hit an object. On dense data the Connections tab, not the canvas, is
the dependable way to select a link.

---

## Out of scope

- **Connection property computation.** The issue notes this as a "further along" idea.
  It needs backend work (a property type keyed on connections rather than annotations)
  and is deliberately not part of this change.
- **Tag/label editing on connections.** `AnnotationsAPI.updateConnection`
  (`AnnotationsAPI.ts:268`) already exists and is currently unused, so this is cheap to
  add later if a use case appears.
- **Re-parenting a connection from the list.** Equivalent to delete + create; the
  annotation-picker UI it would need is not justified yet.
- **Server-side pagination for connections.** Not needed — the data model is compact
  and the client already holds every connection.
