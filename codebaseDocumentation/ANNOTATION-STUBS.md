# Stub Annotations Architecture — Vue 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stub/hydrated annotation architecture to the Vue 3 codebase so annotations can render as lightweight dots (stubs) or full shapes (hydrated), enabling efficient display of 100K+ annotations with viewport-aware visibility and hydration budgets.

**Architecture:** Annotations fetched from the backend are split into stubs (centroid + metadata) and hydrated (full coordinates). A mock data strategy (20% hydrated, 80% stubs) simulates the future backend API. A two-tier visibility system prioritizes viewport annotations for rendering (max 20K) and hydration (max 10K), with an R-tree spatial index for efficient viewport queries.

**Tech Stack:** Vue 3 + Vuex (vuex-module-decorators), TypeScript, GeoJS, RBush, Vitest

**Prior art:** This was implemented on a Vue 2 branch. The design document is at `/Users/arjunraj/code/UPennContrast-stub-annotations/codebaseDocumentation/ANNOTATION-STUBS.md`. The Vue 2 implementation completed Phases 1–4 (types, store, rendering, visibility/hydration/R-tree).

**Status: ALL 7 TASKS COMPLETE** (2026-04-05, branch `feature/stub-annotations`)
- Task 1: Stub types in model.ts ✅
- Task 2: Utility functions (hash, subset, radius, stub style) + 13 tests ✅
- Task 3: Spatial index module (AnnotationSpatialIndex) + 9 tests ✅
- Task 4: Store refactoring (stubs, hydration, visibility action) ✅
- Task 5: ImageViewer zoom event fix ✅
- Task 6: AnnotationViewer visibility/stub rendering integration ✅
- Task 7: Store stub/hydration tests (44 tests) ✅
- Final: 0 tsc errors, 0 lint warnings, 2184/2184 tests pass, production build succeeds

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/store/model.ts` | Modify | Add `IAnnotationStub`, `TAnnotationOrStub`, `THydrationMode`, `IVisibilityConfig`, `isHydratedAnnotation()` |
| `src/utils/annotation.ts` | Modify | Add `getStubStyleFromBaseStyle()`, `hashString()`, `selectRandomSubset()`, `estimateAnnotationRadius()` |
| `src/utils/spatialIndex.ts` | Create | `AnnotationSpatialIndex` class wrapping RBush + module-level singleton |
| `src/store/annotation.ts` | Modify | Add stub/hydration state, mutations, getters, `updateVisibilityAndHydration` action |
| `src/components/ImageViewer.vue` | Modify | Add zoom event listener (one line) |
| `src/components/AnnotationViewer.vue` | Modify | Visibility integration, stub rendering, debounced visibility watcher |
| `src/utils/__tests__/spatialIndex.test.ts` | Create | Unit tests for spatial index |
| `src/store/__tests__/annotationStubs.test.ts` | Create | Unit tests for store stub/hydration logic |

---

## Task 1: Add Stub Types to model.ts

**Files:**
- Modify: `src/store/model.ts` (after line ~1352, after `IAnnotation`)

- [ ] **Step 1: Add type definitions**

After `IAnnotation` (line 1352), add:

```typescript
// --- Stub/Hydrated Annotation Architecture ---

export interface IAnnotationStub {
  id: string;
  centroid: IGeoJSPosition;
  location: IAnnotationLocation;
  shape: AnnotationShape;
  channel: number;
  tags: string[];
  color: string | null;
  estimatedRadius?: number;
}

export type TAnnotationOrStub = IAnnotation | IAnnotationStub;

export type THydrationMode = "shapes" | "dots";

export interface IVisibilityConfig {
  maxVisible: number;
  maxHydrated: number;
}

export function isHydratedAnnotation(
  annotation: TAnnotationOrStub,
): annotation is IAnnotation {
  return "coordinates" in annotation;
}
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/store/model.ts
git commit -m "feat: add stub annotation type definitions (IAnnotationStub, TAnnotationOrStub, THydrationMode, IVisibilityConfig)"
```

---

## Task 2: Add Utility Functions

**Files:**
- Modify: `src/utils/annotation.ts`
- Create: `src/utils/__tests__/annotationStubUtils.test.ts`

- [ ] **Step 1: Write tests for new utility functions**

Create `src/utils/__tests__/annotationStubUtils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  hashString,
  selectRandomSubset,
  estimateAnnotationRadius,
  getStubStyleFromBaseStyle,
} from "../annotation";

describe("hashString", () => {
  it("returns a number", () => {
    expect(typeof hashString("test")).toBe("number");
  });

  it("is deterministic", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
  });

  it("returns unsigned 32-bit integer", () => {
    const hash = hashString("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different strings", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
  });
});

describe("selectRandomSubset", () => {
  it("returns all if under limit", () => {
    const ids = ["a", "b", "c"];
    expect(selectRandomSubset(ids, 5)).toEqual(ids);
  });

  it("returns exactly maxCount if over limit", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectRandomSubset(ids, 10)).toHaveLength(10);
  });

  it("is deterministic", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    expect(selectRandomSubset(ids, 10)).toEqual(selectRandomSubset(ids, 10));
  });
});

describe("estimateAnnotationRadius", () => {
  it("returns default for single point", () => {
    expect(estimateAnnotationRadius([{ x: 10, y: 20 }])).toBe(5);
  });

  it("computes bounding box diagonal / 2 for polygon", () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const expected = Math.sqrt(200) / 2; // diagonal of 10x10 box / 2
    expect(estimateAnnotationRadius(coords)).toBeCloseTo(expected);
  });
});

describe("getStubStyleFromBaseStyle", () => {
  it("returns a style with thinner stroke than full annotations", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.strokeWidth).toBe(2);
  });

  it("uses lower fill opacity", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.fillOpacity).toBe(0.4);
  });

  it("uses fixed small radius", () => {
    const style = getStubStyleFromBaseStyle();
    expect(style.radius).toBe(5);
  });

  it("applies annotation color when provided", () => {
    const style = getStubStyleFromBaseStyle("red");
    expect(style.fillColor).toBe("red");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/utils/__tests__/annotationStubUtils.test.ts`
Expected: FAIL (functions not exported)

- [ ] **Step 3: Implement utility functions**

Add to `src/utils/annotation.ts` (at end of file):

```typescript
// --- Stub annotation utilities ---

export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return hash >>> 0;
}

export function selectRandomSubset(ids: string[], maxCount: number): string[] {
  if (ids.length <= maxCount) return ids;
  const sorted = [...ids].sort((a, b) => hashString(a) - hashString(b));
  return sorted.slice(0, maxCount);
}

export function estimateAnnotationRadius(
  coordinates: IGeoJSPosition[],
): number {
  if (coordinates.length <= 1) return 5;
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  for (const coord of coordinates) {
    minX = Math.min(minX, coord.x);
    maxX = Math.max(maxX, coord.x);
    minY = Math.min(minY, coord.y);
    maxY = Math.max(maxY, coord.y);
  }
  return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2) / 2;
}

export function getStubStyleFromBaseStyle(
  annotationColor?: string,
  isHovered: boolean = false,
  isSelected: boolean = false,
): TAnnotationStyle {
  const style: TAnnotationStyle = {
    stroke: true,
    strokeColor: "black",
    strokeOpacity: 0.8,
    strokeWidth: 2,
    fillColor: "white",
    fillOpacity: 0.4,
    fill: true,
    radius: 5,
    scaled: 1,
  };

  if (annotationColor) {
    const geoColor = { ...geojs.util.convertColor(annotationColor) };
    geoColor.r *= 0.75;
    geoColor.g *= 0.75;
    geoColor.b *= 0.75;
    style.fillColor = annotationColor;
    style.strokeColor = geoColor;
  }
  if (isSelected) {
    style.strokeWidth = 4;
    if (annotationColor) {
      style.strokeColor = { ...geojs.util.convertColor(annotationColor) };
    }
  }
  if (isHovered) {
    style.fillOpacity = 0;
    style.strokeWidth = 3;
    style.strokeColor = { r: 1, g: 0.9, b: 0.9 };
  }
  return style;
}
```

Note: `getStubStyleFromBaseStyle` uses `geojs` — add the import if not already imported in the file. Also add the `IGeoJSPosition` import from `../store/model` if not already imported, and export `TAnnotationStyle` type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/utils/__tests__/annotationStubUtils.test.ts`
Expected: PASS (the `getStubStyleFromBaseStyle` test may need a mock for `geojs.util.convertColor` — if so, add a vi.mock for geojs)

- [ ] **Step 5: Commit**

```bash
git add src/utils/annotation.ts src/utils/__tests__/annotationStubUtils.test.ts
git commit -m "feat: add stub annotation utility functions (hash, subset selection, radius estimation, stub styling)"
```

---

## Task 3: Create Spatial Index Module

**Files:**
- Create: `src/utils/spatialIndex.ts`
- Create: `src/utils/__tests__/spatialIndex.test.ts`

- [ ] **Step 1: Write spatial index tests**

Create `src/utils/__tests__/spatialIndex.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { AnnotationSpatialIndex } from "../spatialIndex";

describe("AnnotationSpatialIndex", () => {
  let index: AnnotationSpatialIndex;

  beforeEach(() => {
    index = new AnnotationSpatialIndex();
  });

  describe("bulkLoad", () => {
    it("loads items and allows querying", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
        { id: "c", x: 90, y: 90 },
      ]);
      const result = index.queryBox(0, 0, 20, 20);
      expect(result.has("a")).toBe(true);
      expect(result.has("b")).toBe(false);
    });

    it("clears previous data on re-load", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.bulkLoad([{ id: "b", x: 50, y: 50 }]);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
      expect(index.queryBox(40, 40, 60, 60).has("b")).toBe(true);
    });
  });

  describe("insert and remove", () => {
    it("inserts a single item", () => {
      index.insert("a", 10, 10);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(true);
    });

    it("removes a single item", () => {
      index.insert("a", 10, 10);
      index.remove("a", 10, 10);
      expect(index.queryBox(0, 0, 20, 20).has("a")).toBe(false);
    });
  });

  describe("splitByViewport", () => {
    it("splits IDs into in-viewport and out-of-viewport", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
        { id: "c", x: 90, y: 90 },
      ]);
      const { inViewportIds, outOfViewportIds } = index.splitByViewport(
        ["a", "b", "c"],
        0, 0, 60, 60,
      );
      expect(inViewportIds).toContain("a");
      expect(inViewportIds).toContain("b");
      expect(outOfViewportIds).toContain("c");
    });

    it("only returns IDs from the provided list", () => {
      index.bulkLoad([
        { id: "a", x: 10, y: 10 },
        { id: "b", x: 50, y: 50 },
      ]);
      const { inViewportIds } = index.splitByViewport(["a"], 0, 0, 100, 100);
      expect(inViewportIds).toEqual(["a"]);
    });
  });

  describe("queryBox", () => {
    it("returns empty set for empty tree", () => {
      expect(index.queryBox(0, 0, 100, 100).size).toBe(0);
    });

    it("includes boundary points", () => {
      index.insert("a", 10, 10);
      expect(index.queryBox(10, 10, 10, 10).has("a")).toBe(true);
    });
  });

  describe("clear", () => {
    it("removes all items", () => {
      index.bulkLoad([{ id: "a", x: 10, y: 10 }]);
      index.clear();
      expect(index.queryBox(0, 0, 100, 100).size).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/utils/__tests__/spatialIndex.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement spatial index module**

Create `src/utils/spatialIndex.ts`:

```typescript
import RBush from "rbush";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

export class AnnotationSpatialIndex {
  private tree: RBush<SpatialItem> = new RBush<SpatialItem>();
  private itemById: Map<string, SpatialItem> = new Map();

  bulkLoad(items: { id: string; x: number; y: number }[]): void {
    this.tree = new RBush<SpatialItem>();
    this.itemById = new Map();
    const spatialItems: SpatialItem[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const { id, x, y } = items[i];
      const item: SpatialItem = { minX: x, minY: y, maxX: x, maxY: y, id };
      spatialItems[i] = item;
      this.itemById.set(id, item);
    }
    this.tree.load(spatialItems);
  }

  insert(id: string, x: number, y: number): void {
    const item: SpatialItem = { minX: x, minY: y, maxX: x, maxY: y, id };
    this.tree.insert(item);
    this.itemById.set(id, item);
  }

  remove(id: string, x: number, y: number): void {
    const item = this.itemById.get(id);
    if (item) {
      this.tree.remove(item);
      this.itemById.delete(id);
    }
  }

  splitByViewport(
    currentFrameIds: string[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): { inViewportIds: string[]; outOfViewportIds: string[] } {
    const inViewport = this.tree.search({ minX, minY, maxX, maxY });
    const inViewportSet = new Set<string>();
    for (const item of inViewport) {
      inViewportSet.add(item.id);
    }

    const inViewportIds: string[] = [];
    const outOfViewportIds: string[] = [];
    for (const id of currentFrameIds) {
      if (inViewportSet.has(id)) {
        inViewportIds.push(id);
      } else {
        outOfViewportIds.push(id);
      }
    }
    return { inViewportIds, outOfViewportIds };
  }

  queryBox(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): Set<string> {
    const results = this.tree.search({ minX, minY, maxX, maxY });
    const ids = new Set<string>();
    for (const item of results) {
      ids.add(item.id);
    }
    return ids;
  }

  clear(): void {
    this.tree = new RBush<SpatialItem>();
    this.itemById = new Map();
  }
}

// Module-level singleton — lives outside Vuex reactive state.
// RBush internal nodes would be corrupted by Vue's reactivity proxying.
export const annotationSpatialIndex = new AnnotationSpatialIndex();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/utils/__tests__/spatialIndex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/spatialIndex.ts src/utils/__tests__/spatialIndex.test.ts
git commit -m "feat: add AnnotationSpatialIndex module wrapping RBush for viewport queries"
```

---

## Task 4: Add Stub/Hydration State to Annotation Store

**Files:**
- Modify: `src/store/annotation.ts`

This is the largest task. It modifies the annotation store to maintain parallel stub/hydrated data structures and adds the `updateVisibilityAndHydration` action.

- [ ] **Step 1: Add imports**

At the top of `src/store/annotation.ts`, add to the model import (line ~10):

```typescript
import type {
  // ... existing imports ...
  IAnnotationStub,
  TAnnotationOrStub,
  THydrationMode,
  IVisibilityConfig,
} from "./model";
import { isHydratedAnnotation } from "./model";
import {
  selectRandomSubset,
  estimateAnnotationRadius,
} from "@/utils/annotation";
import { annotationSpatialIndex } from "@/utils/spatialIndex";
```

- [ ] **Step 2: Add new state fields**

After the existing state declarations (around line 52), add:

```typescript
annotationStubs: Map<string, IAnnotationStub> = markRaw(new Map());
hydratedAnnotations: Map<string, IAnnotation> = markRaw(new Map());
visibleAnnotationIds: Set<string> = markRaw(new Set());
hydrationMode: THydrationMode = "dots";
visibilityConfig: IVisibilityConfig = { maxVisible: 20000, maxHydrated: 10000 };
```

- [ ] **Step 3: Add new getters**

After the existing getters (around line 98), add:

```typescript
get isHydrated() {
  return (id: string): boolean => this.hydratedAnnotations.has(id);
}

get getStub() {
  return (id: string): IAnnotationStub | undefined =>
    this.annotationStubs.get(id);
}

get getHydratedAnnotation() {
  return (id: string): IAnnotation | undefined =>
    this.hydratedAnnotations.get(id);
}

get isVisible() {
  return (id: string): boolean => this.visibleAnnotationIds.has(id);
}

get shouldRenderAsShape() {
  return (id: string): boolean => {
    if (this.selectedAnnotationIds.has(id)) {
      return this.hydratedAnnotations.has(id);
    }
    return this.hydrationMode === "shapes" && this.hydratedAnnotations.has(id);
  };
}

get getForRendering() {
  return (id: string): TAnnotationOrStub | undefined => {
    if (this.shouldRenderAsShape(id)) {
      return this.hydratedAnnotations.get(id);
    }
    return this.annotationStubs.get(id);
  };
}
```

- [ ] **Step 4: Add new mutations**

Add after existing mutations:

```typescript
@Mutation
setVisibleAnnotationIds(ids: string[]) {
  this.visibleAnnotationIds = markRaw(new Set(ids));
}

@Mutation
setHydrationMode(mode: THydrationMode) {
  this.hydrationMode = mode;
}

@Mutation
hydrateAnnotations(ids: string[]) {
  const newMap = new Map(this.hydratedAnnotations);
  for (const id of ids) {
    const idx = this.annotationIdToIdx[id];
    if (idx !== undefined) {
      newMap.set(id, this.annotations[idx]);
    }
  }
  this.hydratedAnnotations = markRaw(newMap);
}

@Mutation
clearNonSelectedHydration(preserveIds?: string[]) {
  const newMap = new Map<string, IAnnotation>();
  const preserveSet = preserveIds ? new Set(preserveIds) : new Set<string>();
  for (const [id, annotation] of this.hydratedAnnotations) {
    if (this.selectedAnnotationIds.has(id) || preserveSet.has(id)) {
      newMap.set(id, annotation);
    }
  }
  this.hydratedAnnotations = markRaw(newMap);
}
```

- [ ] **Step 5: Modify `setAnnotations` mutation**

In the existing `setAnnotations` mutation (line ~486), after the index-building loop, add stub creation and mock data strategy:

```typescript
// After the existing loop that builds annotationCentroids and annotationIdToIdx:

// Build stub map
const newStubs = new Map<string, IAnnotationStub>();
const spatialItems: { id: string; x: number; y: number }[] = new Array(
  this.annotations.length,
);

for (let idx = 0; idx < this.annotations.length; ++idx) {
  const annotation = this.annotations[idx];
  const centroid = this.annotationCentroids[annotation.id];
  newStubs.set(annotation.id, {
    id: annotation.id,
    centroid,
    location: annotation.location,
    shape: annotation.shape,
    channel: annotation.channel,
    tags: annotation.tags,
    color: annotation.color,
    estimatedRadius: estimateAnnotationRadius(annotation.coordinates),
  });
  spatialItems[idx] = { id: annotation.id, x: centroid.x, y: centroid.y };
}
this.annotationStubs = markRaw(newStubs);

// Spatial index
annotationSpatialIndex.bulkLoad(spatialItems);

// Mock data strategy: hydrate first 20%
const newHydrated = new Map<string, IAnnotation>();
const hydrateCount = Math.ceil(this.annotations.length * 0.2);
for (let i = 0; i < hydrateCount && i < this.annotations.length; i++) {
  const annotation = this.annotations[i];
  newHydrated.set(annotation.id, annotation);
}
// Also preserve previously selected annotations that are still present
for (const id of this.selectedAnnotationIds) {
  const idx = this.annotationIdToIdx[id];
  if (idx !== undefined && !newHydrated.has(id)) {
    newHydrated.set(id, this.annotations[idx]);
  }
}
this.hydratedAnnotations = markRaw(newHydrated);
```

- [ ] **Step 6: Modify `addAnnotationImpl` mutation**

In `addAnnotationImpl` (line ~462), after existing logic, add:

```typescript
// After existing centroid and index logic:
const centroid = this.annotationCentroids[value.id];
this.annotationStubs = markRaw(
  new Map(this.annotationStubs).set(value.id, {
    id: value.id,
    centroid,
    location: value.location,
    shape: value.shape,
    channel: value.channel,
    tags: value.tags,
    color: value.color,
    estimatedRadius: estimateAnnotationRadius(value.coordinates),
  }),
);

// New annotations are always hydrated
this.hydratedAnnotations = markRaw(
  new Map(this.hydratedAnnotations).set(value.id, value),
);

// Spatial index
annotationSpatialIndex.insert(value.id, centroid.x, centroid.y);
```

- [ ] **Step 7: Modify `setAnnotation` mutation**

In `setAnnotation` (line ~471), after existing logic, add:

```typescript
// Before updating: remove old position from spatial index
const oldStub = this.annotationStubs.get(annotation.id);
if (oldStub) {
  annotationSpatialIndex.remove(
    annotation.id,
    oldStub.centroid.x,
    oldStub.centroid.y,
  );
}

// After existing centroid update:
const centroid = this.annotationCentroids[annotation.id];
const newStubs = new Map(this.annotationStubs);
newStubs.set(annotation.id, {
  id: annotation.id,
  centroid,
  location: annotation.location,
  shape: annotation.shape,
  channel: annotation.channel,
  tags: annotation.tags,
  color: annotation.color,
  estimatedRadius: estimateAnnotationRadius(annotation.coordinates),
});
this.annotationStubs = markRaw(newStubs);

// Update hydrated if present
if (this.hydratedAnnotations.has(annotation.id)) {
  this.hydratedAnnotations = markRaw(
    new Map(this.hydratedAnnotations).set(annotation.id, annotation),
  );
}

// Insert new position into spatial index
annotationSpatialIndex.insert(annotation.id, centroid.x, centroid.y);
```

- [ ] **Step 8: Add `updateVisibilityAndHydration` action**

```typescript
@Action
updateVisibilityAndHydration(params: {
  filteredIds: string[];
  gcsBounds?: IGeoJSPosition[];
  currentFrameLocation: IAnnotationLocation;
}) {
  const { filteredIds, gcsBounds, currentFrameLocation } = params;
  const { maxVisible, maxHydrated } = this.visibilityConfig;

  // Step 1: Split filteredIds by frame
  const currentFrameIds: string[] = [];
  for (const id of filteredIds) {
    const stub = this.annotationStubs.get(id);
    if (
      stub &&
      stub.location.XY === currentFrameLocation.XY &&
      stub.location.Z === currentFrameLocation.Z &&
      stub.location.Time === currentFrameLocation.Time
    ) {
      currentFrameIds.push(id);
    }
  }

  // Step 2: Split current-frame IDs by viewport
  let inViewportIds = currentFrameIds;
  let outOfViewportIds: string[] = [];

  if (gcsBounds && gcsBounds.length === 4) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const pt of gcsBounds) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    ({ inViewportIds, outOfViewportIds } =
      annotationSpatialIndex.splitByViewport(
        currentFrameIds,
        minX,
        minY,
        maxX,
        maxY,
      ));
  }

  // Step 3: Fill visibility budget (two-tier)
  let visibleIds: string[];
  if (inViewportIds.length >= maxVisible) {
    visibleIds = selectRandomSubset(inViewportIds, maxVisible);
  } else {
    const remaining = maxVisible - inViewportIds.length;
    const offViewport = selectRandomSubset(outOfViewportIds, remaining);
    visibleIds = [...inViewportIds, ...offViewport];
  }

  // Step 4: Fill hydration budget (two-tier, largest first)
  const inViewportWithSize = inViewportIds.map((id) => ({
    id,
    size: this.annotationStubs.get(id)?.estimatedRadius ?? 0,
  }));
  inViewportWithSize.sort((a, b) => b.size - a.size);

  let idsToHydrate: string[];
  if (inViewportWithSize.length >= maxHydrated) {
    idsToHydrate = inViewportWithSize
      .slice(0, maxHydrated)
      .map((item) => item.id);
  } else {
    const remainingBudget = maxHydrated - inViewportWithSize.length;
    const offViewportWithSize = outOfViewportIds.map((id) => ({
      id,
      size: this.annotationStubs.get(id)?.estimatedRadius ?? 0,
    }));
    offViewportWithSize.sort((a, b) => b.size - a.size);
    idsToHydrate = [
      ...inViewportWithSize.map((item) => item.id),
      ...offViewportWithSize.slice(0, remainingBudget).map((item) => item.id),
    ];
  }

  // Step 5: Apply visibility
  this.setVisibleAnnotationIds(visibleIds);

  // Step 6: Determine hydration mode
  this.setHydrationMode(idsToHydrate.length > 0 ? "shapes" : "dots");

  // Step 7: Clear non-selected hydration from previous frame, preserving new targets
  this.clearNonSelectedHydration(idsToHydrate);

  // Step 8: Hydrate new targets
  this.hydrateAnnotations(idsToHydrate);
}
```

- [ ] **Step 9: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: No new errors

- [ ] **Step 10: Run existing tests**

Run: `pnpm test`
Expected: All existing tests pass (this task only adds new state/behavior, doesn't break existing)

- [ ] **Step 11: Commit**

```bash
git add src/store/annotation.ts
git commit -m "feat: add stub/hydration state, mutations, getters, and visibility action to annotation store"
```

---

## Task 5: Fix ImageViewer Zoom Event

**Files:**
- Modify: `src/components/ImageViewer.vue` (line ~800)

- [ ] **Step 1: Add zoom event listener**

At line 800, after `map.geoOn(geojs.event.pan, synchronizationCallback);`, add:

```typescript
map.geoOn(geojs.event.zoom, synchronizationCallback);
```

This ensures `cameraInfo.gcsBounds` updates on zoom, required for the visibility system.

- [ ] **Step 2: Verify app compiles**

Run: `pnpm tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ImageViewer.vue
git commit -m "fix: add zoom event listener so cameraInfo.gcsBounds updates on zoom"
```

---

## Task 6: Integrate Visibility System into AnnotationViewer

**Files:**
- Modify: `src/components/AnnotationViewer.vue`

This is the rendering integration task. It modifies the component to respect the visibility system and render stubs differently from hydrated annotations.

- [ ] **Step 1: Add imports**

Add to the imports section (around line 56–80):

```typescript
import type { TAnnotationOrStub, IAnnotationLocation } from "@/store/model";
import { isHydratedAnnotation } from "@/store/model";
import { getStubStyleFromBaseStyle } from "@/utils/annotation";
import { AnnotationShape } from "@/store/model"; // if not already imported
```

- [ ] **Step 2: Add debounced visibility trigger watcher**

Add after existing watchers (around line 3060):

```typescript
const updateVisibilityDebounced = debounce(() => {
  const ids = (store.filteredDraw
    ? filteredAnnotations.value
    : annotationStore.annotations
  ).map((a: IAnnotation) => a.id);
  annotationStore.updateVisibilityAndHydration({
    filteredIds: ids,
    gcsBounds: store.cameraInfo.gcsBounds,
    currentFrameLocation: { XY: xy.value, Z: z.value, Time: time.value },
  });
}, 250);

watch(
  [filteredAnnotations, () => store.cameraInfo, xy, z, time],
  updateVisibilityDebounced,
);
```

Also trigger initial visibility on mount — add to the `onMounted` callback:

```typescript
updateVisibilityDebounced();
```

- [ ] **Step 3: Modify `layerAnnotations` computed to use visibility + stubs**

Change the type from `Map<string, Map<string, IAnnotation>>` to `Map<string, Map<string, TAnnotationOrStub>>` (line 389–417).

In the inner loop where annotations are added to `annotationIdsSet`, add visibility filtering and stub-aware rendering:

```typescript
// Replace the line: annotationIdsSet.set(annotation.id, annotation);
// With:
if (annotationStore.annotationStubs.size > 0 &&
    !annotationStore.isVisible(annotation.id)) {
  continue;
}
const renderData = annotationStore.annotationStubs.size > 0
  ? annotationStore.getForRendering(annotation.id)
  : annotation;
if (renderData) {
  annotationIdsSet.set(annotation.id, renderData);
}
```

- [ ] **Step 4: Update `displayedAnnotations` computed type**

Change the type from `IAnnotation[]` to `TAnnotationOrStub[]` (line 434).

- [ ] **Step 5: Modify `createGeoJSAnnotation` to handle stubs**

Change the parameter type and add stub handling (line 1272):

```typescript
function createGeoJSAnnotation(
  annotation: TAnnotationOrStub,
  layerId?: string,
) {
  if (!store.dataset || !store.dataset.anyImage()) {
    return null;
  }
  const anyImage = store.dataset.anyImage();
  if (!anyImage) {
    return null;
  }

  const isStub = !isHydratedAnnotation(annotation);
  let coordinates: IGeoJSPosition[];
  let renderShape: AnnotationShape;

  if (isHydratedAnnotation(annotation)) {
    coordinates = unrolledCoordinates(
      annotation.coordinates,
      annotation.location,
      anyImage,
    );
    renderShape = annotation.shape;
  } else {
    coordinates = unrolledCoordinates(
      [annotation.centroid],
      annotation.location,
      anyImage,
    );
    renderShape = AnnotationShape.Point;
  }

  const layer = store.getLayerFromId(layerId);
  const customColor = annotation.color;
  const style = isStub
    ? getStubStyleFromBaseStyle(
        customColor || layer?.color,
        annotation.id === hoveredAnnotationId.value,
        isAnnotationSelected.value(annotation.id),
      )
    : getAnnotationStyle(annotation.id, customColor, layer?.color);

  const options = {
    girderId: annotation.id,
    isHovered: annotation.id === hoveredAnnotationId.value,
    isSelected: isAnnotationSelected.value(annotation.id),
    location: annotation.location,
    channel: annotation.channel,
    color: annotation.color,
    layerId,
    customColor,
    style,
    isStub,
  };

  return geojsAnnotationFactory(renderShape, coordinates, options);
}
```

- [ ] **Step 6: Modify `restyleAnnotations` to handle stubs**

In `restyleAnnotations` (line 1346), extract `isStub` from options and use appropriate styling:

```typescript
function restyleAnnotations() {
  const annotations = props.annotationLayer.annotations();
  const len = annotations.length;
  for (let i = 0; i < len; i++) {
    const geoJSAnnotation = annotations[i];
    const { girderId, layerId, style, customColor, isConnection, isStub } =
      geoJSAnnotation.options();
    if (girderId && !isConnection) {
      const layer = store.getLayerFromId(layerId);
      const newStyle = isStub
        ? getStubStyleFromBaseStyle(
            customColor || layer?.color,
            girderId === hoveredAnnotationId.value,
            isAnnotationSelected.value(girderId),
          )
        : getAnnotationStyle(girderId, customColor, layer?.color);
      geoJSAnnotation.options("style", Object.assign({}, style, newStyle));
    }
  }
  props.annotationLayer.draw();
}
```

- [ ] **Step 7: Update `drawNewAnnotations` restyle path**

In `drawNewAnnotations` (line 789–806), the restyle path for already-drawn annotations also needs the `isStub` flag:

```typescript
// In the existing restyle block:
const { layerId, isHovered, isSelected, style, customColor, isStub } =
  geoJSAnnotation.options();
if (isHovered != isHoveredGT || isSelected != isSelectedGT) {
  const layer = store.getLayerFromId(layerId);
  const newStyle = isStub
    ? getStubStyleFromBaseStyle(
        customColor || layer?.color,
        isHoveredGT,
        isSelectedGT,
      )
    : getAnnotationStyle(annotationId, customColor, layer?.color);
  geoJSAnnotation.options("style", { ...style, ...newStyle });
  geoJSAnnotation.options("isHovered", isHoveredGT);
  geoJSAnnotation.options("isSelected", isSelectedGT);
}
```

- [ ] **Step 8: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: No new errors (there may be downstream type issues in components that consume `displayedAnnotations` — check and fix as needed)

- [ ] **Step 9: Run existing tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/components/AnnotationViewer.vue
git commit -m "feat: integrate visibility system and stub rendering into AnnotationViewer"
```

---

## Task 7: Store Tests for Stub/Hydration Logic

**Files:**
- Create: `src/store/__tests__/annotationStubs.test.ts`

- [ ] **Step 1: Write store stub/hydration tests**

Create `src/store/__tests__/annotationStubs.test.ts`. This tests the store mutations and action added in Task 4.

Key test areas:
- `setAnnotations` creates stubs with correct fields
- `setAnnotations` applies mock data strategy (20% hydrated)
- `addAnnotationImpl` creates both stub and hydrated entry
- `setAnnotation` updates stub and spatial index
- `hydrateAnnotations` fetches from annotations array
- `clearNonSelectedHydration` preserves selected + preserve list
- `updateVisibilityAndHydration` frame filtering, viewport priority, budget limits, hash-based selection
- `getForRendering` returns hydrated if shouldRenderAsShape, stub otherwise
- `isVisible` tracks visibility set correctly

Note: These tests will need to mock the `annotationSpatialIndex` singleton and the store's API layer. Follow the patterns in the existing test files for mocking vuex-module-decorators modules.

- [ ] **Step 2: Run tests**

Run: `pnpm test -- src/store/__tests__/annotationStubs.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/store/__tests__/annotationStubs.test.ts
git commit -m "test: add unit tests for annotation stub/hydration store logic"
```

---

## Verification

After all tasks are complete:

1. **Type check**: `pnpm tsc --noEmit` — no errors
2. **Tests**: `pnpm test` — all pass
3. **Lint**: `pnpm lint` — no new warnings
4. **Build**: `pnpm build` — production build succeeds
5. **Manual verification** (if backend is running):
   - Load a dataset with many annotations
   - Verify annotations render (mix of dots and shapes)
   - Pan/zoom and verify visibility updates (dots appear/disappear based on viewport)
   - Select an annotation — it should hydrate and render as full shape
   - Change Z/Time frame — old frame dehydrates, new frame hydrates
   - Check browser console: `$store.annotation.annotationStubs.size` should show total count
   - Check: `$store.annotation.hydratedAnnotations.size` should show ~20% of total

---

## Key Design Decisions

1. **`markRaw()` on all new Maps/Sets**: Following the existing codebase pattern. Large collections (100K entries) would be expensive to track with deep reactivity. Mutations always replace the Map reference (`this.annotationStubs = markRaw(new Map(...))`) to trigger Vuex reactivity.

2. **Visibility filtering in `layerAnnotations`** (not `displayableAnnotations`): The frame/slice filtering in `layerAnnotations` already iterates all annotations per layer — adding visibility check there avoids a separate filtering pass and keeps the logic co-located with the existing frame matching.

3. **Two spatial indexes coexist**: The existing `displayedAnnotationsSpatialIndex` (RBush in AnnotationViewer, built from bounding boxes of displayed annotations) serves selection hit-testing. The new `annotationSpatialIndex` (module singleton, built from centroids of all annotations) serves viewport-based visibility queries. They are independent.

4. **Mock data strategy in `setAnnotations`**: Hydrates first 20% by array index order. This is temporary — when the backend API returns stubs natively (Phase 5), this mock logic is removed and replaced with real stub fetching.

5. **`annotations[]` array retained**: The full `annotations` array remains for backward compatibility with all existing consumers (AnnotationBrowser, export, property computation, etc.). The stub/hydrated architecture is additive — it provides an optimized rendering path without breaking anything.
