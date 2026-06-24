# Collapse the stub/hydrated distinction for point annotations

**Date:** 2026-06-24
**Branch:** `feature/stub-annotations`
**Status:** Approved design, ready for implementation plan

## Context

The annotation system uses a stub/hydrated architecture (see
`codebaseDocumentation/ANNOTATION-STUBS.md`): annotations load as lightweight
stubs (centroid + metadata, no coordinates) and are selectively *hydrated* (full
coordinates fetched from `POST /upenn_annotation/hydrate`) based on viewport,
size, and selection. This was built for polygons, where the coordinate list is
the bulk of the data.

This architecture is a poor fit for **point** annotations, where a point's only
coordinate *is* its centroid. Investigation on a 1,000,000-point test dataset
(random points on one Z plane of a 1024×1024 image, driven in-browser in
stub-only mode) found:

- **Hydration is wasted work for points.** At one high-zoom sample, 23,454
  points were hydrated — each `/hydrate` response was `coords: [{x,y}]` identical
  to the centroid already held. Those objects are held in `hydratedAnnotations`
  and trigger a second (hydrate-merge) redraw, all for zero new information.
- **Stubs save ~nothing for points.** The `/stubs` payload for 1M points was
  **239 MB** (a point stub's ~200 bytes of metadata dwarfs its 24-byte
  coordinate), nearly the size of a full fetch. Heap went 76 MB → 437 MB on load.
- **A styling discontinuity.** The backend computes `estimatedRadius: 0` for
  points (degenerate single-coordinate bbox), so a point stub renders as a
  radius-0 (stroke-only) dot, while a hydrated point renders at
  `annotationsRadius` and scales with zoom — so a point visibly pops/resizes the
  moment it hydrates.

## Decision

**Reading A — collapse the stub/hydrated distinction for points** (chosen over
"truly remove stub mode for point datasets" because the `/stubs` fetch is
already coordinate-free for points, mixed point+polygon datasets are common and
need stubs for the polygons anyway, and the visibility-budget downsampling — the
thing that makes 1M points tractable — is independent of stub-vs-hydrated).

A point stays in the lightweight `annotationStubs` map + spatial index (so the
visibility budget and selection keep working), but the *stub behavior* — dot
styling and the hydration round-trip — never engages for it:

- A point stub renders **directly as a regular point** (regular point styling,
  coordinates = `[centroid]`).
- Points are **excluded from hydration** — never fetched from `/hydrate`, never
  held in `hydratedAnnotations`.
- The **visibility budget still gates** how many points are drawn (unchanged).

### Scope

This spec covers **point handling only**. The separate, shape-agnostic lever —
viewport-bounding the render/hydration budget so it stops filling with
off-screen annotations when zoomed in (measured at 91.5% off-screen on the
1M-point case) — is **out of scope** and tracked in **GitHub issue #1205** and
`codebaseDocumentation/VIEWPORT-BOUND-BUDGET.md`. The two are cleanly separable;
this design is forward-compatible with viewport-bounding.

## Design

### 1. Render path — `createGeoJSAnnotation` (`src/components/AnnotationViewer.vue`)

Today the stub branch always renders a `Point` feature with **stub styling**
(`getStubStyleFromBaseStyle`, radius = `estimatedRadius`). Change it to branch on
shape:

- **Point stub** → render as a regular point: use the normal point style
  (`getAnnotationStyle(...)`, the same path hydrated/full points use) with
  coordinates = `[centroid]`. No `estimatedRadius`, no stub stroke/fill, no
  world-locked `scaled` override.
- **Non-point stub** (polygon / line / rectangle) → unchanged stub dot styling.

`getForRendering(id)` already returns the stub object for any non-hydrated id,
and a point stub carries everything the regular point style needs (`centroid`,
`color`, `tags`, selection/hover state via the existing helpers). This is a
styling + coordinate-source switch, not a new data path.

### 2. Hydration exclusion — `updateVisibilityAndHydration` Step 4 + `ensureHydrated` (`src/store/annotation.ts`)

- In `updateVisibilityAndHydration` Step 4, exclude point-shaped stubs when
  building `idsToHydrate` (both the in-viewport and off-viewport tiers).
- In `ensureHydrated`, skip point-shaped ids (selecting or navigating to a point
  must not trigger a `/hydrate` fetch).

Result: points never enter `hydratedAnnotations` and never hit the network.

The `hydrationMode` interaction is benign and needs no special handling:

| Dataset | `idsToHydrate` | `hydrationMode` | Points render as | Non-points render as |
|---|---|---|---|---|
| All points | empty | `"dots"` | regular points (from stub, §1) | — |
| Mixed | non-points only | `"shapes"` | regular points (from stub, §1) | hydrated shapes |
| Selected point | n/a | either | regular point + selected styling (from stub) | — |

For a selected point, `shouldRenderAsShape` checks
`hydratedAnnotations.has(id)`, which is false for points → it renders from the
stub, and the regular point style (§1) applies the selected styling.

### 3. What stays unchanged (deliberately)

- **Visibility budget / downsampling** — points remain in `annotationStubs` +
  the spatial index and are still counted by `selectStableSubset` /
  `visibilityBudgetForZoom`. Untouched.
- **Selection** — point-click (`shouldSelectStub`) and drag-select
  (`annotationTestPoints` / `selectionCandidateInPolygon`) already resolve a
  point via its centroid, which is exact for a point. Verify in-browser that the
  click hit-test tolerance reflects the regular-point radius (refine
  `shouldSelectStub`'s radius source for points if needed).
- **Backend** — no change. `/stubs` already returns centroid-only for points;
  `estimatedRadius` simply becomes **unused for points** (it only fed stub-dot
  sizing and the hydration "largest first" ranking, both gone for points).
- **Memory** — a point keeps exactly one lightweight object in
  `annotationStubs`. This change *removes* the second representation
  (`hydratedAnnotations` entries) + the fetch; it adds nothing.

## Files

- `src/components/AnnotationViewer.vue` — `createGeoJSAnnotation` (shape-branch
  the stub styling); possibly `shouldSelectStub` radius source for points.
- `src/store/annotation.ts` — `updateVisibilityAndHydration` Step 4 and
  `ensureHydrated` (exclude points).

No backend, no data migration, no new config.

## Testing

**Unit (Vitest):**
- `createGeoJSAnnotation` renders a point stub with the regular point style (not
  the stub dot style); a polygon stub still renders with stub dot styling.
- `updateVisibilityAndHydration` produces an `idsToHydrate` that excludes
  point-shaped stubs; for a mixed set, only non-points are hydrated.
- `ensureHydrated` is a no-op for point ids.

**In-browser (the existing 1M-point dataset `6a3bf1f329d4eef79ac0c304`):**
- `hydratedAnnotations.size` stays ~0 and `__stubPerf.httpRequestsFired` to
  `/hydrate` stays 0 while panning/zooming.
- Points render as regular points at all zoom levels (no radius-0 dots, no
  pop/resize).
- Per-pan main-thread block drops versus baseline (one fewer draw + no hydration
  churn).
- Point-click and drag-select still select points.

**In-browser (a mixed point + polygon dataset):**
- Polygons still hydrate and render as shapes; points render as regular points
  and never hydrate.

## Out of scope

- Viewport-bounding the render/hydration budget (issue #1205,
  `codebaseDocumentation/VIEWPORT-BOUND-BUDGET.md`).
- Any change to polygon/line/rectangle stub or hydration behavior.
