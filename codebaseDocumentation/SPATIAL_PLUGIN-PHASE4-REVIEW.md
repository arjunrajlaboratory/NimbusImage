# Spatial plugin, Phase 4 (recompute + versions) — review tracker

Branch `xenium-phase0`, self-review of the Phase 4 diff before its commit (the
independent reviewer agent is unavailable: API spend limit). Status: `fixed` /
`by-design` / `deferred — reason`.

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| 1 | High | `server/recompute.py` `carriedRows` / `recompute` | The first carry-over built the carried block with a per-row `sp.vstack` and placed it with `lil[rows] = …` — both loops over up to 700K rows, minutes on the lymph node. | fixed — fancy row indexing on one CSR (an extra all-zero row stands in for cells without a row) and a placement matrix product; dirty and carried rows are disjoint so the two matrices add. |
| 2 | Medium | `server/recompute.py` `recompute` (dirty scope) | The job's staleness call passed the literal `"job"` as the file id, so its cache entry could never be shared with (or invalidated like) the endpoint's. | fixed — the active file id is threaded through `recompute(..., activeFileId)`. |
| 3 | Low | `server/recompute.py` `_varSymbols` | Cache keyed by `id(store)`; an evicted store's id can be reused by another object. | fixed — keyed by the store's path. |
| 4 | Low | `test/test_recompute.py` | First expectations assumed the fixture's six triangle cells carried no `cell` tag; they do (`makeAnnotation` tags every cell), so a tag-filtered rebuild has 10 rows, not 4. | fixed — expectations and the scene docstring corrected; a table's row count is exactly the tagged polygons. |
| 5 | Low | `server/recompute.py` dirty scope, removed cells | A removed cell's molecules are not reassigned unless a neighbour's polygon changed. | by-design — with no polygon left there is nothing to locate them by; a neighbour that grew over them is itself "changed", so its tile is redone. Documented in the code and SPATIAL_PLUGIN.md. |
| 6 | Low | `api/versions.py` `recompute` | The job runs inside the Girder process (no worker container). | by-design for now (plan §13.1): the plugin already opens both stores from the assetstore; a process pool is the escape hatch. Measured live below. |
| 7 | Deferred | frontend | Versions are only surfaced in the Transcripts palette. | deferred — the Measurements tab's "Genes from spatial table" could show the active label; add when a second consumer needs it. |
| 8 | Medium | `server/recompute.py` `staleness`, `CellTableCard.vue` | Live: opening the palette on the vendor table left "Checking for edits…" for the better part of a minute — the scan loaded every polygon's coordinates although a hash-less table can only compare ids; and the version select stayed empty because it waited on the same `Promise.all`. | fixed — an ids-only Mongo projection when the table has no hashes; the card awaits versions first and staleness second. Timing recorded below. |
| 9 | Deferred | `server/recompute.py` `staleness` (hashed tables) | For a recomputed table the scan still needs every polygon's coordinates to hash them: measured 69 s for 709K cells on the old path, and the same cost remains whenever a hashed table's cache misses (every edit burst). | deferred — options: hash at write time into an annotation field (schema change the user declined for Phase 1), or a Mongo aggregation computing a coordinate digest server-side. The result is cached per raster version, so a burst of edits pays once. |

## Live verification (lymph node, 2026-09-03)

- Full rebuild from the 708,983 vendor polygons (`tags: ["cell"]`, QV ≥ 20): **241 s** in
  the Girder process, single-threaded — 812 tiles at ~3.3 tiles/s, then matrix build,
  write (630 MB) and upload. 202,149,740 molecules considered, 179,092,279 assigned
  (88.6 %), 23,057,461 outside every polygon.
- Agreement with the vendor matrix: aggregate means over all cells CD3E 1.149 vs 1.232,
  MS4A1 0.830 vs 0.875, CD19 0.317 vs 0.332, CCL19 0.476 vs 0.520, PECAM1 0.211 vs 0.223;
  per-cell totals on 20 sampled cells run 3–7 % below the vendor's (e.g. 255 vs 271,
  304 vs 315, 437 vs 459). Expected: 10x assigns in 3D with its own boundary handling,
  this rasterizes the 2D polygon at 1 px.
- Staleness after the rebuild: up to date, hashes present. Nudging one polygon by 0.1 %
  → `changed: 1`; `scope: "dirty"` → **1 tile, 54 s** (the polygon scan and the
  700K × 4,624 carry-over dominate, not the tile), up to date again; restoring the
  polygon → `changed: 1` again. Versions afterwards: Nimbus v3 (dirty), Table (vendor),
  Nimbus v2 (vendor polygons); the vendor table was re-activated to leave the dataset as
  found.
- Staleness on the vendor (hash-less) table: 69 s with the coordinate scan, 10 s cold with
  the ids-only projection (finding 8), then cached per raster version. The palette shows
  "Table — 708,983 cells × 4,624 genes", "Up to date with the cell polygons.", and the two
  recomputed versions in the select.
- Follow-ups worth a ticket: the dirty path's fixed ~50 s (load polygons + carry rows)
  could drop to seconds by caching the polygon scan on the raster version and slicing
  the active CSR once; a process pool would take the full rebuild under a minute.
