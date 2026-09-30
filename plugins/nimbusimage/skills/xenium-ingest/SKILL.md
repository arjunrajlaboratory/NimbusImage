---
name: xenium-ingest
description: >
  Load a 10x Xenium spatial-transcriptomics bundle into NimbusImage: the
  morphology and H&E images, cell segmentation polygons, a gene-expression
  marker panel, clustering, a computed UMAP, and cell types as tags. Use this
  skill when the user mentions Xenium, 10x spatial data, cells.zarr,
  cell_feature_matrix, transcripts, he_imagealignment, or wants Xenium /
  spatial-omics cells and per-cell data in NimbusImage. Covers bundle anatomy,
  micron-to-pixel transforms, H&E alignment, orientation validation, bulk
  upload, nested property values, and every trap hit on a 709k-cell dataset.
---

# NimbusImage — Xenium ingest

End-to-end runbook for getting a **10x Xenium** output bundle (XOA 1–4, including Prime 5K
and the XOA 4 protein panels) into NimbusImage as images + cell polygons + per-cell data.
Every step below was measured on one of these:

| Worked example | XOA | Cells | Features | Morphology | H&E | Extras |
|---|---|---|---|---|---|---|
| FFPE Human Lymph Node (Prime 5K) | pre-4 | 708,983 | 4,624 genes | 4 ch, 0.2125 µm/px | own grid, `M` scale 1.289 | cell types csv |
| FFPE Human Kidney RCC, protein | 4.0.0.19 | 465,534 | 405 genes + 27 proteins | 35 ch | 24096×60680, **rotated 90°**, 0.2738 µm/px | 77M molecules, 9-region GeoJSON |

Kidney timings: polygons 74 s (morphology) / 144 s (H&E), UMAP 207 s, clusters + UMAP
properties ~90 s, table build 115 MB in 1 s + register 3 s, transcripts register 13 s,
region summary over 9 regions ~11 s.

Every step lives in the `nimbusimage` package as `nimbusimage.xenium` (≥ 0.3.0), usable
from Python or as the `nimbusimage-xenium` command (one subcommand per step; also
`python -m nimbusimage.xenium`). `nimbusimage-xenium <step> --help` lists each step's
flags. The command reads credentials from the environment only:

```bash
export NI_API_URL=http://localhost:8080/api/v1
export NI_API_KEY=...            # or NI_USERNAME + NI_PASSWORD; never commit a key
pip install 'nimbusimage[xenium]'          # 'nimbusimage[xenium-umap]' adds the UMAP step
```

From a clone, `pip install -e 'nimbusimage[xenium]'`, and run from outside the repo root
(trap 12). The same pipeline from Python:

```python
import nimbusimage as ni
from nimbusimage import xenium

client = ni.connect()
bundle = xenium.XeniumBundle("extracted")
ds = xenium.upload_morphology(client, bundle, "Lymph node")
cells = xenium.upload_polygons(ds, bundle)        # a CellMap; keep it
cells.save("cells_morph.npz")                     # later: xenium.open_cells(ds, bundle, path)
xenium.upload_gene_panel(ds, bundle, cells, ["CD3E", "MS4A1"])
xenium.upload_clusters(ds, bundle, cells)
xenium.upload_umap(ds, bundle, cells, xenium.compute_umap(bundle))
xenium.upload_cell_types(ds, bundle, cells, "cell_types.csv")
table = xenium.build_spatial_table(bundle, cells, "spatial.zarr.zip",
                                   cell_types="cell_types.csv")
xenium.upload_spatial_table(ds, table)            # refuses a table built for another dataset
xenium.register_transcripts(ds, bundle, cells)     # the polygons' frame; checked vs ds
xenium.upload_regions(ds, "annotation.geojson", cells, drawn_in="he",
                      alignment="he_align.csv")    # adds M to the morphology frame

# the H&E image: its own frame and its own cell map
he_frame = xenium.ImageFrame.create(bundle=bundle, alignment="he_align.csv")
he_cells = xenium.upload_polygons(he_ds, bundle, he_frame)
```

Two objects carry what the steps share, so nothing has to be passed twice. Transcripts
and regions take the dataset's `CellMap` (or an explicit `ImageFrame`) and **never fall
back to a default frame**: nothing verifies their coordinates, so a guess would silently
misplace every molecule on an H&E dataset. On the command line that means `--cells`, or
`--image`/`--alignment`/`--pixel-size`; a mistyped `--cells` path is an error.

- **`ImageFrame`** — how microns land on one dataset's pixels: which image (`morphology`
  or `he`), the pixel size, the alignment. Validated when built (pixel size > 0, a 3×3
  invertible alignment). Every coordinate-producing step takes the same frame, so a
  pixel-size override or an alignment cannot reach one step and miss another.
- **`CellMap`** — every cell's annotation id, *with* the dataset they belong to, the frame
  they were drawn with, and the polygon set. Always one slot per cell (None where a
  polygon was degenerate or past `--limit`). Every per-cell step refuses a map of another
  dataset, of nuclei, or of another bundle before writing anything, and
  `open_cells` spot-checks a saved map against the server before it is used.

Every step raises `xenium.XeniumError` instead of writing wrong data (a missing gene, a
malformed alignment, polygons out of `cell_index` order); the command prints it and exits 1.

## 0. The whole pipeline

```bash
X=nimbusimage-xenium
# 1. URLs are JS-rendered on the 10x page — grep the HTML
curl -sL "<dataset-page-url>" | grep -oE 'https://cf\.10xgenomics\.com[^"]*' | sort -u
# 2. Download: the bundle (~8.5 GB), the standalone H&E, its alignment, the cell types
curl -sL -C - --retry 5 -o outs.zip "<prefix>_xe_outs.zip"
curl -sL -C - --retry 5 -o he.ome.tif "<prefix>_he_image.ome.tif"
curl -sL -o he_align.csv "<prefix>_he_imagealignment.csv"
curl -sL -o cell_types.csv "<prefix>_cell_types.csv"
# 3. Extract only what is needed
#    (transcripts.zarr.zip, ~4.7 GB, only for the step-9 overlay: add it then)
unzip -o outs.zip 'morphology_focus/*' cells.zarr.zip cell_feature_matrix.zarr.zip \
      analysis.zarr.zip experiment.xenium -d extracted/
# 4. Images: one dataset from morphology_focus/, channels named by stain (§2);
#    prints the dataset FOLDER id. (Or through the UI, then find the id — §4.)
MORPH=$($X morphology --bundle-dir extracted --name "Lymph node")
# 5. Polygons — validate a slice, then all; keep the cell map each one saves.
#    --alignment/--pixel-size are given HERE only: the cell map records the frame,
#    and every later step reuses it through --cells.
$X polygons --bundle-dir extracted --dataset $MORPH --limit 5000 --tags xenium-test
$X polygons --bundle-dir extracted --dataset $MORPH --delete-tag xenium-test --cells-out cells_morph.npz
$X polygons --bundle-dir extracted --dataset $HE --alignment he_align.csv --cells-out cells_he.npz
# 6. UMAP (10x does not ship one) ~6 min for 709k cells
$X umap --bundle-dir extracted --out umap/
# 7. Per-cell data as nested properties (marker panel, not the whole matrix)
$X properties --bundle-dir extracted --dataset $MORPH --cells cells_morph.npz \
       --what genes,clusters,umap --genes-file panel.txt --umap umap/umap_xy.npy
# 8. Cell types as tags
$X cell-types --bundle-dir extracted --cell-types cell_types.csv \
       --dataset $MORPH --cells cells_morph.npz
# 9. Whole matrix as a spatial table, and the molecules as an overlay (§7b, §7c)
unzip -o outs.zip transcripts.zarr.zip -d extracted/
$X spatial-table --bundle-dir extracted --dataset $MORPH --cells cells_morph.npz
$X transcripts --bundle-dir extracted --dataset $MORPH --cells cells_morph.npz
# 10. Pathology regions (a *_annotation.geojson, drawn in H&E pixels) as tagged polygons
$X regions --geojson annotation.geojson --dataset $MORPH --cells cells_morph.npz \
       --drawn-in he --alignment he_align.csv
$X regions --geojson annotation.geojson --dataset $HE --cells cells_he.npz \
       --drawn-in he
```

Protein panels (XOA 4 "Protein" bundles) quantify antibodies in the same matrix
(`feature_type` "protein"); the table builder keeps them as features named
`<name> (protein)` — several share a gene's name (CD3E, CD4, CD68, …) and symbols must be
unique. Worked example: FFPE Human Kidney RCC protein bundle, 465,534 cells, 405 genes +
27 proteins, 35 morphology channels, 77M molecules; the region summary over its 9
pathology regions takes ~11 s.

Run every upload step with `--limit 2000` first and look at the result in the viewer.

**The H&E dataset's pixel size.** Distances (neighborhood radius) and areas need the
configuration scale. Large-image metadata usually sets it on import (0.2738 µm for the
kidney H&E). When it is blank, the app fills it from the spatial registration — through
the transcript transform on an H&E (`pixelSize / sqrt(|det A|)`), so it is the H&E's own
pixel, not morphology's 0.2125. A value set by hand is never overwritten.

## 1. Bundle anatomy

| File | Where | Contains |
|---|---|---|
| `_xe_outs.zip` | standalone (~8.5 GB) | everything below plus transcripts |
| `morphology_focus/morphology_focus_000{0..3}.ome.tif` (XOA 1-3) or `ch00NN_<stain>.ome.tif` (XOA 4) | **in zip** | ONE logical multi-channel image (DAPI is channel 0) spread over one file per channel; 4 channels, 12 with the protein panel. Stain names are in each file's OME `<Channel Name>` |
| `cells.zarr.zip` | **in zip** | `polygon_sets/{0: nucleus, 1: cell}` vertices in **microns**, `cell_id`, `cell_summary`, label masks |
| `cell_feature_matrix.zarr.zip` | **in zip** | counts, **gene-major CSR** (row = feature, `indices` = cell), `feature_keys`, `feature_types` |
| `analysis.zarr.zip` | **in zip** | `cell_groups` clusterings ONLY — **no UMAP / PCA** |
| `transcripts.zarr.zip` | **in zip** (~4.7 GB) | per-molecule transcripts with a 7-level spatial pyramid; skip for a first ingest |
| `experiment.xenium` | **in zip** | run manifest: `pixel_size`, `num_cells`, panel size |
| `_he_image.ome.tif` | standalone | post-Xenium H&E, RGB, on its **own pixel grid** |
| `_he_imagealignment.csv` | standalone | 3×3 affine, **H&E px → morphology px** |
| `_cell_types.csv` | standalone | `cell_id,group` per cell |

DAPI, segmentation, counts, and clustering exist **only inside the zip** — there are no
per-file CDN links for them. Verify downloads against `Content-Length`, `unzip -t`, sha256.

Three "panel sizes" coexist: real genes (`feature_type == "gene"`, e.g. 4,624) ≠
`gene_panel.json` targets ≠ total matrix rows (11,095 with controls). Always filter to
`feature_type == "gene"`.

## 2. Images

`nimbusimage-xenium morphology` (`xenium.upload_morphology`) creates the dataset from `morphology_focus/` and configures
it as one multi-channel image, channels named after their stains. The file names can't
supply those names: NimbusImage's filename parser splits on `_`, so XOA 4's
`ch0001_atp1a1_cd45_e-cadherin.ome.tif` became channel `ch0001` (and XOA 1-3 files carry no
stain at all). It reads the names from the OME metadata, uploads copies named
`c01-ATP1A1+CD45+E-Cadherin.ome.tif` (two-digit prefix keeps the order; `/` and `_` would
split the token), and pins the channel axis to that name. Importing the files through the
UI works too, with `ch00NN`-style channel names. Import the H&E OME-TIFF as a separate
dataset. A new collection shows only the first `min(6, channels)` channels as layers; on a
35-channel protein bundle add the rest with **Add layer**. The two are **not co-registered** — the H&E dataset needs the alignment matrix
for every overlay (§3).

## 3. Coordinates — the crux

NimbusImage annotation coordinates are **image pixels** (origin top-left, +y down).
Xenium vertices are **microns**. Divide by the *Xenium* `pixel_size` from
`experiment.xenium` — not by whatever pixel size NimbusImage reports (it may show 1.0).

- **Morphology**: `px = µm / pixel_size`, identity orientation.
- **H&E**: `he_px = M⁻¹ · [µm / pixel_size, 1]` where `M` is the csv. Sanity check: the
  2×2 block's magnitude equals `he_px_size / morph_px_size` (1.289 = 0.2738 / 0.2125
  here). `--alignment` (`ImageFrame(alignment=...)`) takes the csv as shipped and applies
  `M⁻¹` for you. For `polygons`, `transcripts` and the per-cell steps, `--alignment`
  alone means the dataset is the H&E image. For `regions` it can also mean "carry
  H&E-drawn regions onto the morphology image", so there the image is never inferred:
  pass `--cells` (whose frame says which image it is) or `--image`.

**Determine orientation empirically, never by eye.** Fetch a ~600 px thumbnail
(`GET item/{id}/tiles/region?width=600&...&encoding=PNG`), threshold it into a tissue
mask, build a cell-centroid density grid at the same resolution, and correlate the two
across identity / flips / rot180 / `M` vs `M⁻¹`. Margins are unambiguous (0.75 vs ≤0.55
for morphology; 0.88 vs 0.21 for `M⁻¹` vs `M`). Do this before uploading 700k polygons.

The kidney's `M` is a 90° rotation with scale 0.7754 (H&E px → morphology px): a
by-eye guess would have put every cell on the wrong axis. The same `M` carries regions
and molecules onto the H&E (through `cells_he.npz`'s frame), and a transformed transcript registration
shows points only (no density heat map).

Pre-upload checklist: centroid px range ⊂ `[0, W] × [0, H]`; correlation winner has a
clear margin; a ~5k-cell slice with a distinct tag looks right in the viewer.

## 4. Dataset ids

The id in a `#/datasetView/<id>/view` URL is a **dataset_view**, not the folder the API
wants:

```python
view = client.girder.get(f"dataset_view/{view_id}")
folder_id = view["datasetId"]           # pass this as --dataset
```

## 5. Polygons (`polygons`, `xenium.upload_polygons`)

Uploads in `cell_index` order via `create_many` in batches of 5,000 — ~100 s for 709k
polygons. A per-annotation loop would be 709k requests; never do that. `--cells-out`
saves the cell map (ids + dataset + frame); every later step takes it as `--cells`.
Without the file, `open_cells` re-derives it from the server by **geometry** — each
annotation is matched to the cell whose first two vertices and vertex count the frame
puts at the same place, never by list position (the server does not promise creation
order) — so regions or nuclei in the dataset are ignored, a `--limit` upload maps the
cells it has, and a double upload is an error. A saved map is checked against
the dataset before use, so the H&E dataset's file can't be used for the morphology
dataset by mistake — both have the same cell count. Files written by the older
`--ids-out` (a bare id array) still work for the per-cell steps, spot-checked with
`--alignment`/`--pixel-size`; they save no frame, so `transcripts` and `regions` refuse
them — pass those the frame flags, or write a full map once with
`xenium.open_cells(ds, bundle, "cells.npz", frame=frame)` (a new path: it re-derives and
saves) — with the frame the polygons were drawn with, e.g.
`xenium.ImageFrame.create(bundle=bundle, alignment="he_align.csv")` for the H&E dataset;
without `frame` it assumes the morphology frame and matches nothing on H&E.
Upload is fast; viewer rendering at this scale is handled by NimbusImage's lazy
annotation loading. Nucleus polygons are `--polygon-set nucleus` (more nuclei than cells
is normal: multinucleate cells). They are for display only: every later step joins per-cell
data by `cell_index`, so run those on a dataset's cell polygons.

## 6. Per-cell data as nested properties (`properties`, `xenium.upload_gene_panel` / `upload_clusters` / `upload_umap`)

A property value nests two levels: `values[propertyId][subKey]` is a scalar or a dict of
scalars. One property therefore carries a whole panel:

| Property | Sub-keys | Notes |
|---|---|---|
| `Gene Expression` | one per gene | **dense** (explicit zeros) so the UI can tell 0 from missing |
| `Clustering` | `graphclust`, `kmeans_2_clusters` … | 0 = unassigned |
| `UMAP` | `x`, `y` | from `nimbusimage-xenium umap` (`xenium.compute_umap`) |

**Choose a marker panel.** 4,624 genes × 709k cells is 3.28 billion dense values; a
31-gene panel is 22 M and uploads in ~60 s. Development panels omit canonical markers
(this one lacked CD3D, IL7R, NKG7, LYZ, ACTA2, …) — the step aborts on a missing
symbol; substitute rather than assume.

Properties are registered into the dataset's collections on creation
(`nimbusimage` ≥ 0.2.2); the step also calls the idempotent `register()`.
Address a sub-value as `[propertyId, "MS4A1"]` for filters, plots, histograms, export.

## 7. Cell types as tags (`cell-types`, `xenium.upload_cell_types`)

Cell types are categorical, property values are numeric, so each cell polygon becomes
`["cell", "<group>"]` through the bulk `PUT upenn_annotation/multiple` (~80 s for 709k).
Tags feed the tag filter, the Analysis panel's categorical axes, and the Selection
summary (Import/export menu → *Selection summary*: composition by tag plus property
statistics for the selection, the filtered set, or the whole dataset, exportable as CSV).
The csv `cell_id` (`aaaaadoa-1`) is decoded (`a..p` → nibbles, `-N` suffix) and matched
against the packed zarr `cell_id`; row order is not trusted. `--reset` undoes it.

## 7b. The full matrix as a spatial table (`spatial-table`, `xenium.build_spatial_table`)

The marker panel above is what the interactive machinery (filters, plots, colors) works
on. The **whole** matrix goes in as one file: an AnnData-layout zarr store, zipped,
uploaded into the dataset folder and registered with the `upenncontrast_spatial` plugin.

```bash
nimbusimage-xenium spatial-table --bundle-dir extracted --dataset $MORPH \
       --cells cells_morph.npz --cell-types cell_types.csv --umap umap/umap_xy.npy \
       --out spatial.zarr.zip          # 709k x 4,624 genes -> ~630 MB, a few minutes
```

It writes `X` (cells × genes CSC), `layers/X_csr`, `obs` (`annotation_id` — the only join
key — `cell_index`, `cell_type`, clusterings), `var` (symbol, gene_id, feature_type),
`obsm/X_umap`, then uploads and calls `POST spatial/{dataset}/register`. From Python:

```python
ds.spatial.info()                                     # nObs, nVar, liveAnnotations
ds.spatial.features("cd")                             # symbol search
ds.spatial.aggregate(["CD3E", "MS4A1"],
    {"tags": {"values": ["Memory B Cell"], "exclusive": False}})   # mean, % expressing
ds.spatial.materialize(["CD3E", "MS4A1", "CD19"])     # -> dense sub-values of a property
```

Any gene is also a **property path** without copying: `["spatial", "CD3E"]` works in
filters, analysis gates and axes, color-by, the object list and the summary
(`ds.spatial.virtual_path("CD3E")`; e.g. `ds.annotations.list(filters={"propertyFilters":
[{"path": ["spatial", "CD3E"], "mode": "range", "min": 3}]})`). Gene-set scores:
`ds.spatial.score(["CD3E", "CD2"], "T cell")`. Differential expression between two filter
objects (a server job; `method="welch"` t-test or `"wilcoxon"` Mann-Whitney):
`ds.spatial.differential(filters_a, filters_b=None)`.

In the app: Measurements tab → **Genes from spatial table** (live columns, copy into a
measurement, or a gene-set score), and the Selection summary's **Expression** section
with **Compare expression…** (mean and % expressing for picked genes over the current
selection, filter, or gate). `--no-upload` builds the file only. Requires `anndata`.

## 7c. Molecules as an overlay (`transcripts`, `xenium.register_transcripts`)

`transcripts.zarr.zip` is registered **as shipped**: it is already a tile pyramid
(`grids/{level}/{gx},{gy}`, 250 µm × 2^level) with a per-gene 10 µm density grid. Upload is
the slow part (4.7 GB for the lymph node); registration only records the scale — the
frame saved with the dataset's polygons, so molecules and cells line up even with a
pixel-size override:

```bash
nimbusimage-xenium transcripts --bundle-dir extracted --dataset $MORPH --cells cells_morph.npz
nimbusimage-xenium transcripts --bundle-dir extracted --dataset $HE --cells cells_he.npz
#   (the H&E map's frame carries the alignment: its inverse is the transform)
```

In the app a **Transcripts** palette appears for such datasets: pick up to 8 genes, set the
quality threshold (20 is Xenium's own cut), and the viewer draws molecules as points at the
finest pyramid level that fits the budget, or the density heat map when zoomed out.
Clicking a molecule shows its gene and quality, and **Go to cell** when it sits inside a
drawn cell outline (the zarr carries no cell reference — its `id` is the transcript's own —
so the cell is found geometrically). From Python: `ds.spatial.transcripts()`,
`ds.spatial.transcript_genes("cd")`, `ds.spatial.transcript_points(["CD3E"], ["12,7"],
level=0, min_qv=20)`.

## 7d. Recompute counts after editing cells (`ds.spatial.recompute`)

With both the table (§7b) and the transcripts (§7c) registered, edited polygons can be
turned into a corrected matrix: in the Transcripts palette, **Cell table → Recompute
counts…** (edited cells only, or a full rebuild; the previous table stays as a version
you can switch back to). From Python: `ds.spatial.staleness()` (added / edited / removed
cells since the table was built), `ds.spatial.recompute("v2", scope="dirty")`,
`ds.spatial.versions()`, `ds.spatial.activate_version(item_id)`. Assignment is
smallest-polygon-wins at image resolution, quality ≥ 20, genes only; cell types follow
the cells' tags.

## 7e. Neighborhoods and regions (`ds.spatial.compute_neighborhood`, `region_summary`)

Selection summary → **Spatial statistics**: **Neighborhood…** counts each cell's
neighbors by type within a radius (30 µm default; converted to pixels with the dataset's
scale) and shows the type-by-type enrichment matrix; the fractions become a
`Neighborhood` measurement usable in filters, gates and color-by. **Regions…** takes a
tag you put on hand-drawn (or imported) polygons and tabulates the cells inside each:
composition by type and mean expression of picked genes. From Python:
`ds.spatial.compute_neighborhood(radius_pixels=141)`, `ds.spatial.neighborhood()`,
`ds.spatial.region_summary("region", features=["CD3E"])`.

## 7f. Regions of interest (`regions`, `xenium.upload_regions`, or the UI)

10x ships a pathologist's layer (`*_annotation.geojson`, QuPath style) in **H&E pixels**.
`nimbusimage-xenium regions --drawn-in {he,morphology,microns}` with `--cells` or `--image {he,morphology}` (required without `--cells`)
(with the dataset's `--cells`, whose frame it reuses; `--alignment` adds the matrix a
morphology frame lacks, for H&E-drawn regions) transforms it (H&E→morphology applies `M`; morphology→H&E `M⁻¹`; microns divide by
`pixel_size`) and uploads each outer ring as a polygon tagged `[<class>, "region"]` (a custom `--tag`
is added; `region` is always kept) — class
first, because GeoJSON export writes the first tag as QuPath's `classification`.

In the app the same file goes in through **Import/export → Import GeoJSON…** (preview,
layer, extra tag default `region`). The importer reads coordinates as *this* image's
pixels, so an H&E-pixel file goes on the H&E dataset only; use `regions` for the
morphology dataset. **Export GeoJSON** (or `ds.export.to_geojson(annotation_ids)`, nimbusimage ≥ 0.2.3)
round-trips vertex-for-vertex; rectangles come back as polygons, names are not re-imported.

**`region` is a reserved tag.** Polygons carrying it are never cells: neighborhoods,
region summaries, recompute assignment and staleness all leave them out. Keep it on every
ROI and never on a cell. Region summaries count a cell when its (vertex-mean) centroid
lies inside the region.

## 7g. Looking at everything at once

With 465K–709K cells the viewer draws a subset. For the whole section: Settings →
*Advanced settings for large numbers of annotations* → **Annotation overview raster**
(server-rendered tiles of every cell; smaller shapes paint over larger, so regions do not
hide cells; interactive vectors take over past the vector switch). Then **Color by
Property** → `Clustering / graphclust` with mode **Categorical** (Auto may pick a
continuous ramp for integer clusters). Applying recolors every annotation, regions
included, and cannot be undone.

## 8. Traps (each cost real time)

1. **`submit_values` does not overwrite.** Re-submitting an existing value is a silent
   no-op; cells without a value do get written, so a re-run leaves a half-old dataset.
   Use `--replace` (deletes the property's values for this dataset first).
2. **`cell_groups` indices are zero-padded.** Unassigned cells hold `0`, so cell 0 appears
   hundreds of times; naive decoding gives cell 0 the last cluster id of every grouping.
   A zero is genuine only as the first element of its block. `xenium.decode_cell_groups` does
   this right; guard any new CSR-style decode with `len(np.unique(ind)) == len(ind)`.
3. **`ds.properties.list()` is server-wide.** A dataset that never received values still
   "has" the property. Check `ds.collections.get_raw()["meta"]["propertyIds"]` and read
   one annotation's values.
4. **Verify the `cell_index → annotation_id` map.** `xenium.fetch_cells` compares every
   annotation's first vertex with the one the frame puts it at and aborts on any
   mismatch; `open_cells` spot-checks a saved map the same way. Keep the `--cells-out`
   file: it records which dataset and frame the ids belong to.
5. **Morphology is one image in four files**; never import file 0001–0003 as separate
   images. **H&E is a separate grid**; never assume co-registration.
6. **Categorical data are tags, not property values.**
7. **XOA 4 renamed the morphology files** to `ch00NN_<stain>.ome.tif`; stain names come
   from OME metadata, never from the filename (§2).
8. **Protein features share gene names** (CD3E gene vs CD3E antibody): the table names them
   `<name> (protein)`; registration refuses duplicate symbols.
9. **A dataset opened while its transcode is finishing can render black** (0 tiles) even
   though the server tiles are fine — reload the page before debugging.
10. **Rebuilding the Girder image kills running local jobs** (materialize, recompute,
    transcode). Never `docker compose build girder` during an ingest.
11. **`ds.properties.get_values()` returns at most 50** — never use it to count or
    verify; use `histogram` or the export endpoints.
12. **Running Python from the repo root shadows the package**: `nimbusimage/` is a folder
    there, so `import nimbusimage` finds a namespace package with no `connect`. Run from
    elsewhere (or install and `cd` out).
13. **Regions without the `region` tag are cells** to every spatial analysis (§7f).
14. **Vendor formats vary by XOA version — test validators on real bundles.** Pre-XOA-4
    `transcripts.zarr.zip` tiles pad `gene_offset` with one trailing empty row (lymph
    node: 11,095 rows for 11,094 `gene_names`; kidney XOA 4: exactly 516). An
    exact-shape check added in an audit rejected every lymph-node tile; only a
    *shorter* table is unsafe.

15. **Mouse panels have `.` in gene symbols** (`Tex19.1`), and symbols become MongoDB keys,
    which can't hold `.` or `$`: the SpatialPlugin refuses such a table. Every stored
    symbol is `safe_symbol(name)` (`.`/`$` → `_`, so `Tex19_1`) in both the table and the
    gene-panel sub-keys; the table keeps the original in `var/feature_name`, and a panel
    may name the gene either way. Found only by running the XOA 3 mouse bundle live.

## 9. Post-upload verification

```python
raw = ds.collections.get_raw()                               # dict or [dict]
assert prop_id in raw["meta"]["propertyIds"]                 # registered
hist = ds.properties.histogram(f"{prop_id}.CD3E", buckets=10)
assert sum(b["count"] for b in hist) == n_cells               # complete
ds.annotations.get(ann_id).tags                              # ["cell", "Memory B Cell"]
```

Spot-check several `cell_index` values against the zarr ground truth on both datasets.

**Cross-dataset parity** is the strongest alignment check once both datasets are loaded:
take the same sample of cells (same upload order) on the H&E and morphology datasets and
count how many fall in each region there. The counts must be identical — on the kidney
all 7 classes matched to the cell over 60K cells, which validates `M`, `M⁻¹` and both
region uploads at once. Then export the regions (`ds.export.to_geojson`) and compare with
the source file vertex-for-vertex (max diff 0.0 on the H&E dataset).
