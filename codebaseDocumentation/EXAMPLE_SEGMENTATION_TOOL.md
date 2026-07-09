# Example-Based Auto-Segmentation Tool ("AutoSeg")

Spec for an interactive, ilastik-style segmentation tool: the user circles a few
example objects, a lightweight pixel classifier is trained live in the browser,
and similar objects across the viewport are outlined as *putative* annotations.
An info panel shows the number of putative annotations; clicking **Accept**
commits them in bulk.

Status: **implemented**, then **unified** (see §12). This document was the
implementation contract; interfaces below are normative unless a deviation is
listed.

> **Update (2026-07) — the two tools are now one.** The AutoSeg classifier
> (§1–§10) and the SAM-embedding similarity variant "SimSAM" (§11) shipped as
> two separate tools, then were **merged into a single "Segment similar
> objects" tool** (`TToolType` `"objectSegmentation"`). §1–§11 remain accurate
> as **algorithm** references, but their *integration* details — file names,
> tool types, tool menus, `AnnotationViewer` wiring — are **superseded by
> §12**, which describes the current architecture. In particular
> `src/pipelines/samSimilarityPipeline.ts`, `src/pipelines/exampleSegmentationPipeline.ts`,
> `ExampleSegmentationToolMenu.vue`, and `SamSimilarityToolMenu.vue` no longer
> exist, and the `"exampleSegmentation"` / `"samSimilarity"` tool types were
> removed. Read §12 first.

---

## 1. Product behavior

### Workflow

1. User creates the tool from the tool creation dialog (new template, type
   `exampleSegmentation`) and selects it in the toolbar.
2. An inline panel (like `SamToolMenu.vue`) appears under the tool button with
   live status, counts, and controls.
3. The user circles 1–N example objects freehand on the image (GeoJS polygon
   interaction mode, same UX as the snap tool). Circled polygons are **training
   scribbles**, not annotations — they render as green outlines.
4. After each example, the tool (re)trains a random-forest pixel classifier on
   multi-scale image features of the current viewport and predicts a
   probability map. Thresholding + connected components + contour tracing
   produce putative object outlines, drawn as low-opacity preview polygons
   (visually consistent with SAM's putative polygon).
5. The panel live-updates: "12 putative objects · trained on 3 examples
   (2 fg / 1 bg) · 640 ms". A threshold slider and size filters re-run only the
   cheap post-processing stage (no retrain).
6. **Accept** commits all putative polygons via
   `annotationStore.createMultipleAnnotations` with the tool's configured
   tags/color/layer/location. The model and examples are **kept**: the user can
   pan/scroll to a new field of view, the classifier re-predicts there
   (no retrain needed), and they accept again. Proposals overlapping existing
   annotations are suppressed, so accepted objects are not re-proposed.
7. **Clear** resets examples, model, and proposals.

### Foreground / background examples

- Default polarity: each circled polygon marks **object** (foreground) pixels.
- A panel toggle ("Next example marks: Object | Background") lets the user
  circle background/negative regions — essential when auto-sampled background
  is wrong (e.g., touching objects). Background examples render as red outlines.
- When the user has drawn no background examples, background training pixels
  are sampled automatically:
  - an annulus around each foreground example (dilate the example mask by
    ~`max(5, 0.5 * sqrt(area))` px in working resolution, take the ring), plus
  - uniform random pixels far from all examples (≥ 2× annulus width), capped
    per §4.3.
- Explicit background examples are *added to* (not replacing) the automatic
  annulus samples, unless that proves harmful in practice — implementer may
  flag-gate.

### Scope and caveats (documented to the user via tool description)

- Operates on the **current viewport** at screen resolution (same as SAM):
  what you see is what gets classified. Zoom so objects are well-resolved.
- The classifier sees the **styled 8-bit composited RGB** rendering. Changing
  contrast/brightness/visible layers changes the features; retrain after big
  display changes for best results.
- Purely frontend; works in all supported browsers (no WebGPU requirement —
  unlike SAM).

### Non-goals (v1) → see §9 Future work

- Whole-dataset / off-screen batch application (naturally a backend
  docker-worker job).
- Raw 16-bit intensity features (needs a `tiles/region` TIFF/raw fetch path).
- Persisting trained models across sessions.

---

## 2. Why purely frontend (and what is naturally backend)

Investigated conclusions:

- **Pixel access**: the only fast bulk pixel path today is the rendered
  canvas — `map.screenshot(layers, "canvas")` (used by SAM at
  `src/pipelines/samPipeline.ts:144` and snap tools at
  `src/components/AnnotationViewer.vue:1894`). 8-bit styled RGB is exactly what
  ilastik-style features need for a "segment what I see" tool. Raw 16-bit data
  is only available per-pixel (`tiles/pixel`, `GirderAPI.ts:371`) — too slow for
  dense features — or via a not-yet-used raw `tiles/region` encoding.
- **Compute**: multi-scale Gaussian features + a small random forest train in
  well under a second on a viewport-sized image in plain TypeScript inside a
  web worker. No server round-trip → true live updates.
- **Commit path**: `createMultipleAnnotations` (`src/store/annotation.ts:136`)
  already batch-creates annotations.
- **Naturally backend** (future): applying a trained model across all
  XY/Z/Time locations of a dataset. That maps onto the existing `segmentation`
  docker-worker system (`upenn_annotation/compute`); the trained forest is
  JSON-serializable, so it could be shipped to a worker as a parameter. Not in
  v1.

---

## 3. Architecture

Mirrors the SAM tool's proven structure: a reactive compute-DAG
(`src/pipelines/computePipeline.ts`) whose outputs are mirrored into a
reactive tool state consumed by `AnnotationViewer.vue` and the tool menu.

```
ManualInputNode                ComputeNode chain (worker-backed)
---------------                -----------------------------------------------
geoJSMap (debounce 1000ms) ──► screenshot ──► workerImage (downscale ≤1024,
                                              transfer RGBA to worker,
examples (immediate) ─────────────────────► trainPredict (rasterize examples
                                              in worker coords, train forest,
                                              dense predict → cached prob map)
threshold (debounce 100ms) ───────────────► postprocess (threshold, CC, size
sizeRange (debounce 100ms) ────────────┘     filter, contour trace, simplify)
simplificationTolerance (100ms) ───────┘        │
                                                ▼
                                       proposals: display→GCS, dedupe vs
                                       existing annotations → reactive state
```

Key points:

- **One web worker** (`src/workers/exampleSegmentation.worker.ts`) owns the
  expensive state: RGBA image, feature stack, trained forest, probability map.
  The pipeline nodes are thin async RPC wrappers. This is the first explicit
  `new Worker` in the codebase — use Vite's native syntax:
  `new Worker(new URL("@/workers/exampleSegmentation.worker.ts", import.meta.url), { type: "module" })`.
- **Retrain** happens when `examples` changes (add/undo/clear/polarity).
- **Re-predict without retrain** happens when the screenshot changes (pan/zoom
  → new features, existing forest). If no forest exists yet, the node outputs
  `NoOutput`.
- **Post-process only** happens when threshold/size/simplification change —
  uses the cached probability map, no inference.
- Working resolution is capped at **1024 px on the long side** (downscale the
  screenshot canvas with `drawImage`); all worker computation happens in
  working coordinates. Bounds memory: ≤ ~1 MP × ~13 float32 feature planes
  ≈ 55 MB per distinct channel.

---

## 4. Algorithm

### 4.1 Features (per distinct channel)

Computed on working-resolution planes extracted from the RGBA screenshot.
Channels R, G, B — **dedupe identical channels** (compare a few hundred sampled
pixels; grayscale renders give R=G=B and should cost 1 channel, not 3).

Per channel, at sigmas `[1, 2, 4, 8]`:

| Feature | Count |
|---|---|
| Raw intensity | 1 |
| Gaussian smoothed `G(σ)` | 4 |
| Gradient magnitude of `G(σ)` (central differences) | 4 |
| Laplacian of Gaussian (`∇²G(σ)`, via discrete Laplacian of the smoothed plane) | 4 |

= **13 planes per distinct channel** (typ. 13 grayscale, 39 full-color).

Implementation: separable Gaussian convolution on `Float32Array` planes,
kernel radius `ceil(3σ)`, edge clamp. Pure TS in the worker — no new
ITK-wasm pipeline needed (the compiled ITK set has no Gaussian anyway).
Feature planes are cached per screenshot and reused across retrains.

### 4.2 Example rasterization

Example polygons arrive in **working-pixel coordinates** (main thread converts
GCS → display via `map.gcsToDisplay`, then scales display → working). The
worker rasterizes each polygon with even-odd scanline fill into the label
buffer. Foreground examples → label 1, background examples → label 0, annulus
and far-field auto-samples → label 0 (§1). Examples partially outside the
viewport are clipped; fully-outside examples contribute nothing (harmless).

### 4.3 Training

- Subsample balanced training sets: up to **4000 foreground** and **8000
  background** pixels (deterministic stride subsampling, no RNG needed).
- Classifier: **random forest**, default 32 trees, max depth 12. Use the
  `ml-random-forest` npm package (MIT) for training. If its API proves
  awkward for per-tree access, a from-scratch CART forest (~200 lines) is an
  acceptable fallback — decide in implementation, but training must be
  deterministic given identical inputs (fixed seed).
- **Fast prediction is mandatory**: do NOT call the library's `predict` on a
  million-row `number[][]`. After training, flatten each tree into typed
  arrays (`featureIndex: Int16Array`, `threshold: Float32Array`,
  `leftChild/rightChild: Int32Array`, `leafValue: Float32Array`) and run a
  hand-rolled loop over pixels reading directly from the feature planes.
  Output = mean of tree leaf probabilities → `Float32Array` probability map.
- Targets on a 2020-era laptop, 1 MP working image, 13 features: features
  ≤ 800 ms (once per screenshot), train ≤ 500 ms, dense predict ≤ 600 ms,
  post-process ≤ 100 ms. The panel shows measured timings.

### 4.4 Post-processing (cheap, re-runnable)

1. Threshold probability map at `threshold` (default 0.5, panel slider 0.05–0.95).
2. Connected components, 8-connectivity, iterative scanline flood fill (no
   recursion).
3. Size filter: drop components outside `[minArea, maxArea]` (working px).
   Defaults are **auto**: `[0.25 × median example area, 4 × median example
   area]` computed from foreground example masks; panel can override with
   absolute values or reset to auto.
4. Outer contour per surviving component via **Moore boundary tracing**
   (holes ignored in v1).
5. Simplify with `geojs.util.rdpLineSimplify` — but this runs on the main
   thread after coordinates come back (geojs is not worker-importable);
   worker returns raw contours in working coords.
6. Main thread: scale working → display, `map.displayToGcs`, RDP-simplify
   (tolerance in display px, default 1, panel slider like SAM's).
7. **Dedupe against committed annotations**: drop any proposal whose centroid
   lies inside an existing annotation polygon that (a) is at the current
   location (XY/Z/Time per the tool's location config) and (b) shares at least
   one tag with the tool's configured tags. Point-in-polygon via
   `geojs.util.pointInPolygon` (or a small local util if unavailable). This is
   what makes the roam-and-accept workflow idempotent.

### 4.5 Worker RPC protocol

Simple `postMessage` request/response with incrementing `requestId`; each
request type below returns a response or `{ error: string }`. Superseded
in-flight requests may be answered late — the pipeline node discards stale
responses by requestId (ComputeNode's re-run semantics already cancel stale
chains; the wrapper must still not resolve with mismatched ids).

```ts
// src/utils/exampleSegmentation/types.ts (shared main/worker)
export interface ISetImageRequest {
  type: "setImage";
  requestId: number;
  rgba: ArrayBuffer;      // transferred
  width: number;          // working resolution
  height: number;
}
export interface ITrainPredictRequest {
  type: "trainPredict";
  requestId: number;
  // Polygons in working-pixel coords; empty array = predict with cached model
  examples: { polarity: "foreground" | "background"; points: { x: number; y: number }[] }[];
}
export interface IPostprocessRequest {
  type: "postprocess";
  requestId: number;
  threshold: number;
  minArea: number | null;  // null = auto
  maxArea: number | null;
}
export interface IPostprocessResponse {
  type: "postprocess";
  requestId: number;
  contours: { x: number; y: number }[][]; // working coords, outer contours
  componentCount: number;                  // before size filtering
  autoSizeRange: { min: number; max: number } | null;
  timings: { featuresMs?: number; trainMs?: number; predictMs?: number; postprocessMs: number };
}
export interface IResetRequest { type: "reset"; requestId: number } // drop model + examples
```

`trainPredict` responds with the same shape as `postprocess` (it runs
post-processing with the last-known threshold/size params, which are included
on the request in the actual implementation — implementer may merge
`trainPredict` and `postprocess` params into one options object). `setImage`
invalidates cached features/probability map but **keeps the trained forest**.

---

## 5. Normative interfaces (frontend integration)

### 5.1 `src/store/model.ts` additions

```ts
// Add to TToolType union:
| "exampleSegmentation"

export const ExampleSegmentationToolStateSymbol: unique symbol = Symbol("Example segmentation tool state");
export type TExampleSegmentationToolStateSymbol = typeof ExampleSegmentationToolStateSymbol;

export interface IExampleSegmentationExample {
  polarity: "foreground" | "background";
  coordinates: IGeoJSPosition[]; // GCS (image) coords of the circled polygon
}

export interface IExampleSegmentationStatus {
  phase: "idle" | "computing" | "ready" | "error";
  error?: string;
  putativeCount: number;          // proposals.length after all filtering
  timings: { featuresMs?: number; trainMs?: number; predictMs?: number; postprocessMs?: number };
}

export interface IExampleSegmentationToolState {
  type: TExampleSegmentationToolStateSymbol;
  nodes: TExampleSegmentationNodes;   // markRaw'd pipeline nodes (import type from the pipeline file)
  mapEntry: IMapEntry | null;         // reactive mirror, same pattern as ISamAnnotationToolState
  examples: IExampleSegmentationExample[]; // reactive mirror of the examples input node
  proposals: IGeoJSPosition[][] | null;    // GCS polygons, post-dedupe; null = nothing computed
  status: IExampleSegmentationStatus;      // reactive mirror
}

// Add to IExplicitToolStateMap:
exampleSegmentation: IExampleSegmentationToolState | IErrorToolState;
```

### 5.2 `src/pipelines/exampleSegmentationPipeline.ts` exports

```ts
export type TExampleSegmentationNodes = {
  allNodes: ComputeNode[];
  input: {
    geoJSMap: ManualInputNode<IMapEntry>;                       // debounce 1000ms (SAM parity)
    examples: ManualInputNode<IExampleSegmentationExample[]>;   // immediate
    threshold: ManualInputNode<number>;                         // debounce 100ms
    sizeRange: ManualInputNode<{ min: number | null; max: number | null }>; // 100ms
    simplificationTolerance: ManualInputNode<number>;           // 100ms
  };
  output: {
    proposals: ComputeNode; // → { proposals: IGeoJSPosition[][], status fields }
  };
};

export function createExampleSegmentationToolStateFromToolConfiguration(
  configuration: IToolConfiguration<"exampleSegmentation">,
): IExampleSegmentationToolState; // mirrors createSamToolStateFromToolConfiguration (samPipeline.ts:611)
```

The state factory `markRaw`s nodes, wraps the rest in `reactive`, and wires
`onOutputUpdate` callbacks to mirror node outputs into `mapEntry`, `proposals`,
`status` — exactly the SAM pattern (`samPipeline.ts:611-696`). It must never
throw for missing WebGPU (not needed); construction errors produce an
`IErrorToolState`.

Dedupe (§4.4 step 7) needs the annotation store — import the store module
directly (as other pipeline-adjacent code does) or accept an injected getter;
keep it out of the worker.

### 5.3 Store wiring — `src/store/index.ts`

In `setSelectedToolImpl` (`src/store/index.ts:800-840`), add:

```ts
case "exampleSegmentation": {
  const state = createExampleSegmentationToolStateFromToolConfiguration(configuration);
  ...  // same shape as the samAnnotation case at :812-816
}
```

### 5.4 `AnnotationViewer.vue` wiring

- `setNewAnnotationMode` switch (`:2075`): `case "exampleSegmentation":`
  `this.interactionLayer.mode("polygon")` (freehand circling — same as snap's
  polygon branch at `:2098`).
- `handleInteractionAnnotationChange` switch (`:2214`): new case reads
  `evt.annotation.coordinates()` (GCS), removes the interaction annotation,
  and appends `{ polarity: <from tool menu state>, coordinates }` to
  `state.nodes.input.examples` (push a *new array*, ManualInputNode-style).
  Current polarity lives on the tool state (set by the panel; see §6) — add a
  `nextPolarity: "foreground" | "background"` field to
  `IExampleSegmentationToolState` for this.
- Rendering (all on `props.annotationLayer`, features flagged
  `options("specialAnnotation", true)` like SAM):
  - **Example outlines**: green (`#00FF00`) stroke for foreground, red
    (`#FF0000`) for background, no fill — re-rendered from a watcher on
    `state.examples` (pattern: `onSamPromptsChanged`, `:2518`).
  - **Putative polygons**: watcher on `state.proposals` draws each proposal as
    a polygon with the tool's configured color, `fillOpacity 0.15`,
    `strokeOpacity 0.8`, dashed if straightforward — visually distinct from
    committed annotations (pattern: `onSamMainOutputChanged`, `:2420`).
- A `exampleSegmentationToolState` computed gated on
  `state.mapEntry.map === props.map` (pattern: `samToolState`, `:298-310`).

`ImageViewer.vue` must feed the map into the pipeline when this tool is
selected — extend the existing SAM watcher block (`ImageViewer.vue:1420-1435`)
to also cover `exampleSegmentation` tool states (both use an input node named
`geoJSMap`; factor the small amount of shared logic rather than duplicating).

### 5.5 Tool menu panel — `src/components/ExampleSegmentationToolMenu.vue`

Rendered from `src/tools/toolsets/Toolset.vue` when the tool is selected —
same conditional pattern as `SamToolMenu` (`Toolset.vue:42-53`). Contents
(follow `codebaseDocumentation/BUTTON_CONVENTIONS.md` and the nimbus-frontend
style rules):

- **Status line**: phase + timings, e.g. "Ready — trained in 480 ms" or a
  progress indicator while computing; error message on error state.
- **Counts**: "N putative objects" (bold, this is the headline number),
  "M examples (K object / L background)".
- **Polarity toggle**: "Circle marks: ⬤ Object / ⬤ Background"
  (`v-btn-toggle` or radio), writes `state.nextPolarity`.
- **Threshold slider** (0.05–0.95, step 0.01, default 0.5) → `threshold` node.
- **Size filter**: min/max numeric fields showing the auto values as
  placeholders, "Auto" reset button → `sizeRange` node.
- **Simplification slider** → `simplificationTolerance` node (SAM parity,
  `SamToolMenu.vue:52-72`).
- **Actions**: "Undo example" (pops last example), "Clear" (resets examples +
  sends worker `reset` + clears proposals), **"Accept N annotations"**
  (primary button, disabled when N = 0, loading state while committing).
- Config persistence: threshold / simplification / turbo-like settings are
  written back to `toolConfiguration.values` via
  `store.editToolInConfiguration`, debounced — same as `SamToolMenu.vue:167-193`.

**Accept** builds `IAnnotationBase[]` from `state.proposals` using the tool's
`values.annotation` (tags, color, shape=polygon) and
`getAnnotationLocationFromTool` (see `annotationStore.addAnnotationFromTool`,
`src/store/annotation.ts:476-513` for the exact field derivation), then calls
`annotationStore.createMultipleAnnotations(bases)`. Do NOT loop
single-annotation creates (CLAUDE.md batch rule). After success: keep examples
and model; proposals will be recomputed and deduped away against the
newly-committed annotations (§4.4 step 7) — force a re-run of the postprocess
node after the store updates.

### 5.6 Tool template — `public/config/templates.json`

New entry (modeled on the SAM entry at `:269-326`):

```json
{
  "name": "Auto-segment from examples (experimental)",
  "type": "exampleSegmentation",
  "shortName": "AutoSeg",
  "description": "Circle a few example objects and a classifier trained in your browser outlines similar objects in the current view. Works on what is displayed: zoom and adjust contrast first.",
  "interface": [
    {
      "name": "Annotation Configuration",
      "id": "annotation",
      "type": "annotation",
      "meta": { "hideShape": true, "defaultShape": "polygon" }
    },
    {
      "name": "Detection threshold",
      "id": "threshold",
      "type": "text",
      "meta": { "value": "0.5", "type": "number" }
    },
    {
      "name": "Simplification",
      "id": "simplificationTolerance",
      "type": "text",
      "meta": { "value": "1", "type": "number" }
    }
  ]
}
```

(No `isSubmenu` select is needed; the tool has a single variant. Verify the
creation dialog renders a section without one — the SAM entry's submenu is its
model picker; if `ToolTypeSelection.vue` requires a submenu element to show a
clickable item, add a trivial one-item select like other sections use.)

---

## 6. New files summary

| File | Contents |
|---|---|
| `src/utils/exampleSegmentation/types.ts` | Worker protocol + shared types (§4.5) |
| `src/utils/exampleSegmentation/workerClient.ts` | Typed RPC client over the worker (requestId matching, buffer transfer) |
| `src/utils/exampleSegmentation/features.ts` | Separable Gaussian, gradient magnitude, LoG on Float32Array planes; channel extraction/dedupe |
| `src/utils/exampleSegmentation/forest.ts` | Train via ml-random-forest (or fallback CART), tree flattening, fast dense predict |
| `src/utils/exampleSegmentation/postprocess.ts` | Threshold, scanline flood-fill CC labeling, size filter, Moore contour tracing |
| `src/utils/exampleSegmentation/rasterize.ts` | Even-odd scanline polygon fill, annulus/far-field background sampling |
| `src/utils/exampleSegmentation/*.test.ts` | Unit tests (§8) |
| `src/workers/exampleSegmentation.worker.ts` | RPC dispatcher owning image/features/model/probmap state |
| `src/pipelines/exampleSegmentationPipeline.ts` | Compute DAG, worker client, state factory, dedupe |
| `src/components/ExampleSegmentationToolMenu.vue` (+`.test.ts`) | Panel (§5.5) |

Touched files: `src/store/model.ts`, `src/store/index.ts`,
`src/components/AnnotationViewer.vue`, `src/components/ImageViewer.vue`,
`src/tools/toolsets/Toolset.vue`, `public/config/templates.json`,
`package.json` (add `ml-random-forest` if used), `TOOLS.md` (mention the new
type).

---

## 7. Performance & memory budget

- Working image ≤ 1024 px long side (≤ ~1 MP).
- Feature stack: 13 planes × 4 B × 1 MP ≈ 55 MB per distinct channel
  (grayscale: 1 channel; worst case RGB: ~165 MB — acceptable transiently, and
  planes are freed when a new screenshot arrives).
- All heavy loops in the worker; main thread only does screenshot, downscale,
  coordinate transforms, geojs simplify, and rendering.
- Debounces: screenshot 1000 ms; threshold/size/simplify 100 ms; retrain fires
  immediately on example changes (that's the interaction the user is waiting
  on).
- Typed arrays end-to-end; never materialize `number[][]` feature matrices.

## 8. Testing

Unit tests (Vitest, alongside sources):

- `features.test.ts`: Gaussian of an impulse ≈ analytic kernel; gradient
  magnitude of a linear ramp is constant; channel dedupe on synthetic
  grayscale RGBA.
- `forest.test.ts`: flattened predictor exactly matches library `predict` on a
  small dataset; deterministic across runs; separable 2-class blobs reach
  ~100% train accuracy.
- `postprocess.test.ts`: CC labeling counts/areas on hand-built masks
  (including 8-connectivity diagonals); Moore trace of a square returns its
  boundary; size filter boundaries inclusive.
- `rasterize.test.ts`: even-odd fill of convex/concave polygons vs brute-force
  point-in-polygon; annulus sampling stays outside the example mask.
- `ExampleSegmentationToolMenu.test.ts`: mirrors `SamToolMenu.test.ts` —
  renders counts from a mocked tool state, Accept disabled at 0 proposals,
  Accept calls `createMultipleAnnotations` once with N bases.

Manual verification: `pnpm run dev` against local docker backend, dataset with
blob-like objects; circle 2 examples → outlines appear < 2 s; threshold slider
updates < 300 ms; Accept creates N annotations (check via annotation browser);
pan → new proposals appear without new examples; accepted objects are not
re-proposed.

## 9. Future work

- **SAM-embedding similarity variant** — specified in §11 below; a
  complementary approach that reuses the SAM encoder embeddings we already
  compute.
- **Backend batch apply** (the natural backend piece): serialize the flattened
  forest + feature config to JSON, run over all locations via the existing
  `segmentation` docker-worker route, creating annotations server-side.
- Raw 16-bit features via `tiles/region` with TIFF/raw encoding (server
  already supports it; frontend needs a decoder) — makes the model robust to
  display-contrast changes.
- Persist trained models in the tool configuration (`values.trainedModel`) so
  a tool "remembers" its training across sessions.
- Hole-preserving contours; per-object probability score displayed on hover;
  active-learning hints (show lowest-confidence proposals first).
- Feature set toggles (texture/structure-tensor features) if plain multiscale
  Gaussians prove insufficient.

---

## 10. Implementation notes / deviations

Where the shipped implementation intentionally departs from the sections
above:

- **Classifier library (§4.3)**: `ml-random-forest` was evaluated and
  rejected — its bundled `ml-cart` recomputes Gini per candidate threshold
  (no sort-and-sweep), putting training ~40× over the ≤500 ms budget at 12k
  rows. The shipped forest (`forest.ts`) is a from-scratch CART with
  histogram-based split search (32 bins), seeded-LCG bagging for determinism,
  and the flattened typed-array predictor described in the spec. Defaults are
  **16 trees** (not 32), max depth 12 — train and dense-predict cost scale
  linearly with tree count and 16 keeps the live loop interactive with
  negligible accuracy loss for binary pixel classification.
- **`TExampleSegmentationNodes` (§5.2)** additionally exposes
  `reset(): Promise<void>` (drops the worker's model/probability map and
  re-arms the "no model yet" guard); the panel's **Clear** uses it. The
  `geoJSMap` input node is typed `ManualInputNode<IMapEntry | TNoOutput>`
  (same as SAM's) so the shared ImageViewer map-feeding watcher can pass
  `NoOutput`.
- **`IExampleSegmentationStatus` (§5.1)** additionally carries
  `autoSizeRange`, surfaced from the worker so the panel can display the auto
  size-filter values as placeholders.
- **Worker protocol (§4.5)**: `trainPredict` carries the post-processing
  params in a `params` object (the "implementer may merge" option), and the
  response type is a single `ISegmentationResultResponse` shared by
  `trainPredict` and `postprocess` — see `types.ts`, which is the source of
  truth.
- **Undo to zero examples** keeps the trained model (and therefore the
  current proposals) — only **Clear** drops the model. This matches the
  roam-and-re-predict design: an empty examples array means "re-predict with
  cached model", per §4.5.

---

## 11. Variant B: SAM-embedding similarity segmentation (implemented — see §11.7 for deviations)

A second, complementary route to "circle a few examples, find the rest": reuse
the **SAM image embeddings we already compute** (`samPipeline.ts` encoder) to
find objects that *look like* the examples, and use the SAM decoder to
produce their masks. This is the "personalized SAM" family of techniques
(cf. PerSAM/Matcher): one or a few example masks → an embedding-space
descriptor → similarity-guided prompting of the decoder.

### 11.1 Why this variant, and how it relates to the classifier (§1–§8)

| | Classifier (AutoSeg, implemented) | SAM similarity (this section) |
|---|---|---|
| Examples needed | ~2+ fg (bg auto-sampled) | 1+ (each example is one SAM click) |
| What it matches | per-pixel texture/intensity | object-level appearance (semantic) |
| Boundary quality | threshold + CC; touching objects can merge | SAM decoder masks; handles touching objects much better |
| Browser support | all browsers (pure TS/worker) | Chrome/WebGPU only (same as SAM tool) |
| Cost per update | retrain ~0.5 s + dense predict | K decoder runs (~20–50 ms each, serialized) |
| Fails when | contrast/display changed, texture ambiguous | objects smaller than ~2 embedding cells (~32 px at model scale), or appearance ≠ embedding-salient |

The two variants share the entire "putative proposals → info panel → accept"
UX and most of the §5 integration surface. They should be exposed as two tool
templates (or one template with a method select), not merged into one
algorithm.

### 11.2 Prerequisites already in the codebase

- Encoder graph with cached ONNX sessions and the screenshot→1024×1024
  aspect-preserving resize, including the recorded `scaledWidth/scaledHeight`
  → display scale factors (`samPipeline.ts:163-224`). The image occupies the
  **top-left** of the padded model input; everything right/below
  `scaledWidth/scaledHeight` is padding and must be masked out of all
  embedding math.
- Encoder outputs: `image_embed` `(1, 256, 64, 64)` for both SAM1 ViT-B and
  SAM2 Hiera; SAM2 additionally `high_res_feats_0/1` (see `ONNX.md:85-112`).
  Each embedding cell corresponds to a 16×16 px patch of the model input.
- Decoder runs with arbitrary point/box prompts (`processPrompt`,
  `samPipeline.ts:241-328`; boxes = point pairs labeled 2/3), serialized per
  session (`runOnnxSessionSerialized`).
- Mask → single-blob polygon via ITK `MaskToBlob` — a perfect fit here, since
  each decoder run yields exactly one object mask.
- The AutoSeg integration surface (§5): putative rendering, panel skeleton,
  bulk accept, dedupe-vs-committed.

### 11.3 Algorithm

**1. Example acquisition.** The user clicks (or box-drags) each example —
the normal SAM prompt flow, reusing `mouseStateToSamPrompt`. Each example is
decoded immediately to a mask, so examples are precise object masks, not
freehand circles. Keep per-example masks; a "mark background" polarity (panel
toggle, as in AutoSeg) yields *negative* examples. Optionally, accepted
polygons from earlier rounds can be re-ingested as examples.

**2. Descriptor extraction (mask pooling).** For each example mask:
downsample the mask to the 64×64 embedding grid (a cell is "in" if ≥50% of
its 16×16 patch is inside the mask, with a ≥1-cell fallback at the argmax
coverage cell for small objects). L2-normalize each cell's 256-dim feature,
average the in-mask cells, L2-normalize again → descriptor `d_i`. Keep
per-example descriptors (do NOT average across examples — score with
`max_i cos(f, d_i)` so multi-modal appearance works). Negative examples give
`n_j` descriptors used as a penalty: `score(f) = max_i cos(f, d_i) −
λ · max_j cos(f, n_j)` (λ ≈ 0.5, tune empirically).

**3. Similarity map.** Score every non-padding embedding cell → a 64×64
similarity map. This is trivially cheap (≤4096 × 256 dot products, sub-ms in
JS; no worker needed).

**4. Candidate prompt generation** — three modes, in order of preference:

- **(a) Similarity-peak prompting (default).** 3×3 max-filter NMS on the
  similarity map; take local maxima above `τ_prompt` (default: 0.6 × the
  mean self-similarity of the examples — calibrate against what the
  examples themselves score, not an absolute constant), cap at K = 64 peaks,
  minimum peak separation ~1.5 cells. Each peak center (cell → model-input px
  → prompt coords) becomes one foreground-point decoder prompt.
- **(b) Box prompting at peaks (option).** Same peaks, but prompt with a box
  centered on the peak sized to the median example's bounding box (in model
  input px). Helps when single points bleed into adjacent touching objects;
  worse when object size varies a lot. Expose as a panel toggle
  ("Prompt with: point / example-sized box").
- **(c) Dense grid sweep ("thorough" mode).** AMG-style N×N point grid
  (e.g. 32×32) over the non-padding region, decode all, filter by similarity
  afterwards. Only worthwhile when similarity peaks miss objects (weak
  embedding contrast); ~10–20× more decoder runs. Expose as an explicit
  "Thorough scan" button, not the live default.

**5. Decode + verify.** For each candidate prompt, run the decoder (one run
per candidate, serialized; reuse the existing decoder context/session and
mask handling — SAM1 `orig_im_size` vs SAM2 rescale, exactly as today). Then
verify each candidate mask independently of how it was prompted:
mask-pool its own descriptor (step 2) and require
`score ≥ τ_accept` (the panel's similarity threshold, default 0.5 of example
self-similarity — this is the live slider, like AutoSeg's probability
threshold) **and** `iou_prediction ≥ 0.7` **and** area within the size filter
(same auto range from example areas as §4.4).

**6. Dedupe / NMS.** Nearby peaks often decode to the same object. Greedy
NMS on the low-res (256×256) decoder masks: sort candidates by score, drop
any with mask-IoU > 0.6 against an already-kept candidate. Also drop
candidates whose mask contains an example centroid (the examples are already
segmented), then apply the §4.4 step 7 centroid dedupe against committed
annotations. Convert survivors to polygons via `MaskToBlob` + RDP simplify +
`displayToGcs` — identical tail to the existing SAM path.

### 11.4 Pipeline sketch

Extends the existing SAM DAG rather than duplicating it — the encoder chain
(screenshot → processCanvas → runEncoder) is reused verbatim; new nodes hang
off the encoder output:

```
encoderOutput ──► descriptors(examples' masks)     [cheap, main thread]
              └─► similarityMap(descriptors)       [cheap]
similarityMap ──► candidatePrompts(mode, τ_prompt, K)
candidatePrompts ──► decodeCandidates              [K serialized decoder runs,
                                                    progress into status]
decodeCandidates ──► verify+NMS+sizeFilter(τ_accept, sizeRange)
                 ──► maskToPolygons ──► dedupe vs annotations ──► proposals
```

- `τ_accept`, size range, and simplification changes re-run only the
  verify/NMS tail on cached candidate masks+descriptors (no re-decoding) —
  the same cheap-reslider property as AutoSeg's postprocess node.
- Pan/zoom → new encoder run (already debounced 1000 ms) → descriptors from
  *examples in the old view* are still valid (they are embedding-space
  vectors, not pixel coords) → similarity map + candidates recompute in the
  new view. Same roam-and-accept workflow as AutoSeg, with the same caveat
  that embeddings are computed on the styled render, plus a new one: SAM
  embeddings are not fully scale-invariant, so matching degrades if the user
  zooms far from the zoom level the examples were taken at. The implementation
  keeps the captured descriptor for matching, but recomputes current-view
  masks only for geometry tasks (example-overlap dedupe and box sizing) when
  the example polygon intersects the active encode. Off-screen examples keep
  matching by descriptor and must not be clamped into fake edge-cell masks.
  Surface the examples' capture zoom in the panel if this bites in practice.

**Decoder budget**: K = 64 point candidates × ~20–50 ms ≈ 1.3–3.2 s per
viewport on WebGPU, serialized. Stream results into the putative overlay as
they decode (update `proposals` incrementally every ~8 candidates) rather
than blocking until the full batch completes; show "23/64 candidates" in the
status line. Thorough mode (32×32 grid = 1024 runs) is tens of seconds —
acceptable only as an explicit user action with progress + cancel.

### 11.5 Integration surface

- New `TToolType` `"samSimilarity"` (or a `method` submenu on a shared
  template) with the SAM models select, `annotation` config, similarity
  threshold, prompt-mode select, and simplification — WebGPU-gated with the
  same `IErrorToolState` fallback as SAM.
- Tool state mirrors `IExampleSegmentationToolState`: examples (now
  `{ polarity, mask descriptor, polygon }`), proposals, status with
  candidate-progress, `nextPolarity`.
- Panel = AutoSeg panel skeleton (§5.5) with: similarity slider replacing the
  probability threshold, prompt-mode toggle, "Thorough scan" button, and the
  same Undo/Clear/Accept N. Accept path is byte-for-byte the AutoSeg accept
  (bulk `createMultipleAnnotations` + dedupe re-run).
- Viewer wiring: example acquisition is SAM's existing mouse-prompt capture
  (not polygon mode); putative rendering reuses the AutoSeg proposal
  watcher pattern.
- **Two example-input modes**, toggled by the panel (`state.exampleInputMode`,
  default `"click"`), mutually exclusive because GeoJS can't run raw mouse
  capture and its own polygon-draw interaction mode at the same time:
  - **Click (SAM)** - the mode described above: shift+click/drag runs the
    SAM decoder to turn the clicked object into a training example.
  - **Circle** - freehand-draws a polygon (GeoJS `polygon` interaction mode,
    same UX as AutoSeg's example circling) that becomes a training example
    directly: its polygon is rasterized onto the embedding grid for the
    descriptor, with **no decoder run**. The example's `prompt` is `null`
    and its `polygon` is authoritative (vs. a click example, whose polygon
    is the decoder's output).
- **Hover live preview (Click mode only)**: as the mouse hovers over the
  image, a debounced SAM decode previews the object outline under the
  cursor - clicking then feels like "confirm what I see", mirroring SAM's
  own live preview (`samPipeline.ts`'s second decoder graph). Dragging
  (shift+drag) previews the box result instead of a point. No live preview
  in Circle mode - the cursor is busy drawing the polygon.

### 11.6 Risks / open questions

- **Threshold calibration** is the main UX risk: absolute cosine thresholds
  vary by image; always normalize against example self-similarity (11.3
  step 4/5) and let the slider express a fraction of it.
- **Small objects** (< ~32 model-input px) occupy <2 embedding cells;
  descriptors get noisy. The classifier variant is strictly better there —
  document the guidance "zoom in" / "use AutoSeg for small blobs".
- **Batched decoding**: the ONNX decoder takes one prompt set per run; if K
  runs prove too slow, investigate exporting a decoder with a batch
  dimension over prompts, or running 2–3 decoder sessions round-robin
  (WebGPU serialization is per-session).
- **SAM2 high-res features** (`high_res_feats_0/1`) could sharpen
  descriptors for small objects (concat pooled high-res features to the
  256-dim descriptor); leave as a follow-up experiment, `image_embed`-only
  first.

### 11.7 Implementation notes / deviations (Variant B)

Status: **pipeline/store layer implemented** (`src/pipelines/samSimilarityPipeline.ts`,
`src/store/model.ts`, `src/store/index.ts`, `public/config/templates.json`).
`AnnotationViewer.vue`/`ImageViewer.vue`/`Toolset.vue` wiring and the tool
menu panel are a later increment (§11.5's viewer/panel bullets), same split
as this document uses for Variant A's §5.4/§5.5. Where the implementation
departs from §11.3/§11.4 above:

- **Decode-node score filtering (§11.4 "Decode + verify").** The decode
  node's output is the *full* scored candidate list, filtered only by
  `iou_prediction >= 0.7` (skipped if a model doesn't expose usable
  `iou_predictions`) - **not** also by `score >= τ_accept`. The similarity
  threshold is applied exclusively in the verify/NMS tail. This is required
  by the "re-runs on threshold ... change WITHOUT re-decoding" property:
  if the threshold were also applied at decode time, decode's output would
  depend on the threshold and moving the slider would look like a no-op
  (stale candidates never redecoded) rather than cheaply re-filtering.
- **Simplification is a tail-only step, not baked in at decode.** `displayToWorld`
  is applied at decode time (it must be - see next bullet), but
  `simplifyCoordinates` runs in the verify/NMS tail, only on the small
  surviving candidate set, so moving the simplification slider re-runs the
  cheap tail exactly like a threshold or size-range change, per this
  section's explicit "re-runs on threshold/size/simplification change
  WITHOUT re-decoding" requirement. (An earlier draft of this section's
  wording - "simplifyCoordinates + displayToWorld already applied at
  decode" - would bake simplification in per-candidate at decode time,
  which conflicts with that requirement; this implementation resolves the
  conflict in favor of the explicit no-redecode constraint.)
- **`displayToWorld` cannot be deferred to the tail.** Candidate/example
  mask polygons are produced in *display* (screenshot-canvas) coordinates,
  which are only meaningful relative to the map's camera transform at the
  moment of that particular screenshot. If the map has since panned/zoomed,
  converting an old display-coordinate polygon with the *current*
  `map.displayToGcs` would silently produce wrong GCS points. `displayToWorld`
  therefore runs immediately at decode/example-decode time, using the same
  `mapEntry` value that produced the screenshot for that run - exactly
  mirroring `samPipeline.ts`'s own decoder chain ordering.
- **Descriptor cache vs. current-view masks (§11.3 step 4b / §11.4).** The
  per-example cache stores the SAM-decoded GCS polygon, prompt anchor, captured
  descriptor, captured self-similarity, and captured cell mask. The captured
  descriptor/self-similarity are reused for matching after pan/zoom. On each
  encode, the cached GCS polygon is projected into the current view only for
  geometry tasks: if it intersects the valid embedding grid, its current mask is
  used for example-overlap dedupe and box sizing; if it is off-screen, no
  current mask is produced, avoiding the centroid-clamp fallback that would
  otherwise turn an old example into a bogus edge-cell mask. Box prompt sizing
  falls back to the captured mask when no current mask is available.
  *Known limitation:* the captured mask is in the cell scale of the encode
  where the example was captured, so when some foreground examples are on-screen
  (current scale) and others are off-screen (captured scale) after a zoom
  change, `medianExampleBoxHalfExtentPx` takes a median across mixed cell scales
  and can mis-size the prompt box. Accepted as-is because box sizing is only a
  prompt heuristic; if it bites in practice, scale the captured mask by the
  zoom ratio or surface the examples' capture zoom in the panel.
- **Thorough "grid" mode uses a 16x16 uniform point grid** (256 decode
  runs), not the 32x32 grid mentioned in §11.4's "Decoder budget" note.
- **`TSamSimilarityNodes.output`** additionally exposes `examples` (the
  example-descriptor node, whose output includes `decodedExamples`) beyond
  the `proposals` output sketched in §11.4/§11.5, so the tool-state factory
  can mirror decoded example polygons into `state.examples` with a plain
  `onOutputUpdate` listener - the same mechanism used for every other
  mirrored field - rather than threading a fourth injected callback through
  pipeline creation (injected callbacks are reserved for the two things
  that genuinely need mid-computation delivery: decode progress and
  streamed partial proposals, both of which fire *during* a single node's
  long-running computation rather than merely on its resolution).
- **Decode staleness mechanism** (§11.4 "Stream results into the putative
  overlay ..."): the decode node compares `candidatesNode.output` against
  the exact `candidates` array reference it was invoked with, after every
  candidate. `ComputeNode.compute()` never invokes a node's function
  concurrently with itself, so the only way this reference can change
  mid-loop is candidatesNode (a direct parent) recomputing - which is
  precisely the condition that makes the current decode run stale. On
  detecting this, the loop simply stops (returning whatever was verified so
  far); no error is thrown or swallowed. `ComputeNode`'s own
  `shouldRecompute` flag is already set in this scenario (a parent changed
  while `computing` was true), so ComputeNode itself re-invokes decode with
  the fresh candidates as soon as the stale call resolves - the early
  return is a performance optimization (skip the remaining now-pointless
  decodes), never a correctness requirement.
- **Foreground-only example aggregates.** `exampleCellMasks`,
  `exampleAreasGcs`, and `examplePromptAnchorsGcs` (used for the
  already-segmented dedupe check and the auto size range) are computed from
  **foreground** examples only; background/negative examples contribute
  only their descriptor to the negative set used in scoring.
- **WebGPU gating** matches `samPipeline.ts`: `createSamSimilarityPipeline`
  throws if `"gpu" in navigator` is false, and
  `createSamSimilarityToolStateFromToolConfiguration` catches that and
  returns an `IErrorToolState`, the same pattern as
  `createSamToolStateFromToolConfiguration`.
- **Hover live-preview node excluded from `allNodes`.** The preview-decode
  node (`previewOutlineNode`, fed by `input.previewPrompt`) is built the same
  way as every other node in the pipeline, but is deliberately left out of
  the `allNodes` array that `recomputeComputingPhase` polls for
  `status.phase`. A debounced decode fires on essentially every hover, and
  including it would make the status line flicker into "Computing..." on
  mouse movement instead of only for real examples/candidates recomputes.
  Its output is still mirrored into `state.livePreview` via the normal
  `onOutputUpdate` pattern (`nodes.output.livePreview`), same as
  `state.examples`/`state.proposals`.
- **Circled examples skip the decoder entirely** (`example.prompt === null`
  in `computeExampleDescriptors`): the polygon is converted GCS → display via
  `mapEntry.map.gcsToDisplay`, then rasterized with the same
  `displayPolygonToCellMask` → `poolDescriptor` → `meanMaskSimilarity` path a
  decoded example would go through, with `polygonGcs` set to the input
  polygon verbatim (no `displayToWorld` round-trip - it was never converted
  away from GCS) and `promptAnchorGcs` set to its centroid
  (`simpleCentroid`, from `@/utils/annotation`) rather than
  `getPromptAnchorGcs` (which only accepts a `TSamPrompt`).
- **`TSamSimilarityExampleInput`** is a discriminated union on `prompt`
  (`{ prompt: TSamPrompt; polygon?: undefined }` for Click-mode examples vs.
  `{ prompt: null; polygon: IGeoJSPosition[] }` for Circle-mode examples)
  rather than the plain `Omit<ISamSimilarityExample, "polygon">` alias used
  before this addendum, so the two input shapes - and which one skips the
  decoder - are enforced at the type level.

---

## 12. Unification: the "Segment similar objects" tool

§1–§11 describe two tools that shipped separately (the AutoSeg classifier and
the SimSAM similarity search). They were then merged into **one** tool so the
user can mix and match *how they pick examples* with *how those examples are
propagated*. This section is the current-state architecture and supersedes the
integration details in §5 and §11.5.

### 12.1 What the user gets

One tool, "Segment similar objects" (`shortName: "Similar"`,
`TToolType` `"objectSegmentation"`), with two independent runtime choices set
in a floating panel:

- **Select examples by** — `samClick` (shift-click, SAM decodes the object
  under the point), `samBox` (shift-drag a box, SAM decodes inside it), or
  `circle` (shift-drag a freehand lasso; the polygon *is* the example, no
  decoder run).
- **Find matches with** — `samSimilarity` (SAM-embedding similarity, §11),
  `classifier` (in-browser random forest, §4), or `samThenClassifier` (chained,
  see §12.6).

Any selection method combines with any application method, because both
application branches consume the **same resolved example set** (each example
reduced to a GCS polygon). A SAM-clicked example therefore trains the
classifier just as a circled one does.

The tool requires **WebGPU** (Chrome) in v1 — even classifier mode, because the
SAM encoder is what resolves prompt (click/box) examples into polygons. Without
WebGPU the state factory throws and the tool renders an error state.

### 12.2 Files (old → current)

| Before (deleted) | Now |
|---|---|
| `src/pipelines/samSimilarityPipeline.ts` + `src/pipelines/exampleSegmentationPipeline.ts` | `src/pipelines/objectSegmentationPipeline.ts` (one DAG) |
| `SamSimilarityToolMenu.vue` + `ExampleSegmentationToolMenu.vue` (inline left-panel menus) | `src/components/ObjectSegmentationPanel.vue` (bottom-right floating panel, mounted by `ImageViewer.vue`) |
| `TToolType` `"exampleSegmentation"`, `"samSimilarity"` | `TToolType` `"objectSegmentation"` |
| `ISamSimilarityToolState`, `IExampleSegmentationToolState`, `*Status`, `*Example`, symbols | `IObjectSegmentationToolState`, `IObjectSegmentationStatus`, `IObjectSegmentationExample`, `ObjectSegmentationToolStateSymbol` |

Unchanged and still consumed as-is: `samPipeline.ts` (encoder/decoder helpers),
`src/utils/samSimilarity/embedding.ts`, `src/utils/exampleSegmentation/*` +
`src/workers/exampleSegmentation.worker.ts` (classifier worker), and
`src/utils/proposalDedupe.ts` / `proposalAccept.ts`.

Both old tool types were branch-only (never on `master`), so there is no
migration path — dev datasets that still hold old-typed tools should have them
recreated as the unified tool.

### 12.3 Unified pipeline (`objectSegmentationPipeline.ts`)

```
geoJSMap → screenshot → processCanvas → runEncoder → embeddingGrid
(examples + embeddingGrid + decoder) → exampleDescriptors   [SHARED: resolves every
    example to a GCS polygon — decodes SAM prompts, passes circles through —
    and also pools SAM descriptors for the similarity branch]

── SAM branch (applicationMethod ∈ {samSimilarity, samThenClassifier}) ──
(exampleDescriptors + embeddingGrid + promptMode + gridSize) → candidates
    → decodeCandidates [staleness/progress/streaming] → samProposals

── Classifier branch (applicationMethod ∈ {classifier, samThenClassifier}) ──
screenshot → downscale → setImage(worker)
(exampleDescriptors.decodedExamples + hybridTraining + setImage) → trainPredict
    → postprocess → classifierProposals
```

Key mechanics:

- **Branch gating via `NoOutput`.** `candidates` returns `NoOutput` unless SAM
  is part of the active method; `downscale` returns `NoOutput` unless the
  classifier is. A `ComputeNode` never runs while any parent is `NoOutput`, so
  the inactive branch idles with no wasted decode / worker work.
- **One example resolution feeds both branches.** `exampleDescriptors`'
  `decodedExamples` (GCS polygons, foreground + background) is the classifier's
  training geometry; its pooled `positives`/`negatives` descriptors drive the
  SAM similarity map.
- **Which proposals are shown.** The state factory mirrors *both* branches'
  proposal nodes into `state.proposals`, but each mirror writes only when the
  active method displays it: `samProposals` for `samSimilarity`;
  `classifierProposals` for `classifier` **and** `samThenClassifier` (the chain's
  final output is the classifier's).
- **`applicationMethod` is a `ManualInputNode`** (it gates the branches) mirrored
  into reactive `state.applicationMethod`; switching it clears
  `state.proposals` so the previous branch's results don't linger.

### 12.4 Interaction & the pan fix

Every selection mode uses `interactionLayer.mode(null)` — GeoJS polygon-draw
mode is never used, even for circle. All example capture goes through
`ImageViewer.vue`'s **shift-gated** custom mouse capture (`isMouseStartEvent`:
`shiftKey && buttons !== 0`), and the GeoJS pan action's modifiers are set to
`shift:false`. Result: **plain click/drag pans and wheel zooms; shift-click /
shift-drag / shift-lasso selects** — matching the regular SAM tool. This fixed
the old "can't pan while the tool is active" problem, which was really the
circle mode's `mode("polygon")` swallowing the drag.

`AnnotationViewer.consumeMouseState` routes the captured gesture on
`state.selectionMode`: `circle` commits `mouseState.path` as a polygon example;
`samClick`/`samBox` decode a point/box prompt (a drag becomes a box in either
SAM mode). `previewMouseState` feeds the hover-preview decode node in SAM modes
and draws the freehand lasso polyline in circle mode.

### 12.5 The panel (`ObjectSegmentationPanel.vue`)

A singleton bottom-right `v-card` (cloned from `LineScanPanel.vue`;
`position: absolute; bottom/right: 10px; z-index: 200`) that `ImageViewer.vue`
renders and gates on `store.selectedTool.configuration.type === "objectSegmentation"`.
Hosts the selection/application/polarity/scope toggles, threshold, size range,
prompt mode (+ grid density in grid mode), simplification, status/progress, and
Undo/Clear/Accept. Choices persist into `configuration.values` (debounced
`editToolInConfiguration`) and restore via `initFromConfig` on mount and on tool
re-selection.

**Reactivity rule (important):** the panel's node-backed controls bind
`v-model` to **reactive `ref`s** that push into the pipeline input nodes via
watchers — never to a `computed` that reads `node.output`. `ComputeNode.output`
is a plain, `markRaw`'d, non-reactive field, so a computed reading it never
re-evaluates and the control snaps back to its stale value (this was the
"prompt-mode dropdown always shows Point prompts" bug). See the nimbus-frontend
skill for the general rule.

### 12.6 Chained mode: `samThenClassifier`

Runs SAM similarity, then trains the classifier on the user's examples **plus
every object SAM found**, and shows the classifier's result. Wiring: the SAM
branch runs as usual; the state factory's `samProposals` mirror pushes SAM's
proposal polygons into a `hybridTraining` `ManualInputNode` (only in this mode);
`trainPredict` adds those polygons as extra foreground training. `hybridTraining`
is a tagged `{ ready, proposals }` value: it is marked pending while the SAM
branch is recomputing, so the classifier cannot publish or be accepted as a
user-examples-only intermediate result. Once SAM settles, it becomes ready with
SAM's proposals (possibly an empty array). Plain classifier mode ignores the
hybrid proposals and leaving chained mode resets the input to ready/empty.
Verified: 2 examples → SAM found 10 → classifier trained on 12 → 6 final
proposals.

### 12.7 Grid density

Grid prompt mode scans a `gridSize × gridSize` uniform point grid.
`gridSize` is a `ManualInputNode` (template default 16, clamped 2–48) surfaced
as a "Grid points" panel field shown only in grid mode.

### 12.8 Notifications

Long-running nodes map to in-viewer overlay strings via `reportLoadingMessages`
→ `state.loadingMessages`, surfaced by the shared `.sam-status-area` overlay in
`ImageViewer.vue` (same overlay as the SAM annotation tool): "Loading SAM
encoder/decoder…", "SAM encoding…", "Analyzing examples…", "SAM segmenting…"
(with `n/N` candidate progress in the panel status line), "Training classifier…",
"Classifying…".

### 12.9 Bugs fixed during unification

- **`image_embed` vs `image_embeddings`** — the SAM1/vit_b encoder names its
  grid embedding `image_embeddings`; SAM2 names it `image_embed`.
  `computeEmbeddingGridState` accepts either (`?? `), fixing the original
  "Cannot read properties of undefined (reading 'dims')" crash.
- **Examples flickering away on re-encode / method switch** — the
  `state.examples` mirror ignores the transient `NoOutput` a `ComputeNode`
  publishes at the start of each recompute (only a real output with
  `decodedExamples: []` clears them), and `replacePreviewPolygons` now calls
  `annotationLayer.modified()` + `draw()` so re-added outlines render without
  needing an interaction.
- **`[object Object]` in tool-creation dropdowns** — `VSelect` defaults to
  `item-title="title"`, but template select items use `{ text, value }`;
  `ToolConfigurationItem.vue` now passes `item-title="text"` for `select`
  elements.

### 12.10 Scope (viewport only, for now)

Both branches operate on a screenshot of the **current viewport**. The panel's
"Apply to" toggle carries a disabled "Whole image" option and a `scope` state
field as forward-looking plumbing; whole-image scanning (a camera/tile sweep, or
pulling the full-resolution region from the backend) is deferred. See §9.

### 12.11 Testing

Unit tests for the algorithm cores are unchanged (`embedding.test.ts`,
`features/forest/postprocess/rasterize.test.ts`). `AnnotationViewer.test.ts`
covers the interaction routing. Everything is gated behind in-browser
verification (`localhost:5173`): each selection × application combination, pan
with plain drag, the grid-points field, and the chained mode were exercised
against a live dataset.
