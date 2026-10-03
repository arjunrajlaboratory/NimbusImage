UPennContrast Spatial Plugin
============================

Girder plugin for NimbusImage's spatial-transcriptomics support. A dataset
folder may hold one ``spatial.zarr.zip`` item: a zipped zarr store in AnnData
layout (counts as CSC and CSR, ``obs.annotation_id`` joining rows to the
dataset's cell annotations, ``var`` naming the features). This plugin registers
that item per dataset and serves it:

- ``GET /spatial/{datasetId}`` — registry + schema
- ``POST /spatial/{datasetId}/register`` / ``DELETE /spatial/{datasetId}``
- ``GET /spatial/{datasetId}/features`` — feature search
- ``GET /spatial/{datasetId}/column`` / ``row`` — one gene / one cell
- ``POST /spatial/{datasetId}/aggregate`` — mean and fraction expressing over
  the annotations matching a list-filter object (gates included)
- ``POST /spatial/{datasetId}/materialize`` — write a feature panel as dense
  sub-values of an annotation property

It depends on ``upenncontrast_annotation`` for models, validation helpers and
access control. Design record: ``codebaseDocumentation/SPATIAL_PLUGIN.md``.
