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

End-to-end runbook for getting a **10x Xenium** (Prime 5K or earlier) output bundle into
NimbusImage as images + cell polygons + per-cell data. Worked example: FFPE Human Lymph
Node, 708,983 cells, 4,624 genes, 0.2125 µm/px. Every step below was measured on it.

Scripts live in `scripts/` next to this file and share `scripts/xenium_common.py`. They
read credentials from the environment only:

```bash
export NI_API_URL=http://localhost:8080/api/v1
export NI_API_KEY=...            # or NI_USERNAME + NI_PASSWORD; never commit a key
pip install nimbusimage numpy zarr numcodecs tifffile   # + scipy scikit-learn umap-learn for UMAP
```

## 0. The whole pipeline

```bash
S=/path/to/plugins/nimbusimage/skills/xenium-ingest/scripts
# 1. URLs are JS-rendered on the 10x page — grep the HTML
curl -sL "<dataset-page-url>" | grep -oE 'https://cf\.10xgenomics\.com[^"]*' | sort -u
# 2. Download: the bundle (~8.5 GB), the standalone H&E, its alignment, the cell types
curl -sL -C - --retry 5 -o outs.zip "<prefix>_xe_outs.zip"
curl -sL -C - --retry 5 -o he.ome.tif "<prefix>_he_image.ome.tif"
curl -sL -o he_align.csv "<prefix>_he_imagealignment.csv"
curl -sL -o cell_types.csv "<prefix>_cell_types.csv"
# 3. Extract only what is needed
unzip -o outs.zip 'morphology_focus/*' cells.zarr.zip cell_feature_matrix.zarr.zip \
      analysis.zarr.zip experiment.xenium -d extracted/
# 4. Load images through the NimbusImage UI (§2); note the dataset FOLDER ids (§4)
# 5. Polygons — validate a slice, then all; keep the returned ids
python $S/xenium_upload_polygons.py --bundle-dir extracted --dataset $MORPH --limit 5000 --tags xenium-test
python $S/xenium_upload_polygons.py --bundle-dir extracted --dataset $MORPH --delete-tag xenium-test --ids-out ids_morph.npy
python $S/xenium_upload_polygons.py --bundle-dir extracted --dataset $HE --alignment he_align.csv --ids-out ids_he.npy
# 6. UMAP (10x does not ship one) ~6 min for 709k cells
python $S/xenium_compute_umap.py --bundle-dir extracted --out umap/
# 7. Per-cell data as nested properties (marker panel, not the whole matrix)
python $S/xenium_upload_properties.py --bundle-dir extracted --dataset $MORPH --ids ids_morph.npy \
       --what genes,clusters,umap --genes-file panel.txt --umap umap/umap_xy.npy
# 8. Cell types as tags
python $S/xenium_upload_cell_types.py --bundle-dir extracted --cell-types cell_types.csv \
       --dataset $MORPH --ids ids_morph.npy
# 9. Whole matrix as a spatial table, and the molecules as an overlay (§7b, §7c)
python $S/xenium_build_spatial_store.py --bundle-dir extracted --dataset $MORPH --ids ids_morph.npy
python $S/xenium_register_transcripts.py --bundle-dir extracted --dataset $MORPH
```

Run every upload script with `--limit 2000` first and look at the result in the viewer.

## 1. Bundle anatomy

| File | Where | Contains |
|---|---|---|
| `_xe_outs.zip` | standalone (~8.5 GB) | everything below plus transcripts |
| `morphology_focus/morphology_focus_000{0..3}.ome.tif` | **in zip** | ONE logical 4-channel image (DAPI is channel 0) spread over 4 files |
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

Import the four `morphology_focus_*.ome.tif` files together through the NimbusImage UI;
they become one multi-source 4-frame image. Import the H&E OME-TIFF as a separate
dataset. The two are **not co-registered** — the H&E dataset needs the alignment matrix
for every overlay (§3).

## 3. Coordinates — the crux

NimbusImage annotation coordinates are **image pixels** (origin top-left, +y down).
Xenium vertices are **microns**. Divide by the *Xenium* `pixel_size` from
`experiment.xenium` — not by whatever pixel size NimbusImage reports (it may show 1.0).

- **Morphology**: `px = µm / pixel_size`, identity orientation.
- **H&E**: `he_px = M⁻¹ · [µm / pixel_size, 1]` where `M` is the csv. Sanity check: the
  2×2 block's magnitude equals `he_px_size / morph_px_size` (1.289 = 0.2738 / 0.2125
  here). `--alignment` in the scripts applies `M⁻¹` for you.

**Determine orientation empirically, never by eye.** Fetch a ~600 px thumbnail
(`GET item/{id}/tiles/region?width=600&...&encoding=PNG`), threshold it into a tissue
mask, build a cell-centroid density grid at the same resolution, and correlate the two
across identity / flips / rot180 / `M` vs `M⁻¹`. Margins are unambiguous (0.75 vs ≤0.55
for morphology; 0.88 vs 0.21 for `M⁻¹` vs `M`). Do this before uploading 700k polygons.

Pre-upload checklist: centroid px range ⊂ `[0, W] × [0, H]`; correlation winner has a
clear margin; a ~5k-cell slice with a distinct tag looks right in the viewer.

## 4. Dataset ids

The id in a `#/datasetView/<id>/view` URL is a **dataset_view**, not the folder the API
wants:

```python
view = client.girder.get(f"dataset_view/{view_id}")
folder_id = view["datasetId"]           # pass this as --dataset
```

## 5. Polygons (`xenium_upload_polygons.py`)

Uploads in `cell_index` order via `create_many` in batches of 5,000 — ~100 s for 709k
polygons. A per-annotation loop would be 709k requests; never do that. `--ids-out` saves
the server-assigned ids in `cell_index` order; keep that file, every later script wants
it. Upload is fast; viewer rendering at this scale is handled by NimbusImage's lazy
annotation loading. Nucleus polygons are `--polygon-set nucleus` (more nuclei than cells
is normal: multinucleate cells).

## 6. Per-cell data as nested properties (`xenium_upload_properties.py`)

A property value nests two levels: `values[propertyId][subKey]` is a scalar or a dict of
scalars. One property therefore carries a whole panel:

| Property | Sub-keys | Notes |
|---|---|---|
| `Gene Expression` | one per gene | **dense** (explicit zeros) so the UI can tell 0 from missing |
| `Clustering` | `graphclust`, `kmeans_2_clusters` … | 0 = unassigned |
| `UMAP` | `x`, `y` | from `xenium_compute_umap.py` |

**Choose a marker panel.** 4,624 genes × 709k cells is 3.28 billion dense values; a
31-gene panel is 22 M and uploads in ~60 s. Development panels omit canonical markers
(this one lacked CD3D, IL7R, NKG7, LYZ, ACTA2, …) — the script aborts on a missing
symbol; substitute rather than assume.

Properties are registered into the dataset's collections on creation
(`nimbusimage` ≥ 0.2.2); the script also calls `register()` for older packages.
Address a sub-value as `[propertyId, "MS4A1"]` for filters, plots, histograms, export.

## 7. Cell types as tags (`xenium_upload_cell_types.py`)

Cell types are categorical, property values are numeric, so each cell polygon becomes
`["cell", "<group>"]` through the bulk `PUT upenn_annotation/multiple` (~80 s for 709k).
Tags feed the tag filter, the Analysis panel's categorical axes, and the Selection
summary (Import/export menu → *Selection summary*: composition by tag plus property
statistics for the selection, the filtered set, or the whole dataset, exportable as CSV).
The csv `cell_id` (`aaaaadoa-1`) is decoded (`a..p` → nibbles, `-N` suffix) and matched
against the packed zarr `cell_id`; row order is not trusted. `--reset` undoes it.

## 7b. The full matrix as a spatial table (`xenium_build_spatial_store.py`)

The marker panel above is what the interactive machinery (filters, plots, colors) works
on. The **whole** matrix goes in as one file: an AnnData-layout zarr store, zipped,
uploaded into the dataset folder and registered with the `upenncontrast_spatial` plugin.

```bash
python $S/xenium_build_spatial_store.py --bundle-dir extracted --dataset $MORPH \
       --ids ids_morph.npy --cell-types cell_types.csv --umap umap/umap_xy.npy \
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

## 7c. Molecules as an overlay (`xenium_register_transcripts.py`)

`transcripts.zarr.zip` is registered **as shipped**: it is already a tile pyramid
(`grids/{level}/{gx},{gy}`, 250 µm × 2^level) with a per-gene 10 µm density grid. Upload is
the slow part (4.7 GB for the lymph node); registration only records the scale:

```bash
python $S/xenium_register_transcripts.py --bundle-dir extracted --dataset $MORPH
python $S/xenium_register_transcripts.py --bundle-dir extracted --dataset $HE \
       --alignment he_align.csv          # H&E: the inverse alignment as the transform
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

## 7e. Neighbourhoods and regions (`ds.spatial.compute_neighbourhood`, `region_summary`)

Selection summary → **Spatial statistics**: **Neighbourhood…** counts each cell's
neighbours by type within a radius (30 µm default; converted to pixels with the dataset's
scale) and shows the type-by-type enrichment matrix; the fractions become a
`Neighbourhood` measurement usable in filters, gates and color-by. **Regions…** takes a
tag you put on hand-drawn (or imported) polygons and tabulates the cells inside each:
composition by type and mean expression of picked genes. From Python:
`ds.spatial.compute_neighbourhood(radius_pixels=141)`, `ds.spatial.neighbourhood()`,
`ds.spatial.region_summary("region", features=["CD3E"])`.

## 8. Traps (each cost real time)

1. **`submit_values` does not overwrite.** Re-submitting an existing value is a silent
   no-op; cells without a value do get written, so a re-run leaves a half-old dataset.
   Use `--replace` (deletes the property's values for this dataset first).
2. **`cell_groups` indices are zero-padded.** Unassigned cells hold `0`, so cell 0 appears
   hundreds of times; naive decoding gives cell 0 the last cluster id of every grouping.
   A zero is genuine only as the first element of its block. `decode_cell_groups` does
   this right; guard any new CSR-style decode with `len(np.unique(ind)) == len(ind)`.
3. **`ds.properties.list()` is server-wide.** A dataset that never received values still
   "has" the property. Check `ds.collections.get_raw()["meta"]["propertyIds"]` and read
   one annotation's values.
4. **Verify the `cell_index → annotation_id` map.** `fetch_annotation_ids` compares
   every annotation's first vertex with the one recomputed from `cells.zarr` and aborts
   on any mismatch (push through `M⁻¹` on the H&E dataset via `--alignment`).
5. **Morphology is one image in four files**; never import file 0001–0003 as separate
   images. **H&E is a separate grid**; never assume co-registration.
6. **Categorical data are tags, not property values.**

## 9. Post-upload verification

```python
raw = ds.collections.get_raw()                               # dict or [dict]
assert prop_id in raw["meta"]["propertyIds"]                 # registered
hist = ds.properties.histogram(f"{prop_id}.CD3E", buckets=10)
assert sum(b["count"] for b in hist) == n_cells               # complete
ds.annotations.get(ann_id).tags                              # ["cell", "Memory B Cell"]
```

Spot-check several `cell_index` values against the zarr ground truth on both datasets.
