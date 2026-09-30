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
- **Validate before the first write.** Validated objects are built before a step's
  first server write; a limited upload is represented explicitly (one slot per cell,
  None past `--limit`), never by a shorter array.

## Regression checklist

Tests are in `nimbusimage/tests/test_xenium.py` unless noted.

**Wrong data never reaches the server**
- Every per-cell step refuses another dataset's, a nucleus, another bundle's cell map, or
  bare ids, with zero writes — `test_per_cell_steps_refuse_wrong_cell_maps`.
- Every CLI subcommand, given a bad input, exits non-zero with zero writes —
  `test_cli_bad_input_fails_with_no_writes`; its valid baseline succeeds —
  `test_cli_baseline_succeeds`.
- A saved cell map of another dataset is refused offline, before any request —
  `test_another_datasets_map_is_refused_offline`.
- A pre-CellMap id file of another dataset (same cell count) is refused by the server
  spot-check — `test_bare_id_file_of_another_dataset`.
- Fetched ids are vertex-verified against the frame — `test_fetch_verifies_the_frame`.
- The cell-type write is read back in one request — `test_cell_types_and_read_back`,
  `test_cell_types_read_back_mismatch`; `get_many` is dataset-scoped —
  `tests/test_annotations.py::TestGetMany::test_scoped_to_the_dataset`.

**Coordinates**
- A frame is validated on construction — `TestImageFrame::test_validated_on_construction`.
- The pixel size given to `polygons` reaches `transcripts` through the saved map —
  `TestCli::test_later_steps_reuse_the_saved_frame`.
- Flags conflicting with a saved frame are an error; an alignment may be added for
  H&E-drawn regions — `test_cli_bad_input_fails_with_no_writes[...-conflicting pixel
  size]`, `TestCli::test_regions_may_add_an_alignment_to_a_saved_frame`.
- Region transforms for every drawn-in × image pair — `test_region_transform_table`.

**Ordering and destructive actions**
- `--delete-tag` deletes only after every input is read —
  `TestPolygons::test_delete_tag_only_after_inputs_are_read`.
- The spatial table checks its small inputs before reading the matrix —
  `test_spatial_table_checks_before_reading_the_matrix`.
- UMAP keeps `pca.npy` when UMAP fails — `TestUmap::test_pca_is_saved_before_umap_runs`.

**Vendor formats**
- `cell_groups` zero-padding — `TestBundle::test_cell_groups_handles_zero_padding`.
- A protein named like a gene doesn't block the gene —
  `TestBundle::test_gene_lookup_skips_a_same_named_protein`.
- Cell types join on the decoded id, not row order —
  `TestBundle::test_cell_types_join_on_id_not_row_order`.

## Process rules this feature proved

- **Four review rounds found 32 issues from 4 root causes** (see the fix-the-fix pattern
  in the `fixing-review-findings` skill). When a round's findings come from the last
  round's fixes, add the missing concept instead of another parameter.
- **Mutation-check contract tables**: delete each guard in a scratch copy and confirm a
  table row fails; a table that passes with a guard removed is not holding it.
- **Verify live on real data read-only first**: the 465K-cell kidney H&E dataset checks
  ids, frames and the wrong-file refusal without writing (`open_cells` on
  `ids_he.npy` / `ids_morph.npy`).
