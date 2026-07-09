# Object Segmentation Tool — Review Findings Tracker

Branch: `claude/nimbus-auto-segmentation-tool-tui99q`
Review source: pasted findings (Codex-style), 2026-07-09.
Design doc: `EXAMPLE_SEGMENTATION_TOOL.md`.

Status legend: `open` / `fixed <commit>` / `stale` / `by-design` / `needs-decision` / `deferred`.

---

## P1 — ONNX session-creation race reintroduced
**Location:** `src/pipelines/onnxModels.ts:113`, new pipeline sessions at
`objectSegmentationPipeline.ts:637` (encoder) / `:671` (decoder).
**Claim:** branch dropped the `sessionCreateChain` serialization that exists on
`origin/master`; the new pipeline creates encoder+decoder sessions from two
independent compute nodes, so the "multiple calls to initWasm()" prod failure
can return. Branch also removed the regression tests.

**Verified:** REAL. Branch carried its own copy of the onnxruntime 1.27 upgrade
+ HTML-shell cache guard but predated master's serialization hotfixes
(`dca23ecf`, `f9a6e9a7`, PR #1237). The new pipeline creates sessions via
`createEncoderSession`/`createDecoderSession` (samPipeline.ts), **both of which
funnel through the shared `createOnnxInferenceSession`** — so serializing that
one function covers the new pipeline automatically.

**Status:** `fixed 9b053838` — merged master into branch. Clean merge (onnx-only:
onnxModels.ts, onnxModels.test.ts, nimbus-frontend SKILL.md,
SAM-ONNX-INITWASM-REVIEW.md). Restores the 2 race regression tests. Verified
tsc + lint + 18/18 onnx tests green.

---

## P2a — Hybrid samThenClassifier can expose/commit SAM proposals
**Location:** `objectSegmentationPipeline.ts:1568` (`reportPartialProposals`),
streamed from `:1161` (decode loop); Accept gated on `putativeCount`/
`state.proposals` in `ObjectSegmentationPanel.vue:208,286,450`.
**Claim:** in `samThenClassifier` the displayed final output must be the
classifier's, but streamed partial SAM proposals write `state.proposals`
directly, so the user can Accept intermediate SAM results before the classifier
runs.

**Verified:** REAL. `reportPartialProposals` wrote `state.proposals`
unconditionally, with no `applicationMethod` guard — unlike the `samProposals`
mirror (`:1670`) which is gated to `samSimilarity`. During a hybrid decode,
`putativeCount > 0` → Accept enabled → `accept()` commits `state.proposals`
(the SAM partials).

**Status:** `fixed (working tree, uncommitted)` — added an
`if (state.applicationMethod !== "samSimilarity") return;` guard to
`reportPartialProposals`, mirroring the `samProposals` display gate. In hybrid
mode Accept now stays disabled until the classifier produces its output.
tsc + lint + 2241 vitest tests green. Awaiting live browser verification before
commit.

**Pattern sweep:** all 5 writers of `state.proposals` audited — the two mirror
writers (`:1682`, `:1685`) are inside the `displayedFor` gate, the method-switch
clear (`:1734`) and the read (`:1751`) are correct; `reportPartialProposals`
(`:1594`) was the only ungated one. No other instance.

---

## P2b — Example descriptor cache goes stale after view changes
**Location:** `objectSegmentationPipeline.ts:762` (`exampleDescriptorCache`,
keyed by example object identity); stale reuse at `:919` (box sizing via
`medianExampleBoxHalfExtentPx`) and `:1021` (overlap IoU via `maskIoU`).
**Claim:** cached entries include grid-tied `cellMask`/`polygon` tied to the
prior screenshot/embedding grid; after a pan/zoom re-encode (same example refs
→ cache hit) those stale masks drive box sizing and overlap filtering on the
new grid, wrongly suppressing candidates or mis-sizing prompts.

**Verified:** REAL and reachable. The pipeline re-encodes on any view change
(nodes depend on the screenshot); examples input is unchanged on pan/zoom, so
the cache hits and reuses old-grid geometry. `cellMask` is embedding-grid space
(not GCS), so it does NOT survive re-encode. The comment at `:747` defends
descriptor reuse as by-design (viewpoint-invariant appearance signature), but
that reasoning does not extend to the grid-space `cellMask` used by box sizing
and mask IoU.

**Status:** `fixed (working tree, uncommitted)` — Option A chosen. Cache entry
slimmed to viewpoint-invariant data only (`polarity`, `polygonGcs`,
`promptAnchorGcs`); `computeExampleDescriptors` split into two passes — pass 1
caches the SAM-decoded GCS outline (expensive decode runs once, survives
pan/zoom), pass 2 recomputes `cellMask`/`descriptor`/`selfSimilarity` fresh
against the current embedding grid via `gcsToDisplay(polygonGcs)`. Box sizing
(`:919`) and overlap IoU (`:1021`) now always match the current grid. On the
first encode this round-trips to the previous behavior (gcsToDisplay ∘
displayToWorld are inverses); only the per-encode CPU pooling re-runs — no extra
GPU decode. tsc + lint + 2241 vitest tests green. Awaiting live browser
verification before commit.

**Pattern sweep:** the grid-space-caching pattern existed only here. The sibling
pipelines were removed in the unification commit (`5bd24911`):
`exampleSegmentationPipeline.ts` deleted (503 lines); `samSimilarityPipeline.ts`
renamed to `objectSegmentationPipeline.ts`. No other pipeline uses
`poolDescriptor`/`cellMask`/a descriptor cache.

### Options
- **A (recommended):** Cache only viewpoint-invariant data (SAM-decoded
  `polygonGcs`, polarity, `promptAnchorGcs`); recompute grid-space geometry
  (`cellMask`, `descriptor`, `selfSimilarity`) fresh each encode from the cached
  GCS polygon. Keeps the expensive SAM decoder call cached; makes all grid-space
  quantities consistent with the current encode. Cheap per-encode recompute
  (CPU pooling/rasterization only). Changes behavior the `:747` comment
  describes (descriptor no longer frozen), so needs sign-off.
- **B:** Invalidate the whole cache on re-encode. Simplest; fully correct; but
  re-runs the SAM decoder for every prompt example on every pan/zoom (slow with
  many examples).
- **C:** Recompute only `cellMask` fresh, keep descriptor frozen. Mixed frames
  (descriptor from old grid, IoU from new) — least clean.
- **D:** Accept as-is / by-design; document the limitation. Staleness only bites
  when the user pans/zooms between placing examples and a re-run.
