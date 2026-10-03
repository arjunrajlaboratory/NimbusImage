# Xenium ingest (`nimbusimage.xenium`)

The Python package code that loads a 10x Xenium bundle into NimbusImage: morphology
images, cell polygons, per-cell properties, cell-type tags, the spatial table, the
transcript overlay and pathology regions. The runbook (coordinate frames, orientation
checks, traps on 709K-cell data) is the `xenium-ingest` skill
(`plugins/nimbusimage/skills/xenium-ingest/SKILL.md`); this file records the design and
what has broken before.

## Layout

| Module | Role |
|---|---|
| `bundle.py` | `XeniumBundle`: reads the bundle, no server. Every zarr read goes through `_open` (missing file → `XeniumError`). |
| `geometry.py` | `ImageFrame`: image (`morphology`/`he`), pixel size, H&E alignment — validated on construction; the one place microns become pixels. |
| `cells.py` | `CellMap` (ids + dataset id + frame + polygon set, saved as one `.npz`), `fetch_cells`, `verify_cells`, `open_cells`. |
| `ingest.py` | One function per step. Per-cell steps start with `_per_cell_stop` → `CellMap.check`. |
| `embedding.py` | `compute_umap`. |
| `cli.py` | `nimbusimage-xenium`: one subcommand per step; `_frame` resolves the frame (saved `--cells` frame wins; flags may only add what it lacks). |

## Design rules

- **Context travels with the data.** Ids never move without their dataset and frame:
  steps take a `CellMap`, never bare ids. `--alignment`/`--pixel-size` are given to
  `polygons` only; the saved cell map carries them to every later step.
- **One guard per invariant**, run by every consumer: `CellMap.check` (right dataset,
  cell polygons, this bundle's cell count); `ImageFrame.__init__` (pixel size > 0,
  3×3 invertible alignment, H&E needs one); `XeniumBundle._open` (file exists).
- **One conversion per input**: `load_embedding`, `_cell_type_labels`,
  `load_alignment`, `bundle.gene_rows` — every form of the input goes through it.
- **Defaults only where the result is verified.** Per-cell steps may default to the
  morphology frame because `open_cells` verifies every map against the server's
  vertices. Transcripts and regions have nothing to verify against, so they take the
  dataset's `CellMap` (checked against the dataset) or an explicit `ImageFrame` —
  never a default; a missing or bare-id `--cells` file is an error there.
- **One input, one meaning.** Where a flag can mean two things (`--alignment` in
  `regions`: the dataset is H&E, or the matrix for H&E-drawn regions), nothing is
  inferred from it; the caller states the other fact (`--image`).
- **Never rely on server list order.** `fetch_cells` matches annotations to cells by
  geometry (first two vertices + vertex count); the server sorts by `_id`, and
  ObjectIds from different Girder instances in the same second don't follow creation
  order.
- **Validate before the first write — in the API function, not only the CLI.** Validated
  objects are built before a step's first server write; a limited upload is represented
  explicitly (one slot per cell, None past `--limit`), never by a shorter array. argparse
  checks don't count: round 9 found `chunk=0, replace=True` and a frame without a pixel
  size deleting data through the API that the CLI had already refused. Anything checked
  inside a generator is checked late, so `_chunks` returns a list.

## Live verification

Unit tests use an in-memory fake; they can't see what only a real server and real vendor
files do (the mouse `Tex19.1` symbol the SpatialPlugin refuses, zarr 3 opening zips
lazily, a recompute writing provenance as attributes). Before merging a change to the
ingest, run `nimbusimage/tests/integration/xenium_live.py` (not collected by pytest). It
takes about 2 minutes on the 10x "tiny" bundles and exits 0 only if every check passes.

**Prerequisites**
- A backend built from the branch (`docker compose build girder && docker compose up -d
  --no-build girder` from the checkout that owns the compose project; the SpatialPlugin
  must be in the image — `GET /api/v1/spatial/...` routes exist).
- The package with its extras, in a venv: `pip install -e 'nimbusimage[dev,xenium-umap]'`.
- MongoDB reachable as a docker container (`nimbusimage-mongodb-1`), read by `mongosh` to
  check stored values independently of the API.
- Extracted bundles: each a directory with `cells.zarr.zip`, `cell_feature_matrix.zarr.zip`,
  `analysis.zarr.zip`, `experiment.xenium`, `transcripts.zarr.zip`, `morphology_focus/`.
  Use more than one XOA version (the lab's set: XOA 3 mouse ileum, XOA 4 ovary, XOA 4
  protein kidney, in `~/Downloads/xenium-tiny/`).

**Run** (from outside the repository root, which would shadow the package):

```bash
XENIUM_LIVE_BUNDLES=~/Downloads/xenium-tiny \
  python /path/to/NimbusImage/nimbusimage/tests/integration/xenium_live.py
```

| Variable | Default | Meaning |
|---|---|---|
| `XENIUM_LIVE_BUNDLES` | — (required) | directory of extracted bundles; every subdirectory is run |
| `NI_API_URL` / `NI_TEST_USER` / `NI_TEST_PASS` | localhost / admin / password | server and login (same as the other integration tests) |
| `XENIUM_LIVE_CLI` | `nimbusimage-xenium` on `PATH` | the CLI under test |
| `XENIUM_LIVE_MONGO` | `nimbusimage-mongodb-1` | MongoDB container |
| `XENIUM_LIVE_WORK` | a new temp dir | where cell maps, CSVs and tables are written |
| `XENIUM_LIVE_BIG_BUNDLE`, `_DATASET`, `_ALIGNMENT`, `_IDS` | unset (skipped) | a large real H&E dataset for a read-only geometry-match check (the lab's: `~/Downloads/xenium-kidney-full`, dataset `6ab9574f635c1c4a679411e6`, its `*_he_imagealignment.csv`, `ids_he.npy`) |

**What it checks** (every check is listed as it runs; all must pass):
1. Per bundle, on a fresh dataset and an H&E-like one (synthetic alignment): every step
   through the CLI, then every property value, tag, table column, molecule count,
   transform and region vertex compared with the bundle.
2. Every bug class from the review rounds reproduced live, through the CLI and (for
   API-only paths) the API; each must fail cleanly and leave every annotation's tags and
   coordinates, every property value (hashed from MongoDB), the item count and the
   transcript registration unchanged. Add a row to `refusals()` whenever a review finds
   a new one. A one-file morphology bundle must make a one-channel dataset.
3. Tables go only to their own dataset, including a real recompute version.
4. Optionally, the geometry match on 465K real cells equals the original ids.

It leaves its datasets (`live e2e <bundle> <time>`) on the server.

## Regression checklist

Tests are in `nimbusimage/tests/test_xenium.py` unless noted.

**Wrong data never reaches the server**
- Every per-cell step refuses another dataset's, a nucleus, another bundle's cell map, or
  bare ids, with zero writes — _"test_per_cell_steps_refuse_wrong_cell_maps"_.
- Every CLI subcommand, given a bad input, exits non-zero with zero writes —
  _"test_cli_bad_input_fails_with_no_writes"_; its valid baseline succeeds —
  _"test_cli_baseline_succeeds"_.
- A saved cell map of another dataset is refused offline, before any request —
  _"test_another_datasets_map_is_refused_offline"_.
- A pre-CellMap id file of another dataset (same cell count) is refused by the server
  spot-check — _"test_bare_id_file_of_another_dataset"_.
- A re-derived map is matched by geometry, whatever the list order (the fake lists in
  reverse), ignoring other polygons — _"test_fetch_matches_the_upload_in_any_order"_; a
  `--limit` upload is re-derivable — _"test_a_limited_upload_can_be_re_derived"_; a double
  upload is an error — _"test_a_duplicate_upload_is_an_error"_; the wrong frame matches
  nothing — _"test_the_wrong_frame_matches_nothing"_.
- Transcripts and regions never default the frame: no `--cells`, a mistyped path or a
  bare-id file fails with zero writes, on morphology and H&E datasets —
  `test_cli_bad_input_fails_with_no_writes[...-no frame stated / mistyped cells path /
  bare-id file as the frame]`, _"test_transcripts_never_default_the_frame"_; the H&E
  baselines succeed — `test_cli_baseline_succeeds[transcripts (H&E)]`, `[regions (H&E)]`.
- The table is uploaded only to the dataset recorded in it (`uns/nimbus/datasetId`) —
  _"test_spatial_table_goes_only_to_its_dataset"_.
- `region`-tagged polygons are never matched as cells, even when identical to one —
  _"test_a_region_identical_to_a_cell_is_never_the_cell"_; stored vertices within 0.01 px
  match (older uploads used float32) — _"test_matching_tolerates_float_arithmetic_only"_.
- Without `--cells`, regions always need `--image` — no flag (not `--alignment`, not
  `--pixel-size`) implies which image the dataset is; a guess puts every region on H&E in
  the wrong place — `test_cli_bad_input_fails_with_no_writes[regions-regions pixel size
  without --image or --cells]`. (Round 7 loosened this to "only with `--alignment`";
  round 8 showed the loosening was itself the bug.)
- An unreadable, damaged or foreign spatial table is a clean error with no writes —
  _"test_unreadable_tables_are_a_xenium_error"_; regions always keep `region`, deduplicated,
  never empty — _"test_region_tags_are_deduplicated_and_never_empty"_; the in-app GeoJSON
  importer warns when its extra tag isn't `region` —
  `src/components/AnnotationBrowser/GeoJsonImportDialog.test.ts` ("warns when the extra
  tag is not region").
- For regions, `--alignment` never implies the H&E image —
  `test_cli_bad_input_fails_with_no_writes[regions-regions alignment without --image or
  --cells]`, `TestCli::test_regions_he_drawn_onto_morphology_without_cells`.
- A cells file never unpickles anything but a real `.npy` —
  _"test_a_pickle_passed_as_cells_never_runs"_, _"test_cells_files_load_without_unpickling"_.
- The cell-type write is read back in one request — _"test_cell_types_and_read_back"_,
  _"test_cell_types_read_back_mismatch"_; `get_many` is dataset-scoped —
  `tests/test_annotations.py::TestGetMany::test_scoped_to_the_dataset`.

**Coordinates**
- A frame is validated on construction — `TestImageFrame::test_validated_on_construction`.
- The pixel size given to `polygons` reaches `transcripts` through the saved map —
  `TestCli::test_later_steps_reuse_the_saved_frame`.
- Flags conflicting with a saved frame are an error; an alignment may be added for
  H&E-drawn regions — `test_cli_bad_input_fails_with_no_writes[...-conflicting pixel
  size]`, `TestCli::test_regions_may_add_an_alignment_to_a_saved_frame`.
- Region transforms for every drawn-in × image pair — _"test_region_transform_table"_.

**Ordering and destructive actions**
- `--delete-tag` deletes only after every input is read, including a frame that can
  convert microns — `TestPolygons::test_delete_tag_only_after_inputs_are_read`.
- A bad `chunk` is refused before `replace` deletes the old values, in every per-cell
  step — _"test_per_cell_steps_check_the_chunk_before_writing"_.
- A one-file morphology bundle configures without a channel assignment —
  `TestUploadMorphology::test_one_or_several_channel_files`.
- The spatial table checks its small inputs before reading the matrix —
  _"test_spatial_table_checks_before_reading_the_matrix"_.
- UMAP keeps `pca.npy` when UMAP fails — `TestUmap::test_pca_is_saved_before_umap_runs`.

**Vendor formats**
- Symbols with `.`/`$` (mouse panels) are stored as `safe_symbol` in the table and the
  panel sub-keys, originals in `var/feature_name` —
  `TestBundle::test_stored_symbols_have_no_dot_or_dollar`,
  _"test_gene_panel_sub_keys_are_stored_symbols"_, _"test_spatial_table_round_trip"_.
- `cell_groups` zero-padding — `TestBundle::test_cell_groups_handles_zero_padding`.
- A protein named like a gene doesn't block the gene —
  `TestBundle::test_gene_lookup_skips_a_same_named_protein`.
- Cell types join on the decoded id, not row order —
  `TestBundle::test_cell_types_join_on_id_not_row_order`; a duplicated id is refused
  whether or not gaps are allowed — `TestBundle::test_cell_types_duplicate_raises`;
  integer ids (before XOA 1.3) are a clean error —
  `TestBundle::test_integer_cell_ids_are_a_xenium_error`.
- Gene counts are placed by cell index whether or not CSR indices are sorted —
  _"test_gene_panel_does_not_assume_sorted_indices"_.
- GeoJSON as a FeatureCollection, an array of Features (QuPath), one Feature or one
  geometry — _"test_regions_accept_every_geojson_shape"_; anything else is a clean error
  with no writes — _"test_malformed_geojson_is_a_xenium_error"_,
  `test_cli_bad_input_fails_with_no_writes[regions-json that is not geojson]`.

## Process rules this feature proved

- **Four review rounds found 32 issues from 4 root causes** (see the fix-the-fix pattern
  in the `fixing-review-findings` skill). When a round's findings come from the last
  round's fixes, add the missing concept instead of another parameter.
- **Mutation-check contract tables**: delete each guard in a scratch copy and confirm a
  table row fails; a table that passes with a guard removed is not holding it. A
  surviving mutant is either a missing test (the pickle guard needed an execution test,
  not an error-message test) or redundant code (a CLI dataset check `open_cells` already
  makes) — add the test or delete the code.
- **Make the fake hostile, not merely faithful**: `FakeAnnotations.iter_all` lists in
  reverse creation order, so order-dependent code fails in tests instead of only in a
  multi-instance production deploy; tags match with `$all` as on the server.
- **Run every real bundle live, not one**: the mouse XOA 3 bundle's `Tex19.1` broke table
  registration after eight review rounds and 500+ unit tests passed on human bundles.
  `live_e2e.py`-style runs (each pipeline step on a fresh dataset, every value checked
  against the bundle, every past bug reproduced with a write-count snapshot) are the
  gate before a merge.
- **Verify live on real data read-only first**: the 465K-cell kidney H&E dataset checks
  ids, frames and the wrong-file refusal without writing (`open_cells` on
  `ids_he.npy` / `ids_morph.npy`).
