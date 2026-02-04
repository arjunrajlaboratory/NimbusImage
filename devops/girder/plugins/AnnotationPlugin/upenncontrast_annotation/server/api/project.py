"""
REST API endpoints for Project management.

Projects are abstract database objects for organizing datasets and collections
for export to Zenodo.

This module also implements project-based permission masking via project-scoped
endpoints. When accessing resources through these endpoints, users must have
appropriate permissions on BOTH the project AND the individual resource.
"""

from bson import ObjectId
from girder.api import access
from girder.api.rest import Resource, filtermodel, loadmodel
from girder.api.describe import Description, autoDescribeRoute
from girder.constants import AccessType
from girder.exceptions import AccessException

from girder.models.folder import Folder

from upenncontrast_annotation.server.models.project import (
    Project as ProjectModel
)
from upenncontrast_annotation.server.models.collection import (
    Collection as CollectionModel
)
from upenncontrast_annotation.server.models.annotation import (
    Annotation as AnnotationModel
)


class Project(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "project"

        self._projectModel = ProjectModel()

        # Basic CRUD
        self.route("POST", (), self.create)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route("PUT", (":id",), self.update)
        self.route("DELETE", (":id",), self.delete)

        # Dataset management
        self.route("POST", (":id", "dataset"), self.addDataset)
        self.route(
            "DELETE", (":id", "dataset", ":datasetId"), self.removeDataset
        )

        # Collection management
        self.route("POST", (":id", "collection"), self.addCollection)
        self.route(
            "DELETE", (":id", "collection", ":collectionId"),
            self.removeCollection
        )

        # Metadata management
        self.route("PUT", (":id", "metadata"), self.updateMetadata)
        self.route("PUT", (":id", "status"), self.updateStatus)

        # Project-scoped resource access (permission masking)
        self.route("GET", (":id", "datasets"), self.listProjectDatasets)
        self.route("GET", (":id", "collections"), self.listProjectCollections)
        self.route(
            "GET", (":id", "dataset", ":datasetId", "annotations"),
            self.getProjectDatasetAnnotations
        )

        # Access management
        self.route("GET", (":id", "access"), self.getAccess)
        self.route("PUT", (":id", "access"), self.setAccess)
        self.route("PUT", (":id", "public"), self.setPublic)

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Create a new project.')
        .responseClass('Project')
        .param('name', 'Name for the project.', required=True, strip=True)
        .param('description', 'Description for the project.',
               required=False, default='', strip=True)
        .errorResponse()
    )
    def create(self, name, description):
        user = self.getCurrentUser()
        return self._projectModel.createProject(name, user, description)

    @access.public
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Get a project by ID.')
        .param("id", "The project's id", paramType="path")
        .responseClass('Project')
        .errorResponse('ID was invalid.')
        .errorResponse('Read access was denied for the project.', 403)
    )
    @loadmodel(
        model="upenn_project",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, upenn_project):
        return upenn_project

    @access.public
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('List projects.')
        .notes('Lists all projects the user has access to.')
        .responseClass('Project', array=True)
        .param('creatorId', 'Filter by creator user ID.', required=False)
        .param('status', 'Filter by status (draft/exporting/exported).',
               required=False)
        .pagingParams(defaultSort='lowerName')
        .errorResponse()
    )
    def find(self, creatorId, status, limit, offset, sort):
        user = self.getCurrentUser()
        query = {}

        if creatorId:
            query['creatorId'] = ObjectId(creatorId)
        if status:
            query['meta.status'] = status

        return self._projectModel.findWithPermissions(
            query, offset=offset, limit=limit, sort=sort, user=user
        )

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Update project name/description.')
        .responseClass('Project')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE)
        .param('name', 'New name for the project.', required=False, strip=True)
        .param('description', 'New description for the project.',
               required=False, strip=True)
    )
    def update(self, upenn_project, name, description):
        return self._projectModel.updateFields(
            upenn_project, name, description
        )

    @access.user
    @autoDescribeRoute(
        Description('Delete a project by ID.')
        .modelParam('id', model=ProjectModel, level=AccessType.ADMIN)
        .errorResponse('ID was invalid.')
        .errorResponse('Admin access was denied for the project.', 403)
    )
    def delete(self, upenn_project):
        self._projectModel.remove(upenn_project)
        return {'message': f"Deleted project {upenn_project['name']}"}

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Add a dataset to a project.')
        .notes('Requires WRITE access on both project and dataset.')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE,
                    destName='project')
        .modelParam('datasetId', model=Folder, level=AccessType.WRITE,
                    destName='dataset', paramType='formData')
        .errorResponse()
        .errorResponse('Write access denied.', 403)
    )
    def addDataset(self, project, dataset):
        """Add dataset to project (WRITE permission enforced on both)."""
        return self._projectModel.addDataset(project, dataset['_id'])

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Remove a dataset from a project.')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE,
                    destName='project')
        .param('datasetId', 'Dataset ID to remove.', paramType='path')
        .errorResponse()
    )
    def removeDataset(self, project, datasetId):
        return self._projectModel.removeDataset(project, datasetId)

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Add a collection to a project.')
        .notes('Requires WRITE access on both project and collection.')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE,
                    destName='project')
        .modelParam('collectionId', model=CollectionModel,
                    level=AccessType.WRITE, destName='collection',
                    paramType='formData')
        .errorResponse()
        .errorResponse('Write access denied.', 403)
    )
    def addCollection(self, project, collection):
        """Add collection to project (WRITE permission enforced on both)."""
        return self._projectModel.addCollection(project, collection['_id'])

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Remove a collection from a project.')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE,
                    destName='project')
        .param('collectionId', 'Collection ID to remove.', paramType='path')
        .errorResponse()
    )
    def removeCollection(self, project, collectionId):
        return self._projectModel.removeCollection(project, collectionId)

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Update project publication metadata.')
        .responseClass('Project')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE)
        .jsonParam('metadata',
                   'A JSON object containing the metadata fields to update',
                   paramType='body', requireObject=True)
        .errorResponse()
        .errorResponse('Write access was denied for the project.', 403)
    )
    def updateMetadata(self, upenn_project, metadata):
        return self._projectModel.updateMetadata(upenn_project, metadata)

    @access.user
    @filtermodel(model=ProjectModel)
    @autoDescribeRoute(
        Description('Update project status.')
        .responseClass('Project')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE)
        .param('status', 'New status (draft/exporting/exported).',
               required=True)
        .errorResponse()
        .errorResponse('Write access was denied for the project.', 403)
    )
    def updateStatus(self, upenn_project, status):
        return self._projectModel.updateStatus(upenn_project, status)

    # =========================================================================
    # Project-scoped resource access endpoints (permission masking)
    # =========================================================================

    @access.public
    @autoDescribeRoute(
        Description('List datasets in a project with permission masking.')
        .notes('''
            Returns datasets that the user can access within this project.
            Access requires READ permission on BOTH the project AND each
            individual dataset. This implements permission masking where
            project permissions act as an additional layer on top of
            dataset permissions.
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.READ,
                    destName='project')
        .pagingParams(defaultSort='lowerName')
        .errorResponse()
        .errorResponse('Read access was denied for the project.', 403)
    )
    def listProjectDatasets(self, project, limit, offset, sort):
        """
        List datasets in a project with permission masking.

        Only returns datasets where the user has READ access to both
        the project (already verified by modelParam) and the dataset.
        """
        user = self.getCurrentUser()
        dataset_ids = [
            d['datasetId'] for d in project['meta'].get('datasets', [])
        ]

        if not dataset_ids:
            return []

        # Use findWithPermissions to automatically filter by dataset ACL
        # This ensures user has READ access on each dataset
        cursor = Folder().findWithPermissions(
            {'_id': {'$in': dataset_ids}},
            user=user,
            level=AccessType.READ,
            limit=limit,
            offset=offset,
            sort=sort
        )
        return list(cursor)

    @access.public
    @autoDescribeRoute(
        Description('List collections in a project with permission masking.')
        .notes('''
            Returns collections that the user can access within this project.
            Access requires READ permission on BOTH the project AND each
            individual collection.
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.READ,
                    destName='project')
        .pagingParams(defaultSort='lowerName')
        .errorResponse()
        .errorResponse('Read access was denied for the project.', 403)
    )
    def listProjectCollections(self, project, limit, offset, sort):
        """
        List collections in a project with permission masking.

        Only returns collections where the user has READ access to both
        the project (already verified by modelParam) and the collection.
        """
        user = self.getCurrentUser()
        collection_model = CollectionModel()
        collection_ids = [
            c['collectionId'] for c in project['meta'].get('collections', [])
        ]

        if not collection_ids:
            return []

        # Use findWithPermissions to filter by collection ACL
        cursor = collection_model.findWithPermissions(
            {'_id': {'$in': collection_ids}},
            user=user,
            level=AccessType.READ,
            limit=limit,
            offset=offset,
            sort=sort
        )
        return list(cursor)

    @access.public
    @autoDescribeRoute(
        Description('Get annotations for a dataset within project context.')
        .notes('''
            Access is granted only if user has READ access to BOTH:
            - The project
            - The dataset (within the project)

            This enforces permission masking - even if a user has direct
            dataset access, they can only see annotations here if they
            also have project access.
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.READ,
                    destName='project')
        .param('datasetId', 'The dataset ID', paramType='path')
        .param('shape', 'Filter annotations by shape', required=False)
        .jsonParam(
            'tags',
            'Filter annotations by tags',
            required=False,
            requireArray=True,
        )
        .pagingParams(defaultSort='_id')
        .errorResponse()
        .errorResponse('Access denied.', 403)
    )
    def getProjectDatasetAnnotations(self, project, datasetId, shape, tags,
                                     limit, offset, sort):
        """Get annotations with project permission masking."""
        user = self.getCurrentUser()
        dataset_id_obj = ObjectId(datasetId)

        # Verify dataset is in project
        dataset_in_project = any(
            d['datasetId'] == dataset_id_obj
            for d in project['meta'].get('datasets', [])
        )
        if not dataset_in_project:
            raise AccessException(
                f'Dataset {datasetId} is not part of this project'
            )

        # Check dataset permissions (masking - both must pass)
        # User must also have READ on the dataset itself
        Folder().load(
            dataset_id_obj, user=user, level=AccessType.READ, exc=True
        )

        # Build query for annotations
        query = {'datasetId': dataset_id_obj}
        if shape is not None:
            query['shape'] = shape
        if tags is not None and len(tags) > 0:
            query['tags'] = {'$all': tags}

        # Fetch annotations
        annotation_model = AnnotationModel()
        cursor = annotation_model.find(
            query,
            limit=limit,
            offset=offset,
            sort=sort
        )
        return list(cursor)

    # =========================================================================
    # Access management endpoints
    # =========================================================================

    @access.user
    @autoDescribeRoute(
        Description('Get the access control list for a project.')
        .notes('''
            Returns the full access list including users and groups that
            have been granted access to this project.
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.ADMIN,
                    destName='project')
        .errorResponse()
        .errorResponse('Admin access was denied for the project.', 403)
    )
    def getAccess(self, project):
        """Get the full access list for a project."""
        return self._projectModel.getFullAccessList(project)

    @access.user
    @autoDescribeRoute(
        Description('Set access permissions for a project.')
        .notes('''
            Set the access control list for a project. This controls who
            can access resources THROUGH this project (permission masking).

            Note: This does NOT affect underlying dataset/collection
            permissions. Users must still have appropriate permissions
            on individual resources to access them through the project.
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.ADMIN,
                    destName='project')
        .jsonParam('access', 'The access control list as JSON.',
                   paramType='body', requireObject=True)
        .param('publicFlags', 'JSON list of public access flags.',
               required=False)
        .param('public', 'Whether the project should be public.',
               dataType='boolean', required=False)
        .errorResponse()
        .errorResponse('Admin access was denied for the project.', 403)
    )
    def setAccess(self, project, access, publicFlags, public):
        """
        Set the access list for a project.

        This only affects project-level permissions. The underlying
        dataset/collection permissions remain unchanged.
        """
        return self._projectModel.setAccessList(
            project, access, save=True, publicFlags=publicFlags,
            setPublic=(public if public is not None else None)
        )

    @access.user
    @autoDescribeRoute(
        Description('Set whether a project is publicly visible.')
        .notes('''
            Make a project public or private. When public, anyone can
            see the project and access resources through it (subject to
            individual resource permissions).
        ''')
        .modelParam('id', model=ProjectModel, level=AccessType.ADMIN,
                    destName='project')
        .param('public', 'Whether the project should be public.',
               dataType='boolean', required=True)
        .errorResponse()
        .errorResponse('Admin access was denied for the project.', 403)
    )
    def setPublic(self, project, public):
        """Set project public visibility."""
        return self._projectModel.setPublic(project, public, save=True)
