# Example-Based Auto-Segmentation Tool ("AutoSeg")

Spec for an interactive, ilastik-style segmentation tool: the user circles a few
example objects, a lightweight pixel classifier is trained live in the browser,
and similar objects across the viewport are outlined as *putative* annotations.
An info panel shows the number of putative annotations; clicking **Accept**
commits them in bulk.

Status: **specified, not yet implemented**. This document is the implementation
contract — interfaces below are normative.

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
