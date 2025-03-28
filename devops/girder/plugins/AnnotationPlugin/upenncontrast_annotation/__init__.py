# -*- coding: utf-8 -*-

"""Top-level package for UpennContrast Annotation Plugin."""

__author__ = """Adrien Boucaud"""
__email__ = "adrien.boucaud@kitware.com"
__version__ = "0.0.0"


from girder.plugin import GirderPlugin

from girder.constants import TokenScope
from girder.utility.model_importer import ModelImporter

from . import system
from .server.models.annotation import Annotation as AnnotationModel
from .server.models.connections import AnnotationConnection as ConnectionModel
from .server.models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)
from .server.models.property import AnnotationProperty as PropertyModel
from .server.models.workerInterfaces import (
    WorkerInterfaceModel as InterfaceModel,
)
from .server.models.workerPreviews import WorkerPreviewModel as PreviewModel
from .server.models.datasetView import DatasetView as DatasetViewModel
from .server.models.history import History as HistoryModel
from .server.models.documentChange import DocumentChange as DocumentChangeModel


class UPennContrastAnnotationAPIPlugin(GirderPlugin):
    DISPLAY_NAME = "UPennContrast Annotation Plugin"

    def load(self, info):
        # Laziliy do these imports as they can connect to the database
        from .server.api.annotation import Annotation
        from .server.api.connections import AnnotationConnection
        from .server.api.propertyValues import PropertyValues
        from .server.api.property import AnnotationProperty
        from .server.api.workerInterfaces import WorkerInterfaces
        from .server.api.workerPreviews import WorkerPreviews
        from .server.api.datasetView import DatasetView
        from .server.api.history import History
        from .server.api.user_assetstore import UserAssetstore

        ModelImporter.registerModel(
            "upenn_annotation", AnnotationModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "annotation_connection",
            ConnectionModel,
            "upenncontrast_annotation",
        )
        ModelImporter.registerModel(
            "annotation_property_values",
            PropertyValuesModel,
            "upenncontrast_annotation",
        )
        ModelImporter.registerModel(
            "annotation_property", PropertyModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "worker_interface", InterfaceModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "worker_preview", PreviewModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "dataset_view", DatasetViewModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "history", HistoryModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "document_change", DocumentChangeModel, "upenncontrast_annotation"
        )

        info["apiRoot"].upenn_annotation = Annotation()
        info["apiRoot"].annotation_connection = AnnotationConnection()
        info["apiRoot"].annotation_property_values = PropertyValues()
        info["apiRoot"].annotation_property = AnnotationProperty()
        info["apiRoot"].worker_interface = WorkerInterfaces()
        info["apiRoot"].worker_preview = WorkerPreviews()
        info["apiRoot"].dataset_view = DatasetView()
        info["apiRoot"].history = History()
        info["apiRoot"].user_assetstore = UserAssetstore()
        system.addSystemEndpoints(info["apiRoot"])
