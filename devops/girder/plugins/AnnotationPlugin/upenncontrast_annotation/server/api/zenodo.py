"""
REST API endpoints for Zenodo publication workflow.

Provides endpoints to:
- Upload a project to Zenodo as a draft deposition
- Check upload status
- Publish (mint DOI) or discard a draft
"""

import datetime
import io
import logging
import threading

import orjson

from bson import ObjectId
from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.constants import AccessType
from girder.exceptions import RestException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.user import User

from ..helpers.serialization import orJsonDefaults
from ..helpers.zenodo_client import ZenodoClient, ZenodoError
from ..models.annotation import Annotation as AnnotationModel
from ..models.collection import Collection as CollectionModel
from ..models.connections import (
    AnnotationConnection as ConnectionModel,
)
from ..models.datasetView import DatasetView as DatasetViewModel
from ..models.project import Project as ProjectModel
from ..models.property import AnnotationProperty as PropertyModel
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)
from .zenodo_credentials import decrypt_token

log = logging.getLogger(__name__)

# License ID mapping from project metadata to Zenodo
LICENSE_MAP = {
    "CC-BY-4.0": "cc-by-4.0",
    "CC-BY-SA-4.0": "cc-by-sa-4.0",
    "CC-BY-NC-4.0": "cc-by-nc-4.0",
    "CC0-1.0": "cc-zero",
    "MIT": "mit-license",
    "Apache-2.0": "apache-2.0",
}

# 50 GB in bytes
MAX_ZENODO_SIZE = 50 * 1024 * 1024 * 1024
MAX_ZENODO_FILES = 100


class Zenodo(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "zenodo"

        self._projectModel = ProjectModel()
        self._annotationModel = AnnotationModel()
        self._connectionModel = ConnectionModel()
        self._propertyModel = PropertyModel()
        self._propertyValuesModel = PropertyValuesModel()
        self._collectionModel = CollectionModel()
        self._datasetViewModel = DatasetViewModel()

        self.route("POST", ("upload",), self.upload)
        self.route("GET", ("status", ":projectId"),
                   self.getStatus)
        self.route("POST", ("publish", ":projectId"),
                   self.publish)
        self.route("POST", ("discard", ":projectId"),
                   self.discard)

    def _getZenodoClient(self, user):
        """Get a ZenodoClient for the given user.

        Loads and decrypts the user's stored Zenodo token.
        Raises RestException if no token is configured.
        """
        fullUser = User().load(user['_id'], force=True)
        zenodo_meta = fullUser.get(
            'meta', {}
        ).get('zenodo', {})
        encrypted = zenodo_meta.get('encryptedToken')

        if not encrypted:
            raise RestException(
                "No Zenodo token configured. Please add "
                "your Zenodo API token in settings.",
                code=400,
            )

        token = decrypt_token(encrypted)
        if not token:
            raise RestException(
                "Failed to decrypt Zenodo token. The "
                "server encryption key may have changed.",
                code=500,
            )

        sandbox = zenodo_meta.get('sandbox', False)
        return ZenodoClient(token, sandbox=sandbox)

    def _gatherProjectFiles(self, project, user):
        """Gather all files that would be uploaded.

        Returns a list of dicts:
        [{"name": str, "size": int, "type": str,
          "datasetId"?: str, "collectionId"?: str}]

        Used for pre-flight size/count validation.
        """
        files = []

        # Dataset source files
        for d in project['meta']['datasets']:
            dataset_id = d['datasetId']
            folder = Folder().load(
                dataset_id, user=user,
                level=AccessType.READ, exc=True,
            )
            # Find items with large_image in this folder
            items = list(Item().find(
                {'folderId': folder['_id']}
            ))
            for item in items:
                item_files = list(File().find(
                    {'itemId': item['_id']}
                ))
                for f in item_files:
                    files.append({
                        'name': f['name'],
                        'size': f.get('size', 0),
                        'type': 'image',
                        'datasetId': str(dataset_id),
                        'fileId': f['_id'],
                        'itemId': item['_id'],
                    })

            # Annotation JSON (estimate ~1MB per dataset)
            files.append({
                'name': (
                    f"{folder['name']}_annotations.json"
                ),
                'size': 0,  # computed at upload time
                'type': 'annotations',
                'datasetId': str(dataset_id),
            })

        # Collection config JSONs
        for c in project['meta']['collections']:
            coll_id = c['collectionId']
            coll = self._collectionModel.load(
                coll_id, force=True
            )
            if coll:
                files.append({
                    'name': (
                        f"{coll['name']}_config.json"
                    ),
                    'size': 0,
                    'type': 'config',
                    'collectionId': str(coll_id),
                })

        # Manifest file
        files.append({
            'name': 'manifest.json',
            'size': 0,
            'type': 'manifest',
        })

        return files

    def _buildAnnotationJson(self, dataset_id):
        """Build annotation export JSON for a dataset.

        Reuses the same logic as the export endpoint.
        Returns bytes.
        """
        ds_oid = (
            ObjectId(dataset_id)
            if isinstance(dataset_id, str)
            else dataset_id
        )

        annotations = list(
            self._annotationModel.find(
                {'datasetId': ds_oid}
            )
        )
        connections = list(
            self._connectionModel.find(
                {'datasetId': ds_oid}
            )
        )

        # Get properties from all configs for this dataset
        dataset_views = list(
            self._datasetViewModel.collection.find(
                {'datasetId': ds_oid}
            )
        )
        config_ids = {
            dv['configurationId'] for dv in dataset_views
        }
        property_ids = set()
        for config_id in config_ids:
            config = self._collectionModel.load(
                config_id, force=True
            )
            if (config and 'meta' in config
                    and 'propertyIds' in config['meta']):
                for pid in config['meta']['propertyIds']:
                    property_ids.add(ObjectId(pid))

        properties = []
        if property_ids:
            properties = list(self._propertyModel.find(
                {'_id': {'$in': list(property_ids)}}
            ))

        # Property values
        prop_values = {}
        cursor = self._propertyValuesModel.find(
            {'datasetId': ds_oid}
        )
        for doc in cursor:
            ann_id = str(doc['annotationId'])
            prop_values[ann_id] = doc.get('values', {})

        data = {
            'annotations': annotations,
            'annotationConnections': connections,
            'annotationProperties': properties,
            'annotationPropertyValues': prop_values,
        }
        return orjson.dumps(data, default=orJsonDefaults)

    def _buildCollectionConfig(self, collection_id):
        """Build a JSON config export for a collection.

        Returns bytes.
        """
        coll = self._collectionModel.load(
            collection_id, force=True
        )
        if not coll:
            return orjson.dumps({})
        # Export the full collection metadata
        data = {
            'name': coll.get('name', ''),
            'description': coll.get('description', ''),
            'meta': coll.get('meta', {}),
        }
        return orjson.dumps(data, default=orJsonDefaults)

    def _buildManifest(self, project, uploaded_files):
        """Build a manifest JSON describing the project.

        :param project: The project document.
        :param uploaded_files: List of dicts with upload
            info (name, type, datasetId, etc).
        :returns: bytes
        """
        manifest = {
            'projectName': project['name'],
            'projectDescription': project['description'],
            'exportDate': (
                datetime.datetime.utcnow().isoformat()
            ),
            'metadata': project['meta'].get(
                'metadata', {}
            ),
            'datasets': [],
            'collections': [],
            'files': uploaded_files,
        }

        for d in project['meta']['datasets']:
            folder = Folder().load(
                d['datasetId'], force=True
            )
            manifest['datasets'].append({
                'datasetId': str(d['datasetId']),
                'name': (
                    folder['name'] if folder else 'unknown'
                ),
                'addedDate': str(d['addedDate']),
            })

        for c in project['meta']['collections']:
            coll = self._collectionModel.load(
                c['collectionId'], force=True
            )
            manifest['collections'].append({
                'collectionId': str(c['collectionId']),
                'name': (
                    coll['name'] if coll else 'unknown'
                ),
                'addedDate': str(c['addedDate']),
            })

        return orjson.dumps(
            manifest, default=orJsonDefaults
        )

    def _buildZenodoMetadata(self, project):
        """Map project metadata to Zenodo metadata schema.

        :returns: Dict suitable for Zenodo's metadata API.
        """
        meta = project['meta'].get('metadata', {})

        # Parse authors into Zenodo creators format
        creators = []
        authors_str = meta.get('authors', '')
        if authors_str:
            for author in authors_str.split(','):
                name = author.strip()
                if name:
                    creators.append({'name': name})
        if not creators:
            creators = [{'name': 'Unknown'}]

        # Map license
        project_license = meta.get(
            'license', 'CC-BY-4.0'
        )
        zenodo_license = LICENSE_MAP.get(
            project_license, 'cc-by-4.0'
        )

        pub_date = meta.get('publicationDate', '')
        if not pub_date:
            pub_date = datetime.date.today().isoformat()

        description = meta.get('description', '')
        if not description:
            description = (
                project.get('description', '')
                or project['name']
            )

        result = {
            'upload_type': 'dataset',
            'title': meta.get('title', project['name']),
            'description': description,
            'creators': creators,
            'publication_date': pub_date,
            'access_right': 'open',
            'license': zenodo_license,
        }

        keywords = meta.get('keywords', [])
        if keywords:
            result['keywords'] = keywords

        doi = meta.get('doi', '')
        if doi:
            result['doi'] = doi

        funding = meta.get('funding', '')
        if funding:
            result['notes'] = f"Funding: {funding}"

        return result

    def _doUpload(self, project, user, project_id):
        """Perform the Zenodo upload in a background thread.

        Updates project.meta.zenodo with progress.
        """
        try:
            client = self._getZenodoClient(user)
            zenodo_meta = project['meta'].get('zenodo', {})

            # Create deposition or new version
            existing_id = zenodo_meta.get('depositionId')
            if (existing_id
                    and zenodo_meta.get('status')
                    == 'published'):
                log.info(
                    "Creating new version of deposition "
                    "%s", existing_id
                )
                deposition = client.create_new_version(
                    existing_id
                )
                # Clear old files from the new version
                client.delete_all_files(deposition['id'])
            else:
                deposition = client.create_deposition()

            dep_id = deposition['id']
            bucket_url = deposition['links']['bucket']

            # Update project with deposition info
            self._updateZenodoMeta(project_id, {
                'depositionId': dep_id,
                'depositionUrl': (
                    deposition['links']['html']
                ),
                'status': 'uploading',
                'sandbox': client.base_url != (
                    "https://zenodo.org"
                ),
                'progress': {
                    'current': 0,
                    'total': 0,
                    'message': 'Starting upload...',
                },
            })

            uploaded_files = []
            file_count = 0

            # Count total files for progress
            total_files = 0
            for d in project['meta']['datasets']:
                folder = Folder().load(
                    d['datasetId'], force=True
                )
                if folder:
                    items = list(Item().find(
                        {'folderId': folder['_id']}
                    ))
                    total_files += len(items)
                total_files += 1  # annotation JSON
            total_files += len(
                project['meta']['collections']
            )
            total_files += 1  # manifest

            # Upload dataset files
            for d in project['meta']['datasets']:
                dataset_id = d['datasetId']
                folder = Folder().load(
                    dataset_id, user=user,
                    level=AccessType.READ,
                )
                if not folder:
                    continue

                folder_name = folder['name']

                # Upload source image files
                items = list(Item().find(
                    {'folderId': folder['_id']}
                ))
                for item in items:
                    item_files = list(File().find(
                        {'itemId': item['_id']}
                    ))
                    for f in item_files:
                        file_count += 1
                        self._updateZenodoProgress(
                            project_id, file_count,
                            total_files,
                            f"Uploading {f['name']}...",
                        )

                        # Stream file from Girder
                        stream = File().download(
                            f, headers=False
                        )
                        # Use -- separator instead of /
                        # because Zenodo bucket API does
                        # not support slashes in filenames
                        filename = (
                            f"{folder_name}--{f['name']}"
                        )
                        result = client.upload_file(
                            bucket_url, filename,
                            stream(),
                        )
                        uploaded_files.append({
                            'name': filename,
                            'type': 'image',
                            'datasetId': str(dataset_id),
                            'checksum': result.get(
                                'checksum', ''
                            ),
                        })

                # Upload annotation JSON
                file_count += 1
                self._updateZenodoProgress(
                    project_id, file_count, total_files,
                    (
                        f"Exporting annotations for "
                        f"{folder_name}..."
                    ),
                )
                ann_json = self._buildAnnotationJson(
                    dataset_id
                )
                ann_filename = (
                    f"{folder_name}_annotations.json"
                )
                client.upload_file(
                    bucket_url, ann_filename,
                    io.BytesIO(ann_json),
                    # Zenodo bucket API only accepts
                    # application/octet-stream
                )
                uploaded_files.append({
                    'name': ann_filename,
                    'type': 'annotations',
                    'datasetId': str(dataset_id),
                })

            # Upload collection configs
            for c in project['meta']['collections']:
                coll_id = c['collectionId']
                coll = self._collectionModel.load(
                    coll_id, force=True
                )
                if not coll:
                    continue

                file_count += 1
                coll_name = coll['name']
                self._updateZenodoProgress(
                    project_id, file_count, total_files,
                    (
                        f"Uploading config for "
                        f"{coll_name}..."
                    ),
                )

                config_json = self._buildCollectionConfig(
                    coll_id
                )
                config_filename = (
                    f"{coll_name}_config.json"
                )
                client.upload_file(
                    bucket_url, config_filename,
                    io.BytesIO(config_json),
                    # Zenodo bucket API only accepts
                    # application/octet-stream
                )
                uploaded_files.append({
                    'name': config_filename,
                    'type': 'config',
                    'collectionId': str(coll_id),
                })

            # Upload manifest
            file_count += 1
            self._updateZenodoProgress(
                project_id, file_count, total_files,
                "Uploading manifest...",
            )
            manifest_json = self._buildManifest(
                project, uploaded_files
            )
            client.upload_file(
                bucket_url, 'manifest.json',
                io.BytesIO(manifest_json),
            )

            # Set metadata
            self._updateZenodoProgress(
                project_id, file_count, total_files,
                "Setting metadata...",
            )
            zenodo_metadata = self._buildZenodoMetadata(
                project
            )
            client.set_metadata(dep_id, zenodo_metadata)

            # Done - mark as draft (ready to publish)
            self._updateZenodoMeta(project_id, {
                'depositionId': dep_id,
                'depositionUrl': (
                    deposition['links']['html']
                ),
                'status': 'draft',
                'sandbox': client.base_url != (
                    "https://zenodo.org"
                ),
                'progress': None,
            })

            log.info(
                "Zenodo upload complete for project %s, "
                "deposition %s",
                project_id, dep_id,
            )

        except Exception as e:
            log.exception(
                "Zenodo upload failed for project %s",
                project_id,
            )
            self._updateZenodoMeta(project_id, {
                'status': 'error',
                'error': str(e),
                'progress': None,
            })

    def _updateZenodoMeta(self, project_id, zenodo_data):
        """Update the project's meta.zenodo field."""
        project = self._projectModel.load(
            project_id, force=True
        )
        if not project:
            return

        existing = project['meta'].get('zenodo', {})
        existing.update(zenodo_data)
        project['meta']['zenodo'] = existing
        project['updated'] = datetime.datetime.utcnow()
        self._projectModel.save(project)

    def _updateZenodoProgress(
        self, project_id, current, total, message
    ):
        """Update upload progress on the project."""
        project = self._projectModel.load(
            project_id, force=True
        )
        if not project:
            return
        zenodo = project['meta'].get('zenodo', {})
        zenodo['progress'] = {
            'current': current,
            'total': total,
            'message': message,
        }
        project['meta']['zenodo'] = zenodo
        self._projectModel.save(project)

    @access.user
    @autoDescribeRoute(
        Description("Upload a project to Zenodo as a draft")
        .notes("""
            Validates project size and file count, then
            starts uploading all project data to Zenodo.
            The upload runs in a background thread.

            If the project was previously published, this
            creates a new version of the existing
            deposition.

            Does NOT auto-publish. Call the publish
            endpoint after reviewing the draft on Zenodo.
        """)
        .jsonParam(
            'body',
            'Request body with projectId',
            paramType='body',
            required=True,
            requireObject=True,
        )
        .errorResponse('Project not found.', 404)
        .errorResponse('Access denied.', 403)
        .errorResponse('Validation failed.', 400)
    )
    def upload(self, body):
        project_id = body.get('projectId')
        if not project_id:
            raise RestException(
                "projectId is required", code=400
            )

        user = self.getCurrentUser()
        project = self._projectModel.load(
            project_id, user=user,
            level=AccessType.ADMIN, exc=True,
        )

        # Check for token
        client = self._getZenodoClient(user)
        try:
            client.validate_token()
        except ZenodoError as e:
            raise RestException(
                f"Zenodo token validation failed: {e}",
                code=400,
            )

        # Check if upload is already in progress
        zenodo = project['meta'].get('zenodo', {})
        if zenodo.get('status') == 'uploading':
            raise RestException(
                "An upload is already in progress for "
                "this project.",
                code=409,
            )

        # Pre-flight: validate size and file count
        files = self._gatherProjectFiles(project, user)
        image_files = [
            f for f in files if f['type'] == 'image'
        ]
        total_size = sum(
            f['size'] for f in image_files
        )
        total_count = len(files)

        if total_size > MAX_ZENODO_SIZE:
            raise RestException(
                f"Project size ({total_size} bytes) "
                f"exceeds Zenodo's 50 GB limit. "
                f"Request a quota increase on Zenodo "
                f"first.",
                code=400,
            )

        if total_count > MAX_ZENODO_FILES:
            raise RestException(
                f"Project has {total_count} files, "
                f"exceeding Zenodo's 100-file limit. "
                f"Consider reducing the number of "
                f"datasets.",
                code=400,
            )

        # Start upload in background thread
        thread = threading.Thread(
            target=self._doUpload,
            args=(project, user, project['_id']),
            daemon=True,
        )
        thread.start()

        return {
            'message': 'Upload started',
            'projectId': str(project['_id']),
            'totalFiles': total_count,
            'totalSize': total_size,
        }

    @access.user
    @autoDescribeRoute(
        Description("Get Zenodo upload status for a project")
        .param(
            'projectId', 'The project ID',
            paramType='path',
        )
        .errorResponse('Project not found.', 404)
    )
    def getStatus(self, projectId):
        user = self.getCurrentUser()
        project = self._projectModel.load(
            projectId, user=user,
            level=AccessType.READ, exc=True,
        )
        zenodo = project['meta'].get('zenodo', {})
        return {
            'status': zenodo.get('status', 'none'),
            'depositionId': zenodo.get('depositionId'),
            'depositionUrl': zenodo.get('depositionUrl'),
            'doi': zenodo.get('doi'),
            'sandbox': zenodo.get('sandbox', False),
            'progress': zenodo.get('progress'),
            'error': zenodo.get('error'),
            'lastPublished': zenodo.get('lastPublished'),
        }

    @access.user
    @autoDescribeRoute(
        Description(
            "Publish a Zenodo draft deposition (mints DOI)"
        )
        .notes("""
            WARNING: Publishing is irreversible. The
            record will receive a permanent DOI and
            cannot be deleted.
        """)
        .param(
            'projectId', 'The project ID',
            paramType='path',
        )
        .errorResponse('Project not found.', 404)
        .errorResponse('No draft to publish.', 400)
    )
    def publish(self, projectId):
        user = self.getCurrentUser()
        project = self._projectModel.load(
            projectId, user=user,
            level=AccessType.ADMIN, exc=True,
        )

        zenodo = project['meta'].get('zenodo', {})
        if zenodo.get('status') != 'draft':
            raise RestException(
                "No draft deposition to publish. "
                "Upload first.",
                code=400,
            )

        dep_id = zenodo.get('depositionId')
        if not dep_id:
            raise RestException(
                "No deposition ID found.", code=400
            )

        client = self._getZenodoClient(user)
        try:
            result = client.publish(dep_id)
        except ZenodoError as e:
            raise RestException(
                f"Zenodo publish failed: {e}",
                code=502,
            )

        doi = result.get('doi', '')
        record_url = result.get('links', {}).get(
            'record_html', ''
        )

        self._updateZenodoMeta(project['_id'], {
            'status': 'published',
            'doi': doi,
            'depositionUrl': record_url or zenodo.get(
                'depositionUrl', ''
            ),
            'lastPublished': (
                datetime.datetime.utcnow().isoformat()
            ),
            'progress': None,
            'error': None,
        })

        # Reload project to get updated zenodo meta,
        # then update project status to 'exported'
        project = self._projectModel.load(
            project['_id'], force=True
        )
        self._projectModel.updateStatus(
            project, 'exported'
        )

        return {
            'message': 'Published successfully',
            'doi': doi,
            'url': record_url,
        }

    @access.user
    @autoDescribeRoute(
        Description("Discard an unpublished Zenodo draft")
        .param(
            'projectId', 'The project ID',
            paramType='path',
        )
        .errorResponse('Project not found.', 404)
        .errorResponse('No draft to discard.', 400)
    )
    def discard(self, projectId):
        user = self.getCurrentUser()
        project = self._projectModel.load(
            projectId, user=user,
            level=AccessType.ADMIN, exc=True,
        )

        zenodo = project['meta'].get('zenodo', {})
        if zenodo.get('status') not in (
            'draft', 'error'
        ):
            raise RestException(
                "No draft deposition to discard.",
                code=400,
            )

        dep_id = zenodo.get('depositionId')
        if dep_id:
            client = self._getZenodoClient(user)
            try:
                client.discard(dep_id)
            except ZenodoError:
                # May fail if already discarded; that's OK
                pass

        # Clear zenodo metadata but keep history
        previous_doi = zenodo.get('doi')
        new_meta = {'status': 'none'}
        if previous_doi:
            # Preserve DOI from prior publications
            new_meta['doi'] = previous_doi
            new_meta['status'] = 'published'

        self._updateZenodoMeta(project['_id'], {
            'depositionId': None,
            'depositionUrl': None,
            'status': new_meta['status'],
            'doi': new_meta.get('doi'),
            'progress': None,
            'error': None,
        })

        return {'message': 'Draft discarded'}
