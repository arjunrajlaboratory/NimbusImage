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

## P2a — Hybrid samThenClassifier can expose/commit intermediate proposals
**Location:** `objectSegmentationPipeline.ts:1568` (`reportPartialProposals`),
streamed from `:1161` (decode loop); Accept gated on `putativeCount`/
`state.proposals` in `ObjectSegmentationPanel.vue:208,286,450`.
**Claim:** in `samThenClassifier` the displayed final output must be the
classifier's SAM-trained result, but intermediate outputs can become
committable: streamed partial SAM proposals used to write `state.proposals`
directly, and the classifier branch could also publish a user-examples-only
pass before SAM populated the hybrid training set.

**Verified:** REAL. `reportPartialProposals` wrote `state.proposals`
unconditionally, with no `applicationMethod` guard — unlike the `samProposals`
mirror (`:1670`) which is gated to `samSimilarity`. During a hybrid decode,
`putativeCount > 0` → Accept enabled → `accept()` commits `state.proposals`
(the SAM partials).

**Status:** `fixed` — `reportPartialProposals` now mirrors the `samProposals`
display gate and only writes displayed/committable partials in `samSimilarity`.
The hybrid training input is also a tagged `{ ready, proposals }` value: it is
pending while SAM recomputes and ready once `samProposals` settles, including
the ready-empty case. `classifierTrainPredict` returns `NoOutput` in
`samThenClassifier` until that input is ready, so Accept cannot commit either
SAM partials or a classifier pass trained only on the user's examples.

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

**Status:** `fixed` — Option C chosen after follow-up review. The cache keeps
the SAM-decoded GCS outline plus the captured descriptor/self-similarity; those
are the durable matching signal after pan/zoom. `computeExampleDescriptors`
reprojects the cached GCS polygon into the current encode only for geometry
tasks. If the polygon intersects the current valid grid, the current mask feeds
example-overlap dedupe and box sizing; if the example is off-screen, no current
mask is produced, avoiding the centroid-clamp fallback that would otherwise
turn an old example into a bogus edge-cell descriptor. Box sizing can fall back
to the captured cell mask when an example is off-screen. This keeps matching
stable across roaming without reusing stale grid positions for IoU.

**Pattern sweep:** the grid-space-caching pattern existed only here. The sibling
pipelines were removed in the unification commit (`5bd24911`):
`exampleSegmentationPipeline.ts` deleted (503 lines); `samSimilarityPipeline.ts`
renamed to `objectSegmentationPipeline.ts`. No other pipeline uses
`poolDescriptor`/`cellMask`/a descriptor cache.

### Options
- **A:** Cache only viewpoint-invariant data (SAM-decoded
  `polygonGcs`, polarity, `promptAnchorGcs`); recompute grid-space geometry
  (`cellMask`, `descriptor`, `selfSimilarity`) fresh each encode from the cached
  GCS polygon. Keeps the expensive SAM decoder call cached; makes all grid-space
  quantities consistent with the current encode. Cheap per-encode recompute
  (CPU pooling/rasterization only). Changes behavior the `:747` comment
  describes (descriptor no longer frozen), so needs sign-off.
- **B:** Invalidate the whole cache on re-encode. Simplest; fully correct; but
  re-runs the SAM decoder for every prompt example on every pan/zoom (slow with
  many examples).
- **C (chosen):** Keep the captured descriptor/self-similarity frozen for
  matching, and recompute only current-view masks when the example intersects
  the active grid. This deliberately separates appearance matching from geometry
  dedupe, and avoids clamping off-screen examples into current edge cells.
- **D:** Accept as-is / by-design; document the limitation. Staleness only bites
  when the user pans/zooms between placing examples and a re-run.
