from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.v1.resource import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.utility.model_importer import ModelImporter
from girder.utility.progress import ProgressContext

from ..helpers import validation
from ..helpers.validation import requireList, requireObjectId


class CustomResource(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = 'resource'
        # Batch resolve endpoint for multiple resource types
        self.route('POST', ('batch',), self.batchResources)

    def _getResourceModel(self, kind, funcName=None):
        """
        Override the function _getResourceModel from Girder`s Resource API to
        allow plugins from 'upenncontrast_annotation'.
        """
        try:
            model = ModelImporter.model(kind)
        except Exception:
            try:
                model = ModelImporter.model(kind, "upenncontrast_annotation")
            except Exception:
                model = None
        if not model or (funcName and not hasattr(model, funcName)):
            raise RestException('Invalid resources format.')
        return model

    def _prepareMoveOrCopy(self, resources, parentType, parentId):
        user = self.getCurrentUser()
        self._validateResourceSet(
            resources, ('folder', 'item', 'upenn_collection'))

        if resources.get('item') and parentType != 'folder':
            raise RestException('Invalid parentType.')
        return ModelImporter.model(parentType).load(
            parentId, level=AccessType.WRITE, user=user, exc=True)

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description('Move a set of items and folders.')
        .jsonParam('resources', 'A JSON-encoded set of resources to move. Each'
                   ' type is a list of ids.  Only folders and items may be '
                   'specified. For example: {"item": [(item id 1), (item id2)]'
                   ',"folder": [(folder id 1)]}.', requireObject=True)
        .param('parentType',
               'Parent type for the new parent of these resources.',
               enum=('user', 'collection', 'folder'))
        .param('parentId', 'Parent ID for the new parent of these resources.')
        .param('progress', 'Whether to record progress on this task.',
               required=False, default=False, dataType='boolean')
        .errorResponse('Unsupported or unknown resource type.')
        .errorResponse('Invalid resources format.')
        .errorResponse('Resource type not supported.')
        .errorResponse('No resources specified.')
        .errorResponse('Resource not found.')
        .errorResponse('ID was invalid.')
    )
    def moveResources(self, resources, parentType, parentId, progress):
        user = self.getCurrentUser()
        parent = self._prepareMoveOrCopy(resources, parentType, parentId)
        total = sum([len(resources[key]) for key in resources])
        with ProgressContext(
                progress, user=user, title='Moving resources',
                message='Calculating requirements...', total=total) as ctx:
            for kind in resources:
                model = self._getResourceModel(kind, 'move')
                for id in resources[kind]:
                    doc = model.load(
                        id=id, user=user, level=AccessType.WRITE, exc=True)
                    ctx.update(
                        message='Moving %s %s' % (kind, doc.get('name', '')))
                    if kind in ['item', 'upenn_collection']:
                        if parent['_id'] != doc['folderId']:
                            model.move(doc, parent)
                    elif kind == 'folder':
                        if ((parentType, parent['_id'])
                                != (doc['parentCollection'], doc['parentId'])):
                            model.move(doc, parent, parentType)
                    ctx.update(increment=1)

    @access.user(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('Batch resolve multiple resource documents by id')
        .notes(
            'Returns maps keyed by id for each requested type. '
            'Enforces READ access.'
        )
        .jsonParam(
            'body',
            description=(
                'Object with optional keys: folder, item, upenn_collection, '
                ' user; each a list of ids'
            ),
            paramType='body',
            requireObject=True
        )
    )
    def batchResources(self, body):
        user = self.getCurrentUser()

        # Only allow known types
        allowed = ('folder', 'item', 'upenn_collection', 'user')
        # A missing or null kind is not requested; any other value must be
        # a list (validated before an empty list is skipped).
        idsByKind = {
            kind: requireList(body[kind], kind)
            for kind in allowed if body.get(kind) is not None
        }
        idsByKind = {kind: ids for kind, ids in idsByKind.items() if ids}
        validation.requireCountWithin(
            sum(len(ids) for ids in idsByKind.values()),
            validation.MAX_BATCH_RESOURCE_IDS, 'Resource ids')
        objectIdsByKind = {
            kind: [requireObjectId(x, kind) for x in ids]
            for kind, ids in idsByKind.items()
        }

        result = {}
        for kind, objectIds in objectIdsByKind.items():
            model = self._getResourceModel(kind)

            # Use bulk aggregation query instead of individual loads
            # This is much more efficient than loading each document
            # individually
            docs = model.findWithPermissions(
                query={"_id": {"$in": objectIds}},
                user=user,
                level=AccessType.READ
            )

            # Filter each document to the fields the caller's access level
            # exposes, as GET <kind>/{id} does. Raw documents carry the ACL
            # (other users' and groups' ids) and, for users, the password
            # hash, email and OTP secret.
            result[kind] = {
                str(doc['_id']): model.filter(doc, user) for doc in docs
            }

        return result
