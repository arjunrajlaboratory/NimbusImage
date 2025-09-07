# -*- coding: utf-8 -*-

"""Top-level package for UpennContrast Annotation Plugin."""

__author__ = """Adrien Boucaud"""
__email__ = "adrien.boucaud@kitware.com"
__version__ = "0.0.0"


from girder.plugin import GirderPlugin

from girder.constants import TokenScope
from girder.utility.model_importer import ModelImporter
from girder.api.v1.resource import allowedDeleteTypes, allowedSearchTypes

from . import system
from .server.models.annotation import Annotation as AnnotationModel
from .server.models.collection import Collection as CollectionModel
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

        # Define custom upload limit scopes
        TokenScope.UPLOAD_500MB = "nimbus.upload.limit.500mb"
        TokenScope.UPLOAD_1GB = "nimbus.upload.limit.1gb"
        TokenScope.UPLOAD_2GB = "nimbus.upload.limit.2gb"
        TokenScope.UPLOAD_5GB = "nimbus.upload.limit.5gb"
        TokenScope.UPLOAD_10GB = "nimbus.upload.limit.10gb"
        TokenScope.UPLOAD_20GB = "nimbus.upload.limit.20gb"
        TokenScope.UPLOAD_50GB = "nimbus.upload.limit.50gb"
        TokenScope.UPLOAD_100GB = "nimbus.upload.limit.100gb"
        TokenScope.UPLOAD_200GB = "nimbus.upload.limit.200gb"
        TokenScope.UPLOAD_500GB = "nimbus.upload.limit.500gb"
        TokenScope.UPLOAD_1TB = "nimbus.upload.limit.1tb"
        TokenScope.UPLOAD_2TB = "nimbus.upload.limit.2tb"

        # Register the custom scopes with the system
        TokenScope.describeScope(TokenScope.UPLOAD_500MB,
                                 name="Upload 500MB",
                                 description="Allows uploads up to 500MB")
        TokenScope.describeScope(TokenScope.UPLOAD_1GB,
                                 name="Upload 1GB",
                                 description="Allows uploads up to 1GB")
        TokenScope.describeScope(TokenScope.UPLOAD_2GB,
                                 name="Upload 2GB",
                                 description="Allows uploads up to 2GB")
        TokenScope.describeScope(TokenScope.UPLOAD_5GB,
                                 name="Upload 5GB",
                                 description="Allows uploads up to 5GB")
        TokenScope.describeScope(TokenScope.UPLOAD_10GB,
                                 name="Upload 10GB",
                                 description="Allows uploads up to 10GB")
        TokenScope.describeScope(TokenScope.UPLOAD_20GB,
                                 name="Upload 20GB",
                                 description="Allows uploads up to 20GB")
        TokenScope.describeScope(TokenScope.UPLOAD_50GB,
                                 name="Upload 50GB",
                                 description="Allows uploads up to 50GB")
        TokenScope.describeScope(TokenScope.UPLOAD_100GB,
                                 name="Upload 100GB",
                                 description="Allows uploads up to 100GB")
        TokenScope.describeScope(TokenScope.UPLOAD_200GB,
                                 name="Upload 200GB",
                                 description="Allows uploads up to 200GB")
        TokenScope.describeScope(TokenScope.UPLOAD_500GB,
                                 name="Upload 500GB",
                                 description="Allows uploads up to 500GB")
        TokenScope.describeScope(TokenScope.UPLOAD_1TB,
                                 name="Upload 1TB",
                                 description="Allows uploads up to 1TB")
        TokenScope.describeScope(TokenScope.UPLOAD_2TB,
                                 name="Upload 2TB",
                                 description="Allows uploads up to 2TB")

        # Laziliy do these imports as they can connect to the database
        from .server.api.annotation import Annotation
        from .server.api.connections import AnnotationConnection
        from .server.api.collection import Collection
        from .server.api.propertyValues import PropertyValues
        from .server.api.property import AnnotationProperty
        from .server.api.workerInterfaces import WorkerInterfaces
        from .server.api.workerPreviews import WorkerPreviews
        from .server.api.datasetView import DatasetView
        from .server.api.history import History
        from .server.api.user_assetstore import UserAssetstore
        from .server.api.user_colors import UserColors
        from .server.api.resource import CustomResource

        ModelImporter.registerModel(
            "upenn_annotation", AnnotationModel, "upenncontrast_annotation"
        )
        ModelImporter.registerModel(
            "upenn_collection", CollectionModel, "upenncontrast_annotation"
        )
        allowedDeleteTypes.add("upenn_collection")
        # Here we need to add the name of the plugin because the search code
        # in Girder will use it
        allowedSearchTypes.add("upenn_collection.upenncontrast_annotation")
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

        info["apiRoot"].resource = CustomResource()
        info["apiRoot"].upenn_annotation = Annotation()
        info["apiRoot"].upenn_collection = Collection()
        info["apiRoot"].annotation_connection = AnnotationConnection()
        info["apiRoot"].annotation_property_values = PropertyValues()
        info["apiRoot"].annotation_property = AnnotationProperty()
        info["apiRoot"].worker_interface = WorkerInterfaces()
        info["apiRoot"].worker_preview = WorkerPreviews()
        info["apiRoot"].dataset_view = DatasetView()
        info["apiRoot"].history = History()
        info["apiRoot"].user_assetstore = UserAssetstore()
        info["apiRoot"].user_colors = UserColors()
        system.addSystemEndpoints(info["apiRoot"])
