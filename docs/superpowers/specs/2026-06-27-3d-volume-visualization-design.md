# 3D Volume Visualization — Design Spec

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Scope of this spec:** A frontend-only v1 (Path A) for qualitative 3D volume
rendering and 3D display of annotations, built on vtk.js, running parallel to
the existing 2D GeoJS viewer. OME-Zarr streaming (Path B) is explicitly out of
scope but the architecture is shaped to accept it later.

---

## 1. Goal & motivation

NimbusImage is currently a 2D viewer. We want to add **3D visualization** of the
existing multidimensional image stacks, with two user-facing goals:

1. **Qualitative volume rendering** — see the structure of a z-stack in 3D and
   rotate it.
2. **Segmentations as 3D objects** — display the dataset's polygon annotations
   (e.g. nuclei) as 3D objects sitting inside the volume, colorable by tag or by
   a computed property.

This is an *additive, opt-in* capability. It must not disturb the 2D viewer.

## 2. Background — current architecture (grounding)

- **2D renderer:** `src/components/ImageViewer.vue` renders tiles with GeoJS
  (WebGL compositing). Coupling to GeoJS is moderate-to-high; we do **not** try
  to reuse it for 3D.
- **Dimension model:** z is already a first-class axis (`IDataset.z: number[]`
  in `src/store/model.ts`). The app already does z max-merge (MIP) and "unroll"
  grids in 2D, so multi-plane display is a known concept.
- **Backend:** Girder `large_image` (v1.34.x) serves a **multi-frame** tiled
  image. Tile metadata exposes `IndexRange.IndexZ`, `IndexStride`, channels,
  `dtype`, and physical pixel size (`mm_x`, `mm_y`; z-step available from
  `dimensionLabels` / frame metadata). Any single plane is retrievable via
  `GET /item/{id}/tiles/region?frame=N` (preferred for full-plane/downsampled
  volume fetches) or `…/tiles/zxy/0/0/0?frame=N` (tile-level spike path).
  The validation dataset's frame order is `frame = z * IndexStride.IndexZ + c`,
  but production code should resolve frames through `IDataset.images(...)` /
  parsed frame metadata instead of depending on that arithmetic.
- **Renderer choice:** **vtk.js** (`@kitware/vtk.js`, already added at 36.2.1).
  Stays in the Kitware ecosystem alongside `large_image` / Girder.

## 3. Validated spike findings (carried into this design)

A throwaway spike (`volume-throwaway.html` + `src/volumeThrowaway.ts`, to be
deleted when the real component lands) was run against dataset **HCR134**
(1024×1024, 7 z-planes, 4 channels, uint16, xy 0.326 µm, z 5 µm → ~15×
anisotropy, 5,101 polygon nuclei annotations). Results:

- **Path A works with zero backend changes.** Fetch frames → assemble
  `vtkImageData` → render: ~890 ms end-to-end, smooth rotation.
- **Composite blend reads better than MIP for thin stacks**; MIP looks close to
  the existing 2D max-merge. → ship both, default **Composite**.
- **Anisotropic spacing is mandatory.** Setting z-spacing from the physical
  z-step is the difference between a real slab and a collapsed flat sheet.
- **Annotations → 3D is easy and fast** (rasterize 5,101 polygons + marching
  cubes ≈ 1.4 s) and surfaces share the vtk.js scene with the volume cleanly.
- **Per-object identity is lost** when annotations are rasterized into a single
  binary mask (adjacent-plane nuclei merge by proximity, not identity). This
  directly motivates the v1 segmentation representation choice (§5.3).

## 4. Locked decisions

These three forks were decided during design:

1. **Channel windowing → reuse existing histogram + contrast, fetch
   server-windowed scalar frames.** The volume is built from per-frame 8-bit
   grayscale images rendered by `large_image` using the same min/max derived
   from each layer's contrast + histogram. The request uses a grayscale palette
   (`#000000` → `#ffffff`) and an explicit `frame`; vtk.js applies the layer
   color afterward. We do *not* fetch raw uint16 in v1. (Trade-off: loses
   dynamic range beyond the current window; acceptable and consistent with 2D.)
2. **Segmentation representation → per-annotation extruded contours.** Each
   polygon is extruded by one z-step into a thin prism, preserving object
   identity and enabling per-object coloring. Marching-cubes isosurfaces are a
   later option, not v1.
3. **Volume fetch → frontend-only, N per-frame fetches.** v1 fetches each
   needed (z, visible layer/channel) frame from the existing tile endpoints. A
   backend endpoint returning the whole downsampled volume in one call is a
   deferred optimization (§9), not v1.

## 5. Approach

### 5.1 Parallel 3D mode

A new component `VolumeViewer.vue` is a sibling to `ImageViewer.vue`. A
**2D ↔ 3D toggle** in the viewer chrome switches which one is mounted/visible.
The volume is built **lazily**, only when 3D mode is first entered for the
current view. Stale builds are abortable, and vtk.js actors/mappers/textures are
torn down when leaving 3D, switching datasets, or changing the request-defining
inputs (visible layers, contrast, xy/time, downsample target).

### 5.2 Volume assembly (Path A) — behind a `VolumeSource` interface

Volume data acquisition lives behind an interface so Path B (OME-Zarr) can be
dropped in later without touching the renderer:

```ts
interface VolumeSource {
  // Returns per-visible-layer/channel vtkImageData with correct spacing,
  // for the given dataset/time/xy and the set of visible layers.
  buildVolume(
    params: VolumeRequest,
    signal?: AbortSignal,
  ): Promise<ChannelVolume[]>;
}
```

The v1 implementation, `TileFrameVolumeSource`:

- Resolves visible display layers → (channel, color, contrast, histogram,
  resolved xy/time) via the existing layer config. 3D mode intentionally renders
  **all z planes** for the resolved xy/time; do not pass a layer's 2D `z:
  max-merge` state into `toStyle`, or the volume will be assembled from
  projection images instead of planes.
- For each visible layer/channel and each z in `dataset.z`, resolves the frame
  through the dataset/frame metadata (`IDataset.images(...)` or a helper around
  it), fetches a server-windowed grayscale frame (decision §4.1), and packs it
  into a per-layer `Uint8Array` (`x + y*W + z*W*H`).
- Uses `tiles/region` with `encoding=PNG`, explicit `frame`, and a style built
  from the layer's contrast-derived min/max with grayscale palette and no
  `bands`. Decode the PNG into pixels with browser image APIs and take one
  grayscale channel/luminance value as the scalar.
- **Downsamples xy** when a full-res volume would exceed a configurable target
  (default max xy dimension ~512 px; all z kept) using the region endpoint's
  size/`magnification` params. The scalar-memory budget (default 128 MiB) bounds
  the **total decoded scalars across all visible channels**, not a single
  channel — it must mirror the sum of GPU 3D-texture uploads, since each visible
  layer/channel is a separate `vtkImageData`. So `N` visible channels means each
  is allotted ~`budget / N` before the xy downsample kicks in. The actual fetched
  resolution is surfaced via the project logging utilities
  (`logWarning`/`logError`) — **no silent caps**.
- Limits concurrent frame fetch/decode work (start with 4–6 in flight) so a
  volume build does not starve normal tile/UI requests.
- Builds `vtkImageData` per visible layer/channel with spacing from a shared
  `VolumeGeometry` object. Normalize all spacing to one unit (use micrometers):
  `spacingXUm = mm_x * 1000 * sourceWidth / fetchedWidth`,
  `spacingYUm = mm_y * 1000 * sourceHeight / fetchedHeight`, and
  `spacingZUm = resolved physical z-step`.

API methods belong in the API layer (new `src/store/VolumeAPI.ts` or methods on
`GirderAPI.ts`), **not** in the Vue component.

### 5.3 Rendering — volume

- One `vtkVolume` + `vtkVolumeMapper` per visible display layer/channel.
- **Blend mode:** Composite (default) and MIP, user-toggleable.
- **Color/opacity transfer functions** are applied to the post-windowed 8-bit
  scalar data: color transfer maps `0 → black`, `255 → layer color`; opacity
  maps low values to transparent and foreground values to a modest opacity
  suitable for composite rendering. A reusable util
  (`src/utils/layerToVolumeTransferFunction.ts`) creates the
  `vtkColorTransferFunction` + `vtkPiecewiseFunction`.
- **Channel visibility** driven by the existing layer visibility toggles.
- Layer color changes can update transfer functions without refetching; contrast
  changes require rebuilding the affected server-windowed volume.
- **Camera:** trackball rotate, reset-camera control.

### 5.4 Rendering — segmentations as 3D objects

- Source annotations from the existing filter store, honoring the **current
  annotation filters** (`filterStore.filteredAnnotations`) — do not blindly
  render all annotations. Then restrict to the current XY and Time, while keeping
  all Z planes unless the user has explicitly enabled the existing
  current-frame-only filter.
- Convert polygons → geometry via a reusable util
  (`src/utils/annotationsTo3D.ts`): each polygon (x, y at plane Z) is scaled
  into the same micrometer coordinate system as the volume and extruded by one
  z-step into a thin prism. All objects are merged into a **single
  `vtkPolyData`** with a per-cell scalar (tag index or property value) so the
  whole set draws as **one actor** with lookup-table coloring (avoids thousands
  of actors).
- v1 supports polygon annotations. Unsupported shapes are skipped with a logged
  count; rectangle/circle/ellipse normalization can be added later if needed.
- **Point annotations (spots) are a near-term follow-up, not someday-maybe.**
  HCR data is fundamentally spot-centric (RNA spots are point annotations), so
  "segmentations as 3D objects" for this domain will want points rendered as
  sphere/disc glyphs at their (x, y, z) in µm. v1 skips them, but the
  `annotationsTo3D` contract must be shaped to emit glyph geometry for points
  without a rewrite — treat it as an expected M2.5, not a hypothetical.
- **Coloring:** by tag, or by a selected computed property value (the latter is
  the scientifically useful mode — a 3D map of a measurement). Missing,
  non-numeric, or mixed property values fall back to a neutral uniform color.
- Surfaces are semi-transparent so the volume shows through; volume and
  segmentation layers each have independent visibility toggles.

### 5.5 Anisotropic spacing

Spacing is read from tile metadata (`mm_x`, `mm_y`) and the physical z-step
(`dimensionLabels.z` / frame `PositionZ` when present; fall back to a
user-editable value). The implementation must normalize these values into a
single unit before passing them to vtk.js. Use micrometers for v1 because the
validated datasets and annotation interpretation are naturally discussed in µm.

The same `VolumeGeometry` is applied to both channel volumes and segmentation
geometry:

```ts
interface VolumeGeometry {
  unit: "um";
  spacing: [number, number, number]; // x, y, z
  origin: [number, number, number];
  dimensions: [number, number, number]; // fetched x, fetched y, z
  sourceSize: [number, number]; // original image x/y pixels
}
```

## 6. Components & module boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `VolumeViewer.vue` | Mount vtk.js render window, interaction, controls (blend mode, channel/seg visibility, reset) | VolumeSource, transfer-fn util, annotations-to-3D util |
| `VolumeAPI.ts` (`TileFrameVolumeSource`) | Fetch frames, downsample, assemble per-layer/channel `vtkImageData` | GirderAPI / existing style logic |
| `src/utils/layerToVolumeTransferFunction.ts` | layer color + post-windowed scalar range → CTF/OTF | — |
| `src/utils/annotationsTo3D.ts` | polygons → merged `vtkPolyData` (extruded), per-cell scalars | annotation/filter/property store types, `VolumeGeometry` |
| `volumeView` store state (minimal) | 3D mode on/off, blend mode, seg coloring choice, z-step override | — |
| 2D↔3D toggle | switch viewer in the existing layout | — |

Each unit is independently testable; the renderer never talks to Girder
directly (only through `VolumeSource`).

## 7. Scope

**In scope (v1):**
- 2D↔3D toggle; lazy volume build/teardown.
- Multi-channel volume render, Composite + MIP, correct anisotropy.
- Channel visibility + transfer functions reused from layer config.
- Annotations as extruded 3D objects, filtered, colored by tag/property.
- xy downsampling with logged/user-visible resolution.
- Abort/rebuild lifecycle for route/layer/contrast changes.

**Out of scope / non-goals (v1):**
- OME-Zarr / Path B (architecture-ready only).
- Raw uint16 fetch path.
- 3D annotation creation/editing (view-only).
- Multiple timepoints / multiple XY positions (current frame only).
- Clipping planes, interactive transfer-function editor, marching-cubes
  isosurfaces (candidate v1.1).
- A backend volume endpoint (deferred optimization).
- Cross-plane annotation lineage into closed per-cell surfaces.

## 8. Path B readiness (OME-Zarr) — future

Path B swaps `TileFrameVolumeSource` for a `ZarrVolumeSource` consuming
`large-image-source-zarr` / OME-NGFF multiscale, feeding the same
`ChannelVolume` / `VolumeGeometry` contract. Nothing in the renderer or
segmentation layers changes. Triggered when datasets routinely exceed the
GPU-memory ceiling that Path A's whole-volume upload implies.

## 9. Risks & open questions

- **GPU memory ceiling.** Whole-volume upload bounds Path A. The default xy
  downsample target plus the 128 MiB scalar budget (total across visible
  channels) keeps typical stacks comfortable, but the "hundreds of planes"
  datasets — especially multi-channel — will hit the wall and pull Path B
  forward. Show the chosen resolution when downsampling is applied.
- **N per-frame fetches.** v1 issues `nVisibleLayers × nZ` requests per volume
  build. These are read-only image fetches (not the looped-DB-call antipattern),
  but a single backend endpoint returning the downsampled volume would cut
  latency and request count — revisit if build time is noticeable on large
  stacks.
- **Rendered scalar path.** Server-windowed PNGs are fast and match the current
  contrast, but they are 8-bit and contrast changes require refetching. Keep the
  `VolumeSource` contract raw-friendly so a future raw uint16 or Zarr path can
  swap in without changing the renderer.
- **Per-object segmentation identity across z.** Extruded contours give one
  prism per *annotation* (per plane). If a user expects one closed surface per
  *cell* spanning planes, we need the connection/lineage data to group
  annotations — out of scope for v1, but the coloring/grouping API should not
  preclude it.
- **Z-step provenance.** Confirm where the physical z-step reliably comes from
  across datasets (metadata vs `dimensionLabels` vs user input).
- **Y-axis orientation.** Confirm annotation/image y-orientation matches the
  assembled volume so segmentations register with the rendered channels.
- **Frame-order assumptions.** HCR134 has convenient contiguous z/channel frame
  ordering, but other data may not. Resolve via parsed metadata and keep the
  arithmetic formula only as a test fixture / sanity check.

## 10. Phased rollout

1. **M1 — Volume only.** `VolumeViewer.vue` + `TileFrameVolumeSource` +
   transfer-fn util + 2D↔3D toggle. Composite/MIP, channels, anisotropy,
   abort/teardown lifecycle.
2. **M2 — Segmentations.** `annotationsTo3D` util + extruded-contour layer,
   current-XY/time filtering, tag coloring; then property coloring.
3. **M3 — Polish.** Downsample messaging, request caching, reset/camera UX,
   user-editable z-step fallback.

## 11. Testing

- **Unit (Vitest):** `layerToVolumeTransferFunction` (known color/post-windowed
  scalar range → expected CTF/OTF points); `annotationsTo3D` (polygon → expected
  prism geometry, cell scalars, µm spacing); frame resolution through metadata
  including a non-contiguous frame-order fixture.
- **Volume source:** mock the tile endpoint; assert per-layer/channel
  `vtkImageData` dimensions, µm spacing, grayscale style with explicit frame/no
  `bands`, cancellation, and that downsampling triggers + logs at the threshold.
- **Manual / visual:** the throwaway spike already validates the rendered
  result; replicate its checks (anisotropy correct, composite default,
  segmentation registration, y-axis orientation) in the real component.

---

### Appendix: cleanup

When `VolumeViewer.vue` lands, delete the throwaway files (`volume-throwaway.html`,
`src/volumeThrowaway.ts`). Keep the `@kitware/vtk.js` dependency.
