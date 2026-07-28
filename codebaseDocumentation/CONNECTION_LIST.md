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

Run `pnpm test src/utils/__tests__/connections.test.ts src/utils/__tests__/camera.test.ts src/utils/__tests__/annotationNavigation.test.ts src/store/__tests__/connectionList.test.ts src/components/AnnotationBrowser src/components/ConnectionActionPanel.test.ts src/components/AnnotationViewer.test.ts src/components/TimelapsePanel.test.ts`.

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
- [ ] **Hover never rebuilds the timelapse layer — but it must still repaint it.** One feature per connection (5,217 measured here) and hover changes continuously as the pointer runs down the list, so selection rebuilds and hover restyles the drawn segments in place. Skipping the repaint entirely was the first attempt, and it silently broke the feature's main gesture: a row click *highlights* rather than selects, so clicking a connection did nothing visible in timelapse mode while it worked everywhere else. Measured on 2,364 segments: 0.8 ms to scan, 6.6 ms median to redraw, throttled to 100 ms. — *"does not rebuild the timelapse layer on hover"*, *"widens a hovered track segment in place, without rebuilding"*, *"does not redraw when the hovered connection is not on the layer"*
- [ ] **Every throttled/debounced callback is cancelled in `onBeforeUnmount`.** A trailing fire after teardown runs against a dead GeoJS view. The guard records the wrappers at construction (a `lodash` mock delegating to the real implementation), because both hand-maintained alternatives failed: naming them left two uncancelled while green, and scanning the exposed surface just moved the list to `defineExpose`, where an unexposed throttle is invisible. — *"cancels every pending debounced/throttled callback so none fire after teardown"*
- [ ] **Scoping resolves connections, never scans all annotations.** `connectionInScope` is a per-connection predicate; building a set of qualifying annotation ids meant scanning `annotationsForIteration`, which materializes all 709K stubs in stub-only mode — on every scrub. — *"scopes by location without scanning every annotation"*
- [ ] **The Connect-selected cap checks the raw id count first.** Resolving the selection to apply a cap that exists to prevent that resolution is self-defeating; a server-mode select-all is hundreds of thousands of ids. Tie detection skips oversized selections too. — *"rejects an oversized selection without resolving it"*
- [ ] **Every scope-derived computed is gated, not just the rows.** `scopedConnections` resolves `scopeAnnotationIds`, which scans all annotations for the dynamic scopes — an ungated count is a full-dataset scan per scrub from a hidden tab. — *"does not read the scope getters while the tab is hidden"*
- [ ] **Counts don't allocate.** The tab badges use `annotationStore.annotationCount`, never `annotationsForIteration.length`, which materializes an array from the 700K-entry stub map. — *"badges both tabs with dataset-wide totals"*
- [ ] **The Timelapse panel gates its reads on the mode, not on being rendered.** It lives in a `v-show` `FloatingPalette` too, so it is mounted from dataset load onward whether or not timelapse is ever switched on. `connectionListStore.trackCount` runs a union-find over every connection, so an ungated read pays it at load for every dataset with connections, and again on every connection create/delete — doubling what the draw path already does, during the one gesture that creates connections one at a time. Same rule as the rows and the scope getters above; this is the third component to need it. — *"does not read trackCount while timelapse mode is off"*

### Track colouring

- [ ] **Every colouring input is in the timelapse watch list.** Track colour is baked into each line feature at draw time and there is no restyle-in-place path for it (unlike hover), so a control missing from `watch([showTimelapseMode, timelapseModeWindow, timelapseTags, showTimelapseLabels, timelapseTrackColoring, timelapseColorSeed])` changes nothing until an unrelated redraw. Silent: tsc, lint and every draw-path test stay green. — *"rebuilds the timelapse layer when timelapseTrackColoring changes"*, *"…when timelapseColorSeed changes"*
- [ ] **Viewer and list colour from the same key.** Both must go through `trackKey` (smallest member id), never `Array.from(component.annotations)[0]` — the two build their components from different connection sets and iterate members in different orders, so insertion order gives one track two colours. Note the test fixture needs insertion order to *differ* from sort order or it passes either way. — *"colours a track by trackKey, matching the connection list swatch"*, *"keys the track id the same way trackKey does"*
- [ ] **Hue only; never luminance.** Saturation and lightness are fixed in `trackColor`. Deriving `#rrggbb` from hash digits put luminance under the hash and made roughly a third of tracks near-black or near-white against the image. — *"keeps every channel in a readable mid band for any id"*
- [ ] **Adjacent ObjectIds must not give adjacent hues,** and the golden-angle step is what guarantees it. Do **not** "improve" this by swapping in `hashString` from `@/utils/annotation`: its murmur finalizer exists to destroy the sequential correlation the golden angle needs. Measured over 40 consecutive ObjectIds, smallest neighbouring-id hue gap — current 77.3°, `hashString` + golden 9.2°, `hashString % 360` 3.0°, the original `% 360` bug 1.0°. — *"separates ids that differ by a single trailing character"*
- [ ] **A colour re-roll re-permutes, it does not rotate.** The seed is folded into the hash accumulator; adding it to the hue rotates every track equally and leaves any confusable pair just as confusable. — *"re-permutes rather than rotating when the seed changes"*
- [ ] **Tour anchors travel with the controls they annotate.** `timelapse-tags` and `timelapse-labels` moved from `NavigatorPanel.vue` to `TimelapsePanel.vue`; `testTimelapseTour.yaml` targets them by `data-tour` and breaks at step 2 if either is dropped or is not hit-testable once the mode is on. No unit test covers this — verify in the browser, with the panel open.

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
| timelapse **selection** (rebuilds the layer) | timelapse **hover** (restyles in place) |
| normal-mode restyle (`restyleAnnotations`) | timelapse restyle (`restyleTimelapseConnections`) |
| creating a throttled/debounced callback | cancelling it in `onBeforeUnmount` |
| flat rendering | track/grouped rendering |
| normal-mode connection styling | the inline style in `drawTimelapseTrack` |
| a track's colour in the viewer | its swatch in the Connections tab |
| a new timelapse draw input | its entry in the timelapse `watch` list |
| the Navigator's mode checkbox | the Timelapse palette's close button |

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
