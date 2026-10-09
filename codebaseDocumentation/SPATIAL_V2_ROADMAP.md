# Spatial omics — V2 feature list

Candidate work for the next version of the spatial-transcriptomics feature
(SPATIAL_PLUGIN.md covers what V1 ships). Compiled 2026-09-26 from a survey of
what spatial-omics users ask for — GitHub issues on the comparable viewers
(Xenium Explorer, Vitessce, napari-spatialdata, TissUUmaps, Squidpy/SpatialData,
QuPath, Seurat), vendor documentation, and tool papers — plus gaps found while
ingesting new datasets.

**Evidence strength: moderate.** No single request has overwhelming demand (the
most-reacted feature requests on these repos carry 2–6 reactions); most of the
signal is indirect — vendor docs describing workarounds, papers naming the gap
they fill. Reddit, image.sc and Biostars were not readable during the survey.
Treat the ranking as judgment, not a vote count.

## Recommended next

| # | Feature | Why | Effort |
|---|---|---|---|
| 1 | **SpatialData / AnnData import and export** | One adapter (via `spatialdata-io`) opens Visium HD, CosMx and MERSCOPE, not only Xenium, and sends tags/annotations back to scanpy/Seurat users. Answers the most common complaint: being stuck in one tool. | M |
| 2 | **Multi-section / cohort analysis** | View several sections together with shared gene/colour settings; DE and composition across samples or conditions (responder vs non-responder). 10x's own KB says it has no built-in multi-sample workflow; the demand comes from the translational labs that buy Xenium. Reuses the existing DE and gating. Projects already group datasets. | L |
| 3 | **Cell typing and niche calling as workers** | Label transfer from an scRNA reference; spatial domains (BANKSY, CellCharter). Results feed tags, gating and DE — closes the code-free loop, NimbusImage's clearest edge. | M |
| 4 | **Figure export with legend and scale bar** | Asked for across viewers (TissUUmaps, QuPath; Xenium Explorer only added high-res export in 3.2). Cheap relative to the rest; snapshots exist, legends/overlays unconfirmed. | S–M |

## Also requested

| Feature | NimbusImage today | Effort |
|---|---|---|
| Assisted H&E / IF / serial-section registration (landmarks or automatic) — manual keypoints in Fiji are "labor-intensive" | Partial: overlays use 10x's alignment matrix; no registration UI | M |
| Import third-party segmentation (Baysor, Proseg, Cellpose) and QC it | Partial: edit-and-recompute exists; no direct importer | S–M |
| Expression gradients vs distance to a structure (tumour border, cortical depth) | Partial: region summaries only | S–M |
| Robustness to vendor format changes | Improved: XOA 4.0 channel naming handled (xenium-ingest) | ongoing |

## Already strengths (lead with these)

- Analysis from the viewer without code (gating, UMAP lasso, DE, neighbourhoods, region stats).
- Sharing without shipping the data (share links / embeds; Xenium Explorer is desktop-only and its shared views drop custom groups).
- Speed at scale (708,983 cells interactive).

## Gaps found while ingesting (2026-09-26)

- **Protein channels.** The 10x *Human Kidney Protein* bundle (XOA 4.0) carries protein quantification alongside genes; the ingest treats it only as extra image channels.
- **Cell types.** The 10x "tiny" bundles ship no `cell_types.csv`; typing them depends on item 3 above.
- **Sparse crops.** The tiny bundles sit on the full slide canvas (~3% tissue); a crop-to-tissue option at ingest would make them read better.
- **Default cell styling.** Untagged polygons draw with a 50%-opacity fill that hides the tissue on dense cells; a lighter default (outline only) for imported segmentations would help.

## Open decisions carried over

- **Anonymous heavy compute** (differential expression, region summaries) stays open on public datasets for now — see SPATIAL_PLUGIN.md "Open decisions / future work".
- **Per-client rate limiting** belongs at the proxy: CytoPixel/AWSDeploy#120. Afterwards the backend's raster geometry-build limiter (effectively one shared bucket behind HAProxy) can be removed.

## Sources

- [10x KB: integrating multiple Xenium samples](https://kb.10xgenomics.com/hc/en-us/articles/35468186410253-How-do-you-integrate-multiple-samples-for-Xenium-analysis)
- [squidpy #784 — comparisons between groups of samples](https://github.com/scverse/squidpy/issues/784)
- [MilliMap paper — viewers vs code-based analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC13174364/)
- [Vitessce #998 — image annotation read/write](https://github.com/vitessce/vitessce/issues/998)
- [spatialdata_xenium_explorer bridge](https://github.com/quentinblampey/spatialdata_xenium_explorer)
- [Seurat #9060 — Xenium format change broke ReadXenium](https://github.com/satijalab/seurat/issues/9060)
- [Proseg README](https://github.com/dcjones/proseg)
- [image.sc — Xenium segmentation into QuPath](https://forum.image.sc/t/import-cell-segmentation-from-xenium-to-qupath/107811)
- [TissUUmaps #3 — figure export](https://github.com/TissUUmaps/TissUUmaps/issues/3)
- [BANKSY, Nature Genetics](https://www.nature.com/articles/s41588-024-01664-3)
- [10x: H&E to Xenium DAPI registration with Fiji](https://www.10xgenomics.com/analysis-guides/he-to-xenium-dapi-image-registration-with-fiji)
