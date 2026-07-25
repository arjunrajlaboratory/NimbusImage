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
| **Click a row** | Recenters the viewer on the child endpoint, selects both endpoint annotations in the Objects tab, and marks the connection selected (highlighted in the viewer) |
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

- **Changing the scope clears the connection selection.** The scope changes what "the
  list" *is*, so a selection made under the old scope must not survive into
  "Delete selected" — otherwise selecting all 4,983 connections, narrowing to a
  3-row scope, and pressing delete removes 4,983 connections the user cannot see.
  Changing the flat/track grouping deliberately does **not** clear it: grouping
  re-arranges the same set rather than redefining it.
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

All of this hangs off the existing `selectAnnotations` entry point, so connections are
selected by the **same gesture as objects**: shift+click on the canvas, or a click with
the select tool active. No new interaction to learn.

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

### 3. Styling

`restyleAnnotations` (`:1774`) grows a connection branch: selected → cyan
(`CONNECTION_SELECTED_COLOR`) at width 6, hovered → width 5, otherwise
`CONNECTION_BASE_STYLE`. The timelapse layer rebuilds its lines on every draw, so it
reads `selectedConnectionIds` at build time instead of being restyled in place.

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
on row click; the viewer writes it on line click; both read it for styling. A viewer
click also scrolls the corresponding row into view in the Connections tab.

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
