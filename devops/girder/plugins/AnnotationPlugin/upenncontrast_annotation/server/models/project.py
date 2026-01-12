"""
Project model for organizing datasets and collections for export to Zenodo.

Projects are abstract database objects (not tied to file structure) that
reference datasets and collections. Think of them like Gmail labels -
flat, non-hierarchical organizational tags.
"""

import datetime
import fastjsonschema

from bson import ObjectId
from girder.constants import AccessType
from girder.models.item import Item
from girder.exceptions import ValidationException, GirderException

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel


class ProjectSchema:
    projectSchema = {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "creatorId": {"type": "objectId"},
            "created": {"type": "datetime"},
            "updated": {"type": "datetime"},
            "lowerName": {"type": "string"},
            "meta": {
                "type": "object",
                "properties": {
                    "datasets": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "datasetId": {"type": "objectId"},
                                "addedDate": {"type": "datetime"}
                            },
                            "required": ["datasetId", "addedDate"]
                        }
                    },
                    "collections": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "collectionId": {"type": "objectId"},
                                "addedDate": {"type": "datetime"}
                            },
                            "required": ["collectionId", "addedDate"]
                        }
                    },
                    "metadata": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "description": {"type": "string"},
                            "license": {"type": "string"},
                            "keywords": {
                                "type": "array",
                                "items": {"type": "string"}
                            }
                        }
                    },
                    "status": {
                        "type": "string",
                        "enum": ["draft", "exporting", "exported"]
                    }
                },
                "required": ["datasets", "collections", "metadata", "status"]
            },
        },
        "required": [
            "name",
            "description",
            "creatorId",
            "created",
            "updated",
            "lowerName",
            "meta"
        ]
    }


class Project(ProxiedModel):

    def __init__(self):
        super().__init__()
        self.schema = ProjectSchema.projectSchema

    jsonValidate = staticmethod(
        customJsonSchemaCompile(ProjectSchema.projectSchema)
    )

    def initialize(self):
        self.name = 'upenn_project'
        self.ensureIndices((
            'creatorId',
            'lowerName',
            'meta.datasets.datasetId',
            'meta.collections.collectionId',
            'meta.status',
            ([('creatorId', 1), ('lowerName', 1)], {})
        ))

        self.exposeFields(level=AccessType.READ, fields=(
            '_id', 'name', 'description', 'created', 'updated',
            'creatorId', 'meta', 'lowerName'
        ))

    def validate(self, document):
        try:
            self.jsonValidate(document)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)
        return document

    def createProject(self, name, creator, description=''):
        """Create a new empty project."""
        now = datetime.datetime.utcnow()

        if not isinstance(creator, dict) or '_id' not in creator:
            raise GirderException(
                'Creator must be a user.',
                'girder.models.project.creator-not-user'
            )

        return self.save({
            'name': Item()._validateString(name),
            'lowerName': Item()._validateString(name).lower(),
            'description': Item()._validateString(description),
            'creatorId': creator['_id'],
            'created': now,
            'updated': now,
            'meta': {
                'datasets': [],
                'collections': [],
                'metadata': {
                    'title': name,
                    'description': description,
                    'license': 'CC-BY-4.0',
                    'keywords': []
                },
                'status': 'draft'
            },
            'access': {
                'groups': [],
                'users': [
                    {
                        'id': creator['_id'],
                        'level': AccessType.ADMIN,
                        'flags': []
                    }
                ]
            },
        })

    def addDataset(self, project, datasetId):
        """Add a dataset to the project (check for duplicates)."""
        datasetId = (
            ObjectId(datasetId) if isinstance(datasetId, str) else datasetId
        )

        # Check if already in project
        existing_ids = {d['datasetId'] for d in project['meta']['datasets']}
        if datasetId in existing_ids:
            raise ValidationException('Dataset already in project')

        # Add dataset reference
        project['meta']['datasets'].append({
            'datasetId': datasetId,
            'addedDate': datetime.datetime.utcnow()
        })

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def removeDataset(self, project, datasetId):
        """Remove a dataset from the project."""
        datasetId = (
            ObjectId(datasetId) if isinstance(datasetId, str) else datasetId
        )

        # Filter out the dataset
        project['meta']['datasets'] = [
            d for d in project['meta']['datasets']
            if d['datasetId'] != datasetId
        ]

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def addCollection(self, project, collectionId):
        """Add a collection to the project (check for duplicates)."""
        collectionId = (
            ObjectId(collectionId) if isinstance(collectionId, str)
            else collectionId
        )

        # Check if already in project
        existing_ids = {
            c['collectionId'] for c in project['meta']['collections']
        }
        if collectionId in existing_ids:
            raise ValidationException('Collection already in project')

        # Add collection reference
        project['meta']['collections'].append({
            'collectionId': collectionId,
            'addedDate': datetime.datetime.utcnow()
        })

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def removeCollection(self, project, collectionId):
        """Remove a collection from the project."""
        collectionId = (
            ObjectId(collectionId) if isinstance(collectionId, str)
            else collectionId
        )

        # Filter out the collection
        project['meta']['collections'] = [
            c for c in project['meta']['collections']
            if c['collectionId'] != collectionId
        ]

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def updateFields(self, project, name=None, description=None):
        """Update project name/description."""
        changed = False

        if name is not None:
            project['name'] = Item()._validateString(name)
            project['lowerName'] = project['name'].lower()
            changed = True

        if description is not None:
            project['description'] = Item()._validateString(description)
            changed = True

        if not changed:
            return project

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def updateMetadata(self, project, metadata):
        """Update project publication metadata."""
        if 'meta' not in project:
            project['meta'] = {}
        if 'metadata' not in project['meta']:
            project['meta']['metadata'] = {}

        # Update metadata fields
        project['meta']['metadata'].update(metadata)

        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)

    def updateStatus(self, project, status):
        """Update project status."""
        valid_statuses = ['draft', 'exporting', 'exported']
        if status not in valid_statuses:
            raise ValidationException(
                f'Invalid status. Must be one of: {valid_statuses}'
            )

        project['meta']['status'] = status
        project['updated'] = datetime.datetime.utcnow()
        return self.save(project)
