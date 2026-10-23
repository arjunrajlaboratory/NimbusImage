---
name: nimbusimage-sg-ingest
description: >
  Load a Spatial Genomics (GenePS / sganalysis) data export into NimbusImage,
  one dataset per ROI: DAPI + GFP images, cell polygons, Leiden clusters as
  tags and a numeric property, UMAP, cell area, the full cell x gene matrix as
  a spatial table, and the transcript list as a Transcripts overlay. Use when
  the user mentions Spatial Genomics, GenePS, sganalysis, a DataExport_* zip,
  basic_results/roi_N, CellxGene.csv, TranscriptList.csv, Boundaries.geojson,
  or sganalysis.session. Complements xenium-ingest (same server machinery,
  different inputs).
---

# NimbusImage — Spatial Genomics ingest

Runbook for a **Spatial Genomics** data export (sganalysis 0.9.x / sgimage 1.2.x)
via `nimbusimage.sg` (the `sg` extra) and the `nimbusimage-sg` command. Worked example: project `Pav_PTR`, 4 ROIs, 274-gene panel,
0.101547 µm/px:

| ROI | Cells | Spots | Image (px) | Zip bytes |
|---|---|---|---|---|
| roi_1 | 75,566 | 187.8M | 54,357 × 52,447 | 18.8 GB |
| roi_2 | 70,704 | 180.2M | 52,510 × 64,128 | 18.9 GB |
| roi_3 | 5,044 | 14.4M | 25,262 × 13,574 | 1.6 GB |
| roi_4 | 41,901 | 126.6M | 38,823 × 44,678 | 12.2 GB |

roi_3 timings for `ingest` (73 s in total): images 60 s (upload and transcode),
polygons 1 s, cell data 2 s, table under 1 s (2.6 MB), transcript store 7 s (277 MB)
plus 2 s to upload. `check --recount` takes 4 s.

Nothing on the server is specific to Spatial Genomics. The images, polygons,
properties, spatial table, Transcripts overlay, overview raster and Color by Property
are the ones Xenium uses. Read `xenium-ingest` §6–§9 for how those behave. What this
skill adds is reading the export and converting the transcript list.

```bash
pip install 'nimbusimage[sg]'          # adds imagecodecs: the masks are zstd
export NI_API_URL=http://localhost:8080/api/v1 NI_API_KEY=...   # or NI_USERNAME/NI_PASSWORD
SG=nimbusimage-sg
$SG inventory --export-dir extracted --count-spots          # ROIs, cells, genes, spots
$SG check --export-dir extracted --roi roi_3 --recount      # local; no server
$SG ingest --export-dir extracted --roi roi_3 --work-dir state/   # every step; prints the dataset id
```

Or step by step (`--export-dir` may be the project folder or any parent up to two
levels; the dataset id is the FOLDER id):

```bash
DS=$($SG images --export-dir X --roi roi_3 --name "Pav_PTR roi_3")
$SG polygons      --export-dir X --roi roi_3 --dataset $DS --cells-out cells.npz
$SG cell-data     --export-dir X --roi roi_3 --dataset $DS --cells cells.npz
$SG spatial-table --export-dir X --roi roi_3 --dataset $DS --cells cells.npz --out spatial.zarr.zip
$SG transcripts   --export-dir X --roi roi_3 --dataset $DS --cells cells.npz --out transcripts.zarr.zip
$SG verify        --export-dir X --roi roi_3 --dataset $DS --cells cells.npz
```

From Python:

```python
import nimbusimage as ni
from nimbusimage import sg

roi = sg.SGRoi("extracted", "roi_3")
assert sg.check_frame(roi)["fraction"] == 1.0
ds = sg.upload_images(ni.connect(), roi, "Pav_PTR roi_3")
cells = sg.upload_polygons(ds, roi); cells.save("cells.npz")
sg.upload_cell_data(ds, roi, cells)
sg.upload_spatial_table(ds, sg.build_spatial_table(roi, cells, "spatial.zarr.zip"))
sg.register_transcripts(ds, cells, sg.build_transcript_store(roi, "transcripts.zarr.zip"))
```

The `SGCellMap` (`cells.npz`) records the label → annotation id map, the dataset, the
project and ROI, and the pixel size. Every later step refuses a map that belongs to
another dataset or ROI before it writes anything. `register_transcripts` also refuses
a store built from another ROI.

## 1. Export anatomy (per ROI)

```
<project>/basic_results/roi_N/
  roi_N_Boundaries.geojson    cell polygons, MICRONS, closed rings, id = label
  roi_N_CellCoordinates.csv   label, area (um^2), center_x, center_y (um)
  roi_N_CellxGene.csv         raw counts; rows = labels; one column per gene
  roi_N_TranscriptList.csv    name, x, y, z (um) — no quality, no cell id
  roi_N_Segmentation.tiff     uint32 cell-label mask, zstd tiles, pyramid
  roi_N_DAPI.tiff             duplicate of mini_project/.../dapi.tiff
<project>/mini_project/roi_N/
  images/dapi.tiff, GFP_image.tiff   OME-TIFF uint16, JPEG2000 tiles, pyramid
  clusters/matrix_*_cells.h5ad       obs leiden, area; obsm X_umap, X_pca; index = label
  genes/<project>.hdf5               per-gene points in PIXELS + 467 UNUSED* controls
  segmentations/*_{cells,nuclei}.tiff  label masks (nuclei have no polygons)
  sganalysis.session                 JSON: shape, res (= um/px)
```

The **cell label** is the join key in every file: the GeoJSON id, the CellxGene row,
the h5ad obs index and the mask value. Unzip one ROI at a time, for example
`unzip <zip> '*/basic_results/roi_3/*' '*/mini_project/roi_3/*' -d extracted`.

## 2. What each step writes

| Step | NimbusImage result |
|---|---|
| `images` | A dataset with one channel per file in `images/`, DAPI first, named from the file (`GFP_image` → `GFP`). It reuses the Xenium staging (`c00-DAPI.ome.tif`) and channel pinning. The JPEG2000 OME-TIFFs transcode without conversion. |
| `polygons` | `px = µm / res`, identity orientation, closing vertex dropped, tag `cell`, `create_many` batches of 5,000. |
| `cell-data` | Tags `["cell", "Leiden k"]`, where `cell` is whatever `polygons --tags` used (the map records it). Properties `SG Area / area_um2`, `UMAP / x, y` and `Clustering / leiden`. Values are replaced on a re-run. |
| `spatial-table` | AnnData zarr v2: raw counts as CSC X plus `layers/X_csr`. obs has `annotation_id`, `cell_index` (= label), `cell_type` ("Leiden k") and `leiden`. var has `gene_id` (Ensembl, from the h5ad), `feature_type` and `feature_name`. Also `obsm/X_umap` and `uns/nimbus`. |
| `transcripts` | `TranscriptList.csv` rewritten in the **Xenium `transcripts.zarr` layout** (§3), uploaded, and registered at the map's pixel size. |

## 3. The transcript store

The SpatialPlugin reads only the 10x layout, so `nimbusimage.sg.transcripts` writes it
in zarr format 2 (from zarr 2 or 3):
- root attribute `gene_names`;
- `grids/{0..6}`: tiles of 250 µm × 2^L, rows sorted by gene, with
  `gene_offset = [lowStart, lowEnd, highStart, highEnd]` and an empty low run;
- level 0: `location`, `quality_score` (40), `gene_identity` (recompute reads it)
  and `id`;
- levels 1–6: count-weighted centroids of each gene's molecules on a
  0.5 µm × 2^L grid, with `cluster_count`;
- `density/gene`: a 10 µm CSR.

A unit test opens the store with the plugin's own `TranscriptStore` and serves points
and density from it. That test only runs where zarr < 3, so CI (zarr 3) skips it. A
store written with zarr 3 and read by the server's zarr 2 was checked by hand on roi_3:
Spp1 returns 189,484 molecules, the same as the export's HDF5.

## 4. Filtering and coloring by gene expression

Gene expression is **not** stored as property values. Every gene in the spatial table is
readable as a virtual property path `["spatial", "<gene>"]`, served live from the table.
A gene appears in the app's pickers only once it has been added, which keeps a
274-gene (or 5K) panel from flooding every menu. Users who "can't find expression in the
property list" have not added it yet.

**In the app:**
1. Click the ruler icon (**Measure objects**) and use the **Gene expression** card's
   **Add genes…** button. Alternatively, open the object list (list icon), go to the
   **Measurements** tab and click **Add genes**.
2. Pick genes and choose a mode:
   - **Add as live columns** (default): no copy is made, and the genes are listed under
     **Spatial table**.
   - **Copy into a measurement**: materializes ordinary property values.
   - **Gene-set score**: combines several genes into one score.
3. The genes are then offered wherever a measurement is: property **filters** (range),
   analysis axes and gates, Color by Property, object-list columns, CSV export, and the
   selection summary.

You can't sort the object list by a gene column (a 400). Live columns persist across
reloads through the displayed paths. Design notes: `codebaseDocumentation/SPATIAL_PLUGIN.md`,
"Phase 2: any gene as a property path".

**From Python** (`ds.spatial.virtual_path("KRT7")` gives `["spatial", "KRT7"]`):

```python
f = {"propertyFilters": [{"path": ["spatial", "KRT7"], "mode": "range", "min": 100}]}
ds.annotations.summary(filters=f)            # counts server-side; nothing downloaded
ds.spatial.aggregate(["KRT7", "Spp1"], {"tags": {"values": ["Leiden 0"], "exclusive": False}})
ds.spatial.materialize(["KRT7", "Spp1"])    # copy into a property (dense sub-values)
```

On roi_3, `KRT7 >= 100` matches 1,057 cells, exactly the count in `CellxGene.csv`.

## 5. Traps

1. **`floor`, not `round`**, when converting µm to pixels for mask lookups. That is
   how `CellxGene.csv` was built: a floor recount matches it to within 2 of 7.4M
   molecules, while `round` changes about 6% of entries.
2. **There is no quality score.** Every molecule is stored at qv 40, so the
   Transcripts palette's quality slider does nothing for this data. Say so.
3. **Controls live only in the HDF5** (`UNUSED*`, ~3.5% of points). They are not in
   the CSV, so the store has none. The plugin's `CONTROL_PATTERN` does not match
   `UNUSED`, so extend it before ever ingesting HDF5 points, or the controls will be
   offered as genes.
4. **HDF5 points are in pixels; the CSVs are in microns.**
5. **Color by Property needs a number.** Leiden as tags cannot color the overview
   raster; `Clustering / leiden` (Categorical mode) can. Its legend counts must equal
   the h5ad's `leiden.value_counts()`.
6. **Each ROI is its own pixel grid**: one dataset per ROI.
7. The masks are zstd, which needs **imagecodecs** (the `sg` extra). `check` decodes
   only the mask tiles it touches, so it never reads a whole 11 GB mask.
8. **Memory on big ROIs** (~180M spots): `transcripts` and `check --recount` hold every
   molecule, and the store build peaks at about 250 B per molecule (3.4 GB measured
   on roi_3's 14.4M). Budget **45–50 GB for roi_1/roi_2** and run them on a large
   machine.
9. `basic_results/*_DAPI.tiff` duplicates `images/dapi.tiff`; upload only one.
10. Gene symbols with `.`/`$` become `_` in the table and the store (`safe_symbol`),
    the same as for Xenium mouse panels.
11. **Genes are absent from the property pickers until added** (§4). Add them as live
    columns rather than materializing the whole panel; `materialize` is for a few
    genes you need as real values.

## 6. Verification checklist

- [ ] `check --recount`: frame 300/300, `entriesEqual` ≥ 0.99, correlation ≈ 1.
- [ ] `verify` exits 0. It checks:
  - the map's sampled first vertices match;
  - a table is registered with one row per mapped cell, all live;
  - transcripts are registered.
- [ ] In the browser:
  - outlines sit on the DAPI nuclei;
  - for 4–5 marker genes, the top cell (`CellxGene.csv` idxmax) is full of that
    gene's spots;
  - clicking a molecule shows its gene, and **Go to cell** jumps to that label;
  - the heat map appears when zoomed out.
- [ ] Add one gene as a live column (§4). A range filter on it matches the
      `CellxGene.csv` count of cells at or above the threshold.
- [ ] Settings → *Advanced settings for large numbers of annotations* → **Annotation
      overview raster** on, then Color by Property → `Clustering / leiden`,
      **Categorical**: the legend matches the h5ad, and vectors take over in the
      same colors when zoomed in.
