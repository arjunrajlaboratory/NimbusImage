from girder.api import access
from girder.api.rest import Resource, filtermodel, loadmodel
from girder.api.describe import Description, autoDescribeRoute
from girder.constants import AccessType, SortDir, TokenScope
from girder.exceptions import RestException

from girder.models.folder import Folder

from upenncontrast_annotation.server.helpers.validation import (
    requireCountWithin,
    requireList,
    requireObjectId,
)
from upenncontrast_annotation.server.models.collection import \
    Collection as CollectionModel

# Fields returned by the lightweight listing endpoint. A full collection
# document embeds "meta" (layers, tools, snapshots, property ids), which is
# far too heavy to ship for thousands of collections at once.
COLLECTION_SUMMARY_FIELDS = (
    '_id',
    'name',
    'description',
    'folderId',
    'creatorId',
    'created',
    'updated',
)

# Upper bound on the number of collections a single listing request returns.
# Clients page past this with the offset parameter.
MAX_COLLECTION_LIST_LIMIT = 10000

# Fields a caller may sort a listing on. Every entry is a small scalar and is
# either indexed or cheap; 'meta' is deliberately absent. 'lowerName' is not
# projected by the summary listing but is the default sort of by_folders.
COLLECTION_SORTABLE_FIELDS = COLLECTION_SUMMARY_FIELDS + ('lowerName',)


def clampCollectionPaging(limit, offset):
    """Land caller-supplied paging in a range that is safe to hand to Mongo.

    Girder coerces the paging params to ints (a clean 400 on garbage) but
    passes negatives through, and limit=0 is its "unlimited" sentinel. Both
    endpoints here are public and return documents, so an unclamped limit lets
    one request materialize everything the caller can read; a negative offset
    makes PyMongo raise. Clamping into [1, MAX] also keeps `limit + 1` (the
    read-one-extra trick /list uses for hasMore) from ever landing on 0 and
    silently becoming "unlimited".

    Reads the module constant at call time so tests can shrink the ceiling.
    """
    return (
        min(
            max(1, limit or MAX_COLLECTION_LIST_LIMIT),
            MAX_COLLECTION_LIST_LIMIT,
        ),
        max(0, offset),
    )


def withIdTieBreaker(sort):
    """Append `_id` to `sort` so the ordering is a total order.

    Both listing endpoints page with `offset`, which is only coherent if the
    sort is deterministic. Mongo stores datetimes at millisecond resolution, so
    collections created in one bulk operation routinely share `updated`; tied
    documents have no defined order, and a later page can then repeat a row
    from an earlier one or skip a row entirely with the data unchanged.

    `_id` is unique, so appending it makes the order total. It inherits the
    primary key's direction so ties read in the same direction as the column
    the user sorted on.
    """
    sort = list(sort or [])
    if any(field == '_id' for field, _direction in sort):
        return sort
    direction = sort[0][1] if sort else SortDir.DESCENDING
    return sort + [('_id', direction)]


def requireSortableFields(sort):
    """Reject sort keys outside the allowlist.

    Sort keys are caller input: pagingParams accepts any field name, so leaving
    it open lets a public caller force a blocking sort over every accessible
    document -- including on the large 'meta' subdocument. The indexes these
    endpoints rely on cover only their own default sorts.
    """
    for field, _direction in sort or []:
        if field not in COLLECTION_SORTABLE_FIELDS:
            raise RestException(
                'sort must be one of: %s'
                % ', '.join(COLLECTION_SORTABLE_FIELDS), code=400)
    return sort


class Collection(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "upenn_collection"

        self._collectionModel = CollectionModel()

        self.route("POST", (), self.create)
        self.route("GET", ("list",), self.listCollections)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route('PUT', (':id', 'metadata'), self.setMetadata)
        self.route("PUT", (":id",), self.update)
        self.route("DELETE", (":id",), self.delete)
        self.route('POST', ('by_folders',), self.findByFolders)

    @access.user(scope=TokenScope.DATA_WRITE)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('Create a new collection.')
        .responseClass('Collection')
        .modelParam('folderId', 'The ID of the parent folder.', model=Folder,
                    level=AccessType.WRITE, paramType='query')
        .param('name', 'Name for the collection.', strip=True)
        .param('description', 'Description for the collection.',
               required=False, default='', strip=True)
        .param('reuseExisting',
               'Return existing collection (by name) if it exists.',
               required=False, dataType='boolean', default=False)
        .jsonParam('metadata',
                   'A JSON object containing the metadata keys to add',
                   paramType='form', requireObject=True, required=False)
        .errorResponse()
        .errorResponse('Write access was denied on the parent folder.', 403)
    )
    def create(self, folder, name, description, reuseExisting, metadata):
        return self._collectionModel.createCollection(
            name, creator=self.getCurrentUser(), folder=folder,
            metadata=metadata, description=description,
            reuseExisting=reuseExisting)

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('List or search for collections.')
        .notes('Search for collections using a folder Id'
               'Searching using text is not supported.')
        .responseClass('Collection', array=True)
        .param('folderId', 'Pass this to list all collections in a folder.',
               required=False)
        .param('text', 'Unsupported',
               required=False)
        .param('name', 'Unsupported', required=False)
        .pagingParams(defaultSort='lowerName')
        .errorResponse()
        .errorResponse('Read access was denied on the parent folder.', 403)
    )
    def find(self, folderId, text, name, limit, offset, sort):
        if text:
            raise NotImplementedError(
                "Text search not implemented for collections")
        if not folderId:
            # ObjectId(None) mints a brand new id, so omitting folderId used
            # to silently match nothing. Fail loudly and point callers at the
            # endpoint that does support folder-less listing.
            raise RestException(
                'folderId is required. Use GET /upenn_collection/list to '
                'list collections across folders.', code=400)
        query = {"folderId": requireObjectId(folderId, 'folderId')}
        return self._collectionModel.findWithPermissions(
            query, offset, limit, sort=sort, user=self.getCurrentUser())

    @access.public(scope=TokenScope.DATA_READ)
    @autoDescribeRoute(
        Description('List collections without their metadata.')
        .notes(
            'Returns {"collections": [...], "hasMore": <bool>}. Each entry '
            'carries only its identifying fields, not the "meta" document, '
            'so large numbers of collections can be listed cheaply. Omit '
            'folderId to list every collection the user can read. At most '
            '%d collections come back per request; page with offset.'
            % MAX_COLLECTION_LIST_LIMIT
        )
        .param('folderId',
               'Restrict the listing to a single folder. Omit to list '
               'collections from every folder the user can read.',
               required=False)
        .pagingParams(defaultSort='updated',
                      defaultLimit=MAX_COLLECTION_LIST_LIMIT,
                      defaultSortDir=SortDir.DESCENDING)
        .errorResponse()
    )
    def listCollections(self, folderId, limit, offset, sort):
        query = (
            {'folderId': requireObjectId(folderId, 'folderId')}
            if folderId else {}
        )
        limit, offset = clampCollectionPaging(limit, offset)
        sort = withIdTieBreaker(requireSortableFields(sort))
        # Read one extra document to tell the client whether paging further
        # would yield anything, without paying for a separate count query.
        documents = list(self._collectionModel.findWithPermissions(
            query,
            offset=offset,
            limit=limit + 1,
            sort=sort,
            fields=COLLECTION_SUMMARY_FIELDS,
            user=self.getCurrentUser(),
        ))
        return {
            'collections': [
                {
                    field: document.get(field)
                    for field in COLLECTION_SUMMARY_FIELDS
                }
                for document in documents[:limit]
            ],
            'hasMore': len(documents) > limit,
        }

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('Get an collection by ID.')
        .param("id", "The collection's id", paramType="path")
        .responseClass('Collection')
        .errorResponse('ID was invalid.')
        .errorResponse('Read access was denied for the item.', 403)
    )
    @loadmodel(
        model="upenn_collection",
        plugin="upenncontrast_annotation",
        level=AccessType.READ,
    )
    def get(self, upenn_collection):
        return upenn_collection

    @access.user(scope=TokenScope.DATA_WRITE)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('Set metadata fields on an collection.')
        .responseClass('Collection')
        .notes('Set metadata fields to null in order to delete them.')
        .modelParam('id', model=CollectionModel, level=AccessType.WRITE)
        .jsonParam('metadata',
                   'A JSON object containing the metadata keys to add',
                   paramType='body', requireObject=True)
        .param('allowNull', 'Whether "null" is allowed as a metadata value.',
               required=False, dataType='boolean', default=False)
        .errorResponse(('ID was invalid.',
                        'Invalid JSON passed in request body.',
                        'Metadata key name was invalid.'))
        .errorResponse('Write access was denied for the collection.', 403)
    )
    def setMetadata(self, upenn_collection, metadata, allowNull):
        return self._collectionModel.setMetadata(
            upenn_collection, metadata, allowNull=allowNull)

    @access.user(scope=TokenScope.DATA_WRITE)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('Update collection name/description.')
        .responseClass('Collection')
        .modelParam('id', model=CollectionModel, level=AccessType.WRITE)
        .param(
            'name',
            'New name for the collection.',
            required=False,
            strip=True,
        )
        .param(
            'description',
            'New description for the collection.',
            required=False,
            strip=True,
        )
    )
    def update(self, upenn_collection, name, description):
        return self._collectionModel.updateFields(
            upenn_collection,
            name,
            description,
        )

    @access.user(scope=TokenScope.DATA_WRITE)
    @autoDescribeRoute(
        Description('Delete an item by ID.')
        .modelParam('id', model=CollectionModel, level=AccessType.WRITE)
        .errorResponse('ID was invalid.')
        .errorResponse('Write access was denied for the item.', 403)
    )
    def delete(self, upenn_collection):
        self._collectionModel.remove(upenn_collection)
        return {'message': 'Deleted collection %s.' % upenn_collection['name']}

    @access.public(scope=TokenScope.DATA_READ)
    @filtermodel(model=CollectionModel)
    @autoDescribeRoute(
        Description('List collections grouped by folder ids')
        .responseClass('Collection', array=True)
        .notes(
            'Returns a flat list with folderId on each collection. '
            'Use client-side grouping if needed.'
        )
        .jsonParam(
            'body',
            'Object with key "folderIds": array of folder ids',
            paramType='body',
            requireObject=True
        )
        .pagingParams(defaultSort='lowerName')
        .errorResponse()
    )
    def findByFolders(self, body, limit, offset, sort):
        # This endpoint is public, so every shape assumption has to produce a
        # 400 rather than an uncaught error: a bare ValueError, a string
        # folderIds (which would iterate per character) or a malformed id all
        # surfaced as a 500 before.
        folderIds = requireList(body.get('folderIds') or [], 'folderIds')
        if not folderIds:
            raise RestException(
                'folderIds is required in the request body', code=400)
        requireCountWithin(
            len(folderIds), MAX_COLLECTION_LIST_LIMIT, 'folderIds')
        # This endpoint returns WHOLE documents (meta included), so it needs
        # the same paging and sort guards as the lightweight /list -- more so,
        # since each row it serializes is far heavier.
        limit, offset = clampCollectionPaging(limit, offset)
        sort = withIdTieBreaker(requireSortableFields(sort))
        query = {'folderId': {
            '$in': [requireObjectId(x, 'folderIds') for x in folderIds]
        }}
        return self._collectionModel.findWithPermissions(
            query, offset, limit, sort=sort,
            user=self.getCurrentUser())
