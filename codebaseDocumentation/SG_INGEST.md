# Spatial Genomics (GenePS) ingest

Export: `spatialgenomics_dataexport_pav_2026-10-15_2330.zip` (51.5 GB), project
`Pav_PTR`, sganalysis 0.9.8 / sgimage 1.2.0. Panel: 274 genes, a mix of mouse
(`Spp1`, `Col1a1`, …) and human (`KRT7`, `EGFR`, …) symbols, plus 467 `UNUSED*`
negative-control barcodes.

## Inventory

| ROI | Cells | Spots (TranscriptList.csv) | Image (px) | Area | Zip bytes (all files) |
|---|---|---|---|---|---|
| roi_1 | 75,566 | 187,824,488 | 54,357 × 52,447 | 5.5 × 5.3 mm, 29.4 mm² | 18.8 GB |
| roi_2 | 70,704 | 180,236,313 | 52,510 × 64,128 | 5.3 × 6.5 mm, 34.7 mm² | 18.9 GB |
| roi_3 | 5,044 | 14,395,713 | 25,262 × 13,574 | 2.6 × 1.4 mm, 3.5 mm² | 1.6 GB |
| roi_4 | 41,901 | 126,619,029 | 38,823 × 44,678 | 3.9 × 4.5 mm, 17.9 mm² | 12.2 GB |

Pixel size 0.101547 µm, the same in every ROI. Roughly half of each ROI's bytes
are transcripts (CSV plus HDF5, ~10 GB for roi_1/2) and the rest images
(~8 GB: DAPI is shipped twice plus GFP). About 52% of molecules fall inside a
cell (roi_3).

## Bundle anatomy (per ROI)

| File | Contains | Used? |
|---|---|---|
| `mini_project/roi_N/images/dapi.tiff`, `GFP_image.tiff` | OME-TIFF, uint16, single channel, tiled, **JPEG2000** (34712), 8-level pyramid, `PhysicalSizeX` = 0.101547 | yes, 2-channel dataset |
| `basic_results/roi_N/roi_N_DAPI.tiff` | same DAPI again (same size, same pixels) | no (duplicate) |
| `basic_results/roi_N/roi_N_Boundaries.geojson` | cell polygons in **microns**, closed rings, feature `id` = cell label, `objectType: cell` | yes, polygons |
| `basic_results/roi_N/roi_N_CellCoordinates.csv` | `label, area (µm²), center_x, center_y (µm)` | yes, area property |
| `basic_results/roi_N/roi_N_CellxGene.csv` | raw counts, rows = label 1…N in order, 274 gene columns | yes, spatial table |
| `basic_results/roi_N/roi_N_TranscriptList.csv` | `name, x, y, z` in µm; **no quality, no cell id** | yes, transcript overlay |
| `basic_results/roi_N/roi_N_Segmentation.tiff` | uint32 cell-label mask, zstd, pyramidal | validation only |
| `mini_project/roi_N/segmentations/Pav_PTR_{cells,nuclei}.tiff` | cell and nucleus label masks | nuclei not ingested (no polygons shipped) |
| `mini_project/roi_N/clusters/matrix_*_cells.h5ad` | AnnData: obs `area`, `leiden`; obsm `X_umap`, `X_pca`, `spatial`; `rank_genes_groups`; obs index = label | yes, Leiden + UMAP |
| `mini_project/roi_N/genes/Pav_PTR.hdf5` | per-gene groups (`points` [n,4] in **pixels**, 8-level offsets pyramid), 741 targets incl. 467 `UNUSED*`, plus `Lookup` | not used (CSV is simpler; HDF5 holds the control barcodes) |
| `sganalysis.session`, `thresholds/*.json` | viewer state; `shape`, `res` (pixel size) | pixel size cross-check |
| `ROIs.jpg` | overview of the ROI placement | no |

## Pipeline (`nimbusimage.sg`, `nimbusimage-sg`)

| Module | Role |
|---|---|
| `sg/export.py` | `SGRoi`: finds the project folder, reads each file, applies `safe_symbol` to gene names |
| `sg/verify.py` | `check_frame` and `recount`; `labels_at` decodes only the mask tiles it needs |
| `sg/cells.py` | `SGCellMap`: label → annotation id, plus the dataset, project/ROI and pixel size; `verify_cells` reads back first vertices |
| `sg/ingest.py` | `upload_images`, `upload_polygons`, `upload_cell_data`, `build_spatial_table` / `upload_spatial_table`, `build_transcript_store` / `register_transcripts` |
| `sg/transcripts.py` | `write_transcript_store`: any (gene, x, y, z µm) list → the Xenium transcript layout, zarr format 2 |
| `sg/cli.py` | `inventory`, `check`, `images`, `polygons`, `cell-data`, `spatial-table`, `transcripts`, `verify`, `ingest` |

Steps, for one ROI:

1. **Images**: one channel per file in `images/` (DAPI first), staged and pinned like
   Xenium's. The JPEG2000 OME-TIFFs transcode as they are.
2. **Polygons**: `px = µm / res`, identity orientation, closing vertex dropped,
   `create_many` in batches of 5,000.
3. **Cell data**:
   - tags `["cell", "Leiden k"]`;
   - properties `SG Area / area_um2`, `UMAP / x,y` and `Clustering / leiden`
     (numeric, so Color by Property and the overview raster can use it).
4. **Spatial table**: raw counts from `CellxGene.csv`, with obs `annotation_id`,
   `cell_index` (= label), `cell_type` ("Leiden k") and `leiden`; Ensembl ids come
   from the h5ad.
5. **Transcripts**: `TranscriptList.csv` → store → upload → register at the cell
   map's pixel size. The store records its project/ROI, and registration refuses a
   map of another ROI.

## What differed from Xenium, and what had to be built

| | Xenium | Spatial Genomics | Consequence |
|---|---|---|---|
| Images | `morphology_focus/` multi-file OME, stain names in OME | `dapi.tiff` + `GFP_image.tiff`, JPEG2000 tiles, channel name `dapi_channel_0` | name the channels ourselves; DAPI is shipped twice, so upload one copy |
| Cells | `cells.zarr.zip` polygon sets in µm, packed `cell_id` | GeoJSON in µm, integer label = `id` | simple reader; label is the join key everywhere |
| Nuclei | polygon set 0 | label mask only | not ingested (would need mask → polygon) |
| Matrix | `cell_feature_matrix.zarr` (gene-major CSR) | `CellxGene.csv`, dense, raw counts | build the AnnData table by hand (`build_spatial_table` takes a Xenium bundle) |
| Clusters | `analysis.zarr` `cell_groups` (zero-padding trap) | h5ad `obs.leiden` | simpler; one clustering |
| UMAP | not shipped (compute) | shipped in h5ad `obsm/X_umap` | no compute step |
| Cell types | separate csv | none; Leiden only | `cell_type` = "Leiden k" |
| Transcripts | `transcripts.zarr.zip`, registered as shipped | CSV (or HDF5 in pixels) | **new converter** to the Xenium zarr pyramid |
| Quality | `qv` per molecule (≥ 20 cut) | none | every molecule set to qv 40; the quality slider is inert |
| z | z per molecule (µm) | 6 z-slices (`zslices` attr), z column kept but flattened in the viewer | 2D overlay |
| Controls | `NegControl*`, `BLANK*` in `gene_names` | `UNUSED*` in HDF5 only (~3.5% of HDF5 points), absent from the CSV | the CSV-based store has no controls; the server's `CONTROL_PATTERN` does not match `UNUSED`, so add it before ingesting HDF5 points |
| H&E | separate grid + alignment | none | no second frame; everything is identity µm / 0.101547 |
| Multiple regions | one bundle per section | 4 ROIs in one export, separate pixel grids | one dataset per ROI |

What was reused unchanged: dataset creation and channel pinning, `create_many`,
the property helpers, `update_many` tags, `ds.spatial.upload_and_register`,
`upload_transcripts` / `register_transcripts`, and the whole server side
(spatial plugin, raster, color-by). **No server or frontend changes were
needed.**

## Verification on roi_3

- **Frame**: 300/300 CellCoordinates centroids land inside their own label in
  `Segmentation.tiff` at `floor(µm / 0.101547)`.
- **Spots ↔ cells ↔ matrix**: assigning every molecule by the segmentation mask
  reproduces `CellxGene.csv` to 7,449,978 / 7,449,980 molecules (99.45% of
  entries identical, r = 1.0000). `floor` is the right pixel convention: `round`
  gives 93.9%.
- **Label → annotation map**: 50 random cells' first vertex matches the source.
  The table's `liveAnnotations` = 5,044.
- **Browser, zoomed in**:
  - the top-Col1a1 cell (914 counts) is packed with Col1a1 spots;
  - the top-KRT7 cell (669) with KRT7;
  - the top-Pecam1 cell (145, plus 253 Col1a1) shows both;
  - the top-Lyz2 cell (126) is Lyz2 only;
  - outlines sit on the DAPI nuclei.
- **Molecule click**: the readout shows gene, position and quality 40, and
  "Go to cell" jumps to the right annotation (label 5013).
- **Heat map**: the zoomed-out density map renders.
- **Overview raster + color by `Clustering / leiden` (categorical)**: the
  legend counts equal the h5ad's Leiden counts exactly (8: 1000, 3: 727,
  0: 634, …); clusters form coherent regions, and the vectors take over in the
  same colors when zoomed in.
- **Aggregate API**: mean / percent expressing per Leiden cluster returns
  sensible values.

## Traps

1. **Use `floor`, not `round`, for µm → pixel lookups** against the label masks
   (it is the convention SG used to build `CellxGene.csv`).
2. GeoJSON rings are closed: drop the duplicated last vertex.
3. The masks are zstd-tiled and need `imagecodecs` (in the `sg` extra).
   `labels_at` decodes only the tiles a lookup touches, so the checks never read a
   whole mask (~11 GB for roi_1).
4. Color-by needs a **numeric property**: Leiden as tags alone cannot drive the
   raster colors, hence `Clustering / leiden`.
5. The HDF5 points are in **pixels** while the CSVs are in **µm**.
6. There is no quality field: don't describe the overlay's quality threshold as
   meaningful for SG data.
7. The large ROIs (~180M spots) need memory. The store build peaks at about
   250 B per molecule (3.4 GB measured for roi_3's 14.4M molecules): the CSV
   parse, the per-level merges and the density `np.unique`. Budget 45–50 GB for
   roi_1/roi_2. Streaming by tile would lower that; it is not implemented.

## Not done yet

- roi_1, roi_2, roi_4 (each ~10–15× roi_3).
- Nuclei polygons (mask → polygon).
- UNUSED-barcode controls in the transcript store (would let the FDR show).

## Regression checklist

Each item names the test (`nimbusimage/tests/test_sg.py`) that holds it.

**Frame and counts**
- µm → px is `floor(µm / res)`; centroids land on their own mask label, and a wrong
  pixel size is caught — *"test_frame_check_passes_and_catches_a_wrong_pixel_size"*.
- Mask lookups decode only the tiles they touch and match a whole-image read —
  *"test_labels_at_reads_tiles_like_the_whole_image"*.
- A mask recount reproduces `CellxGene.csv` — *"test_recount_reproduces_the_matrix"*.

**Cell map**
- Polygons go up in pixels with the closing vertex dropped, and the map
  round-trips with its dataset, ROI and pixel size —
  *"test_polygons_are_pixels_and_the_map_round_trips"*.
- A non-positive `limit` uploads nothing (`labels[:-1]` would upload almost
  everything) — *"test_polygon_limit_must_be_positive"*; `chunk < 1` or a
  negative `verify_sample` on `upload_cell_data` is refused before any write —
  *"test_invalid_controls_are_refused_before_any_write"*.
- A map of another dataset or ROI is refused before any write —
  *"test_a_map_of_another_dataset_or_roi_is_refused"*, and through the CLI —
  *"test_steps_with_a_cell_map_of_another_dataset_write_nothing"*.
- An unreadable map is an `SGError`, not a traceback —
  *"test_an_unreadable_map_is_an_sg_error"*.

**Per-cell data**
- Custom polygon tags survive `cell-data` —
  *"test_custom_polygon_tags_survive_cell_data"*.
- Property values are replaced, not merged —
  *"test_values_are_replaced_not_merged"*.

**Spatial table**
- A mapped cell without a `CellxGene.csv` row is refused (no short table) —
  *"test_a_mapped_cell_without_a_matrix_row_is_refused"*.

**Transcript store**
- Every level holds every molecule, gene runs match `gene_identity`, and the
  density CSR sums per gene —
  *"test_layout_levels_and_density"*.
- Merging across levels keeps exact count-weighted centroids —
  *"test_merging_keeps_true_centroids"*.
- The plugin's own `TranscriptStore` serves points and density from the store
  (zarr 2 only) — *"test_the_server_reads_the_store"*.
- Registration uses the map's pixel size and refuses another ROI's store —
  *"test_register_uses_the_map_frame_and_refuses_another_roi"*.

**CLI**
- Unwritable outputs fail before any upload or build —
  *"test_unwritable_outputs_fail_before_any_upload_or_build"*, and `ingest`
  checks its work dir first — *"test_ingest_checks_its_work_dir_before_uploading"*.
- `verify` fails when the table or transcripts are missing or the table is
  short — *"test_verify_fails_when_the_table_or_transcripts_are_missing"*.
