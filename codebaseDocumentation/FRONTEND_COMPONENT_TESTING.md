# Frontend Component Test Harness (Vitest + `<script setup>`)

How to write and extend the large component tests in `src/components/` — chiefly
`AnnotationViewer.test.ts` and `ImageViewer.test.ts`. These files mount a real Vue
component against mocked stores and a mocked GeoJS, then exercise its internal
functions and watchers. The mechanics below are non-obvious and cost real time to
rediscover; read this before adding cases.

## General patterns (any `<script setup>` component test here)

### 1. Store mocks are `reactive()` — you can drive watchers post-mount

Each store is `vi.mock`ed with a `reactive({...})` object (see the top of
`AnnotationViewer.test.ts`). Because the mock is reactive, mutating it **after**
mount re-runs the component's computeds and watchers:

```ts
mockedStore.z = 1;                 // frame refs are computed(() => store.z)
await wrapper.vm.$nextTick();       // let watchers flush
```

Frame indices are `const xy/z/time = computed(() => store.xy/z/time)`, so a store
mutation propagates through any computed/watcher that depends on them. A `beforeEach`
resets the common fields (`annotations`, `xy/z/time`, `drawAnnotations`,
`visibilityConfig`, …) — set your scenario state **after** the reset (or before
mount) and mutate again to trigger the watcher you're testing.

### 2. You cannot spy on `<script setup>` closures

Watchers and internal callbacks invoke the original function closure, **not** the
property exposed via `defineExpose`. `vi.spyOn(wrapper.vm, "someFn")` replaces the
proxy property but the watcher still calls the closure, so the spy never fires. The
existing tests note this inline ("In Vue 3 `<script setup>`, can't spy on closure
functions").

Consequences:
- To confirm a **watcher** fired, assert a **side effect**, not a spy on the
  handler. Good observable side effects: `annotationLayer.draw` (a `vi.fn` on the
  mock layer), the mock layer's `annotations()` contents, or an exposed computed
  like `wrapper.vm.displayedAnnotations`.
- Spying only works when the code path calls the function **through** `wrapper.vm`
  (i.e. you invoke it yourself in the test), as in the `onDisplayedAnnotationsChange`
  → `drawAnnotationsAndTooltips` skip test.
- Many internal functions are exposed for direct invocation (`clearOldAnnotations`,
  `drawNewAnnotations`, `drawAnnotationsNoThrottle`, `onDisplayedAnnotationsChange`,
  `handlingPrimaryChange`, `displayedAnnotations`, …). Prefer calling those directly
  over trying to trigger them through the reactive graph when you only need the unit
  behavior.

### 3. Fake timers are active — flush throttled/debounced work explicitly

`beforeEach` calls `vi.useFakeTimers()` (and `vi.useRealTimers()` in `afterEach`).
The draw path is throttled: `drawAnnotations = throttle(drawAnnotationsNoThrottle,
THROTTLE)` with `THROTTLE = 100`. Lodash `throttle` fires the **leading** edge
synchronously but defers trailing calls to a timer, and visibility uses
`debounce(updateVisibility, 250)`. After a change that schedules a deferred draw:

```ts
await wrapper.vm.$nextTick();      // run the watcher
vi.advanceTimersByTime(101);        // flush the trailing throttled draw
```

Advance past the window (`> 100`) between successive frame changes so the next call
lands on a fresh leading edge rather than being coalesced into a trailing one.

## AnnotationViewer-specific mocks

### `@/utils/annotation` is mock-mirrored, not imported

Importing the real `@/utils/annotation` pulls in a heavy transitive graph that OOMs
this large test file, so the mock provides **faithful hand-copies** of the small
pure helpers the component calls (`drawnFeatureUnchanged`, `geometryKeyForRender`,
`drawnFeatureUsesDotStyle`, `shouldRetainFeature`, …). The real implementations are
unit-tested separately in `src/utils/__tests__/annotationStubUtils.test.ts`.

**Gotcha:** if you add an exported helper from `@/utils/annotation` that the
component starts using, you must add it to this mock too, or every test in the file
fails with `No "<name>" export is defined on the "@/utils/annotation" mock`.

### `geojsAnnotationFactory` ignores its arguments

The default mock returns a bare `mockGeoJSAnnotation()` and does **not** apply the
`options` (girderId, layerId, color, …) the component passes. So a created feature
has no identity unless you opt in:

```ts
(geojsAnnotationFactory as any).mockImplementation(
  (_shape, _coords, options) => {
    const feature = mockGeoJSAnnotation("point");
    if (options) feature.options(options);   // now feature.options("girderId") works
    return feature;
  },
);
```

Do this whenever a test needs to read the **drawn set** by id (e.g. asserting which
annotations a frame shows).

### `mockGeoJSAnnotation().options()` is a real getter/setter store

`options()` → shallow copy of all options; `options("k")` → one value;
`options("k", v)` / `options({...})` → set. This is what `shouldRetainFeature`,
`drawnFeatureUnchanged`, and the retained-feature cache read.

### Driving the displayed set: make `layerSliceIndexes` frame-reactive

`store.layerSliceIndexes` defaults to a `vi.fn` returning a constant, so the
displayed set won't turn over on a frame change. To simulate frame turnover:

```ts
(mockedStore.layerSliceIndexes as any).mockImplementation(() => ({
  xyIndex: mockedStore.xy,
  zIndex: mockedStore.z,
  tIndex: mockedStore.time,
}));
```

Then give annotations distinct `location.{XY,Z,Time}` so each frame shows a
different subset (`layerAnnotations` filters by `annotation.location.* === sliceIndex`
unless the axis is unrolled or `max-merge`). `createGeoJSAnnotation` early-returns
`null` unless `store.dataset?.anyImage()` is truthy — the store mock provides this.

## Worked examples in the suite

- **Pure predicate** — `annotationStubUtils.test.ts` `describe("shouldRetainFeature")`:
  unit-tests the extracted skip predicate in isolation (no mount).
- **Cache bookkeeping** — `AnnotationViewer.test.ts`
  `describe("retained-feature reuse")`: mounts, removes a feature via
  `clearOldAnnotations` (retain), then redraws via `drawNewAnnotations` and asserts
  the object is reused (no `geojsAnnotationFactory` call) or rejected-and-rebuilt
  when stale. Runs against the GeoJS mock, so it guards the cache **logic**, not the
  real GeoJS `_exit`/re-add contract (see [ZSCRUB_FEATURE_REUSE.md](ZSCRUB_FEATURE_REUSE.md)).
- **Watcher / reactive chain** — `AnnotationViewer.test.ts`
  `describe("frame-index change (xy/z/time) redraw path")`: an `it.each` over the
  three axes that mutates `mockedStore.{xy,z,time}` and asserts `displayedAnnotations`
  turns over, `annotationLayer.draw` is called, the drawn set switches frames, and
  `handlingPrimaryChange` stays `false` (proving the frame change flows through the
  visibility → `onDisplayedAnnotationsChange` path, not `onPrimaryChange`).

  **Limitation:** the mocked `updateVisibilityAndHydration` is a no-op, so the mock
  does not model the real async two-phase `visibleAnnotationIds` update. This test
  therefore proves the correctness contract (a frame change redraws with the new
  set) but cannot detect a *performance* regression such as re-adding `xy/z/time` to
  the primary-change watcher (which would reintroduce a wasted leading draw).
