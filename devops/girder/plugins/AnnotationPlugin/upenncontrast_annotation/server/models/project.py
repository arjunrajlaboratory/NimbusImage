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
from girder.models.folder import Folder
from girder.models.user import User
from girder.exceptions import ValidationException, GirderException

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel
from ..models.datasetView import DatasetView as DatasetViewModel
from ..models.collection import Collection as CollectionModel


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
            'creatorId', 'meta', 'lowerName', 'public'
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

    def _gatherAllResources(self, project):
        """Bulk-load all resources referenced by a project.

        Returns a dict with keys:
        - datasets: list of Folder documents
        - collections: list of Collection documents
        - datasetViews: list of DatasetView documents
        """
        dataset_ids = [
            d['datasetId']
            for d in project['meta']['datasets']
        ]
        collection_ids = [
            c['collectionId']
            for c in project['meta']['collections']
        ]

        # Bulk load datasets (Folders)
        datasets = list(Folder().find(
            {'_id': {'$in': dataset_ids}}
        )) if dataset_ids else []

        # Bulk load directly-referenced collections
        collections_by_id = {}
        if collection_ids:
            for c in CollectionModel().find(
                {'_id': {'$in': collection_ids}}
            ):
                collections_by_id[c['_id']] = c

        # Find all DatasetViews linked to project
        # datasets or project collections
        or_clauses = []
        if dataset_ids:
            or_clauses.append(
                {'datasetId': {'$in': dataset_ids}}
            )
        if collection_ids:
            or_clauses.append(
                {'configurationId': {'$in': collection_ids}}
            )

        dataset_views = []
        if or_clauses:
            dataset_views = list(DatasetViewModel().find(
                {'$or': or_clauses}
            ))
            # Bulk load extra configs from views not
            # already in the project's collection list
            extra_ids = {
                dv['configurationId']
                for dv in dataset_views
                if dv['configurationId']
                not in collections_by_id
            }
            if extra_ids:
                for c in CollectionModel().find(
                    {'_id': {'$in': list(extra_ids)}}
                ):
                    collections_by_id[c['_id']] = c

        return {
            'datasets': datasets,
            'collections': list(
                collections_by_id.values()
            ),
            'datasetViews': dataset_views,
        }

    def _bulkSetUserAccess(
        self, doc_ids, model, user_id, level
    ):
        """Set a single user's access on multiple docs.

        Uses two bulk MongoDB ops ($pull + $push) instead
        of N individual setUserAccess calls.

        :param doc_ids: List of document ObjectIds.
        :param model: The Girder model instance.
        :param user_id: The user's ObjectId.
        :param level: AccessType level, or -1 to remove.
        """
        if not doc_ids:
            return
        query = {'_id': {'$in': list(doc_ids)}}
        model.update(
            query,
            {'$pull': {
                'access.users': {'id': user_id}
            }}
        )
        if level is not None and level >= 0:
            model.update(
                query,
                {'$push': {'access.users': {
                    'id': user_id,
                    'level': level,
                    'flags': []
                }}}
            )

    def _bulkSetPublic(self, doc_ids, model, public):
        """Set public flag on multiple documents.

        Uses a single updateMany instead of N individual
        setPublic calls.

        :param doc_ids: List of document ObjectIds.
        :param model: The Girder model instance.
        :param public: Boolean, True to make public.
        """
        if not doc_ids:
            return
        model.update(
            {'_id': {'$in': list(doc_ids)}},
            {'$set': {'public': public}}
        )

    def _bulkSetAllUsersAccess(
        self, doc_ids, model, project
    ):
        """Apply project's full user ACL to multiple docs.

        Bulk-validates that users exist, then uses two
        bulk MongoDB ops ($pull + $push with $each).

        :param doc_ids: List of document ObjectIds.
        :param model: The Girder model instance.
        :param project: The project document.
        """
        if not doc_ids:
            return
        project_users = project.get(
            'access', {}
        ).get('users', [])
        if not project_users:
            return
        # Bulk validate users exist
        user_ids = [u['id'] for u in project_users]
        valid_ids = {
            u['_id'] for u in User().find(
                {'_id': {'$in': user_ids}},
                fields=['_id']
            )
        }
        entries = [
            {
                'id': u['id'],
                'level': u['level'],
                'flags': u.get('flags', [])
            }
            for u in project_users
            if u['id'] in valid_ids
        ]
        if not entries:
            return
        query = {'_id': {'$in': list(doc_ids)}}
        valid_user_ids = [e['id'] for e in entries]
        model.update(
            query,
            {'$pull': {
                'access.users': {
                    'id': {'$in': valid_user_ids}
                }
            }}
        )
        model.update(
            query,
            {'$push': {
                'access.users': {'$each': entries}
            }}
        )

    def propagateUserAccess(
        self, project, targetUser, level
    ):
        """Propagate a single user's access level to all
        project resources.

        Uses bulk DB operations instead of per-document
        setUserAccess calls.

        :param project: The project document.
        :param targetUser: The Girder user document.
        :param level: AccessType level (0, 1, 2) or -1
                      to remove access.
        """
        resources = self._gatherAllResources(project)
        uid = targetUser['_id']
        ds_ids = [d['_id'] for d in resources['datasets']]
        coll_ids = [
            c['_id'] for c in resources['collections']
        ]
        dv_ids = [
            v['_id'] for v in resources['datasetViews']
        ]
        self._bulkSetUserAccess(
            ds_ids, Folder(), uid, level
        )
        self._bulkSetUserAccess(
            coll_ids, CollectionModel(), uid, level
        )
        self._bulkSetUserAccess(
            dv_ids, DatasetViewModel(), uid, level
        )

    def propagatePublic(self, project, public):
        """Set public/private on all project resources.

        Uses bulk DB operations instead of per-document
        setPublic calls.

        :param project: The project document.
        :param public: Boolean, True to make public.
        """
        resources = self._gatherAllResources(project)
        ds_ids = [d['_id'] for d in resources['datasets']]
        coll_ids = [
            c['_id'] for c in resources['collections']
        ]
        dv_ids = [
            v['_id'] for v in resources['datasetViews']
        ]
        self._bulkSetPublic(ds_ids, Folder(), public)
        self._bulkSetPublic(
            coll_ids, CollectionModel(), public
        )
        self._bulkSetPublic(
            dv_ids, DatasetViewModel(), public
        )

    def propagateAllUsersAccess(
        self, project, documents, model
    ):
        """Apply the project's full user access list to
        one or more documents of a given model.

        Uses bulk DB operations instead of per-user
        per-document setUserAccess calls.

        :param project: The project document.
        :param documents: List of documents to update
                          (or a single document).
        :param model: The Girder model instance.
        """
        if not isinstance(documents, list):
            documents = [documents]
        doc_ids = [d['_id'] for d in documents]
        self._bulkSetAllUsersAccess(
            doc_ids, model, project
        )

    def _gatherDatasetResources(self, dataset):
        """Load a dataset's associated views and configs.

        Returns (dataset_views, configs) where:
        - dataset_views: list of DatasetView documents
        - configs: list of Collection documents
        """
        dvModel = DatasetViewModel()
        dataset_views = list(dvModel.find(
            {'datasetId': dataset['_id']}
        ))
        config_ids = {
            dv['configurationId']
            for dv in dataset_views
        }
        configs = []
        if config_ids:
            collModel = CollectionModel()
            configs = list(collModel.find(
                {'_id': {'$in': list(config_ids)}}
            ))
        return dataset_views, configs

    def _gatherCollectionResources(self, collection):
        """Load a collection's associated views and
        datasets.

        Returns (dataset_views, datasets) where:
        - dataset_views: list of DatasetView documents
        - datasets: list of Folder documents
        """
        dvModel = DatasetViewModel()
        dataset_views = list(dvModel.find(
            {'configurationId': collection['_id']}
        ))
        dataset_ids = {
            dv['datasetId'] for dv in dataset_views
        }
        datasets = []
        if dataset_ids:
            datasets = list(Folder().find(
                {'_id': {'$in': list(dataset_ids)}}
            ))
        return dataset_views, datasets

    def propagateAccessToDataset(self, project, dataset):
        """Propagate project ACL to a dataset and its
        associated views/configs.

        :param project: The project document.
        :param dataset: The dataset (Folder) document.
        """
        dataset_views, configs = (
            self._gatherDatasetResources(dataset)
        )
        self.propagateAllUsersAccess(
            project, dataset, Folder()
        )
        self.propagateAllUsersAccess(
            project, dataset_views, DatasetViewModel()
        )
        self.propagateAllUsersAccess(
            project, configs, CollectionModel()
        )

    def propagateAccessToCollection(
        self, project, collection
    ):
        """Propagate project ACL to a collection and its
        associated views/datasets.

        :param project: The project document.
        :param collection: The Collection document.
        """
        dataset_views, datasets = (
            self._gatherCollectionResources(collection)
        )
        self.propagateAllUsersAccess(
            project, collection, CollectionModel()
        )
        self.propagateAllUsersAccess(
            project, dataset_views, DatasetViewModel()
        )
        self.propagateAllUsersAccess(
            project, datasets, Folder()
        )

    def propagatePublicToDataset(self, project, dataset):
        """Propagate project public flag to a dataset and
        its associated views/configs.

        Uses bulk DB operations instead of per-document
        setPublic calls.

        :param project: The project document.
        :param dataset: The dataset (Folder) document.
        """
        if not project.get('public', False):
            return

        dataset_views, configs = (
            self._gatherDatasetResources(dataset)
        )
        self._bulkSetPublic(
            [dataset['_id']], Folder(), True
        )
        dv_ids = [v['_id'] for v in dataset_views]
        self._bulkSetPublic(
            dv_ids, DatasetViewModel(), True
        )
        config_ids = [c['_id'] for c in configs]
        self._bulkSetPublic(
            config_ids, CollectionModel(), True
        )

    def propagatePublicToCollection(
        self, project, collection
    ):
        """Propagate project public flag to a collection
        and its associated views/datasets.

        Uses bulk DB operations instead of per-document
        setPublic calls.

        :param project: The project document.
        :param collection: The Collection document.
        """
        if not project.get('public', False):
            return

        dataset_views, datasets = (
            self._gatherCollectionResources(collection)
        )
        self._bulkSetPublic(
            [collection['_id']], CollectionModel(), True
        )
        dv_ids = [v['_id'] for v in dataset_views]
        self._bulkSetPublic(
            dv_ids, DatasetViewModel(), True
        )
        ds_ids = [d['_id'] for d in datasets]
        self._bulkSetPublic(
            ds_ids, Folder(), True
        )
