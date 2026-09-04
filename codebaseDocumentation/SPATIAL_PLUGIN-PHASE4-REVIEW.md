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
| 5 | Low | `server/recompute.py` dirty scope, removed cells | A removed cell's molecules are not reassigned unless a neighbor's polygon changed. | superseded by Astra review fix — tables now retain old bounds for moved/deleted cells; legacy tables fall back to a full rebuild. Pinned by `testDirtyRecomputeIncludesPreviousFootprint`. |
| 6 | Low | `api/versions.py` `recompute` | The job runs inside the Girder process (no worker container). | by-design for now (plan §13.1): the plugin already opens both stores from the assetstore; a process pool is the escape hatch. Measured live below. |
| 7 | Low | frontend | Versions were only surfaced in the Transcripts palette. | fixed — the Measurements tab's Add genes button names the active table (label, cells × genes) in its tooltip. |
| 8 | Medium | `server/recompute.py` `staleness`, `CellTableCard.vue` | Live: opening the palette on the vendor table left "Checking for edits…" for the better part of a minute — the scan loaded every polygon's coordinates although a hash-less table can only compare ids; and the version select stayed empty because it waited on the same `Promise.all`. | fixed — an ids-only Mongo projection when the table has no hashes; the card awaits versions first and staleness second. Timing recorded below. |
| 10 | Low | `api/versions.py` `recompute` | Branch review (three-state list contract): `tags: []` was accepted and, through `if tags:` in `cellPolygons`, meant "every polygon" — the same as omitting it. | fixed — an empty list is a 400; omit the key for every polygon (the dialog already sends null for a blank field). |
| 11 | Medium | `server/recompute.py` dirty scope | Independent review: a re-assigned cell straddling into a quiet tile lost its molecules on the far side — the tile set was built from dirty cells only, then every cell touching those tiles was reset. | fixed — tiles and touched cells grow together to a fixed point; *"testStalenessAndDirtyScope"* now has a straddling cell and expects both tiles. |
| 12 | Medium | `server/recompute.py` `staleness` | Independent review: the cache key ignored the caller-supplied cell list, so the job's tag-filtered call could seed the endpoint's whole-dataset answer with every untagged polygon "removed". | fixed — a supplied cell list neither reads nor writes the cache. |
| 13 | Nit | `api/versions.py`, `recompute.py` | Independent review: routes re-entered the decorated `versions` route (a second folder load); `bool("false")` was true; `dict` comprehension copy; bare `except Exception` at the job boundary uncommented. | fixed — `_versionsPayload`, strict boolean, `stats.copy()`, boundary comments. |
| 14 | Low | `server/recompute.py` dirty scope | Round 2 (own pass): the fixed-point loop tested every cell against every dirty tile in Python (tiles × 700K per round). | fixed — one vectorized bbox test per tile over the cells' bbox array. |
| 9 | Medium | `server/recompute.py` `staleness` (hashed tables) | For a recomputed table the scan needed every polygon's coordinates to hash them: 69 s for 709K cells per cache miss. | fixed — the hash is a numeric fingerprint (`count:Σx:Σy:Σxy:Σ(x²+y²)`, 0.01 px) that Mongo computes with `$size`/`$sum`; no coordinates leave the database. Mongo's and Python's values are asserted equal in *"testStalenessAndDirtyScope"*. Round 2 added the second moment: a rectangle scaled symmetrically about its center kept the first three sums (*"testUnits"*). |

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
- After the "fix everything" round: staleness on the recomputed (sha1-era) table answers in
  2.5 s — its digests are not fingerprints, so it is read as hash-less (added/removed only)
  until it is recomputed once; a table written by the new code compares fingerprints that
  Mongo computes, so no coordinate download happens on either path.
