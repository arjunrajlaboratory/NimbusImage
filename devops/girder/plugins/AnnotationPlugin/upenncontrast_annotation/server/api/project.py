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
from girder.exceptions import RestException
from girder.models.folder import Folder
from girder.models.user import User

from upenncontrast_annotation.server.helpers.access_helpers import (
    fetchUserEmails
)
from upenncontrast_annotation.server.models.project import (
    Project as ProjectModel
)
from upenncontrast_annotation.server.models.collection import (
    Collection as CollectionModel
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

        # Sharing / access control
        self.route("POST", (":id", "share"), self.share)
        self.route(
            "POST", (":id", "set_public"), self.setPublic
        )
        self.route(
            "GET", (":id", "access"), self.getAccess
        )

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
        """Add dataset to project, then sync permissions."""
        result = self._projectModel.addDataset(
            project, dataset['_id']
        )
        self._projectModel.propagateAccessToDataset(
            project, dataset
        )
        self._projectModel.propagatePublicToDataset(
            project, dataset
        )
        return result

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
        """Add collection to project, then sync permissions."""
        result = self._projectModel.addCollection(
            project, collection['_id']
        )
        self._projectModel.propagateAccessToCollection(
            project, collection
        )
        self._projectModel.propagatePublicToCollection(
            project, collection
        )
        return result

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

    @access.user
    @autoDescribeRoute(
        Description('Share a project with another user.')
        .notes("""
            Grants or revokes access to the project AND
            all its contained resources (datasets,
            collections, dataset views).

            Set accessType to:
            - 0 (READ) for view-only access
            - 1 (WRITE) for edit access
            - -1 to remove user's access entirely
        """)
        .modelParam(
            'id', model=ProjectModel,
            level=AccessType.ADMIN,
            destName='project'
        )
        .param(
            'userMailOrUsername',
            'Email or username of the target user.',
            required=True
        )
        .param(
            'accessType',
            'Access level: -1 (remove), 0 (READ), '
            '1 (WRITE).',
            dataType='integer', required=True
        )
        .errorResponse()
        .errorResponse('Admin access denied.', 403)
    )
    def share(self, project, userMailOrUsername,
              accessType):
        accessType = AccessType().validate(accessType)

        targetUser = User().findOne(
            {"$or": [
                {"login": userMailOrUsername},
                {"email": userMailOrUsername},
            ]}
        )
        if not targetUser:
            raise RestException("badEmailOrUsername")

        self._projectModel.setUserAccess(
            project, targetUser, accessType, save=True
        )
        self._projectModel.propagateUserAccess(
            project, targetUser, accessType
        )

        return True

    @access.user
    @autoDescribeRoute(
        Description(
            'Get access list for a project.'
        )
        .notes("""
            Returns the current access list for a
            project, including users with their access
            levels and the public status.

            Requires ADMIN access to the project.
        """)
        .modelParam(
            'id', model=ProjectModel,
            level=AccessType.ADMIN,
            destName='project'
        )
        .errorResponse('ID was invalid.')
        .errorResponse(
            'Admin access was denied.', 403
        )
    )
    def getAccess(self, project):
        accessList = (
            self._projectModel.getFullAccessList(
                project
            )
        )

        userIds = [
            u['id']
            for u in accessList.get('users', [])
        ]
        userEmails = fetchUserEmails(userIds)

        return {
            'projectId': str(project['_id']),
            'public': project.get('public', False),
            'users': [
                {
                    'id': str(u['id']),
                    'login': u.get('login', ''),
                    'name': u.get('name', ''),
                    'email': userEmails.get(
                        u['id'], ''
                    ),
                    'level': u['level'],
                }
                for u in accessList.get('users', [])
            ],
            'groups': accessList.get('groups', []),
        }

    @access.user
    @autoDescribeRoute(
        Description(
            'Make a project and all its resources '
            'public or private.'
        )
        .notes("""
            Sets public READ access on:
            - The project itself
            - All datasets (folders) in the project
            - All collections in the project
            - All dataset views linking them
        """)
        .modelParam(
            'id', model=ProjectModel,
            level=AccessType.ADMIN,
            destName='project'
        )
        .param(
            'public',
            'True to make public, False to '
            'make private.',
            dataType='boolean', required=True
        )
        .errorResponse()
        .errorResponse('Admin access denied.', 403)
    )
    def setPublic(self, project, public):
        self._projectModel.setPublic(
            project, public, save=True
        )
        self._projectModel.propagatePublic(
            project, public
        )

        return {
            'projectId': str(project['_id']),
            'public': public,
        }
