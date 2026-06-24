# Point Annotation Stub Collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make point annotations render as regular points (not dot stubs) and never hydrate, while staying in the lightweight `annotationStubs` index — eliminating the wasted `/hydrate` round-trip, the second redraw, and the stub→hydrated visual pop for points.

**Architecture:** Two pure predicates in `src/utils/annotation.ts` capture the rule "points are self-complete (centroid IS the coordinate), so they never need a dot placeholder or hydration." Three styling sites in `AnnotationViewer.vue` consult the predicate to style point stubs with the regular point style. The hydration-selection step in `annotation.ts` (`updateVisibilityAndHydration` Step 4) and `ensureHydrated` filter points out of hydration. The visibility budget (which gates how many features are drawn) is untouched — it is what makes 1M points tractable and is shape-agnostic.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vuex (vuex-module-decorators), GeoJS, Vitest. Backend (Girder) is unchanged.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-24-point-annotation-stub-collapse-design.md`.
- **Scope is points only.** Do NOT touch polygon/line/rectangle stub or hydration behavior. Viewport-bounding the budget is out of scope (GitHub issue #1205, `codebaseDocumentation/VIEWPORT-BOUND-BUDGET.md`).
- No backend changes, no data migration, no new config.
- Test runner: `pnpm exec vitest run <path>` for a single file (avoid bare `pnpm test` right after a `tox` run — it globs `.tox/**` spec files and reports ~10 spurious failures). Typecheck: `pnpm tsc`. Lint: `pnpm lint`.
- Editing `src/store/*.ts` during a running `pnpm run dev` breaks Vuex HMR (`[vuex] duplicate getter key`) — a hard browser reload is required before in-browser verification of store changes.
- Existing 1M-point test dataset for in-browser verification: `http://localhost:5173/#/dataset/6a3bf1f329d4eef79ac0c304` (points on Z index 0 = "-15 µm"; navigate the Z slider fully left to reach them).

---

### Task 1: Add the `shapeNeedsHydration` and `drawnFeatureUsesDotStyle` predicates

**Files:**
- Modify: `src/utils/annotation.ts` (add two exported functions near `estimateAnnotationRadius`, ~line 567)
- Test: `src/utils/__tests__/annotationStubUtils.test.ts`

**Interfaces:**
- Produces:
  - `shapeNeedsHydration(shape: AnnotationShape): boolean` — `false` for `Point`, `true` otherwise.
  - `drawnFeatureUsesDotStyle(isStub: boolean, shape: AnnotationShape): boolean` — `isStub && shapeNeedsHydration(shape)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/__tests__/annotationStubUtils.test.ts`. First add the imports: add `shapeNeedsHydration` and `drawnFeatureUsesDotStyle` to the existing `from "../annotation"` import block, and add a new import line for the shape enum:

```typescript
import { AnnotationShape } from "@/store/model";
```

Then add this describe block at the end of the file:

```typescript
describe("shapeNeedsHydration", () => {
  it("returns false for points (a point's centroid is its only coordinate)", () => {
    expect(shapeNeedsHydration(AnnotationShape.Point)).toBe(false);
  });

  it("returns true for polygon, line, and rectangle", () => {
    expect(shapeNeedsHydration(AnnotationShape.Polygon)).toBe(true);
    expect(shapeNeedsHydration(AnnotationShape.Line)).toBe(true);
    expect(shapeNeedsHydration(AnnotationShape.Rectangle)).toBe(true);
  });
});

describe("drawnFeatureUsesDotStyle", () => {
  it("uses the dot style for an unhydrated non-point stub", () => {
    expect(drawnFeatureUsesDotStyle(true, AnnotationShape.Polygon)).toBe(true);
  });

  it("does NOT use the dot style for a point stub (regular point style)", () => {
    expect(drawnFeatureUsesDotStyle(true, AnnotationShape.Point)).toBe(false);
  });

  it("does NOT use the dot style for a hydrated annotation", () => {
    expect(drawnFeatureUsesDotStyle(false, AnnotationShape.Polygon)).toBe(false);
    expect(drawnFeatureUsesDotStyle(false, AnnotationShape.Point)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/utils/__tests__/annotationStubUtils.test.ts`
Expected: FAIL — `shapeNeedsHydration is not a function` / `drawnFeatureUsesDotStyle is not a function` (imports unresolved).

- [ ] **Step 3: Implement the predicates**

In `src/utils/annotation.ts`, immediately after the `estimateAnnotationRadius` function (ends ~line 567), add:

```typescript
// Whether annotations of this shape need backend hydration. Points do NOT: a
// point's centroid IS its single coordinate, so a point stub already holds its
// full geometry. Such stubs render with the regular point style (not the dot
// placeholder) and are never fetched from /hydrate. Polygons/lines/rectangles
// load as dot stubs and hydrate on demand.
export function shapeNeedsHydration(shape: AnnotationShape): boolean {
  return shape !== AnnotationShape.Point;
}

// A drawn feature uses the dot placeholder style only when it is an unhydrated
// stub of a shape that still needs hydration. Point stubs use the regular point
// style — identical to a hydrated point — because they are already complete.
export function drawnFeatureUsesDotStyle(
  isStub: boolean,
  shape: AnnotationShape,
): boolean {
  return isStub && shapeNeedsHydration(shape);
}
```

Verify `AnnotationShape` is already imported in `src/utils/annotation.ts` (it is used by `annotationDistance` etc.). If for some reason it is not, add it to the existing `from "@/store/model"` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/utils/__tests__/annotationStubUtils.test.ts`
Expected: PASS (all existing tests in the file plus the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/utils/annotation.ts src/utils/__tests__/annotationStubUtils.test.ts
git commit -m "feat(stub-annotations): add shapeNeedsHydration + drawnFeatureUsesDotStyle predicates

Points are self-complete (centroid IS the coordinate): they never need a dot
placeholder or backend hydration. Pure predicates that the render and
hydration paths will consult next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WBfPTkdddxm4wbG4rTyD5w"
```

---

### Task 2: Render point stubs with the regular point style (three styling sites)

**Files:**
- Modify: `src/components/AnnotationViewer.vue`
  - import block (~line 114)
  - `createGeoJSAnnotation` (~lines 1397, 1422–1452)
  - `drawNewAnnotations` restyle loop (~lines 893–914)
  - `restyleAnnotations` (~lines 1497–1518)

**Interfaces:**
- Consumes: `drawnFeatureUsesDotStyle(isStub, shape)` from Task 1.
- Produces: GeoJS feature `options` now carry an `annotationShape` field (`= annotation.shape`) so the two restyle loops can re-derive the dot-vs-regular decision without the full annotation object.

- [ ] **Step 1: Import the predicate**

In `src/components/AnnotationViewer.vue`, add `drawnFeatureUsesDotStyle` to the existing import from `@/utils/annotation` (the block that already imports `getStubStyleFromBaseStyle`, ~line 109–114):

```typescript
  getStubStyleFromBaseStyle,
  drawnFeatureUsesDotStyle,
```

- [ ] **Step 2: Update `createGeoJSAnnotation` — style decision + carry the shape**

In `createGeoJSAnnotation`, replace the `const style = isStub ? ... : ...` block (~lines 1425–1434) with a shape-aware decision:

```typescript
  const useDotStyle = drawnFeatureUsesDotStyle(isStub, annotation.shape);
  const style = useDotStyle
    ? getStubStyleFromBaseStyle(
        customColor || layer?.color,
        annotation.id === hoveredAnnotationId.value,
        isAnnotationSelected.value(annotation.id),
        stubRadius,
        getStubScaled(),
        store.annotationOpacity,
      )
    : getAnnotationStyle(annotation.id, customColor, layer?.color);
```

Then add `annotationShape` to the `options` object (~lines 1436–1452), next to `isStub`:

```typescript
    isStub,
    annotationShape: annotation.shape,
    stubRadius,
```

(Leave `isStub` and `stubRadius` as-is — a point stub is still a stub internally; only its *style* changes. `isStub` still drives the incremental-draw keep-check `drawnFeatureUnchanged`.)

- [ ] **Step 3: Update the `drawNewAnnotations` restyle loop**

In `drawNewAnnotations` (~lines 893–913), add `annotationShape` to the destructure and use the predicate:

```typescript
      const {
        layerId,
        isHovered,
        isSelected,
        style,
        customColor,
        isStub,
        annotationShape,
        stubRadius,
      } = geoJSAnnotation.options();
      if (isHovered != isHoveredGT || isSelected != isSelectedGT) {
        const layer = store.getLayerFromId(layerId);
        const newStyle = drawnFeatureUsesDotStyle(isStub, annotationShape)
          ? getStubStyleFromBaseStyle(
              customColor || layer?.color,
              isHoveredGT,
              isSelectedGT,
              stubRadius,
              stubScaled,
              store.annotationOpacity,
            )
          : getAnnotationStyle(annotationId, customColor, layer?.color);
        geoJSAnnotation.options("style", { ...style, ...newStyle });
```

- [ ] **Step 4: Update `restyleAnnotations`**

In `restyleAnnotations` (~lines 1497–1518), add `annotationShape` to the destructure and use the predicate:

```typescript
    const {
      girderId,
      layerId,
      style,
      customColor,
      isConnection,
      isStub,
      annotationShape,
      stubRadius,
    } = geoJSAnnotation.options();
    if (girderId && !isConnection) {
      const layer = store.getLayerFromId(layerId);
      const newStyle = drawnFeatureUsesDotStyle(isStub, annotationShape)
        ? getStubStyleFromBaseStyle(
            customColor || layer?.color,
            girderId === hoveredAnnotationId.value,
            isAnnotationSelected.value(girderId),
            stubRadius,
            stubScaled,
            store.annotationOpacity,
          )
        : getAnnotationStyle(girderId, customColor, layer?.color);
      geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
    }
```

- [ ] **Step 5: Typecheck and run existing component tests**

Run: `pnpm tsc`
Expected: 0 errors.

Run: `pnpm exec vitest run src/components/__tests__/AnnotationViewer.test.ts`
Expected: PASS (no regressions). If this test file path differs, run `pnpm exec vitest run` over the components test dir.

- [ ] **Step 6: In-browser smoke check (point rendering)**

With `pnpm run dev` running, hard-reload `http://localhost:5173/#/dataset/6a3bf1f329d4eef79ac0c304`, click View, drag the Z slider fully left (Z = "-15 µm", index 0). Confirm the points render as regular points (same dot style as a small point dataset — no radius-0 stroke-only artifacts, no oversized world-locked circles). Panning should not show any stub→regular style change for points.

- [ ] **Step 7: Commit**

```bash
git add src/components/AnnotationViewer.vue
git commit -m "feat(stub-annotations): render point stubs with the regular point style

Point stubs are complete (centroid IS the coordinate), so they render with the
regular point style instead of the dot placeholder. Carries annotation.shape in
the GeoJS feature options so the two restyle loops can re-derive the decision.
Non-point stubs are unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WBfPTkdddxm4wbG4rTyD5w"
```

---

### Task 3: Exclude points from hydration

**Files:**
- Modify: `src/store/annotation.ts`
  - import block (~line 45, the existing `from "@/utils/annotation"`)
  - `updateVisibilityAndHydration` Step 4 (~lines 2316–2338)
  - `ensureHydrated` (~lines 2400–2406)

**Interfaces:**
- Consumes: `shapeNeedsHydration(shape)` from Task 1.
- Produces: no new exports. After this task, point ids never appear in `idsToHydrate`, never enter `hydratedAnnotations`, and never hit `POST /upenn_annotation/hydrate`.

- [ ] **Step 1: Import the predicate**

In `src/store/annotation.ts`, add `shapeNeedsHydration` to the existing import from `@/utils/annotation` (the block that already imports `idsNeedingHydration`, `selectLargestBySize`, ~line 45).

- [ ] **Step 2: Filter points out of the hydration budget (Step 4)**

In `updateVisibilityAndHydration`, replace the Step 4 block (~lines 2316–2338, beginning `const sizeOf = (id: string) => ...`) with:

```typescript
    // Step 4: Fill hydration budget (two-tier, largest first, UNEXPANDED box).
    // Points are self-complete (centroid IS the only coordinate), so they never
    // hydrate — drop them from both tiers BEFORE budget allocation so the budget
    // goes entirely to shapes that actually need coordinates. For an all-points
    // dataset this filters the candidate lists to empty, so the size-selection
    // is skipped entirely.
    const needsHydration = (id: string): boolean => {
      const stub = stubsMap.get(id);
      return !!stub && shapeNeedsHydration(stub.shape);
    };
    const sizeOf = (id: string) => stubsMap.get(id)?.estimatedRadius ?? 0;
    const hydInViewport = hydrationSplit.inViewportIds.filter(needsHydration);
    let idsToHydrate: string[];
    if (hydInViewport.length >= maxHydrated) {
      idsToHydrate = selectLargestBySize(hydInViewport, sizeOf, maxHydrated);
    } else {
      const remainingBudget = maxHydrated - hydInViewport.length;
      idsToHydrate = [
        ...hydInViewport,
        ...selectLargestBySize(
          hydrationSplit.outOfViewportIds.filter(needsHydration),
          sizeOf,
          remainingBudget,
        ),
      ];
    }
```

(The two-tier structure, `selectLargestBySize`, and `sizeOf` are unchanged — only the candidate lists are now point-free.)

- [ ] **Step 3: Skip points in `ensureHydrated`**

In `ensureHydrated`, replace the `const idsToFetch = idsNeedingHydration(...)` call (~lines 2400–2404) with a version that also drops points:

```typescript
    const stubs = this.annotationStubs;
    const idsToFetch = idsNeedingHydration(
      ids,
      this.hydratedAnnotations,
      stubs,
    ).filter((id) => {
      const stub = stubs.get(id);
      return !!stub && shapeNeedsHydration(stub.shape);
    });
```

(The existing `if (idsToFetch.length === 0) { return; }` guard immediately below now also short-circuits a points-only selection.)

- [ ] **Step 4: Typecheck**

Run: `pnpm tsc`
Expected: 0 errors.

- [ ] **Step 5: Run the store tests**

Run: `pnpm exec vitest run src/store/__tests__/annotationStubs.test.ts`
Expected: PASS. (These tests assert visibility/hydration bookkeeping on a mini-store and do not exercise the new shape filter directly — the filter's correctness is covered by the Task 1 unit tests plus the in-browser verification in Task 4. If any test breaks, it is a regression to fix, not an expected change.)

- [ ] **Step 6: Commit**

```bash
git add src/store/annotation.ts
git commit -m "feat(stub-annotations): never hydrate point annotations

A point's centroid IS its only coordinate, so hydrating it fetches data
identical to the centroid already held. Filter points out of the hydration
budget (updateVisibilityAndHydration Step 4) and out of ensureHydrated, so
points never hit /hydrate, never enter hydratedAnnotations, and never trigger
the hydrate-merge redraw. For an all-points dataset the size-selection over the
off-viewport set is skipped entirely.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WBfPTkdddxm4wbG4rTyD5w"
```

---

### Task 4: Full verification (points-only + mixed) and docs

**Files:**
- Modify: `codebaseDocumentation/ANNOTATION-STUBS.md` (note the point-collapse behavior)

**Interfaces:**
- Consumes: the running app + the 1M-point dataset; a mixed point+polygon dataset created in Step 2 below.

- [ ] **Step 1: Suite-wide checks**

Run: `pnpm tsc` → Expected: 0 errors.
Run: `pnpm lint` → Expected: no new errors/warnings in `src/utils/annotation.ts`, `src/store/annotation.ts`, `src/components/AnnotationViewer.vue`.
Run: `pnpm exec vitest run src/utils/__tests__/annotationStubUtils.test.ts src/store/__tests__/annotationStubs.test.ts` → Expected: PASS.

- [ ] **Step 2: Create a mixed point+polygon test dataset**

Add ~200 polygon annotations to the existing 1M-point dataset (Z index 0) so one dataset exercises both branches. Write `/private/tmp/.../scratchpad/add_polys.js`:

```javascript
const ds = ObjectId("6a3bf1f329d4eef79ac0c304");
const docs = [];
for (let i = 0; i < 200; i++) {
  const x = Math.random() * 1000 + 12;
  const y = Math.random() * 1000 + 12;
  docs.push({
    tags: ["polytest"],
    shape: "polygon",
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: [
      { x: x - 10, y: y - 10 },
      { x: x + 10, y: y - 10 },
      { x: x + 10, y: y + 10 },
      { x: x - 10, y: y + 10 },
    ],
    color: null,
    datasetId: ds,
  });
}
db.upenn_annotation.insertMany(docs, { ordered: false });
print("polygons now: " + db.upenn_annotation.countDocuments({ datasetId: ds, shape: "polygon" }));
```

Run:
```bash
docker compose cp <scratchpad>/add_polys.js mongodb:/tmp/add_polys.js
docker compose exec -T mongodb mongosh girder --quiet --file /tmp/add_polys.js
```
Expected: `polygons now: 200`.

- [ ] **Step 3: In-browser verification — read the live store**

Hard-reload the dataset, open the viewer, navigate to Z index 0. In the browser console (or via the diagnostics), capture the store via the component tree and assert:

```javascript
// after locating the annotation store as window.__annStore (walk #app.__vue_app__
// component tree for a setupState key `annotationStore`), then pan/zoom a few times:
const s = window.__annStore;
({
  stubOnlyMode: s.stubOnlyMode,                       // expect true
  hydratedSize: s.hydratedAnnotations.size,           // expect == 200 (polys) at most; 0 points
  httpRequestsFired: window.__stubPerf.httpRequestsFired,
  // sample: confirm no hydrated entry is a point
  hydratedShapes: [...s.hydratedAnnotations.values()].reduce((m, a) => {
    m[a.shape] = (m[a.shape] || 0) + 1; return m;
  }, {}),
});
```

Expected: `stubOnlyMode: true`; `hydratedShapes` contains **only** `polygon` (never `point`); the count of hydrated points is 0 regardless of pan/zoom.

- [ ] **Step 4: In-browser verification — visual + interaction**

- Points render as regular points at all zoom levels (no radius-0 dots; no pop/resize).
- The 200 polygons render as filled polygon shapes (they hydrate) and are visually distinct from the point dots.
- Point click-select and drag-select still select points (drag a box over a region, confirm a selection count appears).
- Per-pan responsiveness is no worse than before, and `__stubPerf.httpRequestsFired` stops climbing once polygons are hydrated (points add nothing).

- [ ] **Step 5: Regression check on a polygon-only dataset**

Open an existing polygon dataset (e.g. the 26K HCR dataset) and confirm polygons still load as dot stubs when below detail and hydrate into shapes on zoom-in exactly as before — i.e. this change did not alter non-point behavior.

- [ ] **Step 6: Update the architecture doc**

In `codebaseDocumentation/ANNOTATION-STUBS.md`, add a short subsection (under the styling/refinements area) recording: point annotations now collapse the stub/hydrated distinction — they render with the regular point style and are never hydrated (`shapeNeedsHydration` / `drawnFeatureUsesDotStyle` in `utils/annotation.ts`; filtered in `updateVisibilityAndHydration` Step 4 and `ensureHydrated`); the visibility budget still downsamples them; `estimatedRadius` is now unused for points. Cross-reference issue #1205 for the separate viewport-bound budget work.

- [ ] **Step 7: Commit**

```bash
git add codebaseDocumentation/ANNOTATION-STUBS.md
git commit -m "docs(stub-annotations): record point stub/hydrated collapse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WBfPTkdddxm4wbG4rTyD5w"
```

---

## Self-Review

**Spec coverage:**
- Render point stubs as regular points → Task 2 (3 sites) + Task 1 predicate. ✓
- Exclude points from hydration (Step 4 + `ensureHydrated`) → Task 3. ✓
- Keep points in the lightweight index / visibility budget untouched → not modified (verified by Task 4 Step 3 `stubOnlyMode: true` + points still drawn). ✓
- Backend unchanged, `estimatedRadius` becomes unused for points → no backend task; noted in Task 4 Step 6. ✓
- `hydrationMode` interaction (all-points → "dots"; mixed → "shapes") → falls out of Task 3; verified by Task 4 Step 3/4 (mixed dataset). ✓
- Selection still works via centroid → Task 4 Step 4. ✓
- Testing: unit (Task 1) + in-browser points-only and mixed (Task 4) + polygon regression (Task 4 Step 5). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual code; commands have expected output. ✓

**Type consistency:** `shapeNeedsHydration(shape)` and `drawnFeatureUsesDotStyle(isStub, shape)` are defined in Task 1 and consumed with matching signatures in Tasks 2 and 3. The `annotationShape` option added in Task 2 Step 2 is read in Task 2 Steps 3–4. ✓

**Open item (intentional, from spec §3):** `shouldSelectStub` click-tolerance for points is left as a verify-in-browser step (Task 4 Step 4) — refine only if point click-select misbehaves; not pre-specified.
