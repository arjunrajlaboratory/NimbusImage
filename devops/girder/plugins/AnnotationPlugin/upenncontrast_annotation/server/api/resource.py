from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.v1.resource import Resource
from girder.constants import AccessType, TokenScope
from girder.exceptions import RestException
from girder.utility.model_importer import ModelImporter
from girder.utility.progress import ProgressContext

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
                ' user; each a list of ids. An optional "fields" list trims '
                'every returned document to those keys plus _id, so callers '
                'that only need e.g. names do not pull whole documents.'
            ),
            paramType='body',
            requireObject=True
        )
    )
    def batchResources(self, body):
        user = self.getCurrentUser()
        result = {}
        fields = self._batchProjection(body.get('fields'))

        # Only allow known types
        allowed = ('folder', 'item', 'upenn_collection', 'user')
        for kind in allowed:
            ids = body.get(kind)
            if not ids:
                continue
            requireList(ids, kind)
            model = self._getResourceModel(kind)

            # Use bulk aggregation query instead of individual loads
            # This is much more efficient than loading each document
            # individually.
            docs = model.findWithPermissions(
                query={"_id": {"$in": [
                    requireObjectId(x, kind) for x in ids
                ]}},
                user=user,
                level=AccessType.READ,
                fields=self._queryFields(fields),
            )

            # Build the mapping from the bulk query results.
            # model.filter() is what @filtermodel would apply: it drops every
            # key the model does not expose at the caller's access level.
            # Returning the raw documents leaked 'access' (who holds which
            # permission) for folders and, for the user type, 'salt' -- the
            # bcrypt password hash -- plus 'email', to any signed-in caller.
            mapping = {}
            for doc in docs:
                mapping[str(doc['_id'])] = self._project(
                    model.filter(doc, user), fields)

            result[kind] = mapping

        return result

    def _queryFields(self, fields):
        """Widen a response projection to what access filtering needs.

        `model.filter()` calls `getAccessLevel(doc, user)`, which reads the
        document's own 'access' and 'public'. Projecting those away would make
        every document look unreadable and silently strip fields the caller is
        entitled to, so they are fetched and then dropped from the response by
        _project. Returns None (whole documents) when no projection was asked
        for.
        """
        if fields is None:
            return None
        return list(set(fields) | {'_id', 'access', 'public'})

    def _project(self, doc, fields):
        """Narrow a filtered document to the caller's requested fields."""
        if fields is None:
            return doc
        return {key: value for key, value in doc.items() if key in fields}

    def _batchProjection(self, fields):
        """Validate the optional `fields` list into a Mongo projection.

        Returns None (no projection, whole documents) when the caller omits it,
        so existing callers are unaffected. The keys build a projection, so
        they are caller input on a query shape: reject anything not a plain
        non-empty string, and reject '.' and '$' which would address a subpath
        or read as an operator. '_id' is always included -- the response is a
        map keyed by id, so it is not optional.
        """
        if fields is None:
            return None
        requireList(fields, 'fields')
        for field in fields:
            if (
                not isinstance(field, str)
                or not field
                or '.' in field
                or '$' in field
            ):
                raise RestException(
                    'fields must be a list of plain document keys', code=400)
        return list(set(fields) | {'_id'})
