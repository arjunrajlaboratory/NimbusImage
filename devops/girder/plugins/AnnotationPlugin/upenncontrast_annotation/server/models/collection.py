"""
Object containing tools to annotate an image. It is tied to a dataset using a
DatasetView.

Some functions are taken directly from Girder's Item model

Contains the:
 - layer parameters
 - tools
 - propertyIds
 - snapshots
 - scales
 - compatibility values
"""

import datetime
import fastjsonschema

from girder.constants import AccessType
from girder.models.model_base import AccessControlledModel
from girder.models.item import Item
from girder.exceptions import ValidationException, GirderException

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel


class CollectionSchema:

    collectionSchema = {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "folderId": {"type": "objectId"},
            "creatorId": {"type": "objectId"},
            "baseParentType": {"type": "string"},
            "baseParentId": {"type": "objectId"},
            "created": {"type": "datetime"},
            "updated": {"type": "datetime"},
            "size": {"type": "integer"},
            "lowerName": {"type": "string"},
            "meta": {
                "type": "object",
                "properties": {
                    "subtype": {"type": "string"},
                    "compatibility": {"type": "object"},
                    "layers": {"type": "array"},
                    "tools": {"type": "array"},
                    "propertyIds": {"type": "array",
                                    "items": [{"type": "string"}]
                                    },
                    "snapshots": {
                        "type": "array",
                        "items": {}
                    },
                    "scales": {"type": "object"}
                },
                "required": [
                    "subtype",
                    "compatibility",
                    "layers",
                    "tools",
                    "propertyIds",
                    "snapshots",
                    "scales"
                ]
            },
        },
        "required": [
            "name",
            "description",
            "folderId",
            "creatorId",
            "baseParentType",
            "baseParentId",
            "created",
            "updated",
            "size",
            "meta",
            "lowerName"
        ]
    }


class Collection(ProxiedModel, AccessControlledModel):

    def __init__(self):
        super().__init__()

        self.schema = CollectionSchema.collectionSchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(CollectionSchema.collectionSchema)
    )

    def initialize(self):
        self.name = 'upenn_collection'
        self.ensureIndices(('folderId', 'name', 'lowerName',
                            ([('folderId', 1), ('name', 1)], {})))

        self.exposeFields(level=AccessType.READ, fields=(
            '_id', 'size', 'updated', 'description', 'created', 'meta',
            'creatorId', 'folderId', 'name', 'baseParentType', 'baseParentId',
            'copyOfItem'))

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)
        return document

    def createCollection(self, name, creator, folder, metadata, description='',
                         reuseExisting=False):
        if reuseExisting:
            raise NotImplementedError("reuseExisting is not implemented")
        now = datetime.datetime.utcnow()

        if not isinstance(creator, dict) or '_id' not in creator:
            # Internal error -- this shouldn't be called without a user.
            raise GirderException('Creator must be a user.',
                                  'girder.models.item.creator-not-user')

        return self.save({
            'name': Item()._validateString(name),
            'lowerName': Item()._validateString(name).lower(),
            'description': Item()._validateString(description),
            'folderId': folder['_id'],
            'parentCollection': "folder",
            'parentId': folder['_id'],
            'creatorId': creator['_id'],
            'baseParentType': "folder",
            'baseParentId': folder['_id'],
            'created': now,
            'updated': now,
            'size': 0,
            'meta': metadata,
            "access": {
                "groups": [],
                "users": [
                    {
                        "id": creator['_id'],
                        "level": 2,
                        "flags": []
                    }
                ]
            },
        })

    def setMetadata(self, collection, metadata, allowNull=False):
        if 'meta' not in collection:
            collection['meta'] = {}

        # Add new metadata to existing metadata
        collection['meta'].update(metadata.items())

        # Remove metadata fields that were set to null (use items in py3)
        if not allowNull:
            toDelete = [k for k, v in metadata.items() if v is None]
            for key in toDelete:
                del collection['meta'][key]

        self.validateKeys(collection['meta'])

        collection['updated'] = datetime.datetime.utcnow()

        # Validate and save the item
        return self.save(collection)

    def move(self, collection, folder):
        collection['folderId'] = folder['_id']
        collection['baseParentType'] = folder['baseParentType']
        collection['baseParentId'] = folder['baseParentId']
        return self.save(collection)
