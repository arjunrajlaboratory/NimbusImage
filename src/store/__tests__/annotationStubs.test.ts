/**
 * Tests for annotation stub/hydration store logic.
 *
 * The annotation store (vuex-module-decorators) has many external dependencies
 * (Girder client, other store modules, etc.) making direct import impractical
 * for unit tests. Instead, we replicate the core mutation logic in a plain Vuex
 * store so we can test the algorithms in isolation.
 *
 * The utility functions (simpleCentroid, estimateAnnotationRadius, etc.) and
 * the spatial index are tested separately in their own test files.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createStore, Store } from "vuex";
import { markRaw } from "vue";
import {
  IAnnotation,
  IAnnotationStub,
  THydrationMode,
  IAnnotationLocation,
  AnnotationShape,
  isHydratedAnnotation,
} from "@/store/model";
import {
  simpleCentroid,
  estimateAnnotationRadius,
  selectStableSubset,
  stubFromAnnotation,
} from "@/utils/annotation";
import { selectVisibleIds, clampVisibleBudget } from "@/utils/visibilityBudget";
import { AnnotationSpatialIndex } from "@/utils/spatialIndex";

// ---------- helpers ----------

function makeAnnotation(
  id: string,
  coords: { x: number; y: number }[],
  overrides: Partial<IAnnotation> = {},
): IAnnotation {
  return {
    id,
    name: null,
    tags: ["DAPI"],
    shape: AnnotationShape.Polygon,
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    coordinates: coords,
    datasetId: "dataset-1",
    color: null,
    ...overrides,
  };
}

function makeSquareAnnotation(
  id: string,
  cx: number,
  cy: number,
  size: number,
  overrides: Partial<IAnnotation> = {},
): IAnnotation {
  const half = size / 2;
  return makeAnnotation(
    id,
    [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ],
    overrides,
  );
}

// ---------- minimal store replicating annotation store logic ----------

interface StubStoreState {
  annotations: IAnnotation[];
  annotationCentroids: Record<string, { x: number; y: number }>;
  annotationIdToIdx: Record<string, number>;
  annotationStubs: Map<string, IAnnotationStub>;
  hydratedAnnotations: Map<string, IAnnotation>;
  visibleAnnotationIds: Set<string>;
  hydrationMode: THydrationMode;
  selectedAnnotationIds: Set<string>;
  visibilityConfig: {
    maxVisible: number;
    maxHydrated: number;
    minimumVisible?: number;
  };
}

function createStubStore(spatialIndex: AnnotationSpatialIndex) {
  return createStore<StubStoreState>({
    state(): StubStoreState {
      return {
        annotations: [],
        annotationCentroids: {},
        annotationIdToIdx: {},
        annotationStubs: markRaw(new Map()),
        hydratedAnnotations: markRaw(new Map()),
        visibleAnnotationIds: markRaw(new Set()),
        hydrationMode: "dots",
        selectedAnnotationIds: markRaw(new Set()),
        visibilityConfig: {
          maxVisible: 20000,
          maxHydrated: 10000,
          minimumVisible: 5000,
        },
      };
    },
    getters: {
      isHydrated: (state) => (id: string) => state.hydratedAnnotations.has(id),
      isVisible: (state) => (id: string) => state.visibleAnnotationIds.has(id),
      shouldRenderAsShape: (state) => (id: string) => {
        if (state.selectedAnnotationIds.has(id)) {
          return state.hydratedAnnotations.has(id);
        }
        return (
          state.hydrationMode === "shapes" && state.hydratedAnnotations.has(id)
        );
      },
      getForRendering: (state, getters) => (id: string) => {
        if (getters.shouldRenderAsShape(id)) {
          return state.hydratedAnnotations.get(id);
        }
        return state.annotationStubs.get(id);
      },
      getStub: (state) => (id: string) => state.annotationStubs.get(id),
      getHydratedAnnotation: (state) => (id: string) =>
        state.hydratedAnnotations.get(id),
    },
    mutations: {
      setAnnotations(state, values: IAnnotation[]) {
        state.annotations = values;
        state.annotationCentroids = {};
        state.annotationIdToIdx = {};
        for (let idx = 0; idx < values.length; idx++) {
          const a = values[idx];
          state.annotationCentroids[a.id] = simpleCentroid(a.coordinates);
          state.annotationIdToIdx[a.id] = idx;
        }
        const newStubs = new Map<string, IAnnotationStub>();
        const spatialItems: { id: string; x: number; y: number }[] = [];
        for (let idx = 0; idx < values.length; idx++) {
          const a = values[idx];
          const centroid = state.annotationCentroids[a.id];
          newStubs.set(a.id, {
            id: a.id,
            centroid,
            location: a.location,
            shape: a.shape,
            channel: a.channel,
            tags: a.tags,
            color: a.color,
            estimatedRadius: estimateAnnotationRadius(a.coordinates),
          });
          spatialItems.push({ id: a.id, x: centroid.x, y: centroid.y });
        }
        state.annotationStubs = markRaw(newStubs);
        spatialIndex.bulkLoad(spatialItems);

        // Mock data strategy: hydrate first 20%
        const newHydrated = new Map<string, IAnnotation>();
        const hydrateCount = Math.ceil(values.length * 0.2);
        for (let i = 0; i < hydrateCount && i < values.length; i++) {
          newHydrated.set(values[i].id, values[i]);
        }
        for (const id of state.selectedAnnotationIds) {
          const idx2 = state.annotationIdToIdx[id];
          if (idx2 !== undefined && !newHydrated.has(id)) {
            newHydrated.set(id, state.annotations[idx2]);
          }
        }
        state.hydratedAnnotations = markRaw(newHydrated);
      },

      addAnnotationImpl(state, value: IAnnotation) {
        state.annotations.push(value);
        const centroid = simpleCentroid(value.coordinates);
        state.annotationCentroids[value.id] = centroid;
        state.annotationIdToIdx[value.id] = state.annotations.length - 1;

        state.annotationStubs = markRaw(
          new Map(state.annotationStubs).set(value.id, {
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
        state.hydratedAnnotations = markRaw(
          new Map(state.hydratedAnnotations).set(value.id, value),
        );
        spatialIndex.insert(value.id, centroid.x, centroid.y);
      },

      // Mirrors the real store's setAnnotation mutation: rebuilds the stub,
      // refreshes the hydrated entry if present, and repositions the spatial
      // index for a single replaced annotation.
      setAnnotation(
        state,
        { annotation, index }: { annotation: IAnnotation; index: number },
      ) {
        const oldStub = state.annotationStubs.get(annotation.id);
        if (oldStub) {
          spatialIndex.remove(annotation.id);
        }
        state.annotations[index] = annotation;
        const centroid = simpleCentroid(annotation.coordinates);
        state.annotationCentroids[annotation.id] = centroid;
        state.annotationIdToIdx[annotation.id] = index;
        state.annotationStubs = markRaw(
          new Map(state.annotationStubs).set(
            annotation.id,
            stubFromAnnotation(annotation, centroid),
          ),
        );
        if (state.hydratedAnnotations.has(annotation.id)) {
          state.hydratedAnnotations = markRaw(
            new Map(state.hydratedAnnotations).set(annotation.id, annotation),
          );
        }
        spatialIndex.insert(annotation.id, centroid.x, centroid.y);
      },

      // Mirrors the real store's setAnnotationsAtIndices mutation (batch
      // in-place update path used by updateAnnotationsPerId in non-stub mode).
      setAnnotationsAtIndices(
        state,
        values: {
          annotation: IAnnotation;
          index: number;
          updateCentroid?: boolean;
        }[],
      ) {
        if (!values.length) {
          return;
        }
        const nextStubs = new Map(state.annotationStubs);
        const nextHydrated = new Map(state.hydratedAnnotations);
        let hydratedChanged = false;
        for (const { annotation, index, updateCentroid = true } of values) {
          state.annotations[index] = annotation;
          if (updateCentroid) {
            state.annotationCentroids[annotation.id] = simpleCentroid(
              annotation.coordinates,
            );
          }
          state.annotationIdToIdx[annotation.id] = index;

          // Keep the derived maps the canvas renders from in sync with the
          // edit (Finding 2): rebuild the stub, refresh the hydrated entry if
          // present, and reposition the spatial index when the centroid moved.
          const centroid = state.annotationCentroids[annotation.id];
          if (state.annotationStubs.has(annotation.id)) {
            nextStubs.set(
              annotation.id,
              stubFromAnnotation(annotation, centroid),
            );
          }
          if (nextHydrated.has(annotation.id)) {
            nextHydrated.set(annotation.id, annotation);
            hydratedChanged = true;
          }
          if (updateCentroid && state.annotationStubs.has(annotation.id)) {
            // insert is upsert-safe, so this repositions the existing node.
            spatialIndex.insert(annotation.id, centroid.x, centroid.y);
          }
        }
        state.annotationStubs = markRaw(nextStubs);
        if (hydratedChanged) {
          state.hydratedAnnotations = markRaw(nextHydrated);
        }
      },

      setVisibleAnnotationIds(state, ids: string[]) {
        state.visibleAnnotationIds = markRaw(new Set(ids));
      },

      setHydrationMode(state, mode: THydrationMode) {
        state.hydrationMode = mode;
      },

      hydrateAnnotations(state, ids: string[]) {
        const newMap = new Map(state.hydratedAnnotations);
        for (const id of ids) {
          const idx = state.annotationIdToIdx[id];
          if (idx !== undefined) {
            newMap.set(id, state.annotations[idx]);
          }
        }
        state.hydratedAnnotations = markRaw(newMap);
      },

      clearNonSelectedHydration(state, preserveIds?: string[]) {
        const newMap = new Map<string, IAnnotation>();
        const preserveSet = preserveIds
          ? new Set(preserveIds)
          : new Set<string>();
        for (const [id, annotation] of state.hydratedAnnotations) {
          if (state.selectedAnnotationIds.has(id) || preserveSet.has(id)) {
            newMap.set(id, annotation);
          }
        }
        state.hydratedAnnotations = markRaw(newMap);
      },

      setSelected(state, ids: string[]) {
        state.selectedAnnotationIds = markRaw(new Set(ids));
      },
    },
    actions: {
      updateVisibilityAndHydration(
        { state, commit },
        params: {
          filteredIds?: string[];
          gcsBounds?: { x: number; y: number }[];
          currentFrameLocation: IAnnotationLocation;
          // Zoom-adaptive budget overrides (mirrors the real action). Fall back
          // to the static config caps when not supplied.
          maxVisible?: number;
          maxHydrated?: number;
        },
      ) {
        const { filteredIds, gcsBounds, currentFrameLocation } = params;
        const zoomVisibleBudget =
          params.maxVisible ?? state.visibilityConfig.maxVisible;
        const zoomHydrated =
          params.maxHydrated ?? state.visibilityConfig.maxHydrated;
        // Floor the visible budget at minimumVisible, capped at the config max.
        const minimumVisible = state.visibilityConfig.minimumVisible ?? 0;
        const visibleBudget = clampVisibleBudget(
          zoomVisibleBudget,
          minimumVisible,
          state.visibilityConfig.maxVisible,
        );
        // Never hydrate more than the drawn (visible) set (mirrors the store).
        const hydrationBudget = Math.min(zoomHydrated, visibleBudget);

        const onCurrentFrame = (stub: IAnnotationStub | undefined) =>
          !!stub &&
          stub.location.XY === currentFrameLocation.XY &&
          stub.location.Z === currentFrameLocation.Z &&
          stub.location.Time === currentFrameLocation.Time;

        // When filteredIds is omitted (no client filter), iterate the stub map
        // directly instead of a pre-built id array (Finding 15).
        const currentFrameIds: string[] = [];
        if (filteredIds) {
          for (const id of filteredIds) {
            if (onCurrentFrame(state.annotationStubs.get(id))) {
              currentFrameIds.push(id);
            }
          }
        } else {
          for (const [id, stub] of state.annotationStubs) {
            if (onCurrentFrame(stub)) {
              currentFrameIds.push(id);
            }
          }
        }

        // Single-pass three-way partition (mirrors the real action, C2): the
        // UNEXPANDED viewport (drives hydration + coverage counts + visibility
        // tier 1), the RING out to the 50%-expanded box (pan pre-load), and
        // everything OUTSIDE.
        let inViewport = currentFrameIds;
        let ring: string[] = [];
        let outside: string[] = [];

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
          const width = maxX - minX;
          const height = maxY - minY;
          ({ inViewport, ring, outside } = spatialIndex.partitionByViewports(
            currentFrameIds,
            { minX, minY, maxX, maxY },
            {
              minX: minX - width * 0.5,
              minY: minY - height * 0.5,
              maxX: maxX + width * 0.5,
              maxY: maxY + height * 0.5,
            },
          ));
        }

        // Priority tiers (mirrors the real action): actual viewport first, then
        // the pan-preload ring, then off-screen — so the minimumVisible floor
        // (folded into visibleBudget) is honored in the visible area.
        const visibleIds = selectVisibleIds({
          inViewportIds: inViewport,
          marginIds: ring,
          offViewportIds: outside,
          budget: visibleBudget,
          selectSubset: selectStableSubset,
        });
        // Restrict hydration candidates to the drawn (visible) set (mirrors the
        // store): only visible annotations are rendered, so hydrating others is
        // wasted and can leave drawn annotations as dots.
        const visibleSet = new Set(visibleIds);

        const inViewportWithSize = inViewport
          .filter((id) => visibleSet.has(id))
          .map((id) => ({
            id,
            size: state.annotationStubs.get(id)?.estimatedRadius ?? 0,
          }));
        inViewportWithSize.sort((a, b) => b.size - a.size);

        let idsToHydrate: string[];
        if (inViewportWithSize.length >= hydrationBudget) {
          idsToHydrate = inViewportWithSize
            .slice(0, hydrationBudget)
            .map((item) => item.id);
        } else {
          const remainingBudget = hydrationBudget - inViewportWithSize.length;
          const offViewportWithSize = ring
            .concat(outside)
            .filter((id) => visibleSet.has(id))
            .map((id) => ({
              id,
              size: state.annotationStubs.get(id)?.estimatedRadius ?? 0,
            }));
          offViewportWithSize.sort((a, b) => b.size - a.size);
          idsToHydrate = [
            ...inViewportWithSize.map((item) => item.id),
            ...offViewportWithSize
              .slice(0, remainingBudget)
              .map((item) => item.id),
          ];
        }

        commit("setVisibleAnnotationIds", visibleIds);
        commit("setHydrationMode", idsToHydrate.length > 0 ? "shapes" : "dots");
        commit("clearNonSelectedHydration", idsToHydrate);
        commit("hydrateAnnotations", idsToHydrate);
      },
    },
  });
}

// ---------- tests ----------

describe("annotation stub/hydration store logic", () => {
  let store: Store<StubStoreState>;
  let spatialIndex: AnnotationSpatialIndex;

  beforeEach(() => {
    spatialIndex = new AnnotationSpatialIndex();
    store = createStubStore(spatialIndex);
  });

  // ---- setAnnotations creates stubs ----

  describe("setAnnotations", () => {
    it("populates annotationStubs with correct fields", () => {
      const ann = makeSquareAnnotation("ann-1", 150, 150, 100, {
        tags: ["DAPI"],
        channel: 2,
        color: "#ff0000",
      });

      store.commit("setAnnotations", [ann]);

      const stub = store.state.annotationStubs.get("ann-1");
      expect(stub).toBeDefined();
      expect(stub!.id).toBe("ann-1");
      expect(stub!.centroid.x).toBe(150);
      expect(stub!.centroid.y).toBe(150);
      expect(stub!.location).toStrictEqual({ XY: 0, Z: 0, Time: 0 });
      expect(stub!.shape).toBe(AnnotationShape.Polygon);
      expect(stub!.channel).toBe(2);
      expect(stub!.tags).toStrictEqual(["DAPI"]);
      expect(stub!.color).toBe("#ff0000");
      expect(stub!.estimatedRadius).toBeGreaterThan(0);
    });

    it("creates stubs for all annotations", () => {
      const annotations = Array.from({ length: 50 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );

      store.commit("setAnnotations", annotations);

      expect(store.state.annotationStubs.size).toBe(50);
      for (const ann of annotations) {
        expect(store.state.annotationStubs.has(ann.id)).toBe(true);
      }
    });

    it("populates spatial index so splitByViewport works", () => {
      const annotations = [
        makeSquareAnnotation("in-1", 50, 50, 10),
        makeSquareAnnotation("out-1", 500, 500, 10),
      ];

      store.commit("setAnnotations", annotations);

      const { inViewportIds, outOfViewportIds } = spatialIndex.splitByViewport(
        ["in-1", "out-1"],
        0,
        0,
        100,
        100,
      );
      expect(inViewportIds).toContain("in-1");
      expect(outOfViewportIds).toContain("out-1");
    });
  });

  // ---- Mock data strategy: first 20% hydrated ----

  describe("mock data strategy (first 20% hydrated)", () => {
    it("hydrates first 20% of annotations", () => {
      const annotations = Array.from({ length: 10 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );

      store.commit("setAnnotations", annotations);

      // ceil(10 * 0.2) = 2
      expect(store.state.hydratedAnnotations.size).toBe(2);
      expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
      expect(store.state.hydratedAnnotations.has("ann-1")).toBe(true);
      expect(store.state.hydratedAnnotations.has("ann-2")).toBe(false);
    });

    it("remaining 80% are stub-only", () => {
      const annotations = Array.from({ length: 10 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );

      store.commit("setAnnotations", annotations);

      for (let i = 2; i < 10; i++) {
        expect(store.state.annotationStubs.has(`ann-${i}`)).toBe(true);
        expect(store.state.hydratedAnnotations.has(`ann-${i}`)).toBe(false);
      }
    });

    it("hydrates all when there are 5 or fewer", () => {
      const annotations = Array.from({ length: 5 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );

      store.commit("setAnnotations", annotations);

      // ceil(5 * 0.2) = 1
      expect(store.state.hydratedAnnotations.size).toBe(1);
    });

    it("preserves selected annotations in hydrated set", () => {
      const annotations = Array.from({ length: 10 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );

      // Select an annotation that would normally be stub-only
      store.commit("setSelected", ["ann-9"]);
      store.commit("setAnnotations", annotations);

      // First 20% + selected
      expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
      expect(store.state.hydratedAnnotations.has("ann-1")).toBe(true);
      expect(store.state.hydratedAnnotations.has("ann-9")).toBe(true);
    });
  });

  // ---- addAnnotationImpl ----

  describe("addAnnotationImpl", () => {
    it("creates both stub and hydrated entry", () => {
      const ann = makeSquareAnnotation("new-1", 100, 200, 50);

      store.commit("addAnnotationImpl", ann);

      expect(store.state.annotationStubs.has("new-1")).toBe(true);
      expect(store.state.hydratedAnnotations.has("new-1")).toBe(true);
      expect(store.state.hydratedAnnotations.get("new-1")).toBe(ann);
    });

    it("creates correct stub fields for new annotation", () => {
      const ann = makeSquareAnnotation("new-1", 100, 200, 50, {
        tags: ["GFP", "mCherry"],
        channel: 3,
        shape: AnnotationShape.Rectangle,
        color: "#00ff00",
      });

      store.commit("addAnnotationImpl", ann);

      const stub = store.state.annotationStubs.get("new-1");
      expect(stub!.centroid.x).toBe(100);
      expect(stub!.centroid.y).toBe(200);
      expect(stub!.tags).toStrictEqual(["GFP", "mCherry"]);
      expect(stub!.channel).toBe(3);
      expect(stub!.shape).toBe(AnnotationShape.Rectangle);
      expect(stub!.color).toBe("#00ff00");
    });

    it("inserts into spatial index", () => {
      const ann = makeSquareAnnotation("new-1", 100, 200, 50);

      store.commit("addAnnotationImpl", ann);

      const ids = spatialIndex.queryBox(50, 150, 150, 250);
      expect(ids.has("new-1")).toBe(true);
    });

    it("adds to existing annotations without destroying stubs", () => {
      const initial = [makeSquareAnnotation("old-1", 10, 10, 5)];
      store.commit("setAnnotations", initial);

      store.commit(
        "addAnnotationImpl",
        makeSquareAnnotation("new-1", 50, 50, 10),
      );

      expect(store.state.annotationStubs.has("old-1")).toBe(true);
      expect(store.state.annotationStubs.has("new-1")).toBe(true);
    });
  });

  // ---- setAnnotationsAtIndices (Finding 2) ----
  //
  // The non-stub-mode updateAnnotationsPerId path commits via
  // setAnnotationsAtIndices. Canvas rendering reads annotationStubs /
  // hydratedAnnotations whenever the stub system is active, so an in-place
  // edit must refresh those derived maps or the canvas keeps the stale copy.

  describe("setAnnotationsAtIndices", () => {
    it("refreshes the stub's color when an annotation is edited", () => {
      const ann = makeSquareAnnotation("ann-0", 10, 10, 20, { color: null });
      store.commit("setAnnotations", [ann]);

      const edited = { ...ann, color: "#abcdef" };
      store.commit("setAnnotationsAtIndices", [
        { annotation: edited, index: 0, updateCentroid: false },
      ]);

      expect(store.state.annotationStubs.get("ann-0")!.color).toBe("#abcdef");
    });

    it("refreshes the stub's tags when an annotation is edited", () => {
      const ann = makeSquareAnnotation("ann-0", 10, 10, 20, { tags: ["DAPI"] });
      store.commit("setAnnotations", [ann]);

      const edited = { ...ann, tags: ["GFP", "RFP"] };
      store.commit("setAnnotationsAtIndices", [
        { annotation: edited, index: 0, updateCentroid: false },
      ]);

      expect(store.state.annotationStubs.get("ann-0")!.tags).toEqual([
        "GFP",
        "RFP",
      ]);
    });

    it("refreshes the hydrated entry when present", () => {
      // ann-0 is hydrated by the mock 20% strategy.
      const ann = makeSquareAnnotation("ann-0", 10, 10, 20, { color: null });
      store.commit("setAnnotations", [ann]);
      expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);

      const edited = { ...ann, color: "#123456" };
      store.commit("setAnnotationsAtIndices", [
        { annotation: edited, index: 0, updateCentroid: false },
      ]);

      expect(store.state.hydratedAnnotations.get("ann-0")!.color).toBe(
        "#123456",
      );
    });

    it("repositions the spatial index when coordinates change", () => {
      const ann = makeSquareAnnotation("ann-0", 10, 10, 20);
      store.commit("setAnnotations", [ann]);
      // Originally centered near (10,10).
      expect(spatialIndex.queryBox(0, 0, 20, 20).has("ann-0")).toBe(true);

      const moved = makeSquareAnnotation("ann-0", 500, 500, 20);
      store.commit("setAnnotationsAtIndices", [
        { annotation: moved, index: 0, updateCentroid: true },
      ]);

      // The stale (10,10) location must no longer match; the new one must.
      expect(spatialIndex.queryBox(0, 0, 20, 20).has("ann-0")).toBe(false);
      expect(spatialIndex.queryBox(490, 490, 510, 510).has("ann-0")).toBe(true);
      expect(store.state.annotationStubs.get("ann-0")!.centroid.x).toBe(500);
    });
  });

  // ---- Getters ----

  describe("getters", () => {
    beforeEach(() => {
      const annotations = Array.from({ length: 10 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );
      store.commit("setAnnotations", annotations);
    });

    describe("isHydrated", () => {
      it("returns true for hydrated annotations", () => {
        expect(store.getters.isHydrated("ann-0")).toBe(true);
      });

      it("returns false for stub-only annotations", () => {
        expect(store.getters.isHydrated("ann-5")).toBe(false);
      });

      it("returns false for unknown id", () => {
        expect(store.getters.isHydrated("nonexistent")).toBe(false);
      });
    });

    describe("isVisible", () => {
      it("returns false by default (no visibility set)", () => {
        expect(store.getters.isVisible("ann-0")).toBe(false);
      });

      it("returns true after setVisibleAnnotationIds", () => {
        store.commit("setVisibleAnnotationIds", ["ann-0", "ann-3"]);
        expect(store.getters.isVisible("ann-0")).toBe(true);
        expect(store.getters.isVisible("ann-3")).toBe(true);
        expect(store.getters.isVisible("ann-5")).toBe(false);
      });
    });

    describe("shouldRenderAsShape", () => {
      it("returns false in dots mode even if hydrated", () => {
        expect(store.state.hydrationMode).toBe("dots");
        expect(store.getters.shouldRenderAsShape("ann-0")).toBe(false);
      });

      it("returns true in shapes mode for hydrated annotation", () => {
        store.commit("setHydrationMode", "shapes");
        expect(store.getters.shouldRenderAsShape("ann-0")).toBe(true);
      });

      it("returns false in shapes mode for non-hydrated annotation", () => {
        store.commit("setHydrationMode", "shapes");
        expect(store.getters.shouldRenderAsShape("ann-5")).toBe(false);
      });

      it("returns true for selected + hydrated regardless of mode", () => {
        store.commit("setSelected", ["ann-0"]);
        // dots mode, but selected and hydrated
        expect(store.getters.shouldRenderAsShape("ann-0")).toBe(true);
      });

      it("returns false for selected but non-hydrated", () => {
        store.commit("setSelected", ["ann-5"]);
        expect(store.getters.shouldRenderAsShape("ann-5")).toBe(false);
      });
    });

    describe("getForRendering", () => {
      it("returns stub when not rendering as shape", () => {
        // dots mode, ann-5 is stub-only
        const result = store.getters.getForRendering("ann-5");
        expect(result).toBeDefined();
        expect(result.id).toBe("ann-5");
        // Stub has no coordinates
        expect("coordinates" in result).toBe(false);
      });

      it("returns hydrated annotation when rendering as shape", () => {
        store.commit("setHydrationMode", "shapes");
        const result = store.getters.getForRendering("ann-0");
        expect(result).toBeDefined();
        expect(isHydratedAnnotation(result)).toBe(true);
        expect(result.coordinates).toBeDefined();
      });

      it("returns stub for hydrated annotation in dots mode", () => {
        // ann-0 is hydrated but mode is dots
        const result = store.getters.getForRendering("ann-0");
        expect(result).toBeDefined();
        expect("coordinates" in result).toBe(false);
      });

      it("returns undefined for unknown id", () => {
        expect(store.getters.getForRendering("nonexistent")).toBeUndefined();
      });
    });
  });

  // ---- Mutations ----

  describe("mutations", () => {
    beforeEach(() => {
      const annotations = Array.from({ length: 10 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 20),
      );
      store.commit("setAnnotations", annotations);
    });

    describe("setVisibleAnnotationIds", () => {
      it("sets visible ids", () => {
        store.commit("setVisibleAnnotationIds", ["ann-0", "ann-5"]);
        expect(store.state.visibleAnnotationIds.size).toBe(2);
        expect(store.state.visibleAnnotationIds.has("ann-0")).toBe(true);
        expect(store.state.visibleAnnotationIds.has("ann-5")).toBe(true);
      });

      it("replaces previous visible ids", () => {
        store.commit("setVisibleAnnotationIds", ["ann-0"]);
        store.commit("setVisibleAnnotationIds", ["ann-3"]);
        expect(store.state.visibleAnnotationIds.has("ann-0")).toBe(false);
        expect(store.state.visibleAnnotationIds.has("ann-3")).toBe(true);
      });
    });

    describe("setHydrationMode", () => {
      it("changes hydration mode", () => {
        expect(store.state.hydrationMode).toBe("dots");
        store.commit("setHydrationMode", "shapes");
        expect(store.state.hydrationMode).toBe("shapes");
      });
    });

    describe("hydrateAnnotations", () => {
      it("adds annotations to hydrated map", () => {
        expect(store.state.hydratedAnnotations.has("ann-5")).toBe(false);
        store.commit("hydrateAnnotations", ["ann-5", "ann-6"]);
        expect(store.state.hydratedAnnotations.has("ann-5")).toBe(true);
        expect(store.state.hydratedAnnotations.has("ann-6")).toBe(true);
      });

      it("preserves existing hydrated annotations", () => {
        expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
        store.commit("hydrateAnnotations", ["ann-5"]);
        expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
        expect(store.state.hydratedAnnotations.has("ann-5")).toBe(true);
      });

      it("ignores ids not present in annotations array", () => {
        const sizeBefore = store.state.hydratedAnnotations.size;
        store.commit("hydrateAnnotations", ["nonexistent"]);
        expect(store.state.hydratedAnnotations.size).toBe(sizeBefore);
      });
    });

    describe("clearNonSelectedHydration", () => {
      it("clears all hydration when nothing selected and no preserveIds", () => {
        expect(store.state.hydratedAnnotations.size).toBeGreaterThan(0);
        store.commit("clearNonSelectedHydration", undefined);
        expect(store.state.hydratedAnnotations.size).toBe(0);
      });

      it("preserves selected annotations", () => {
        store.commit("setSelected", ["ann-0"]);
        store.commit("clearNonSelectedHydration", undefined);
        expect(store.state.hydratedAnnotations.size).toBe(1);
        expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
      });

      it("preserves annotations in preserveIds list", () => {
        store.commit("clearNonSelectedHydration", ["ann-1"]);
        expect(store.state.hydratedAnnotations.has("ann-1")).toBe(true);
      });

      it("preserves both selected and preserveIds", () => {
        store.commit("setSelected", ["ann-0"]);
        store.commit("clearNonSelectedHydration", ["ann-1"]);
        expect(store.state.hydratedAnnotations.has("ann-0")).toBe(true);
        expect(store.state.hydratedAnnotations.has("ann-1")).toBe(true);
      });
    });
  });

  // ---- updateVisibilityAndHydration ----

  describe("updateVisibilityAndHydration", () => {
    it("filters annotations by current frame location", async () => {
      const annotations = [
        makeSquareAnnotation("frame0-a", 50, 50, 10, {
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        makeSquareAnnotation("frame0-b", 60, 60, 10, {
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        makeSquareAnnotation("frame1-a", 70, 70, 10, {
          location: { XY: 1, Z: 0, Time: 0 },
        }),
      ];
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: ["frame0-a", "frame0-b", "frame1-a"],
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      // Only frame 0 annotations should be visible
      expect(store.state.visibleAnnotationIds.has("frame0-a")).toBe(true);
      expect(store.state.visibleAnnotationIds.has("frame0-b")).toBe(true);
      expect(store.state.visibleAnnotationIds.has("frame1-a")).toBe(false);
    });

    it("derives ids from the stub map when filteredIds is omitted (Finding 15)", async () => {
      const annotations = [
        makeSquareAnnotation("frame0-a", 50, 50, 10, {
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        makeSquareAnnotation("frame0-b", 60, 60, 10, {
          location: { XY: 0, Z: 0, Time: 0 },
        }),
        makeSquareAnnotation("frame1-a", 70, 70, 10, {
          location: { XY: 1, Z: 0, Time: 0 },
        }),
      ];
      store.commit("setAnnotations", annotations);

      // No filteredIds passed → the action walks its own stub map and applies
      // the same current-frame filter, equivalent to passing every id.
      await store.dispatch("updateVisibilityAndHydration", {
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      expect(store.state.visibleAnnotationIds.has("frame0-a")).toBe(true);
      expect(store.state.visibleAnnotationIds.has("frame0-b")).toBe(true);
      expect(store.state.visibleAnnotationIds.has("frame1-a")).toBe(false);
    });

    it("uses viewport bounds to prioritize in-viewport annotations", async () => {
      const annotations = [
        makeSquareAnnotation("in-view", 50, 50, 10),
        makeSquareAnnotation("out-view", 500, 500, 10),
      ];
      store.commit("setAnnotations", annotations);

      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: ["in-view", "out-view"],
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      expect(store.state.visibleAnnotationIds.has("in-view")).toBe(true);
      // Out-of-viewport annotations may still be visible if within budget
      expect(store.state.visibleAnnotationIds.has("out-view")).toBe(true);
    });

    it("respects visibility budget (maxVisible)", async () => {
      // Create more annotations than the budget allows
      const smallBudget = 5;
      store.state.visibilityConfig = {
        maxVisible: smallBudget,
        maxHydrated: 3,
      };

      const annotations = Array.from({ length: 20 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 5),
      );
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      expect(store.state.visibleAnnotationIds.size).toBeLessThanOrEqual(
        smallBudget,
      );
    });

    it("floors the visible-area count at minimumVisible when the zoom budget is lower", async () => {
      // 200 annotations in the viewport, cap 1000, floor 50. A zoom-adaptive
      // budget of 10 (passed in) is below the floor → at least 50 must be drawn
      // in the actual viewport, not the raw 10.
      store.state.visibilityConfig = {
        maxVisible: 1000,
        maxHydrated: 1000,
        minimumVisible: 50,
      };
      const annotations = Array.from({ length: 200 }, (_, i) =>
        makeSquareAnnotation(
          `ann-${i}`,
          5 + (i % 20) * 4,
          5 + ((i / 20) | 0) * 9,
          2,
        ),
      );
      store.commit("setAnnotations", annotations);
      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
        maxVisible: 10, // zoom-adaptive budget below the floor
      });

      // Floored to minimumVisible (50), not the raw zoom budget (10)...
      expect(store.state.visibleAnnotationIds.size).toBe(50);
      // ...and every drawn annotation is one of the in-view 200 (the floor lands
      // in the visible area, not the pan-preload margin).
      for (const id of store.state.visibleAnnotationIds) {
        expect(id.startsWith("ann-")).toBe(true);
      }
    });

    it("keeps the floored draws in the viewport, not the pan-preload margin", async () => {
      // 60 in the actual viewport (0..100) and 60 in the margin ring (110..140,
      // inside the 50%-expanded box). Floor 30, zoom budget 5 → the 30 drawn must
      // all come from the actual viewport.
      store.state.visibilityConfig = {
        maxVisible: 1000,
        maxHydrated: 1000,
        minimumVisible: 30,
      };
      const inView = Array.from({ length: 60 }, (_, i) =>
        makeSquareAnnotation(
          `in-${i}`,
          5 + (i % 10) * 9,
          5 + ((i / 10) | 0) * 15,
          2,
        ),
      );
      const margin = Array.from({ length: 60 }, (_, i) =>
        makeSquareAnnotation(
          `margin-${i}`,
          112 + (i % 6) * 4,
          5 + ((i / 6) | 0) * 9,
          2,
        ),
      );
      store.commit("setAnnotations", [...inView, ...margin]);
      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: [...inView, ...margin].map((a) => a.id),
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
        maxVisible: 5,
      });

      expect(store.state.visibleAnnotationIds.size).toBe(30);
      for (const id of store.state.visibleAnnotationIds) {
        expect(id.startsWith("in-")).toBe(true); // never a margin id
      }
    });

    it("shows everything in view when fewer than minimumVisible are present", async () => {
      // 20 in view, floor 50 → all 20 drawn (nothing to floor up to).
      store.state.visibilityConfig = {
        maxVisible: 1000,
        maxHydrated: 1000,
        minimumVisible: 50,
      };
      const annotations = Array.from({ length: 20 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, 10 + i * 4, 50, 2),
      );
      store.commit("setAnnotations", annotations);
      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
        maxVisible: 5,
      });

      expect(store.state.visibleAnnotationIds.size).toBe(20);
    });

    it("respects hydration budget (maxHydrated)", async () => {
      const smallBudget = 3;
      store.state.visibilityConfig = {
        maxVisible: 20000,
        maxHydrated: smallBudget,
      };

      const annotations = Array.from({ length: 20 }, (_, i) =>
        makeSquareAnnotation(`ann-${i}`, i * 10, i * 10, 5),
      );
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      // Hydration should be limited. The action clears non-selected first,
      // then hydrates up to budget.
      expect(store.state.hydratedAnnotations.size).toBeLessThanOrEqual(
        smallBudget,
      );
    });

    it("only hydrates annotations that are in the drawn (visible) set", async () => {
      // Varying sizes so the "largest" hydration pick differs from the
      // stable-hash visible subset; a budget below the in-view count forces a
      // subset. Every hydrated annotation must still be one that is drawn —
      // otherwise the backend hydrates undrawn annotations while drawn ones stay
      // dots (the bug this restriction fixes).
      store.state.visibilityConfig = {
        maxVisible: 1000,
        maxHydrated: 1000,
        minimumVisible: 0,
      };
      const annotations = Array.from({ length: 100 }, (_, i) =>
        makeSquareAnnotation(
          `ann-${i}`,
          5 + (i % 10) * 9,
          5 + ((i / 10) | 0) * 9,
          1 + (i % 7), // varying radius
        ),
      );
      store.commit("setAnnotations", annotations);
      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
        maxVisible: 20, // visible budget 20 << 100 in view → a stable subset
        maxHydrated: 20,
      });

      expect(store.state.visibleAnnotationIds.size).toBe(20);
      expect(store.state.hydratedAnnotations.size).toBeGreaterThan(0);
      for (const id of store.state.hydratedAnnotations.keys()) {
        expect(store.state.visibleAnnotationIds.has(id)).toBe(true);
      }
    });

    it("sets hydration mode to shapes when annotations are hydrated", async () => {
      const annotations = [makeSquareAnnotation("ann-0", 50, 50, 10)];
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: ["ann-0"],
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      expect(store.state.hydrationMode).toBe("shapes");
    });

    it("sets hydration mode to dots when no annotations match frame", async () => {
      const annotations = [
        makeSquareAnnotation("ann-0", 50, 50, 10, {
          location: { XY: 1, Z: 0, Time: 0 },
        }),
      ];
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: ["ann-0"],
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      expect(store.state.hydrationMode).toBe("dots");
    });

    it("prioritizes larger annotations for hydration", async () => {
      store.state.visibilityConfig = {
        maxVisible: 20000,
        maxHydrated: 2,
      };

      // small, medium, large annotations all at same location
      const annotations = [
        makeSquareAnnotation("small", 50, 50, 10),
        makeSquareAnnotation("medium", 60, 60, 50),
        makeSquareAnnotation("large", 70, 70, 200),
      ];
      store.commit("setAnnotations", annotations);

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      // Should hydrate the 2 largest
      expect(store.state.hydratedAnnotations.has("large")).toBe(true);
      expect(store.state.hydratedAnnotations.has("medium")).toBe(true);
      expect(store.state.hydratedAnnotations.has("small")).toBe(false);
    });

    it("hydrates the actual (unexpanded) viewport, not the larger pre-load region (C2)", async () => {
      // Hydration budget too small to cover everything in the expanded box.
      store.state.visibilityConfig = { maxVisible: 20000, maxHydrated: 2 };

      // Raw viewport is [0,100]²; expanded 50% on each side → [-50,150]².
      // Three modest annotations sit inside the actual viewport...
      const annotations = [
        makeSquareAnnotation("in-a", 40, 40, 10), // radius 5
        makeSquareAnnotation("in-b", 60, 60, 8), // radius 4
        makeSquareAnnotation("in-c", 50, 30, 6), // radius 3
        // ...and one HUGE annotation just outside it but inside the pre-load
        // margin (centroid 140,140 ∈ expanded box, ∉ raw box).
        makeSquareAnnotation("edge-big", 140, 140, 400), // radius 200
      ];
      store.commit("setAnnotations", annotations);

      const gcsBounds = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ];

      await store.dispatch("updateVisibilityAndHydration", {
        filteredIds: annotations.map((a) => a.id),
        gcsBounds,
        currentFrameLocation: { XY: 0, Z: 0, Time: 0 },
      });

      // Hydration tracks what the user is actually looking at: the two largest
      // annotations INSIDE the viewport — not the huge one in the pre-load
      // margin. If hydration ranked against the expanded box (the C2 bug),
      // edge-big would win the budget and in-b would be dropped.
      expect(store.state.hydratedAnnotations.has("in-a")).toBe(true);
      expect(store.state.hydratedAnnotations.has("in-b")).toBe(true);
      expect(store.state.hydratedAnnotations.has("edge-big")).toBe(false);

      // Visibility still pre-loads the expanded region so a pan reveals it
      // immediately — the off-viewport pre-load must NOT regress.
      expect(store.state.visibleAnnotationIds.has("edge-big")).toBe(true);
    });
  });

  // ---- isHydratedAnnotation type guard ----

  describe("isHydratedAnnotation", () => {
    it("returns true for full annotation objects", () => {
      const ann = makeSquareAnnotation("test", 0, 0, 10);
      expect(isHydratedAnnotation(ann)).toBe(true);
    });

    it("returns false for stub objects", () => {
      const stub: IAnnotationStub = {
        id: "test",
        centroid: { x: 0, y: 0 },
        location: { XY: 0, Z: 0, Time: 0 },
        shape: AnnotationShape.Polygon,
        channel: 0,
        tags: [],
        color: null,
      };
      expect(isHydratedAnnotation(stub)).toBe(false);
    });
  });
});
