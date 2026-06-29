# 3D Volume Mode — Review Feedback (Round 1)

**Reviewer:** ran the implementation in the browser against the **HCR134**
dataset (`/datasetView/6a400ee0f71566dcddc0bd0a/view`) — runtime observation,
not unit tests.
**Verdict:** FAIL — the pipeline builds and renders, but the volume comes out
**geometrically squashed ~15×** on the first real dataset. Architecture and
plumbing match the spec; the failure is localized to z-step provenance.

**Reproduce:** open the dataset → click the top-right **3D** toggle → watch the
console on build, then rotate the result. It renders as a flat sheet, not a
slab.

---

## P0 — Blocker: z-step inference fails → volume squashed ~15×

**Symptom.** On entering 3D the console logs:

```
Ignoring implausibly large z-step override for 3D volume
Unable to infer z spacing for 3D volume; using 0.3257 um fallback
```

The volume is built with z-spacing = the **xy pixel size** (~0.326 µm) instead
of the true **5 µm** step. Rotating shows a near-flat sheet (z ends up *smaller*
than xy: 7 × 0.326 µm ≈ 2.3 µm thick over a ~333 µm field). Correct anisotropy
is the one property the spec calls mandatory (§3, §5.5) — "the difference
between a real slab and a collapsed flat sheet."

**Root cause** — `inferZStepUm` (`src/store/VolumeAPI.ts:135`) has three sources
and all three miss on this data:

1. **Override** (`store.scales.zStep` → µm): computed as a meters-scale value
   and rejected by the `override < 1_000_000` µm guard. That's a unit/default
   bug — a real 5 µm zStep should never be rejected. Check what
   `store.scales.zStep` actually holds for this dataset and how `convertLength`
   maps it (it's producing ≥ 1e6 µm).
2. **Metadata** (`frame.PositionZ`): this dataset's frames have **no
   `PositionZ`** field — their keys are only
   `Channel / Frame / Index / IndexC / IndexZ`. So `framePositions` is empty and
   the median diff is null.
3. **Fallback**: average of `mm_x`/`mm_y` → ~0.326 µm. Squash.

**The real z-step is available and unused.** The dataset folder's
`meta.dimensionLabels.z` is `["-15 µm", "-10 µm", "-5 µm", "0 nm", "5 µm",
"10 µm", "15 µm"]` — a clean 5 µm step that the code never consults.

**Fix direction** (don't over-prescribe, but):
- Add **`dimensionLabels.z` parsing as a primary z-step source** — parse the
  per-plane labels to numeric µm and take the median spacing. This is where the
  answer lives for this (and likely most NimbusImage) datasets.
- Fix the **override** path so a legitimate `store.scales.zStep` isn't converted
  into a meters-scale value and rejected (unit handling / default).
- Keep `PositionZ` and the xy-size fallback as later resorts, and keep the
  warning when truly nothing is known.
- This is exactly the spec §9 "Z-step provenance" risk — resolve it explicitly.

**Re-verify:** rotate the rebuilt volume — it should read as a slab
(~333 µm × ~35 µm aspect), not a sheet.

## P1 — Should fix: segmentations occlude the volume by default

With both layers on (the default), the extruded nuclei surfaces (opacity 0.55,
and very dense — 5,101 of them) **completely hide the volume** — the user sees
only a field of yellow blobs and no image data. Toggling segmentations off
reveals the volume is there but buried.

Pick one: **segmentations off by default** (recommended — the headline feature
is the volume; the overlay is opt-in), or materially lower segmentation opacity,
or render volume-first. As-is, the default 3D view doesn't show the volume at
all.

## P1 — Should fix (likely resolves with P0): volume is very dim

Even with segmentations off, the volume is nearly black versus the bright 2D
DAPI view. This is partly **caused by the squash** — composite blend over a
~2.3 µm collapsed stack accumulates almost no opacity. **Re-check after the P0
z-step fix before tuning anything.** If it's still dim with correct 5 µm
spacing, then revisit the opacity transfer ramp / windowing in
`layerToVolumeTransferFunction`.

## P2 — Minor: segmentation color collides with channel palette

Single-tag "color by tag" renders uniform **yellow**, the same as the TRITC
channel color — confusing when both are visible. Consider a default
segmentation color outside the channel palette, or a distinct LUT.

---

## Works well — please don't regress

- Renders without crashing; smooth interaction.
- Per-channel xy downsample `1024→512` with a logged message (matches spec; no
  silent caps).
- xy spacing formula correctly accounts for the downsample ratio
  (`VolumeAPI.ts:328-330`).
- Blend-mode / volume-visibility / segmentation-visibility / reset toggles all
  respond.
- **Clean 2D↔3D lifecycle** — toggling out and back tears down and rebuilds with
  zero console errors. The abort/serial guard works.

## Not yet verified (blocked behind P0)

- MIP blend *visual* result.
- Color-by-property (whether `propertyItems` populates and recolors).

These are moot until the volume renders with correct proportions; worth a
self-check once P0 is fixed.
