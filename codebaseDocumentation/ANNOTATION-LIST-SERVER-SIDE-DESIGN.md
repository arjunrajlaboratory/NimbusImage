# Server-Side Annotation List — Design Spec (Stub Annotations, Option B)

**Date:** 2026-06-18
**Branch:** `feature/stub-annotations`
**Status:** Design approved; implementation plan pending.
**Related:** `ANNOTATION-STUBS.md` (the stub architecture this builds on; this is its "Option B").

---

## 1. Background & problem

The `AnnotationBrowser/AnnotationList` is a **client-side, load-everything** component:

- `<v-data-table :items="filteredItems">` materializes one item object per *filtered* annotation; Vuetify sorts/filters the whole array in JS.
- Property values are loaded **wholesale** for every annotation (`propertiesStore.propertyValues` = `{[annoId]: {[propId]: value}}`) — the single largest mutable structure in the app and, at scale, the dominant memory cost (larger than annotation coordinates per `ANNOTATION-STUBS.md`'s memory analysis).
- Interim guard (Option A, shipped): above `LIST_ITEM_LIMIT = 20000` filtered annotations the list refuses to render and asks the user to narrow with filters.

Option B replaces the guarded list, at scale, with a server-driven list so the client never holds all rows or all property values.

## 2. Goals / non-goals

**Goals (iteration 1 — "Core scale fix"):**

- List pagination, sorting, and **property-value filtering** move server-side above a threshold.
- Property values loaded only for the **visible page's displayed columns** — the memory win.
- Tag, location, and ID-substring filters also move server-side in this mode (pagination must reflect *all* active filters).
- `Select All` / `Delete Unselected` keep current meaning ("all matching the filters") via a matching-IDs endpoint.
- Small datasets are **unchanged** (dual-mode; zero behavior change below the threshold).

**Non-goals (deferred):**

- **Server-side ROI (polygon) filtering** — arbitrary-polygon containment needs Mongo geo operators; deferred. In server mode an active ROI filter shows a "not available for very large datasets yet" notice.
- **Infinite scroll** — iteration 1 keeps page numbers + total. Deep-page jumps are a common mode and ultimately want cursor-based infinite scroll; recorded as the next pagination iteration (more work).
- **Other `propertyValues` consumers** (property plots, AnnotationProperties panels) — still load values; not addressed by B-core, which targets the list.
- Per-property database indexes (see §5.4 — accept a dataset-scoped scan for v1).

## 3. Decisions (resolved during design)

| Decision | Choice |
|---|---|
| Scope of iteration 1 | Core scale fix (sort/filter/paginate server-side; lazy per-page property values) |
| `Select All` / `Delete Unselected` | **Matching-IDs endpoint** — fetch all matching IDs, populate selection, run existing batch ops |
| Pagination model | **Page numbers + total** now; migrate to infinite scroll later |
| Backend query | **Annotation-driven single aggregation** (Approach 1); bidirectional optimization deferred |
| Mode switch | **Dual-mode**, mirroring the existing stub under/over-threshold pattern |
| ROI server-side | Deferred |

## 4. Architecture — dual-mode list

Mirrors the existing stub system (`needsStubSystem` activates only when over budget), so small datasets keep today's exact behavior and risk is contained to the large-dataset path.

- **Below threshold** (≤ the list guard, currently 20,000 matching): today's **client-side** list — all filters incl. ROI, client sort, property values loaded for that bounded set. Unchanged.
- **Above threshold:** **server-driven** list. It sends `{datasetId, filters, sort, page, pageSize, propertyPaths}` and renders the returned page. `propertyValues` is **not** bulk-loaded; each row carries only its displayed-column values.

The canvas is **unaffected** — it keeps using stubs + viewport hydration. The list becomes an independent server-driven view. Selection (`selectedAnnotationIds`) remains shared between canvas and list.

## 5. Backend design

New routes on the existing `Annotation` resource (`server/api/annotation.py`), following the established orjson-streamed, `@access.public` + dataset `READ` pattern used by `find`/`stubs`.

### 5.1 `POST /upenn_annotation/list`

POST (not GET) so many property paths / filter values don't hit URL length limits — matches the CSV export precedent.

**Request body:**
```jsonc
{
  "datasetId": "ObjectId",
  "filters": {
    "shape": "polygon",                       // optional
    "tags": { "values": ["DAPI"], "exclusive": false },  // semantics match tagCloudFilterFunction / existing find $all
    "location": { "XY": 0, "Z": 0, "Time": 0 },          // optional (onlyCurrentFrame)
    "idSubstring": "abc",                     // optional
    "propertyFilters": [                      // optional
      { "path": ["propId", "sub"], "mode": "range", "min": 0, "max": 10 },
      { "path": ["propId2"], "mode": "values", "values": [1, 2, 3] }
    ]
  },
  "sort": { "type": "property", "key": ["propId", "sub"], "order": "asc" },
  // sort.type: "property" (key = path array) | "field" (key = "location.XY" | "name" | "channel" | "_id")
  "propertyPaths": [ ["propId", "sub"] ],     // columns whose values to return per row
  "offset": 0,
  "limit": 50
}
```

**Response (streamed):**
```jsonc
{
  "total": 142318,
  "rows": [
    {
      "id": "ObjectId",
      "centroid": { "x": 1.0, "y": 2.0 },
      "location": { "XY": 0, "Z": 0, "Time": 0 },
      "shape": "polygon",
      "channel": 0,
      "tags": ["DAPI"],
      "color": null,
      "values": { "propId": { "sub": 1.23 } }   // only for requested propertyPaths
    }
  ]
}
```

**Page aggregation pipeline (annotation-driven):**
1. `$match` — `datasetId` + shape + tags (`$all` / exclusive) + location + `idSubstring` (`$regex` on stringified `_id`, or a dedicated id-prefix match).
2. `$lookup` `annotation_property_values` on `_id` ↔ `annotationId` → `pv` (needed only if there are property filters, a property sort, or requested `propertyPaths`; skip otherwise).
3. `$unwind` `{ path: "$pv", preserveNullAndEmptyArrays: true }` (1:1; null when no values doc).
4. `$match` property filters (range / values) on `pv.values.<path>` — only if present.
5. `$addFields` — `centroid` (via `$avg` of coordinates, like `stubs`); for property sort, `sortValue = $pv.values.<path>` and `hasValue = {$cond: present}`.
6. `$sort` — for property sort: `{ hasValue: -1, sortValue: order, _id: 1 }` so **missing values sort to the end regardless of direction** (matches the current client sort) and ties are stable by `_id`. For field sort: `{ <field>: order, _id: 1 }`. Default (no sort): `{ _id: 1 }`.
7. `$skip: offset`, `$limit: limit`.
8. `$project` — stub fields + centroid + `values` reduced to the requested `propertyPaths`. Always exclude `coordinates`.

**Count:** a parallel pipeline mirroring stages 1–4 (the lookup + property `$match` only when a property *filter* is active — sorting never changes the count) then `$count`. One HTTP response carries both `total` and the page.

### 5.2 `POST /upenn_annotation/list/ids`

Same `filters` block; returns all matching IDs (no values, no coordinates) for `Select All` / `Delete Unselected`.

```jsonc
// request: { "datasetId": "...", "filters": { ... } }
// response (streamed): { "ids": ["ObjectId", ...], "total": 142318 }
```

### 5.3 Access control & validation

- `@access.public`, load dataset folder with `AccessType.READ` (same as `find`/`stubs`).
- API layer converts inputs once at the top (datasetId/property ids → `ObjectId`, validate sort/filter shape), passes clean data to a model method (`server/models/annotation.py`); the model raises `ValueError`/`ValidationException`, never `RestException`.

### 5.4 Indexing / performance

- v1 accepts a **dataset-scoped** aggregation scan (one dataset's annotations + their 1:1 property-value docs — bounded, not the whole DB). Existing `(datasetId, _id)` compound indexes serve the `$match` and stable sort.
- **Perf lever (deferred):** sparse `(datasetId, "values.<propertyId>")` indexes + the bidirectional query (drive from `annotation_property_values` when sorting/filtering by a property). Because properties are created at runtime, index creation would hook property-compute completion. Add only if profiling shows property sort/filter is slow at target scale.

## 6. Frontend design

### 6.1 List component

- `AnnotationList.vue` uses Vuetify **server-items mode**: `:items` = current page rows, `:items-length` = `total`, react to `@update:options` (page / itemsPerPage / sortBy) with a **debounced** fetch and a table loading state.
- Below threshold: existing client-side path (unchanged). The mode flag aligns with the existing list guard / stub `stubOnlyMode`.

### 6.2 New store module

A focused module (e.g. `src/store/annotationListServer.ts`) owns server-mode list state (page rows, total, current sort, loading) and the fetch, keeping the already-large `annotation.ts` / `filters.ts` from growing. API calls live in `AnnotationsAPI.ts` (`fetchAnnotationListPage`, `fetchAnnotationListIds`).

### 6.3 Filter translation & ROI

- The module reads active filters from `filterStore` (tag, location/onlyCurrentFrame, property, ID-substring) and translates them to backend params.
- If an **ROI filter is active in server mode**, show an inline notice: "ROI filtering isn't available for very large datasets yet" (ROI server-side is deferred).

### 6.4 Property values & columns

- Server mode requests values only for `displayedPropertyPaths` (+ the sort property); rows carry their own `values`. `propertyStore.propertyValues` is **not** loaded in server mode (the memory win).
- The "Index" column becomes position-in-result (`offset + rowIndex`).

## 7. Selection & bulk operations

- Per-row checkbox + canvas drag-select → `selectedAnnotationIds` (unchanged).
- `Select All` / `Delete Unselected`: call `/list/ids` with the current filters, populate `selectedAnnotationIds` with the full matching set, then run the existing batch delete/tag/color endpoints. Behavior identical to today; only the source of the ID set changes.

## 8. Limitations & future work

### Performance at very large scale — measured, DEFERRED (2026-06-18)

Real-data testing on two live datasets confirmed **correctness** (HCR 26K: 16/16 checks; Xenium 708K: all functional checks pass) but revealed a **serious latency problem at 708K** that is deferred to a dedicated perf pass:

| Call (708K dataset) | Latency |
|---|---|
| `/list/ids` (708K ids) | ~1.5 s |
| page 1 — no property column, no sort | ~3.6 s |
| page 1 — field sort (location.XY) | ~3.7 s |
| page 1 — with a property column | ~13.4 s |
| property sort | ~13.9 s |
| range filter | ~21.1 s |
| deep page + property sort | ~25.0 s |

**Root cause:** the pipeline computes the centroid `$addFields`, does the property `$lookup`+`$unwind`, and `$sort`s over the **entire matched set** before `$skip`/`$limit`, so the per-row cost is paid on all 708K rows for every page. Two compounding culprits: centroid+sort over the full set (~3.6 s floor) and the lookup over the full set (+~10 s).

**Planned fix (deferred), two tiers:**
1. **Cheap, high-impact reorder:** for the default browse + field-sort case (no property sort/filter), defer the centroid `$addFields` and the `$lookup` until *after* `$skip`/`$limit` — `match → (indexed sort) → skip → limit → centroid + lookup on just the page`. Turns 3.6–13 s into ~tens of ms at any scale. Covers the most common UI interactions.
2. **Property sort/filter at scale needs an index — but indexing is non-trivial here and needs design thought (the reason this is deferred, not done now):** property values are stored **nested** (`values.<propertyId>.<subField>`) and the `<propertyId>`s **differ per dataset**, so a naive per-property compound index doesn't generalize — you'd need a wildcard index, a flattened/reshaped property-values collection, an index created at property-compute time, or the bidirectional query (drive from `annotation_property_values`). Pick a strategy deliberately later.

Decision (2026-06-18): proceed with the frontend now; do the perf pass as a follow-up. The architecture is correct; large datasets are just slow until then.

### Other deferred items

- **Pagination → infinite scroll:** iteration 1 is page numbers + total. Deep-page jumps (`$skip` at large offsets) are slow and are a common access mode, so a later iteration should move to cursor-based infinite scroll (encode sort key + `_id`). This is meaningfully more work; functional page-numbers first.
- **Server-side ROI filtering:** deferred (Mongo geo / centroid-bounds).
- **Other `propertyValues` consumers** (plots, properties panels) still load values wholesale; separate future work.

## 9. Testing plan

**Backend (pytest):**
- `/list`: each filter (shape, tags incl/excl, location, idSubstring, property range, property values), sort asc/desc on a property and on a field, **missing-value ordering** (missing always last), pagination (offset/limit + `total`), requested `propertyPaths` projection, `coordinates` excluded.
- `/list/ids`: returns exactly the matching set; matches `/list` total for the same filters.
- Access denied for a user without dataset READ; empty dataset; nonexistent dataset.

**Frontend (vitest):**
- Server-mode fetch fires on page / itemsPerPage / sortBy change (debounced) and renders returned rows + total.
- Dual-mode switch at the threshold.
- `Select All` populates selection from `/list/ids`; bulk delete/tag/color run on that set.
- Loading state on the table; ROI-active notice in server mode.

## 10. Risks

- **Deep-offset `$skip`** latency at 1M (accepted for v1; infinite-scroll follow-up).
- **`$lookup` + `$unwind`** cost without per-property indexes (mitigations in §5.4).
- **Filter-semantics drift** between client (`filteredAnnotations` getter / `tagCloudFilterFunction`) and the new server filters — backend tests must pin tag-exclusive and missing-value semantics to match the client exactly so the dual-mode switch is seamless.
