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
        # Girder converts limit/offset to ints (a clean 400 on garbage) but
        # passes negatives straight through: a negative offset makes PyMongo
        # raise, and a negative limit would silently truncate the slice below.
        # limit=0 means "unlimited" to Girder's paging params, so clamp that
        # to the ceiling rather than honoring it — an unauthenticated caller
        # must not be able to ask for every collection in one response.
        offset = max(0, offset)
        limit = min(
            max(1, limit or MAX_COLLECTION_LIST_LIMIT),
            MAX_COLLECTION_LIST_LIMIT,
        )
        # Only the returned fields may be sorted on. Anything else lets a
        # public caller sort the whole collection on an unindexed key (or on
        # the large 'meta' document) and pay for a blocking sort.
        for field, _direction in sort or []:
            if field not in COLLECTION_SUMMARY_FIELDS:
                raise RestException(
                    'sort must be one of: %s'
                    % ', '.join(COLLECTION_SUMMARY_FIELDS), code=400)
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
        query = {'folderId': {
            '$in': [requireObjectId(x, 'folderIds') for x in folderIds]
        }}
        return self._collectionModel.findWithPermissions(
            query, max(0, offset), limit, sort=sort,
            user=self.getCurrentUser())
