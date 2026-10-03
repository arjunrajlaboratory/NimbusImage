# Spatial plugin review tracker

Review of `xenium-phase0` against `master`, 2026-09-04.

## Findings

1. **High — lossy geometry identity**
   - Location: `SpatialPlugin/upenncontrast_spatial/server/recompute.py:75`
   - Polygon edits can collide under the moment-based geometry fingerprint and retain stale expression rows.
   - **Status:** fixed — working tree; exact SHA-256 geometry identities are persisted and legacy annotations are backfilled

2. **High — concurrent property writes lose unrelated values**
   - Location: `SpatialPlugin/upenncontrast_spatial/server/materialize.py:69`
   - Read/merge/replace writes let concurrent materialize, score, neighborhood, or user edits erase each other.
   - **Status:** fixed — working tree; model-layer atomic nested bulk upserts replace read/merge/replace writes, with a one-time coalescing migration before the unique annotation key is enforced

3. **High — neighborhood analysis has unbounded allocations**
   - Location: `SpatialPlugin/upenncontrast_spatial/server/neighborhood.py:116`
   - Dense result matrices and the complete neighbor-pair array can exhaust the Girder process.
   - **Status:** fixed — working tree; result arrays and neighbor-pair work have explicit tested ceilings

4. **High — stale provider ids can widen a filter to match all**
   - Location: `AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py:1093`
   - `_idSelector` compares raw provider cardinality with the live dataset rather than intersecting with live ids.
   - **Status:** fixed — working tree; selector cardinality and complements use the live-id intersection

5. **Medium — share-link tiles use the wrong logged-in identity**
   - Location: `AnnotationPlugin/upenncontrast_annotation/server/api/shareLink.py:117`
   - A recipient's existing cookie overrides the link bearer for image, raster, and density tile requests.
   - **Status:** fixed — working tree; share-view image, raster, and density URLs carry the in-memory link bearer and `/me` no longer mutates cookies

6. **Medium — transcript 413 fallback reuses keys from another level**
   - Location: `src/components/TranscriptOverlay.vue:325`
   - The fallback sends a coarser level number with tile keys planned for a different level.
   - **Status:** fixed — working tree; every retry computes keys for the exact coarser level

7. **Medium — virtual-property merging drops sibling columns**
   - Location: `src/store/properties.ts:508`
   - A shallow merge replaces the complete `spatial` subtree when a later virtual column arrives.
   - **Status:** fixed — working tree; all partial property-value merges now recursively retain nested sibling paths

8. **Medium — transcript density cache is entry-bounded, not byte-bounded**
   - Location: `SpatialPlugin/upenncontrast_spatial/server/transcripts.py:226`
   - Four stores can retain up to 64 full float64 density grids regardless of their memory cost.
   - **Status:** fixed — working tree; float32 grids are evicted by a tested process-wide byte budget divided across open stores

9. **Medium — Python spatial client ignores failed jobs**
   - Location: `nimbusimage/nimbusimage/spatial.py:131`
   - `materialize`, `score`, and `differential` do not check the boolean returned by `Job.wait()`.
   - **Status:** fixed — working tree; every awaited spatial job checks failure and returns its published final result

10. **Low — selection summary counts unresolved ids**
    - Location: `src/components/AnnotationBrowser/SelectionSummaryDialog.vue:297`
    - Display, disabled state, and scope labels use the raw selection while the request uses the resolved selection.
   - **Status:** fixed — working tree; labels, disabled state, default scope, and requests all use the resolved selection

11. **Low — spatial documentation describes superseded behavior**
    - Locations: `SpatialPlugin/upenncontrast_spatial/server/differential.py:9`, `codebaseDocumentation/SPATIAL_PLUGIN.md:149`, `nimbusimage/nimbusimage/spatial.py:185`
    - Wilcoxon is described as deferred despite being implemented, and virtual paths are described as exportable despite CSV export intentionally leaving them empty.
   - **Status:** fixed — working tree; implementation docs, client docstrings, share-link docs, comments, and regression checklist now match the corrected behavior
