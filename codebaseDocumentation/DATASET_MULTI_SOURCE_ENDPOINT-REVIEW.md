# `POST /dataset/{id}/multi_source` — review findings

Review of PR #1225 after merging `origin/master` (187 commits) into
`claude/dataset-upload-endpoint-cdbdj8`. Findings came from reading the diff
against the current frontend plus **live testing against a rebuilt girder
container** with real image files (6 TIFF channel×time set, two multi-file ND2
sets, a 290-page TIFF, a synthesized RGB TIFF).

Merge itself was clean; the parity batteries still pass unchanged
(frontend 23/23, backend 103/103), which is what established that findings
below are *gaps in coverage*, not drift in the ported arithmetic.

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| P1 | high | `server/api/dataset.py:187` | Transcode path 500s on a real backend: config item is already `largeImage` (autoSet via the `multi` source) when `createImageItem` runs | fixed |
| P2 | medium | `server/api/dataset.py:156` | `validate_assignments` runs before the `dryRun` return, so a caller can never obtain the `variables` needed to build an `assignments` override | fixed |
| P3 | medium | `server/helpers/multi_source.py` | No mixed-`dtype` guard — master #1309 added one to the frontend, so the endpoint builds configs the UI rejects | fixed |
| P4 | low | `server/api/dataset.py:303` | `_markLargeImages` picks an arbitrary file for multi-file items; girder's own endpoint refuses them | fixed |
| P5 | low | `server/helpers/multi_source.py` (several) | JS `typeof x === "undefined"` / `Number(x) \|\| 0` ported as `x is None` / `float(x)` — diverges on explicit `null`, on booleans, and raises on non-numeric strings | fixed |
| P6 | nit | `src/views/dataset/MultiSourceConfiguration.vue:1266` | `getCompositingValueFromAssignments` is a byte-identical duplicate of `getValueFromAssignments` | fixed |

## Second round (branch review of the fixes above)

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| R1 | medium | `nimbusimage/client.py:110` | Datasets created through the API never appeared in `list_datasets()`, which enumerates dataset views | fixed — the endpoint now creates a collection + view (`createView`, default on) |
| R2 | low | `server/helpers/multi_source.py:125` | `_js_number_or_zero` returned `-0.0` where JS `\|\| 0` gives `+0`, rendering "-0 nm" | fixed |
| R3 | low | `nimbusimage/models.py:175` | `isRGBFile` / `rgbBandCount` / `transcodeDefault` came back only on dry runs and were dropped by the model | fixed — returned by both paths, modelled on both |
| R4 | low | `test_dataset_multi_source.py` | Malformed-body dry-run test asserted only the status, and two routes reached 400 | fixed — pins the reason |
| R5 | low | `test_multi_source_parity.py:112` | Validation fixtures check message parity across ends that deliberately behave differently | fixed — documented at the assertion |
| R6-R9 | nit | package + tests | `import os` in a method; `(source, guess)` used as a variable identity; `"multi-source2.json"` literal ×10; `upload()` silently dropping subdirectories | fixed |

R1's fix is the largest: a fourth port (`helpers/default_configuration.py`,
covering `defaultConfigurationBase` / `newLayer` / `getDatasetCompatibility` /
`getDatasetScales` / `inferZStepFromDimensionLabelsUm`) so the collection gets
the same default layers, colours and scales the UI would create. Two
divergences were caught while writing its tests, both of which would have made
API-created datasets subtly different from UI-created ones:

* the frontend's `median` is the **upper** median (`sorted[floor(n / 2)]`), not
  the mean of the middle pair, so an even number of z-spacings picks the larger;
* `normalizeLengthUnit` accepts far more spellings than the obvious four
  (`nanometers`, `micrometer`, …) and normalizes GREEK SMALL LETTER MU to MICRO
  SIGN before matching.

The colour tables are the drift risk, so `TestColourTableParity` re-parses
`src/store/model.ts` and compares — a palette edit on the frontend fails the
backend suite instead of silently giving API-created datasets different layer
colours. It self-skips where the frontend tree is unreachable (the Linux
container), so run that file under `tox` too, where 43 tests pass rather than
40 + 3 skipped.

Writing R1's fix also reproduced, in new code, the exact bug shape this review
flagged in `_markLargeImages`: the first version built the collection and view
in a helper returning a tuple, so when the view creation raised, the helper's
local `collection` was lost and the caller's rollback variable was never
assigned — leaking the collection. Caught by
`testViewFailureRollsBackTheWholeRequest`. Each resource is now assigned to its
own variable as it is created.

## Third round (Codex, commit b273889f)

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| X1 | P2 | `server/api/dataset.py` | Clearing the source items ran before the transcode and view creation, so a later failure destroyed `largeImage` state this request did not create and cannot restore — and deletes the derived file for a worker-converted source | fixed — the destructive clear is now the last step |
| X2 | P2 | `server/api/dataset.py` | Compositing forces every `xySet` to 0, so the image has one XY position, but the collection recorded the assignment size and `areCompatibles()` would call it incompatible with its own dataset | fixed — `compute_configuration` reports `compositing`, and the compatibility block uses `xy_count=1` when it is set |
| X3 | P2 | `server/helpers/default_configuration.py` | The creator's saved channel-colour overrides were ignored, so API-created collections silently differed from UI-created ones | fixed — `resolve_channel_colors` merges them, loaded via `UserColors().getUserColors(user)` |

All three were verified against the frontend before fixing: `areCompatibles`
does compare `xyDimensions` exactly, and `createConfigurationFromDataset` does
thread `userColors` into `newLayer`.

X1 is the sharper version of a trade-off the second round had noticed and
accepted ("matches the frontend's failure state, and a retry re-marks"). What
that reasoning missed is the worker-converted case, where `ImageItem().delete`
removes the derived image file — not recoverable by re-marking. Deferring the
clear until nothing fallible remains removes the whole class rather than
arguing about which failures are survivable.

## Fourth round (Codex, commit 6ef3f3e6)

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| Y1 | P1 | `server/helpers/filename_parsing.py:96` | The minimal-spanning-column search is 2**N in token columns; measured 9.4s at 20 tokens, doubling per token, on a synchronous Girder request | fixed — two output-preserving bounds |
| Y2 | P2 | `server/api/dataset.py` | `_uploadConfiguration` created the item and then loaded it; a failing load left the caller with no handle, orphaning `multi-source2.json` so every retry hit the preflight 409 | fixed |
| Y3 | P2 | `server/api/dataset.py` | Source clearing is several deletes and was still inside the fallible region, so a mid-way failure destroyed some derived files *and* unwound a good dataset | fixed — commit first, clear best-effort |

**Y1** is inherited from the frontend's algorithm, but the severity is not:
in a browser it hangs one tab, behind this endpoint it blocks a request
thread for every user. Both bounds are provably output-preserving, which is
why no cap on user data was needed:

1. A column with a single distinct value multiplies the product by 1, so any
   matching combination containing it also matches without it — and the
   smaller combination is enumerated first. The minimal match therefore never
   contains one (except the empty combination, which is never enumerated and
   only matches a single row, hence the `total_rows > 1` guard).
2. `_assign_unique_categorizations` discards a minimal set larger than the
   four categories, returning `[]` — exactly what "no match" returns. Searching
   past size four can only spend time to reach the same answer.

Distinct counts are also computed once per column instead of once per
combination. 20 tokens went from 9.4s to under a millisecond, 120 tokens is
instant, and all 108 parsing/parity tests are unchanged — which is the real
evidence that the output is preserved.

**Y2** is the third instance on this branch of one shape: *a helper creates a
resource and the caller's rollback handle is only assigned when the helper
returns*. The first two were the collection/view tuple and this. The rule now
written down: never let a created resource exist without a caller-visible
handle to it.

Residual, deliberately not swept: if `Upload().uploadFromFile` itself fails
*after* creating the item, there is no handle at all. Cleaning that up would
mean finding the item by folder + name, which is unsafe — the concurrent-upload
case (`testConcurrentConfigurationUploadConflictsAndRollsBack`) has two
requests in the same folder, and a name lookup would let the failing one delete
the winner's configuration.

## Fifth round (Codex, commit 82831be3)

| # | Severity | Location | Summary | Status |
|---|---|---|---|---|
| Z1 | P1 | `server/helpers/filename_parsing.py` | The round-four bounds still left the *all-varying* case expensive: 3 files × 120 two-valued columns built every one- to four-column set — reproduced at 2.3s and **893MB peak RSS** | fixed — walk the choices instead of materializing them, plus product/divisibility pruning |
| Z2 | P2 | `nimbusimage/dataset.py` | A partially failed `upload()` left the earlier files behind, so retrying uploaded duplicates that girder renamed and `configure()` then read as extra sources | fixed — the call removes what it uploaded |

Z1 is a fair hit on the round-four **test** as much as the code: the cost test
used constant tokens, which bound 1 drops outright, so it was passing on the
case the bound already handled and blind to the one that mattered. The new
tests cover all-varying tokens, and — because every speed assertion expects
`[]` — one of them checks a set that *must* still match, so the suite cannot be
satisfied by a search that returns nothing.

The added prune is that the final product is the partial product times whole
numbers, so a partial that does not divide the row count can be abandoned. With
three files and two-valued columns every branch dies at depth one (`3 % 2`), so
120 columns went from 2.3s/893MB to 0.0001s/18MB, and 400 columns is still
instant.

`transcode` defaults to `true` for any dataset that is not entirely `.nd2`, so
this is the **primary** path, and it failed on every attempt:

```
dataset.py:188 → createImageItem(newItem, newFile, createJob="always")
large_image.exceptions.TileGeneralError: Item already has largeImage set.
```

Girder's upload handler (`largeImage.autoSet`, on by default) marks the
just-uploaded `multi-source2.json` as a large image — confirmed in mongo:

```
db.item.find({name:'multi-source2.json'}) → largeImage: {fileId: …, sourceName: "multi"}
```

The frontend never hits this because `addMultiSourceMetadata`
(`src/store/index.ts:1932`) clears `largeImage` from **all** items — including
the configuration it just uploaded — *before* calling
`generateTiles(itemId, force, localJob)`. `dataset.py` did it in the opposite
order and excluded the new item from the clear list entirely.

**Why the test suite could not catch it.** Under `pytest_girder` only
`upenncontrast_annotation` is loaded — `loadedPlugins()` returns exactly that
one — so `girder_large_image`'s `load()` never runs and **none** of its event
handlers are bound. `checkForLargeImageFiles` (the `model.file.save.after`
handler behind `largeImage.autoSet`) therefore cannot fire under test, no
matter which tile sources are installed. Every existing assertion about the
transcode path was describing a precondition the deployed server does not
have.

(First hypothesis was that `tox.ini` merely lacked `large-image-source-multi`,
so nothing could read the configuration JSON. That is true but not the
operative cause: adding the source changes nothing while the handler is
unbound, so the dependency was reverted rather than left in as dead weight.)

The regression test therefore has to establish the precondition itself. Binding
the genuine `checkForLargeImageFiles` was tried first and is unusable: probing
the multi-source JSON walks every installed source and `large_image_source_tiff`
segfaults pylibtiff on arm64 (crash inside `libtiff.GetField`). The
`largeImageAutoSet` fixture instead writes the same `largeImage` shape autoSet
writes (`fileId` + `sourceName`, no `originalId`/`jobId`), which is the only
part of it this endpoint interacts with.

**Fix.** Mirror the frontend's ordering: clear `largeImage` from the source
items and, when transcoding, from the configuration item too, *before*
regenerating its tiles. `ImageItem().delete()` is safe here — it only removes
the underlying file when `largeImage.originalId` is set (a worker-converted
file), which an autoSet mark never has, so `multi-source2.json` itself is not
touched.

**Generalized (symmetric-path sweep).** The shape is "a rule applied to one of
two symmetric paths" — the source items and the configuration item are the two
paths, and only one was being cleared. Swept the rest of the endpoint for the
same asymmetry: `_markLargeImages` correctly covers only source items (the
configuration does not exist yet), and the failure path removes the
configuration item wholesale via `Item().remove`, so its mark cannot leak.

## P2 — `dryRun` cannot be used to discover variables

`compute_configuration` → `validate_assignments` → `if dryRun: return` meant a
dry run whose defaults do not fill every variable returned a bare
`400 Not all variables are assigned` with no variable list.

This is not hypothetical. A folder of two ND2 files
(`DP_Fli1_Ets1_DNA_FISH_slide1_loc005.nd2`,
`DP_Fli1_Ets1_Gapdh_RNA_FISH_slide1_loc005.nd2`) produces three sized
variables — a filename variable guessed `C`, a file `Z` (38), a file `C` (4) —
and the defaults fill only two, so the request 400s. The caller needs
`variables` to know that the answer is
`{"XY": {"source": "filename", "guess": "C"}}`, but validation denies them the
list. I had to run the helpers offline to find it.

The 400 on a **real** run is correct parity (the frontend also refuses to
submit). What is wrong is applying it to the discovery mode.

**Fix.** For `dryRun`, report validation failures in the body as
`validationError` (HTTP 200) alongside the computed `variables` /
`assignments` / `config`; real runs still raise 400. Malformed-request errors
(unknown dimension, bad assignment shape, non-boolean option) still 400 in dry
runs — those are not discovery results.

**Generalized (cost-before-guard sweep).** Checked the rest of the handler for
the inverse ordering problem (expensive work before a cheap guard that would
skip it): the `contrastDataset`, 409 and empty-folder guards all run before any
tile metadata is read, so they are correctly ordered.

## P3 — mixed-`dtype` guard missing

Master's #1309 (`Block mixed-dtype multi-source datasets`) added
`mixedSourceDtypeError` to `MultiSourceConfiguration.vue`, taking precedence
over the assignment error, and made `generateJson` bail out early. The port has
no equivalent, so the endpoint will happily produce a configuration the UI
refuses to create.

`dtype` is already present in the tile metadata the endpoint fetches (verified
against a live item), so no extra request is needed.

**Fix.** `validate_source_dtypes` in `multi_source.py` (pure, raises
`ValueError`), called before `validate_assignments` to match the frontend's
`mixedSourceDtypeError ?? assignmentError` precedence.

**Coverage.** The error *message* is now parity-checked rather than
hand-copied: the parity harness gained a third fixture category
(`validation_*.json`) whose goldens are generated from the real Vue component's
`submitError` / `generationErrorMessage`, with a matching loop on the Python
side. This closes the gap that let P3 exist — the previous harness only
compared successfully-generated configs, so a frontend-side *refusal* was
invisible to it.

## P4 — arbitrary file chosen for multi-file items

`_markLargeImages` batch-loaded files with `File().find({itemId: {$in: …}})`
and kept the first one seen per item via `setdefault`. With no sort that is
non-deterministic in mongo's natural order, and for an item with more than one
file it silently picks one. Girder's own `POST item/{id}/tiles`
(`girder_large_image/rest/tiles.py:234`) uses `childFiles(item, limit=2)` and
**refuses** the item unless exactly one file is present.

**Fix.** Mirror girder: group the batch-loaded files per item and raise
`400` naming the item when it has more than one file, keeping the existing
`400` for zero files. Still one query, no per-item `childFiles` loop.

## P5 — JS coercion semantics in the port

Same family, five instances found by sweeping `multi_source.py` for every place
a JS `typeof`/`??`/`||`/`Number()` idiom was translated:

1. `_detect_color_vs_channels` — `if photo is None` stands in for
   `typeof photo === "undefined"`. JS `typeof null === "object"`, so an
   explicit `"photometricInterpretation": null` skips the band-count branch in
   the frontend but entered it in Python. Now keyed on key **presence**.
2. `_camera_matrix_source` — `channels.get("volume") is not None` stands in for
   `chan.volume !== undefined`; an explicit `null` volume diverged the same
   way. Now keyed on key presence.
3. `_get_z_labels` — `float(step_um)` raises `ValueError` on a non-numeric
   string where JS `Number(x) || 0` yields `0`. Now coerced the JS way.
4. `_is_finite` — returned `True` for `bool` (Python `isinstance(True, int)`),
   but `Number.isFinite(true) === false`. Booleans now excluded, which matters
   for `Number.isFinite(z.parameters.homeIndex)`.
5. `_get_time_labels` — `params.get("periodMs") or 0` was already correct
   (`||` semantics); left as-is and noted so the sweep is not re-run.

These are all unreachable with metadata that `large_image` actually emits
today; they are fixed because the module's contract is "reproduces the JS
exactly", and a silent divergence in a parity port is worse than a loud one.

## P6 — duplicate function in the component

`getValueFromAssignments` (line 1239) and
`getCompositingValueFromAssignments` (line 1266) are byte-identical. The port
correctly used one implementation for both call sites; folding the duplicate
away in the component keeps the thing being ported single-sourced.

---

## Regression checklist

Each line names the invariant and the test that holds it. Run
`docker exec girder bash -lc "cd /src/AnnotationPlugin && python -m pytest
upenncontrast_annotation/test/test_dataset_multi_source.py
upenncontrast_annotation/test/test_multi_source_parity.py -q --mongo-uri
mongodb://mongodb:27017"` and
`pnpm test src/views/dataset/MultiSourceConfigParity.test.ts` and
`cd nimbusimage && .venv/bin/python -m pytest tests/test_dataset.py`.

### Transcode / large-image lifecycle

- [ ] **An already-marked configuration still transcodes.** `autoSet` marks the
  uploaded `multi-source2.json` before the endpoint reaches `createImageItem`,
  which refuses an item that already has a `largeImage`. Clear it first, and
  check the configuration's own file survives the clearing. —
  *"testTranscodeSchedulesJobWhenConfigIsAutoMarked"*
- [ ] **The twin: a non-transcode run KEEPS the configuration's mark.** That
  mark is what makes the dataset readable; only the source items lose theirs. —
  *"testAutoSetMarkSurvivesNonTranscodeRun"*, *"testFullRunNonTranscode"*
- [ ] **A failed transcode setup leaves the folder retryable.** No orphan
  configuration item, no `dimensionLabels`, no stray marks. —
  *"testTranscodeSetupFailureCanBeRetried"*

### Discovery / validation

- [ ] **`dryRun` reports validation failures instead of raising.** A 400
  withholds the `variables` list the caller needs to build an `assignments`
  override, so discovery would dead-end. The same test feeds the dry run's own
  answer back and expects it to succeed. —
  *"testDryRunReportsValidationErrorWithVariables"*
- [ ] **Malformed bodies still 400 under `dryRun`.** A bad request is not a
  discovery result. — *"testDryRunStillRejectsMalformedBodies"*
- [ ] **Sources with different pixel types are refused.** Parity with the
  frontend's `mixedSourceDtypeError`; reported rather than raised on a dry run.
  — *"testRejectsMixedSourceDtypes"*,
  *"testDryRunReportsMixedDtypeInsteadOfFailing"*
- [ ] **The twin: uniform and absent dtypes are accepted.** An absent `dtype`
  must not count as a distinct type. — *"testUniformDtypesAreAccepted"*
- [ ] **Refusal messages and their precedence match the component exactly.**
  Goldens are generated from the real Vue component by the parity harness's
  `validation fixtures` block, so the strings cannot drift by hand-copy. —
  *"validation fixtures"*, *"test_parity"*

### Items / files

- [ ] **An item with no files 400s naming the item.** —
  *"testRejectsItemWithNoFiles"*
- [ ] **An item with several files 400s rather than guessing.** Girder's own
  tiles endpoint refuses these; picking whichever file mongo returned first
  would be non-deterministic. — *"testRejectsItemWithMultipleFiles"*

### Cost

- [ ] **Marking large images uses one batched query.** `File().find({$in: …})`,
  never a `childFiles` call per item. —
  *"testMarksLargeImagesWithASingleFileQuery"*

### Cost and availability

- [ ] **The spanning-column search stays bounded for varying tokens too.**
  The first version of this check used constant tokens, which one bound drops
  outright — it passed on the case already handled and missed 893MB of peak
  RSS on all-varying ones. — *"testManyVaryingTokensAreFast"*
- [ ] **A bounded search still finds real spanning columns.** Every speed
  assertion expects `[]`, so without this one they would all pass against a
  search that returned nothing. —
  *"testVaryingTokensStillFindTheSpanningColumns"*
- [ ] **The spanning-column search stays bounded.** It is 2**N in token
  columns and runs inside a synchronous request; the bounds must remain
  output-preserving, so these assert equality with the unbounded answer, not
  just speed. — *"testManyConstantTokensAreFast"*,
  *"testSingleValueColumnsCannotChangeTheMinimalMatch"*,
  *"testMoreThanFourSpanningColumnsYieldsNothingEitherWay"*,
  *"testSingleRowStillMatches"*

### Collection and view

- [ ] **A created resource always has a caller-visible handle.** Three
  instances on this branch: the collection/view tuple, and the configuration
  item's separate load. Otherwise the rollback has nothing to undo and an
  orphaned configuration blocks every retry on the preflight 409. —
  *"testConfigItemIsRemovedWhenItsLoadFails"*,
  *"testViewFailureRollsBackTheWholeRequest"*
- [ ] **Rollback attempts every item and never replaces the response.** It
  runs from `finally`, where a raised exception discards the return value —
  pre-fix, a successful dry run came back as a 500. —
  *"testRollbackTriesEveryItemAndDoesNotMaskTheResponse"*
- [ ] **A failed source-clear does not unwind a good dataset.** Clearing is
  several deletes and cannot be undone, so it happens after the commit and is
  best-effort. — *"testSourceClearingFailureDoesNotUndoAGoodDataset"*
- [ ] **A failed run leaves pre-existing `largeImage` state alone.** Items
  marked before the request are not in `newlyMarked` and cannot be restored,
  and clearing a worker-converted source deletes its derived file, so the
  clear must come after everything fallible. —
  *"testPreExistingLargeImagesSurviveAFailedRun"*
- [ ] **Compositing collapses XY to one position, and the collection says
  so.** Otherwise `areCompatibles()` rejects the collection for its own
  dataset. — *"test_compositing_reported_and_xy_collapsed"*,
  *"test_not_compositing_when_not_requested"*
- [ ] **The creator's channel-colour overrides are honoured.** —
  *"testUserChannelColoursAreHonoured"*, *"testUserOverrideWinsOverTheDefaultTable"*,
  *"testMergeDoesNotMutateTheSharedTable"*
- [ ] **A configured dataset gets a collection and a view by default.**
  Without them the UI has nothing to open and view-based listings cannot see
  it. — *"testCreatesCollectionAndViewByDefault"*
- [ ] **`createView: false` creates neither.** —
  *"testCreateViewCanBeDisabled"*
- [ ] **A view failure rolls back the collection too.** The first version
  built both in a helper returning a tuple, so a failure lost the caller's
  handle on the collection and leaked it. —
  *"testViewFailureRollsBackTheWholeRequest"*
- [ ] **The ported colour tables equal the frontend's.** Re-parsed from
  `src/store/model.ts`, with a guard that the parse found something. —
  *"testPaletteMatches"*, *"testChannelColoursMatch"*,
  *"testParsingFoundSomething"*
- [ ] **Layer defaults match `newLayer`.** Known channel names keep their
  colour, a duplicate colour falls back to the palette, duplicate names get
  positional ones, and an empty name becomes "Channel N" (not "Layer N" --
  that branch is dead in the frontend too). —
  *"testKnownChannelNamesGetTheirColour"*,
  *"testDuplicateChannelColourFallsBackToThePalette"*,
  *"testDuplicateChannelNamesGetPositionalLayerNames"*,
  *"testEmptyChannelNameFallsBackToItsIndex"*
- [ ] **z-step uses the frontend's UPPER median, not the mean of the middle
  pair.** — *"testUpperMedianNotMeanOfMiddlePair"*

### Python API surface

- [ ] **`transcode=None` is omitted from the body, not sent as null.** The
  server picks the default (on unless every file is `.nd2`); a literal null is
  a 400. — *"test_configure_omits_transcode_unless_given"*
- [ ] **Real runs drop cached tile metadata, dry runs do not.** Configuring
  replaces the image the cache describes. —
  *"test_configure_invalidates_cached_metadata"*,
  *"test_dry_run_keeps_cached_metadata"*, *"test_upload_invalidates_cached_metadata"*
- [ ] **`unassigned_variables` finds the leftover variable.** Matched on the
  unique `name`, not on `(source, guess)` -- two variables can share that
  pair. — *"test_unassigned_variables_finds_the_leftover"*
- [ ] **`create_view` defaults on and is forwarded.** —
  *"test_create_view_defaults_on_and_can_be_disabled"*
- [ ] **RGB fields survive the response.** They only ever came back on a dry
  run and the model was dropping them. —
  *"test_rgb_fields_survive_the_response"*
- [ ] **A partially failed `upload()` leaves the folder as it found it.**
  Otherwise a retry uploads duplicates, girder renames them, and
  `configure()` reads them as extra sources. —
  *"test_partial_upload_failure_removes_what_it_uploaded"*,
  *"test_upload_reports_items_it_could_not_clean_up"*,
  *"test_failed_upload_invalidates_cached_metadata"*
- [ ] **`upload()` refuses subdirectories.** Silently skipping them made a
  partial upload look complete. — *"test_upload_rejects_subdirectories"*

**Process notes proven by this review**
- A green `tox` says nothing about the running container: the plugin is baked
  into the image, so `docker compose build girder && up -d girder` is required
  before any curl verification.
- A green `tox` also says nothing about handlers that only exist when a plugin
  is *loaded*. `pytest_girder` loads one plugin; anything driven by
  `girder_large_image`'s event bindings has to be established by the test.
- **This suite cannot be trusted on arm64 macOS.** `large_image_source_tiff`
  segfaults pylibtiff (`libtiff.GetField`) while probing the synthetic TIFFs,
  intermittently and depending on test selection — including on tests nobody
  touched. Run the backend suite in the Linux girder container instead, which
  is deterministic:

  ```bash
  docker exec girder bash -lc "pip install -q pytest 'pytest-girder>5' \
      pytest-custom-exit-code mock"
  docker cp devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test \
      girder:/src/AnnotationPlugin/upenncontrast_annotation/
  docker cp devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server \
      girder:/src/AnnotationPlugin/upenncontrast_annotation/
  docker exec girder bash -lc "cd /src/AnnotationPlugin && python -m pytest \
      upenncontrast_annotation/test/ -q --mongo-uri mongodb://mongodb:27017"
  ```

  `--mongo-uri` is required — pytest-girder defaults to `localhost:27017`,
  which inside the container is nothing, and each test then burns a 20s
  server-selection timeout (30 errors in 10 minutes, all reported as setup
  errors that say nothing about mongo).
- Verify against a folder that actually has the property under test: the
  mixed-dtype path needed a deliberately-built fixture because every TIFF set
  in `tmp/` is uniformly `uint16`.
- Confirm the red: with `server/api/dataset.py` stashed, the five new tests all
  fail (`5 failed, 25 passed`) and pass with it restored.
