"""Spatial-transcriptomics plugin for NimbusImage.

Stores one per-cell expression table per dataset (a zipped zarr store in
AnnData layout, an item in the dataset folder) and serves it: schema, feature
search, per-gene and per-cell reads, aggregation over a filtered set of
annotations, and materialization of a feature panel into an annotation
property. See ``codebaseDocumentation/SPATIAL_PLUGIN.md``.
"""

__version__ = "0.0.0"

from girder.plugin import GirderPlugin, getPlugin
from girder.utility.model_importer import ModelImporter

from .server.api.spatial import Spatial
from .server.models.registry import DatasetSpatial


class UPennContrastSpatialPlugin(GirderPlugin):
    DISPLAY_NAME = "UPennContrast Spatial Plugin"

    def load(self, info):
        # Everything here reads and writes through the annotation plugin's
        # models and validation helpers, so it must be loaded first.
        getPlugin("upenncontrast_annotation").load(info)
        ModelImporter.registerModel(
            "dataset_spatial", DatasetSpatial, plugin="upenncontrast_spatial"
        )
        info["apiRoot"].spatial = Spatial()
