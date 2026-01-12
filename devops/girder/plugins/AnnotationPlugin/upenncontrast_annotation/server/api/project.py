"""
REST API endpoints for Project management.

Projects are abstract database objects for organizing datasets and collections
for export to Zenodo.
"""

from bson import ObjectId
from girder.api import access
from girder.api.rest import Resource, filtermodel, loadmodel
from girder.api.describe import Description, autoDescribeRoute
from girder.constants import AccessType

from girder.models.folder import Folder

from upenncontrast_annotation.server.models.project import (
    Project as ProjectModel
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
        .notes('Requires WRITE access on the project.')
        .modelParam('id', model=ProjectModel, level=AccessType.WRITE,
                    destName='project')
        .param('collectionId', 'Collection ID to add.', paramType='formData')
        .errorResponse()
        .errorResponse('Write access denied.', 403)
    )
    def addCollection(self, project, collectionId):
        """Add collection to project."""
        return self._projectModel.addCollection(project, collectionId)

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
