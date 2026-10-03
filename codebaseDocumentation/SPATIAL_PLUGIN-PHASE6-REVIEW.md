# Spatial plugin, Phase 6 (neighborhood + regions) — review tracker

Branch `xenium-phase0`, self-review before the commit (independent reviewer unavailable).

| # | Severity | Location | Finding | Status |
|---|---|---|---|---|
| 1 | Medium | `api/analysis.py` | The route method `neighborhood` shadowed the imported module of the same name inside the class body, so decorators referencing `neighborhood.MAX_REGIONS` read the *method* (AttributeError at import). | fixed — module imported as `analysis`; caught by the first test run. |
| 2 | Low | `server/neighborhood.py` `cellCentroids` | Coordinates of 700K polygons are not downloaded: Mongo computes the centroid (`$avg`), the one place `collection.aggregate` is the right tool (CLAUDE.md exception). | by-design. |
| 3 | Low | `server/neighborhood.py` `neighborhood` | `query_pairs` materializes every pair (≈ 7 M for the lymph node at 30 µm, two int64 columns). | by-design — ~110 MB, one pass; radius is capped at 100K px. |
| 4 | Low | `materialize.py` | The chunked property writer was inlined in `writeValues`; the neighborhood job needed it too. | fixed — extracted as `writeCellValues`, `writeValues` delegates. |
| 7 | Low | `server/neighborhood.py` `cellCentroids` | Independent review: a public route ran the 700K-document centroid pass on every call. | fixed — cached per (dataset, excluded tags, excluded ids, annotation raster version); the neighborhood job shares it. |
| 8 | Low | `server/neighborhood.py` `regionPolygons` | Independent review (symmetric path): two-corner rectangles were expanded for cells (`recompute._rectangleCorners`) but skipped as regions. | fixed — shared helper. |
| 9 | Low | `RegionSummaryDialog.vue` | Independent review: region tags came from `annotations`, which in stub-only mode holds only hydrated objects. | fixed — `annotationStore.annotationTags`. |
| 10 | Medium | `server/neighborhood.py` `cellCentroids` | Round 2: the cache key included the excluded region ids, so every distinct "Selected polygons" summary stored its own ~100 MB centroid copy (8 entries ≈ 800 MB from a public route). | fixed — keyed on dataset, tags and raster version; excluded ids are dropped after the cache; two entries kept; pinned in *"testRegionSummary"*. |
| 11 | Low | `RegionSummaryDialog.vue` | Round 2: "Selected polygons (N)" counted every selected object and the 50-region cap applied to points too. | fixed — only ids resolving to polygons/rectangles (or unresolved) count and are sent. |
| 5 | Deferred | plan §15 | Cohort summaries across configurations. | deferred — needs a project-level surface; `regions/summary` is the per-dataset building block. |
| 6 | Low | `RegionSummaryDialog.vue` | Regions were picked by tag only. | fixed — "Selected polygons" summarizes the viewer's current selection through `regionIds`. |
| 12 | High | `dataset_spatial` documents, the materialized property, `annotation_property_values` | Round 3 (live API pass, 2026-09-25): the US-spelling commits (`8c509e75`, `9090ad5d`) renamed code, routes and docs but not data already written. `GET /spatial/{ds}/neighborhood` 404'd on a dataset whose registry entry held a complete result under `neighbourhood` (28 types, 708,983 cells typed); `SpatialAPI.fetchNeighborhood` maps 404 to `null`, so the dialog offered a 69 s recompute of something it already had. The property was named `Neighbourhood` (a re-run would have made a duplicate under the new name) and its per-cell count sub-key was `neighbours` while `NEIGHBOR_COUNT_KEY` is now `neighbors`. | fixed — one-off Mongo migration renamed all three (1 registry key, 1 property, 708,983 sub-keys); payload verified intact and the endpoint now answers. **A rename that touches a persisted field name needs a migration, not only a code sweep** — every test writes fresh data with the new spelling, so the whole suite stayed green. |
| 13 | Medium | `NeighborhoodDialog.vue`, `store/spatial.ts` | Round 3 (live, 2026-09-25): the dialog takes a radius in microns and converts with `store.scales.pixelSize`, so on a freshly ingested Xenium dataset — the target case — it refused with "The dataset has no pixel size; set one in the scale settings first" and disabled Compute, even though the registry it had already fetched carried `pixelSize: 0.2125` (the very value the stored 141.18 px radius was computed from). Two places knew the pixel size and the dialog consulted the one that is usually empty. | fixed — `refreshInfo` now adopts the registry's microns-per-pixel into the configuration scale (`adoptRegistryPixelSize`), so the scale is a property of the dataset rather than something to retype. Only ever fills a blank, never overwrites a hand-set value, and skips read-only viewers and share links via `canEditDatasetView`. Pinned in `store/spatial.test.ts` (5 cases). Live: the dialog now reads "30 µm is 141 image pixels" and the viewer gained a 1 mm physical scalebar. |

## Live verification (2026-09-03)

- Neighborhood at 30 µm (141 px) over 708,983 typed cells, 28 types: **69 s** end to end
  (centroids by Mongo, `query_pairs`, then the 709K property-value writes dominate).
  Strongest self-enrichment: Neutrophil 2.34, Mature conventional DC 2.28, Plasma cell
  1.68, Plasmacytoid DC 1.65, Classical monocyte 1.45 (log2); strongest cross pairs:
  Classical monocyte–Neutrophil 1.47, Erythrocyte–Neutrophil 1.29, Memory B–Naive B 0.90.
  The `Neighborhood` property now exists on the dataset (fractions per type + count).
- Regions: two temporary 6,000 × 6,000 px rectangles tagged `phase6-region`,
  `regions/summary` with three genes in **10.2 s** (the centroid pass dominates):
  34,050 and 41,706 cells with per-type composition and CD3E/MS4A1/CCL19 means; the
  regions were deleted afterwards.
- The two dialogs were not exercised in the browser this session (the owner's tab had been
  signed out by the Phase 5 incident, see `SHARING-PHASE5-REVIEW.md` finding 10); their
  behavior is pinned by the unit tests listed in `SPATIAL_PLUGIN.md`.
- Round 2 live: `user/me` for a bearer now carries the `shareLink` marker (dataset id
  matches), so the client's bearer-session guards fire; a region summary by id answers with
  the centroid pass cached per dataset rather than per selection.
