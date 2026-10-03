# Spatial Transcriptomics (10x Xenium and similar)

NimbusImage can hold a whole spatial-transcriptomics run: the tissue images, every segmented cell, the full gene-expression table, and the individual molecules. This topic explains what you get and how to explore it in the web interface.

## Getting Xenium Data In
Loading a Xenium output bundle is done with the **xenium-ingest** scripts, usually by a server admin or by an AI assistant such as Claude Code, not through the upload page. Ask whoever runs your server to ingest the bundle. Afterwards you typically have:

**Two datasets**:
- A **morphology dataset** with the fluorescence stains, channels named by stain (e.g. `c00-DAPI`). Protein bundles (Xenium Onboard Analysis 4 "Protein") can have ~35 channels
- A separate **H&E dataset**. H&E is imaged on its own pixel grid, so it is *not* co-registered with the morphology image; the ingest uses 10x's alignment matrix to place cells, regions and molecules correctly on it

**On each dataset**:
- **Cell polygons**, one object per segmented cell
- **Measurements** such as `Gene Expression` (a marker panel), `Clustering` (e.g. `graphclust`) and `UMAP` (`x`, `y`)
- **Cell types as tags**: each cell is tagged `cell` plus its type (e.g. `Memory B Cell`)
- A **spatial expression table** with *every* gene for every cell. On protein bundles, antibody targets appear as `<name> (protein)` (e.g. `CD4 (protein)`) so they don't collide with the gene of the same name
- A **transcripts overlay** of the individual molecules
- Optionally, **pathology regions** as polygons tagged `region`

**Channels**: a new collection shows at most 6 channels as layers. Use **Add layer** in the Layers panel to show the rest.

## Looking at Molecules: the Transcripts Palette
On datasets with registered transcripts, a **Transcripts** button (hexagon-of-dots icon) appears in the palette toolbar.

1. Open **Transcripts** and turn on **Show transcripts**
2. Type in **Genes (up to 8)** to search and pick genes; each gets its own color, which you can change next to the gene name
3. Adjust **Quality ≥** (default 20, Xenium's own cut-off) and **Opacity**
4. Choose **Rendering**:
   - **Auto** — individual molecules as points when zoomed in, a density **Heat map** when zoomed out
   - **Points** or **Heat map** to force one
5. **Points on screen at most** caps how many molecules are drawn at once

**Things to know**:
- The status line under the controls says what is shown (number of molecules, or "Density heat map")
- Zoomed out, points are clustered and the quality threshold is only approximate; the heat map counts molecules of every quality. Zoom in for an exact threshold
- On the H&E dataset only points are available (no heat map)

**Clicking a molecule** shows its gene, position and quality. If it lies inside a drawn cell outline, **Go to cell** jumps to and selects that cell.

**Cell table → Recompute counts…**: after you redraw, add or delete cell outlines, the **Cell table** card in the same palette can rebuild the expression table from the molecules:
1. Click **Recompute counts…**
2. Enter a **Version label** and choose **Edited cells only** or **Every cell (full rebuild)**
3. Optionally set the quality threshold, restrict to **Only cells tagged …**, or tick **Also recompute PCA / UMAP / k-means**
4. Click **Recompute**

The previous table is kept: use the drop-down in the **Cell table** card to switch between table versions. The refresh button checks for new edits.

## Genes as Measurements
Every gene in the spatial table can be used like any other measurement.

1. Open the **Object Browser** and go to the **Measurements** tab
2. Click **Add genes** (DNA icon; only shown when the dataset has a spatial table)
3. Search and pick genes, then choose:
   - **Add as live columns** — read straight from the table, instantly; works in filters, plots, color-by, the object list and CSV export, but is not sortable
   - **Copy into a measurement** — stores each gene's count per cell under a **Measurement name**; sortable and exportable (a server job on large datasets)
   - **Gene-set score** — one value per cell, the **mean** or **sum** of the picked genes, with a **Score name**

Once added, genes appear in the Filters panel, the Analysis panel (scatter plots and gates; see the Analysis panel topic) and **Color by Property**.

## Selection Summary and Spatial Statistics
Open the **Import / export data** menu (up/down-arrows icon in the top bar) → **Selection summary**.

1. Choose **Objects to summarize**: all objects, **Filtered objects**, or selected objects
2. Read the **Composition by tag** table (count and % per cell type)
3. Optionally pick **Properties to summarize** for statistics
4. In **Expression**, pick genes to see **Mean count** and **% expressing**
5. **Download CSV** saves the summary

**Compare expression…** ranks every gene by how differently it is expressed in group A (the current filter) versus group B (**B: everything else** or **B: objects with any of these tags**), with a **Welch t-test** or **Wilcoxon (Mann-Whitney)**. Results can be saved with **Download CSV**.

**Spatial statistics → Neighborhood…**:
- Counts each cell's neighbors by type within a **Radius (µm)** (default 30) and shows a log₂ observed/expected enrichment matrix; **CSV** downloads it
- **Tags that are not types** (default `cell`) lists tags to ignore as types
- Each cell's neighbor fractions are saved as a `Neighborhood` measurement for filters, gates and color-by
- The radius needs the dataset's pixel size. It is filled in automatically from the spatial table when blank, including on the H&E dataset (via the alignment); the hint under the radius shows the conversion to image pixels

**Spatial statistics → Regions…** (**Region statistics**):
- Choose **Polygons with a tag** and enter the **Region tag** (e.g. `region`), or use selected polygons
- Optionally pick **Genes (mean per region)**, then click **Summarize**
- Each row shows the region, its number of cells (cells whose center lies inside) and their composition by type; **CSV** downloads the table

## Pathology Regions: GeoJSON Import and Export
Region layers from QuPath or 10x (`*_annotation.geojson`) can be imported as polygons.

1. Open **Import / export data** → **Import GeoJSON…**
2. Choose the `.geojson` or `.json` file and check the **Preview** (counts by shape and by class)
3. Pick the **Layer (sets the channel)**
4. Keep **Extra tag for every annotation** as `region` (the default); each feature's class name also becomes a tag
5. Click **Import N** (N is the number of objects)

**Coordinates** are read as this image's pixels with the origin at the top-left (QuPath's convention); objects are placed at the current XY/Z/time. A warning appears if coordinates fall outside the image, which usually means the file is in microns or belongs to the other image. Files drawn on the H&E image must be imported on the **H&E dataset**.

**Export GeoJSON** (same menu) downloads the selected objects, otherwise the filtered objects, otherwise all objects, as a `.geojson` file for QuPath and similar tools.

**Important — keep the `region` tag on regions, never on cells**: polygons tagged `region` are treated as regions, not cells, by Neighborhood, Regions… and Recompute counts. A region without that tag would be counted as a giant cell; a cell with it would be dropped from those analyses.

## Seeing Every Cell at Once
With hundreds of thousands of cells, the viewer normally draws only a subset at a time. For a full-tissue picture:

1. Open **Settings** (sliders icon) → **Advanced settings for large numbers of annotations**
2. Turn on **Annotation overview raster** (off by default)
3. Choose the **Overview style** (**Filled footprints** or **Centroid discs**) and the **Raster opacity**
4. **Vector switch** sets how far you must zoom in before the raster gives way to interactive outlines

The raster is display-only: zoom in past the switch to click and select cells. Smaller objects are painted over larger ones, so region polygons don't hide the cells inside them. The raster is hidden while layers are unrolled.

**Color cells by cluster or gene**: click the palette icon (**Color objects by a property value**) in the top bar or the Object list, or **More Actions → Color by Property…**:
- Pick the property (e.g. `Clustering / graphclust`, or a gene)
- For cluster ids choose **Categorical** — **Auto** may give integer clusters a continuous ramp
- **Apply** recolors *every* object in the dataset and cannot be undone; **Remove coloring** (in the same dialog) resets to layer colors
- A legend shows the mapping, with object counts per category

## Sharing a View
Dataset owners can share one collection's view without making the dataset public:

1. Click **Share** on the dataset page and select the collection to share
2. In **Share links**, add an optional **Label**, choose **Expires** (7, 30 or 90 days, or **Never**) and click **Create**
3. Copy the link (an embed link without the toolbar is also shown)

Anyone with the link can view, without signing in, but cannot edit, download files or export. Use **Revoke** to disable a link; deleting the dataset revokes all its links.

## Troubleshooting
- **Image area black right after an ingest finishes**: reload the page
- **Overlays misplaced on H&E**: H&E and morphology are separate images. Use the objects and regions that were ingested onto the dataset you are viewing; don't import morphology-pixel files onto the H&E dataset or vice versa
- **Distances or areas off by a constant factor**: check the pixel size. Click the scale bar in the viewer to open **Scale settings**; a pixel size typed by hand is never overwritten automatically
- **Region summary counts look wrong**: cells are counted by their center; make sure every region carries the region tag and no cell does; "No polygon carries that tag" means the tag is misspelled or missing
- **"unknown feature"**: that gene isn't in this dataset's spatial table (check the spelling, the `(protein)` suffix, or whether you switched datasets)
- **No Transcripts button or Add genes button**: this dataset has no registered transcripts or spatial table; ask your admin to run the ingest step

For scripted analysis, the `nimbusimage` Python package exposes the same features through `ds.spatial` (expression table, transcripts, neighborhoods, region summaries).
