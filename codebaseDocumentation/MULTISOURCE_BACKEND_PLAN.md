# Backend Multi-Source Descriptor Generation — Implementation Plan

## 1. Goal & motivation

Today, when a user uploads a set of image files, **the frontend**
(`src/views/dataset/MultiSourceConfiguration.vue`, ~2,460 lines) does all of:

1. probing each file's metadata,
2. guessing which dimension (XY / Z / T / C) each filename token or file axis
   represents,
3. letting the user confirm/override the assignment, and
4. assembling `multi-source2.json` — the large_image composite descriptor — and
   uploading it to Girder, then triggering transcode + cache jobs.

We want a **backend endpoint that can do steps 1, 2, and 4 autonomously**, so a
dataset can be assembled from a set of files **without the browser UI driving
it** (headless / scripted / API ingestion), and so file metadata is probed
in-process where the files already live (reliability + performance).

**Chosen architecture: Option A — an autonomous auto-detect endpoint.** It
probes all files, runs the (ported-to-Python) filename guesser, assembles the
descriptor, writes it, and transcodes. It accepts an **optional explicit
assignment override** so the existing UI (or a careful caller) can correct a bad
guess without giving up the rest of the pipeline.

**Decision (from scoping): the filename-guessing heuristic
(`collectFilenameMetadata2`) WILL be ported to Python.** This is the
centerpiece and the main risk. Parity with the current TS behavior is the whole
game, which is why the test corpus (Section 3) is front-and-center.

> **The single most important input is the user-supplied corpus of filename
> sets that must parse correctly.** Assembling that corpus is the user's
> responsibility; everything in Section 3 is built around it.

---

## 2. What already exists (we are mostly relocating, not inventing)

| Capability | Where it already lives | Reuse |
|---|---|---|
| Write a large_image multi-source descriptor, upload it, transcode it | `system.py` `cacheMaxMerge` (lines ~94-212): builds a `multi={tileWidth,tileHeight,sources:[…]}` dict, `yaml.dump` → `Upload().uploadFromFile()` → load item → `ImageItem().convertImage(localJob=True)` | The endpoint is structurally a sibling of this |
| Read a file's frame/axis metadata server-side, in-process | `ImageItem._loadTileSource(item)` → `ts.getMetadata()` (`IndexRange`/`IndexStride`/`frames`/`channels`) and `ts.getInternalMetadata()` (ND2 stage positions) | Replaces the frontend's `getTiles`/`getTilesInternalMetadata` round-trips |
| CPU-bound work as a local job with progress | `zenodo.py` (`createLocalJob`) + `zenodo_job.py` (`run(job)`, `updateJob`) | Endpoint schedules a local job; parse+assemble+transcode run there |
| Batch resource loading (no N+1) | `zenodo_job.py` `$in` over Folder/Item/File | Load all dataset items/files at once |
| large_image with all sources, `yaml`, `orjson` | `devops/girder/.../Dockerfile`, plugin `setup.py` | Available; **pandas/numpy must be added** |

What does **not** exist yet and must be built:

- The filename-guessing heuristic in Python (`collectFilenameMetadata2` port).
- The descriptor assembler (`generateJson` port — basic + RGB-split +
  ND2-compositing branches).
- The endpoint + its local job module.
- The parity test harness and corpus.

---

## 3. The test corpus & parity harness (build this FIRST)

The parser is a pile of heuristics; two implementations *will* drift unless the
Python one is pinned to concrete examples. We treat the corpus as the
specification.

### 3.1 What the user provides

A set of **filename groups**, each representing one "upload" of files that
should be parsed into a known dimensional layout. For each group:

- the **list of filenames** (just the names, e.g. `well_A1_z0_ch_DAPI.tif`), and
- the **expected assignment** — for each dimension that should be detected,
  which token/axis it maps to and the expected list of distinct values
  (and ideally the expected value index per filename).

Recommended fixture format — one JSON file per real-world scenario, dropped into
a fixtures directory:

```jsonc
// test/fixtures/multisource_parsing/wells_z_channels.json
{
  "description": "96-well plate, 3 z-slices, 2 channels, filename-encoded",
  "filenames": [
    "well_A1_z0_ch_DAPI.tif",
    "well_A1_z0_ch_GFP.tif",
    "well_A1_z1_ch_DAPI.tif",
    "..."
  ],
  "expected": {
    "XY": { "values": ["A1", "A2", "..."] },
    "Z":  { "values": ["z0", "z1", "z2"] },
    "C":  { "values": ["DAPI", "GFP"] }
    // T omitted => must NOT be detected
  }
}
```

The user only *has* to provide `filenames` + the human-verified `expected`
axes. The full `valueIdxPerFilename` mapping can be seeded automatically
(below) and then spot-checked.

### 3.2 Golden-master seeding from the current TS implementation

To bootstrap `expected` cheaply and catch drift precisely, add a tiny Node
script that runs the **existing** `collectFilenameMetadata2` over each fixture's
`filenames` and emits the current output. Commit those as golden snapshots.

- Location: `scripts/dump-filename-parse.ts` (or a Vitest snapshot test
  alongside `parsing.ts`).
- The human then reviews each golden snapshot and **corrects any wrong guesses**
  — those corrections become the authoritative `expected`. (The current TS
  parser is not always right; the corpus is where we encode "what it *should*
  do," which may be stricter than today's behavior.)

This gives two reference sets:
- **TS-current** (what the frontend does today), and
- **expected/authoritative** (human-verified truth).

### 3.3 The Python parity tests

`test/test_multisource_parsing.py` loads every fixture and asserts the **Python
parser** matches `expected`. Where `expected` intentionally diverges from
TS-current, note it in the fixture `description` so we know it's a deliberate
fix, not a regression.

Acceptance bar: **100% of the user-assembled corpus parses to its `expected`
assignment.** New real-world failures get added as fixtures, then fixed — the
corpus only grows.

---

## 4. Phased plan

### Phase 0 — Corpus + harness (Section 3)
- [ ] Create `test/fixtures/multisource_parsing/` and the JSON fixture format.
- [ ] User assembles the real-world filename groups + `expected` axes.
- [ ] Add `scripts/dump-filename-parse.ts` to seed golden snapshots from TS.
- [ ] Stand up `test_multisource_parsing.py` (red until Phase 1 lands).

### Phase 1 — Port the filename guesser to Python
New module: `server/helpers/multisource_parsing.py`. Port each TS function from
`src/utils/parsing.ts` with pandas/numpy:

| TS function (`parsing.ts`) | Python equivalent | Notes / parity risk |
|---|---|---|
| `filenameDelimiterPattern = /[_\.\/]/` | same regex | trivial |
| `processFilenamesDF` | tokenize → `pandas.DataFrame`, sort by Filename | column count = max tokens; **NaN/short-name padding** must match JS undefined behavior |
| `findMinimalSpanningColumns` | smallest column combo whose distinct-value Cartesian product == row count | **combination order** must match `getCombinations` (lexicographic head-first) so ties break identically |
| `getCombinations` | `itertools.combinations` — but verify ordering matches the TS recursion | tie-break determinism |
| `findComplementaryColumns` / `findAllComplementaryColumns` | 1:1 co-varying columns via combined-distinct-count test | direct port |
| `findCommonSubstring` / `findColumnCommonSubstring` | per-position char match, `_` placeholder | assumes equal-length tokens (port the assumption) |
| `triggersPerCategory`, `categorizeSubstring` | dict + substring match; default `chan` | keep keyword lists identical |
| `categorizeColumns` | well-regex `^[A-Za-z]\d{1,2}$` → xy; no-digit → chan; else substring category | port regex exactly |
| `assignUniqueCategorizations` | initial assign + conflict resolution over `["chan","xy","z","t"]` | **resolution order** must match |
| `structuredAssignments` | sort distinct tokens, map token→index, build `valueIdxPerFilename` | `tokens.sort()` is JS default (lexicographic) — use the same string sort, **not** natural/numeric |
| `collectFilenameMetadata2` | top-level orchestration → `list[VariableGuess]` | return a dataclass mirroring `IVariableGuess` |

Output dataclass:

```python
@dataclass
class VariableGuess:
    guess: str                      # "XY" | "Z" | "T" | "C"
    values: list[str]               # distinct values, sorted
    value_idx_per_filename: dict[str, int]
```

> **Watch item:** `dataframe-js` and pandas differ in sort stability and
> distinct ordering. The corpus tests are how we find these. Pin string sorts
> to plain lexicographic to match JS `Array.prototype.sort` default.

### Phase 2 — Server-side metadata probing
Helper: `server/helpers/multisource_probe.py`.

```python
def probe_item(item) -> ItemTileInfo: ...
# wraps ImageItem._loadTileSource(item).getMetadata():
#   IndexRange, IndexStride, frames, channels, sizeX/sizeY, mm_x/mm_y, bandCount
def probe_item_internal(item) -> dict: ...
# wraps getInternalMetadata(): nd2_frame_metadata, nd2.channels (for compositing)
```

- [ ] **Verify** the server-side tile source exposes the same
  `nd2_frame_metadata` / `nd2.channels.cameraTransformationMatrix` fields the
  frontend gets from `getTilesInternalMetadata`. If not, compositing parity is
  at risk and must be scoped separately (see Section 7).
- Load all items/files for the dataset folder in one batched `$in` query.

### Phase 3 — Port the descriptor assembler
Helper: `server/helpers/multisource_assemble.py`, porting `generateJson`
(`MultiSourceConfiguration.vue:1527-1789`). Output the **identical** shape
large_image already consumes:

```python
{
  "channels": [...],
  "sources":  [...],          # basic OR compositing source dicts
  "uniformSources": True,
  "singleBand": <isMultiBandRGBFile>,
}
```

Three branches to port faithfully:

1. **Channel naming hierarchy** (lines 1528-1568): C-from-file → join distinct
   per-index with `/`; C-from-filename → use values; C-from-images →
   `"Default {i}"`; none → `["Default"]`.
2. **Basic (non-compositing)** branch (1720-1782): per item build `framesAsAxes`
   strides (File source) / value index (Filename source) / stride-1 (Images
   source); emit `xyValues`/`zValues`/`tValues`/`cValues`.
   - **RGB split sub-branch** (1728-1741): per frame × band, emit
     `style.bands:[{band: b+1}]`, expand channel names with
     ` - Red/ - Green/ - Blue` suffixes, set `singleBand:true`.
3. **Compositing (single ND2 with stage positions)** branch (1587-1719): the
   hardest port — per frame (× band) emit `{xySet,zSet,tSet,cSet,frames}`, then
   compute `position` from `nd2_frame_metadata.stagePositionUm` normalized by
   `mm_x/mm_y`, apply the camera transform matrix (`s11..s22`, with the
   `-1/-1` flip special-case), transform image corners, compute global
   offset min/max, and round each source's `position` into a common frame.
   See lines 1624-1719 — this is real geometry, port it carefully and add
   numeric fixtures.

Pure-function design: assembler takes `(items, probe_results, assignments,
options)` and returns the dict. No Girder I/O inside — easy to unit-test.

### Phase 4 — The endpoint + local job
Endpoint (sibling of `cacheMaxMerge`; either extend `system.py` or add
`server/api/multisource.py`):

```
POST /api/v1/dataset/:datasetId/build_multisource
  body: {
    transcode: bool = true,
    compositing: bool = false,          # opt-in, single-ND2 only
    splitRGBBands: bool = false,
    assignments?: { XY|Z|T|C: {...} }   # OPTIONAL explicit override; if omitted, auto-detect
  }
  -> { jobId }                          # schedules a local job
```

- `.modelParam("datasetId", model=Folder, level=AccessType.WRITE)` —
  write-without-UI surface, so be deliberate about access (Section 6).
- API method: parse/validate body (RestException for HTTP errors), convert
  inputs once at the top, then `createLocalJob(module=
  'upenncontrast_annotation.server.helpers.multisource_job', ...)` and
  `scheduleJob`. **No business logic in the API layer.**

Local job `server/helpers/multisource_job.py` `run(job)`:
1. `updateJob(RUNNING)`.
2. Batch-load dataset items/files.
3. Probe metadata (Phase 2). Report progress.
4. If `assignments` absent → run guesser (Phase 1) over filenames + file axes,
   pick best assignment (mirror the component's source-precedence:
   File-axis > Filename > Images).
5. Assemble descriptor (Phase 3).
6. Write `multi-source2.json` via `Upload().uploadFromFile()` into the dataset
   folder (constant must match frontend `DEFAULT_LARGE_IMAGE_SOURCE =
   "multi-source2.json"`, `src/girder/index.ts:77`).
7. Remove stale large_image from source items (mirror
   `addMultiSourceMetadata` logic: transcode → all items; else → other
   large-image items).
8. If `transcode`: `ImageItem().convertImage(..., localJob=True)` (or the
   `generateTiles` equivalent) and track to completion.
9. Store `dimensionLabels` ({xy,z,t}) on the dataset folder metadata.
10. Trigger the cache computations the frontend schedules (tile-frames,
    max-merge, histogram) — confirm whether these are frontend-only
    orchestration or have backend equivalents to call.
11. `updateJob(SUCCESS)` with the resulting itemId; on failure
    `updateJob(ERROR)` (catch **specific** exceptions, not bare `Exception`).

### Phase 5 — Make the frontend a thin client (optional, incremental)
Once the endpoint is trusted, `MultiSourceConfiguration.vue` can:
- still gather/preview the guesses (call the endpoint in a "dry-run/detect"
  mode that returns the proposed assignment without committing), then
- POST the confirmed `assignments` to `build_multisource` instead of building
  JSON locally.
This collapses `generateJson`, the dataframe-js dependency, and
`addMultiSourceMetadata` over time. Add an API method in `GirderAPI.ts`
(not in the component) for the new endpoint.

### Phase 6 — Cleanup
- Remove now-dead client JSON-assembly once the UI uses the endpoint.
- Keep `parsing.ts` only if still used by the dry-run preview; otherwise retire
  it and the `dataframe-js` dep.

---

## 5. New / changed files

| File | Status | Purpose |
|---|---|---|
| `test/fixtures/multisource_parsing/*.json` | new | **User-assembled** corpus (Section 3) |
| `scripts/dump-filename-parse.ts` | new | Seed golden snapshots from current TS parser |
| `.../server/helpers/multisource_parsing.py` | new | Ported filename guesser |
| `.../server/helpers/multisource_probe.py` | new | Server-side metadata probing |
| `.../server/helpers/multisource_assemble.py` | new | Ported descriptor assembler |
| `.../server/helpers/multisource_job.py` | new | Local job `run(job)` orchestration |
| `.../server/api/multisource.py` (or extend `system.py`) | new/edit | The endpoint |
| `.../__init__.py` | edit | Register route (if new resource) |
| `.../test/test_multisource_parsing.py` | new | Parity tests vs corpus |
| `.../test/test_multisource_assemble.py` | new | Assembler unit tests (incl. ND2 geometry) |
| `.../test/test_multisource_endpoint.py` | new | Endpoint + job integration test |
| `.../setup.py` (+ Docker if needed) | edit | Add `pandas`/`numpy` deps |
| `src/store/GirderAPI.ts` | edit (Phase 5) | API method for the endpoint |
| `src/views/dataset/MultiSourceConfiguration.vue` | edit (Phase 5) | Thin-client mode |

---

## 6. Access control & security

- Require `AccessType.WRITE` on the dataset folder — this is now a
  programmatic write path, not gated by the UI.
- Per CLAUDE.md layer rules: **RestException only in the API layer**; helpers
  raise `ValueError`/`ValidationException`. Convert inputs (ObjectIds, JSON
  body) once at the top of the API method.
- Use `Model().find(...)` (not `.collection.find`), `exc=True` on loads, batch
  `$in` queries (no per-item loops).
- Catch specific exceptions in the job; never bare `except Exception`.
- Idempotency: re-running on a dataset that already has `multi-source2.json`
  must replace cleanly (mirror `cacheMaxMerge`'s early-out / `reuseExisting`).

---

## 7. Risks & open questions

1. **Parser parity (highest risk).** dataframe-js vs pandas differ on sort
   stability, distinct ordering, and NaN/short-token handling. Mitigation: the
   corpus + golden snapshots; pin lexicographic string sorts; match
   combination ordering exactly.
2. **ND2 compositing internal metadata.** Must confirm the server-side tile
   source exposes `nd2_frame_metadata.position.stagePositionUm` and
   `nd2.channels[*].cameraTransformationMatrix`. **If not available
   server-side, scope compositing as a follow-up** and ship basic + RGB-split
   first.
3. **Cache-job orchestration** (`scheduleTileFramesComputation`,
   `scheduleMaxMergeCache`, `scheduleHistogramCache`) is currently frontend
   store logic — determine the backend equivalents or whether the endpoint
   should leave these to a subsequent client call.
4. **"Best assignment" selection.** The component encodes source precedence and
   user choices; the autonomous path must pick deterministically. Encode the
   precedence (File-axis > Filename > Images) and document it; let
   `assignments` override.
5. **pandas/numpy in the backend image.** New runtime deps — confirm wheel
   availability and image size impact.
6. **Large datasets.** Probing thousands of files in one job — ensure progress
   reporting and that `_loadTileSource` per item is acceptable (it reads
   headers, not pixels, so should be cheap, but verify on a big set).

---

## 8. Suggested sequencing for the first PR

To de-risk, the first PR should be **Phases 0-1 only**: the corpus format, the
golden-snapshot script, the Python parser, and the parity tests — *no
endpoint*. That proves the hardest part (parser equivalence) in isolation,
against the user's real filename sets, before any wiring. Phases 2-4 (probe,
assemble, endpoint) follow once parity is green; compositing (Phase 3 branch 3)
can be its own PR gated on the Section 7.2 verification.
