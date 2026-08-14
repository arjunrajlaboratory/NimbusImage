# Color-by-Property — Review Findings Tracker

Branch review of the color-by-property feature (uncommitted working tree vs
master, 2026-08-04). One entry per finding; update Status as each is resolved.

Decision recorded during review: **legend visibility stays shared (per
configuration)** — `showLegend` lives in `colorByProperty` in the collection
metadata, deliberately not in the per-user DatasetView.

| # | Severity | Location | Summary | Status |
|---|----------|----------|---------|--------|
| 1 | Medium | `AnnotationColorLegend.vue` | Legend ignores `.left-palettes-open` shift; z 1003 sits above the layer-info popup (z 1000) | fixed — z 999 (below layer-info popup), joins the `.left-palettes-open` shift + 0.2s slide like the rest of the bottom-left cluster |
| 2 | Medium | `ColorByPropertyDialog.vue` | Apply overwrites all manual colors, non-undoably, without saying so | fixed — dialog copy states it replaces every annotation's color and cannot be undone; test asserts the copy |
| 3 | Low | `models/annotation.py::_colorContinuous` | Single explicit bound can invert the range (rangeMin > data max) → all-mid-color + inverted legend instead of 400 | fixed — explicit-bound empty range raises ValueError → 400; `testEmptyExplicitRangeIsA400` covers both directions |
| 4 | Low | spec / `annotation.ts` undo | Undo of a recorded color change bypasses the legend-clearing choke point | documented — added to the spec's accepted-staleness list with the rationale for not clearing on every undo |
| 5 | Low | `ColorByPropertyDialog.vue::canApply` | Stale `selectedPathKey` across dataset switches → Apply enabled but silently no-ops | fixed — `canApply` requires a live `pathByKey` entry; test covers the stale-key case |
| 6 | Low | apply/remove flows | Failed apply skips refetch though backend colors may already have changed | fixed — store actions refetch in `finally`, except on a 400 (rejected at validation, before any write) to avoid a pointless large refetch; tests cover 400 vs 500 |
| 7 | Low | `ColorByPropertyDialog.vue` | Apply/clear orchestration in the component | fixed — `applyColorByProperty` / `removeColorByProperty` actions in the annotation store own the invariant, `rawError: true` verified by an identity-assert test (confirmed to fail with the flag removed) |
| 8 | Nit | `api/annotation.py::colorByProperty` | 400 message says `propertyPaths` (plural) for the request field `propertyPath` | fixed — explicit `isValidPropertyPath` check with a singular, accurate message |
| 9 | Nit | dialog + legend | Gradient-CSS builder and axios-error extraction duplicated | fixed — `utils/colors.ts::cssLinearGradient` and `utils/errors.ts::extractErrorMessage` (the latter matches a pattern hand-rolled in 4+ existing files; migrating those is out of this branch's scope) |
| 10 | Nit | `models/annotation.py` | `setdefault(x, []).append` grouping → `collections.defaultdict(list)` | fixed — all three grouping sites |
| 11 | Nit | `AnnotationColorLegend.vue` | `variant="tonal"` off the button taxonomy | fixed — `variant="outlined"` |
| 12 | Nit | `models/annotation.py::_colorCategorical` | int 1 vs float 1.0 become distinct categories in forced-categorical mode | fixed — integral floats normalize to the int label; `testForcedCategoricalMergesIntAndIntegralFloat` |

## Live backend testing (708K-annotation dataset `6a19784f…3206`)

Tested against the running container on :8080 (rebuilt between cycles). All
error paths, nested paths, auto-mode selection, the MAX_CATEGORIES guard and
`clear` behaved correctly. Three problems only real data exposed, each fixed
and re-verified live:

| # | Problem | Evidence | Fix |
|---|---------|----------|-----|
| L1 | Full-extent default range is useless on skewed data | Area: 99% of values occupy 14.2% of min..max (19.5 vs 12792 with p99 = 1960). 131 distinct colors, one bucket holding 52,424 annotations, all near-identical dark purple | Default the ramp to the **1st..99th percentile** (`DEFAULT_PERCENTILE_LOW/HIGH`), overridable via `percentileLow/High`, with `rangeMin/rangeMax` still absolute overrides. Legend gained `dataMin`/`dataMax`/`clippedLow`/`clippedHigh`; the viewer labels clipped ends `≤`/`≥` with the true extent on hover. After: **254 distinct colors, largest bucket 1.1%** |
| L2 | Categorical palette cycled, so distant categories rendered identically | A real 36-cluster graph clustering produced only **20 distinct colors** — clusters 1 and 21 both `#4e79a7` | `categoricalColor(index)` shifts lightness once the 20-color palette is exhausted (5 cycles → 100 distinguishable colors). After: **36 categories, 36 distinct colors** |
| L3 | Cost before the guard (the pattern this repo's review skill flags) | Forcing categorical on continuous Area built a **555,479-entry** grouping dict before the 256 cap rejected it, ~12s | Bail inside the grouping loop the moment the cap is exceeded; message now reports the cap, not a total. After: **3.7s** (the residual is streaming values from Mongo, unavoidable before cardinality is known) |

Live matrix confirmed: continuous (16.9s/708K), categorical (12.6s), nested
path (`Centroid.x`), absolute range clipping, custom percentiles 25/75
(matched Mongo's independent p25/p75 to 0.1), auto-mode picking continuous for
integer gene counts, `clear` (4.1s), and 400s for empty range / bad colormap /
bad mode / unknown property / inverted percentiles.

Not exercised live: the `uncolored` count — every property in this dataset
covers all 708,983 annotations, so partial coverage stays unit-test-only
(`testContinuousAutoMapsExtremesAndSkipsMissing`).

**Dataset left exactly as found**: all 708,983 colors back to `null` (verified
post-`clear`).

## Browser verification (708K dataset, stub mode)

Verified in the live app at `#/datasetView/6a1978ad247013c97128321f/view`
(708,983 stubs, `stubOnlyMode` true, 15,727 features drawn):

- **Finding 1's fix confirmed**: with the left palette column open the legend
  computes `transform: matrix(1,0,0,1,430,0)` — it joins the bottom-left
  cluster's shift instead of hiding under the palettes — at `z-index: 999`,
  and `elementFromPoint` at the panel's centre returns the legend itself.
- **Apply → persist → refetch end to end** (via the store action the dialog
  calls): continuous on `cell Blob metrics / Area` returned 708,983 coloured /
  0 uncoloured, persisted the new-shape legend (ramp 150.01–1959.97, extent
  19.50–12792.47, clipped both ends), and the refetched stubs carried
  per-annotation colours (217 distinct in a 5,000 sample).
- **Categorical** on `Clustering / graphclust`: 36 categories, **36 distinct
  colours**, cluster 1 `#4e79a7` vs cluster 21 `#2b435c` — the palette
  extension working on real data. Legend showed 30 rows + "+6 more",
  scrollable at 240px.
- **Collapse/reopen via real clicks**: persisted `showLegend` false/true, and
  confirmed present in the collection metadata over REST.
- **Legend honesty**: `colorAnnotationIds` on a single annotation retired the
  legend (config → `null`, legend removed from the DOM).
- **Backwards compatibility**: a legend saved before the percentile change
  (no `dataMin`/`clippedLow`) still rendered, with no `≤`/`≥` markers.

Two things fixed as a direct result of *looking* at it:

1. The continuous bar was vertical in a panel whose width is set by the
   property name, leaving ~180px of dead space (panel 220×196, bar 16×140).
   Now a full-width horizontal ramp: panel 193×90, bar 171×12.
2. `toPrecision(3)` rendered the range end 1959.97 as **"1.96e+3"**. Now
   `Intl.NumberFormat` with 3 significant digits → "1,960" / "12,800".

**Not verified**: the click path through the *More Actions → Color by
Property…* menu into the dialog. The Chrome window was occluded
(`visibilityState=hidden`, `framesPerSec=0`), which leaves every Vuetify
overlay at `visibility: hidden; pointer-events: none` — the menu item is in
the DOM and enabled, and clicks register (`v-overlay--active`, z-index 2000),
but overlay content never becomes hittable. Environmental, not a defect; needs
a foreground window to confirm.

**Dataset left clean**: all 708,983 colours `null` and no legend in the
configuration, so a fresh apply from the UI starts from nothing.

## Post-apply refetch removed (`returnAssignment`)

Follow-up after measuring the whole user-visible operation: writing colours was
never the dominant cost — the `GET /stubs` refetch that followed it was (12.8s,
178 MB, recomputing every centroid from full polygon coordinates for a change
that touched only a colour string). The endpoint already holds the id→colour
grouping it just wrote, so it now returns it on request and the client patches
in place. **Whole apply on 708K annotations: ~22s → ~11s.** See
`COLOR_BY_PROPERTY.md` § "The post-apply refetch" for the numbers and the
invariants.

Two defects found while building it, both by measuring rather than reasoning:

| # | Problem | How it surfaced | Fix |
|---|---------|-----------------|-----|
| L4 | The new mutation assigned `annotationStubs` **without `markRaw`** — the only one of ten assignments to that map that didn't — so Vue walked and proxied all 708,983 entries | The clear path measured **16.9s** when the backend clear is ~5s and the patch ~0.5s; the gap didn't add up | `markRaw(newStubs)`, plus `src/store/__tests__/rawStateMaps.test.ts` asserting the invariant for every mutation replacing one of these maps. Verified by removing only the `markRaw` call: exactly one test fails. Patch is now **~0.5s** |
| L5 | Hydration issued before a recolor could land after it and reinstate pre-recolor colours (the race raised in review) | Reasoned from the write window, then reproduced live by committing a stale-coloured hydration | `mergeHydratedAnnotations` takes `color` from the local stub when one exists; geometry still comes from the fetch. Verified live: `#STALE0` overridden, coordinates preserved |

Verified live on the 708K dataset: **zero** stub refetches on both apply and
clear, **zero** mismatches across all 708,983 stub colours against the returned
assignment, and a direct 5/5 spot-check of client colours against MongoDB.

## Merge-round findings (Codex on merge commit `34053a4`, plus carried-over P2s)

Codex re-reviewed after the merge of master (annotation raster overview,
analysis gating). Three new findings, two P2s from the original `6aeeb2f4`
round that were never addressed, and one human style comment.

| # | Severity | Location | Finding | Status |
|---|----------|----------|---------|--------|
| M1 | P2 | `api/annotation.py` bound loop | `math.isfinite(10**1000)` raises `OverflowError` → 500 instead of the clean 400 the loop exists to provide. Siblings found by sweep: `requireFloat` (`float(bigint)` raises the same, uncaught by its `(TypeError, ValueError)`), `_isFiniteNumber` (gate-vertex validation on the public analysis endpoints). | fixed — `isFiniteNumber` exported from validation.py (OverflowError-safe), used by the bound loop and gate vertices; `requireFloat` catches OverflowError. Tests: `TestIsFiniteNumber`, `TestRequireFloat`, `TestGateVertexValidation`, huge-int case in `testNonFiniteBoundsAreClean400s` |
| M2 | P2 | `models/annotation.py` `_writeColors`/`clearColors` | The raster-version bump sits after the writes, so a `bulk_write`/`update` raising partway leaves partially-changed colors cached (geometry + 304s) until the 120s TTL. The frontend already treats non-400 failures as "may have written" and refetches; the server cache must too. | fixed — bump moved into `finally` in both `_writeColors` and `clearColors`; over-invalidation on a no-write failure costs one cache rebuild, the reverse serves wrong colors. Test: `testFailedColorWritesStillInvalidateRaster` |
| M3 | P2 | `annotation.ts` `colorAnnotationIds` | A dataset/configuration switch during the awaited write suppresses legend retirement entirely — the captured dataset's colors were changed but its configuration keeps the stale property legend. Guard must protect the NEW dataset without abandoning cleanup of the captured one. | fixed — new captured-pair write action (now generalized as `main.saveColorByPropertyFor({datasetId, configurationId, state})`, see M7) targets the captured pair; same-config path reuses the local mutation with the captured dataset id, switched-config path PUTs the pruned key via `updateConfigurationKey` (best-effort, like `saveColorByProperty`). Tests: two switch cases in `colorByProperty.test.ts` |
| M4 | P3 | `annotation.ts` comment, `COLOR_BY_PROPERTY.md` dialog-flow | Prose still describes the pre-`returnAssignment` behavior (apply ⇒ refetch); successful apply/remove now patch locally and deliberately skip the refetch. | fixed — comment in `annotation.ts`, apply-flow + clearing-semantics + testing sections in `COLOR_BY_PROPERTY.md`, and the dialog's apply() comment now describe the local assignment; refetch is documented as the fallback only |
| M5 | P2 (orig. round) | `ColorByPropertyDialog.vue` `parseBound` | Invalid numeric text (`1e309`, partial exponent) parses to `undefined` — the same value as an intentionally blank field — so Apply silently proceeds with defaults on a destructive, non-undoable operation. | fixed — `boundErrors` computed distinguishes invalid from blank, shows per-field errors, and gates `canApply` (except categorical mode, where the fields are hidden and never sent). Tests: two new dialog cases |
| M7 | P2 (Codex on `d166900`) | `annotation.ts` apply/remove switch branches | M3's twin on the property paths: a mid-request dataset switch skipped persisting the captured dataset's NEW legend (an older coloring's legend would reopen over the new colors — the wrong-legend direction the design forbids), and `removeColorByProperty` left the cleared dataset's legend active. | fixed — `retireColorByProperty` generalized to `saveColorByPropertyFor({datasetId, configurationId, state})`; apply persists the new legend and remove retires it for the captured pair regardless of switches, while only the LOCAL color apply stays switch-guarded. Tests: three switch cases in `colorByProperty.test.ts`, each watched failing pre-fix |
| M8 | P2 (Codex on `e0c0441`) | `annotation.ts` apply/remove failure paths | A non-400 failure after a partial bulk write refetched the colors but left a PREVIOUSLY persisted legend standing — describing neither the half-applied mapping nor the refetched colors. | fixed — both catch blocks retire the captured pair's legend when `backendMayHaveChanged` (a 400 wrote nothing, so its legend stays). Tests: three failure-path cases in `colorByProperty.test.ts`, the two retire cases watched failing pre-fix |
| M9 | P3 (Codex on `e0c0441`) | `COLOR_BY_PROPERTY.md` model section | Spec still documented the singleton `colorByProperty: IColorByPropertyState \| null` shape with an `appliedAt` field, and the apply-flow bullets named `saveColorByProperty` — the exact current-pair invariant M7 replaced. | fixed — model section now shows the dataset-keyed `TColorByPropertyByDataset` (no `appliedAt`, `{}` default) and the flow bullets describe `saveColorByPropertyFor` on success and failure paths |
| M10 | P2 (Codex on `891eaae`) | `annotation.ts` `colorAnnotationIds` | The manual-recolor twin of M8: `updateAnnotationsPerId` rejecting after the backend bulk save began (remove + insert_many) left partial manual colors under a standing property legend, and the canvas out of sync with what landed. | fixed — catch retires the captured pair's legend unless the failure was a 400, refetches when still on the captured dataset, and rethrows. Tests: two failure cases in `colorByProperty.test.ts`, the 500 case watched failing pre-fix |
| M11 | P2 (Codex on `891eaae`) | `models/annotation.py` `colorByProperty` | Property-value docs are matched on their own denormalized `datasetId`, so an annotation moved to another dataset still contributed its value — distorting the range/categories, inflating the covered-id count, and listing never-written ids in the assignment (writes were already correctly scoped). | fixed — the value map is filtered against the dataset's actual annotation ids in one chunked indexed pass; the `_writeColors` skipClear fallback stays as a backstop. Test: `testMovedAnnotationsValuesAreExcludedFromTheMapping` (MongoDB-backed, runs in CI; pre-fix failure is structural — the unfiltered map provably included the moved id) |
| M12 | P2 (Codex on `891eaae`) | `annotation.ts` apply flow | Legends live per (configuration, dataset) while `annotation.color` is dataset-global, so configuration B (same dataset) keeps showing its old legend over colors written under configuration A — for the open session AND for configurations not currently open, including other users'. | by-design (user decision) — documented in `COLOR_BY_PROPERTY.md` § "Known, accepted staleness": the client cannot write configurations the user may not own, and a server-side sweep is the permission-escalation shape the backend rules forbid. The principled follow-up, if it bites in practice, is moving legend provenance onto the dataset (recoloring already requires dataset WRITE) |
| M13 | P3 (Codex on `a8985cf3`) | `ColorByPropertyDialog.vue` Remove button | Enabled for unauthenticated viewers of a public dataset, who can only receive an authorization error — Apply and the menu entries already gate on login. | fixed — `!store.isLoggedIn` added to the disabled condition (disabled, not hidden: the viewer still sees the active coloring). Test: `disables Remove coloring for unauthenticated viewers`, watched failing pre-fix |
| M14 | P3 (Codex on `a8985cf3`) | `models/annotation.py` `colorByProperty` docstring | Said omitted bounds default to the data extent; the implemented default is the 1st..99th percentile clip — the endpoint notes and feature doc were correct, the model docstring said the opposite. | fixed — docstring now describes percentile resolution and points at _colorContinuous |
| M6 | style (pchoisel) | `api/annotation.py` `colorByProperty` `.notes()` | The `Body: {...}` schema blob makes the notes unreadable; move it to a comment/docstring at the top of the function. | fixed — body schema moved to the endpoint docstring; `.notes()` keeps the behavioral prose |

Sweep notes for this round:

- `History._undoOrRedo` (master, pre-existing) has the same write-then-bump
  shape as M2 — raw restore operations, bump only after success. Out of this
  branch's scope; noted here rather than churned.
- Every new frontend/unit test was watched failing pre-fix.
  `testFailedColorWritesStillInvalidateRaster` needs the MongoDB-backed
  server fixture, which this environment cannot run; its pre-fix failure is
  structural (the bump was sequenced after the raising call, so it provably
  never ran) and the green side runs in CI.
