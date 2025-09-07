from bson import ObjectId
from girder.api import access
from girder.api.rest import Resource, filtermodel, loadmodel
from girder.api.describe import Description, autoDescribeRoute
from girder.constants import AccessType

from girder.models.folder import Folder

from upenncontrast_annotation.server.models.collection import \
    Collection as CollectionModel


class Collection(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "upenn_collection"

        self._collectionModel = CollectionModel()

        self.route("POST", (), self.create)
        self.route("GET", (":id",), self.get)
        self.route("GET", (), self.find)
        self.route('PUT', (':id', 'metadata'), self.setMetadata)
        # self.route("PUT", (":id",), self.update)
        self.route("DELETE", (":id",), self.delete)
        self.route('POST', ('by_folders',), self.findByFolders)

    @access.user
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

    @access.user
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
        query = {"folderId": ObjectId(folderId)}
        return self._collectionModel.findWithPermissions(
            query, offset, limit, sort=sort, user=self.getCurrentUser())

    @access.user
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

    @access.user
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

    @access.user
    @autoDescribeRoute(
        Description('Delete an item by ID.')
        .modelParam('id', model=CollectionModel, level=AccessType.WRITE)
        .errorResponse('ID was invalid.')
        .errorResponse('Write access was denied for the item.', 403)
    )
    def delete(self, upenn_collection):
        self._collectionModel.remove(upenn_collection)
        return {'message': 'Deleted collection %s.' % upenn_collection['name']}

    @access.user
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
        folderIds = body.get('folderIds')
        if not folderIds:
            raise ValueError("folderIds is required in the request body")
        query = {"folderId": {"$in": [ObjectId(x) for x in folderIds]}}
        return self._collectionModel.findWithPermissions(
            query, offset, limit, sort=sort, user=self.getCurrentUser())
