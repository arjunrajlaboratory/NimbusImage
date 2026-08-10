# AI Panel view/settings tools — Design

**Date:** 2026-07-10
**Branch:** `claude/ai-panel-interface-spec-9k6gsv`

## Problem

The agent could navigate, set layer color/visibility/contrast, and select/edit
annotations, but couldn't touch viewer display settings, view mode, camera
framing, physical scale, or property-value filtering — all things a user
naturally asks for ("hide the annotations", "show it in 3D", "zoom to my
nuclei", "set the pixel size", "only show cells bigger than 100"). (Contrast was
already covered by `update_layer`.)

## Decisions (confirmed with user)

Build all four batches: display settings + 3D; camera-fit + shared contrast;
property-value filtering; set_scale. Destructive data mutation
(create/delete annotations) deliberately deferred.

## New / extended tools (all in `src/agent/executors.ts`)

1. **`set_display_options`** (new, view tool): drawAnnotations, annotationOpacity
   (0–1, validated), showScalebar, scalebarColor, backgroundColor,
   drawAnnotationConnections — thin wrappers over the existing `main.set*`
   display mutations.
2. **`set_view_mode`** (new, view tool): 2D ↔ 3D via `volumeView.setViewMode`.
3. **`set_camera` + `fit`** (extended): `fit: "annotations" | "selection" |
   "full"`. "full" mirrors the viewer's recenter button
   (`map.bounds(map.maxBounds())`); "annotations"/"selection" compute a padded
   pixel bounding box (new pure, unit-tested `annotationsBoundingBox` helper) and
   apply it with `map.bounds(bbox)`.
4. **`update_layer` + `contrastScope`** (extended): `"view"` (default, personal,
   unchanged) or `"configuration"` (shared) → `saveContrastInConfiguration`.
5. **`set_annotation_filter` + property filters** (extended): `propertyFilters:
   [{ propertyPath, min?, max? }]` and `clearPropertyFilters`. Builds a range
   `IPropertyAnnotationFilter` via `filters.updatePropertyFilter`. `clearAll`
   now also disables property filters (no bulk-clear mutation exists, so each is
   disabled in place). `get_property_values` now also returns the full
   `propertyPath` so the model can round-trip it into a filter.
6. **`set_scale`** (new): pixelSize / zStep (length units) and tStep (time
   units), validated, via `main.saveScaleInConfiguration` (shared collection).

## Reversibility

`set_display_options` and `set_view_mode` are added to `VIEW_STATE_TOOLS`, and
their state (the display options + `volumeView.viewMode`) is captured in the
per-turn snapshot and restored by "revert view changes", keeping the revert
promise honest.

## Testing

Pure/unit-testable parts get executor tests (display options incl. opacity
validation; view-mode; contrast scope routing; property-filter build +
validation + clear; set_scale unit/value validation; snapshot capture/restore of
display + view mode; `annotationsBoundingBox` math). The one non-unit-testable
piece is the GeoJS `map.bounds()` application in `set_camera fit` (no map in the
test harness) — its bounds math is unit-tested via `annotationsBoundingBox`; the
map call is verified live. Camera-fit's pixel→map y-axis convention needs live
confirmation.

## Deploy note

Schema + prompt ship in the plugin package → needs a girder rebuild to go live.
