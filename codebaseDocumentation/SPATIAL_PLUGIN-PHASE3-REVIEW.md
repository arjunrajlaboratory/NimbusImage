# Spatial plugin, Phase 3 (transcript layer) — review tracker

Branch `xenium-phase0`, review of the Phase 3 diff before its commit. Findings from the
self-review pass and live verification on the lymph node (an independent reviewer agent was
started but died on an API spend limit before reporting). Status: `fixed` / `by-design` /
`deferred — reason`.

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| 1 | High | `server/transcripts.py`, `api/transcripts.py`, `store.py`, build script, frontend readout | The design assumed the zarr's level-0 `id` was the packed Xenium **cell** id and built a whole id path on it (`obs.xenium_cell_id`, `rowsForXeniumCellIds`, `annotation_ids` route, `cellRow` on the wire, `hasCellIds`). Live data: `id` is the *transcript's* id (836,389 unique values in an 836,389-row tile; the bundle ships no per-molecule cell reference). Every molecule mapped to "no cell". | fixed — the id machinery is deleted; the cell is found geometrically at click time (`src/utils/annotationAtPoint.ts`: bbox prefilter + `geo.util.pointInPolygon` over the drawn outlines). Wire body is `n, hasQuality, xy, slot, [quality]`. |
| 2 | Medium | `api/transcripts.py` `transcriptPoints` | An empty `tiles` list passed `requireList` and reached `np.concatenate([])` → 500. | fixed — 400 "tiles must not be empty"; pinned in *"testPointsRejectBadInputAndTooMany"*. |
| 3 | Low | `api/transcripts.py` `transcriptDensityTile` | Unlike the annotation raster route, a tile index outside the pyramid rendered a blank PNG instead of a 400. | fixed — same `ceil(size * scale / tileSize)` bound as the raster route; pinned in *"testDensityTileValidatesParams"*. |
| 4 | Low | `server/transcripts.py` `searchGenes` | Prefix matches were sorted alphabetically, so "cd3" offered CD300A, CD300C, … before CD3E. | fixed — shortest prefix match first, then alphabetical, then substring matches. |
| 5 | Nit | `TranscriptsPanel.vue` | "Clustered molecules (no quality or cell at this zoom)" mentioned the cell that finding 1 removed from the wire. | fixed — string updated. |
| 6 | Low | `TranscriptOverlay.vue` | Level-of-detail is planned from tile counts that cover **all** genes, scaled by a rough per-gene share; a popular gene can still exceed the budget. | by-design — the server's 413 is the correction (steps one level coarser), tested by *"steps one level coarser when the server answers 413"*. |
| 7 | Low | `TranscriptOverlay.vue` `showDensity` | Several genes shared one heat map drawn white. | fixed ("fix everything" round) — one OSM layer per gene in its color, deleted when the gene is removed (round 2: hiding alone leaked a tile layer per symbol ever shown); *"draws one heat map per gene in its own color and deletes removed ones"*. |
| 8 | Low | `api/transcripts.py` density route | No ETag/304 handling, unlike the raster route. | by-design — the store is immutable once registered, so the tile is served with `Cache-Control: private, max-age=3600` instead; the client changes the URL when genes/color change. |
| 13 | Nit | `api/transcripts.py` `transcriptPoints` | Independent review: `np.concatenate(qvs) if level == 0` would 500 on a level-0 tile without `quality_score`. | fixed — guarded on `qvs`. |
| 14 | Nit | `SPATIAL_PLUGIN.md` | Independent review: the transcripts schema row still listed `hasCellIds`. | fixed. |
| 9 | Deferred | plan §12.3 | Per-tile client cache keyed by level/tile/genes/minQv. | deferred — a view's request is one POST answering in 30–50 ms warm (0.8 s cold, opening the zip); caching would add invalidation for little gain. Revisit with H&E or slower stores. |
| 10 | Low | plan §12.3 | Opacity control. | fixed — palette slider, a restyle of points and heat maps (store `opacity`). |
| 11 | Medium | `server/transcripts.py` `densityTile` | Live: CD3E's heat map was a flat saturated sheet over the whole section — log(count)/log(max) puts a typical bin at alpha ≈ 0.6. | fixed — alpha = sqrt(count / p99.5 of occupied bins); the gradient is visible. |
| 12 | Medium | `TranscriptOverlay.vue`, `transcriptTiles.ts` | Live: "auto" at whole-section zoom drew 119,574 level-2 clustered points at radius 4.5 px — a solid red blob. | fixed — `AUTO_DENSITY_LEVEL` 3 → 2 (heat map from 1 mm tiles) and clustered points draw at 2 px. |

## Live verification (lymph node, 2026-09-03)

- Upload 4.9 GB in 40 s, registration instant: 232,650,139 molecules, 4,624 genes, 7 levels
  (812 level-0 tiles of 1,176 px).
- Points: 4 densest level-0 tiles, CD3E → 9,833 points, 0.81 s cold / 0.04 s warm;
  4 genes → 37,974 points in 0.04 s; level 3 all 18 tiles CD3E → 38,414 points 0.05 s.
- Density tile: 40 ms first (grid build for the gene), 10 ms cached.
- UI: see the Phase 3 section of `SPATIAL_PLUGIN.md` for the checklist; browser verification
  recorded below the table once done.
