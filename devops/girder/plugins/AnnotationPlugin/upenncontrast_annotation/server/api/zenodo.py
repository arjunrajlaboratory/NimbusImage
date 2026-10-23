"""
REST API endpoints for Zenodo publication workflow.

Provides endpoints to:
- Upload a project to Zenodo as a draft deposition
- Check upload status
- Publish (mint DOI) or discard a draft
"""

import datetime
import logging

from bson import ObjectId

from girder.api import access
from girder.api.describe import Description, autoDescribeRoute
from girder.api.rest import Resource
from girder.constants import AccessType
from girder.exceptions import RestException
from girder_jobs.models.job import Job as JobModel

from ..helpers.access_helpers import (
    requireProjectContentsAccess,
    requireResourcesAccess,
)
from ..helpers.zenodo_client import (
    ZenodoError,
    get_zenodo_client_for_user,
    update_zenodo_meta,
)
from ..helpers.zenodo_job import (
    batch_load_project_data,
    upload_may_be_running,
)
from ..models.collection import Collection as CollectionModel
from ..models.project import Project as ProjectModel

log = logging.getLogger(__name__)

# 50 GB in bytes
MAX_ZENODO_SIZE = 50 * 1024 * 1024 * 1024
MAX_ZENODO_FILES = 100


class Zenodo(Resource):

    def __init__(self):
        super().__init__()
        self.resourceName = "zenodo"

        self._projectModel = ProjectModel()
        self._collectionModel = CollectionModel()

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
        try:
            return get_zenodo_client_for_user(user)
        except ValueError as e:
            raise RestException(str(e), code=400)

    def _gatherProjectFiles(self, project, user):
        """Gather all files that would be uploaded.

        Uses batch queries to load folders and files
        efficiently. Returns a list of dicts for
        pre-flight validation.
        """
        files = []
        datasets = project['meta'].get('datasets', [])
        collections = project['meta'].get(
            'collections', []
        )

        (folders_by_id, items_by_folder,
         files_by_item, _) = (
            batch_load_project_data(project)
        )

        for d in datasets:
            ds_id = ObjectId(d['datasetId'])
            folder = folders_by_id.get(ds_id)
            if not folder:
                continue

            for item in items_by_folder.get(ds_id, []):
                for f in files_by_item.get(
                    item['_id'], []
                ):
                    files.append({
                        'name': f['name'],
                        'size': f.get('size', 0),
                        # The spatial plugin's stores live in the dataset
                        # folder too, so the record carries the matrix and
                        # the molecules along with the images.
                        'type': (
                            'spatial' if f['name'].endswith('.zarr.zip')
                            else 'image'
                        ),
                    })

            files.append({
                'name': (
                    f"{folder['name']}_annotations.json"
                ),
                'size': 0,
                'type': 'annotations',
            })

        # Batch load all collections
        coll_ids = [
            ObjectId(c['collectionId'])
            for c in collections
        ]
        if coll_ids:
            for coll in self._collectionModel.find(
                {'_id': {'$in': coll_ids}}
            ):
                files.append({
                    'name': (
                        f"{coll['name']}_config.json"
                    ),
                    'size': 0,
                    'type': 'config',
                })

        files.append({
            'name': 'manifest.json',
            'size': 0,
            'type': 'manifest',
        })

        return files

    @access.user
    @autoDescribeRoute(
        Description("Upload a project to Zenodo as a draft")
        .notes("""
            Validates project size and file count, then
            starts uploading all project data to Zenodo
            as a background job.

            Requires ADMIN on the project and on every
            dataset and collection it lists. Configurations
            reached only through the datasets' views are
            exported only if the caller owns them.

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
        # Publishing hands out every file in the project: an owner
        # operation on each dataset and collection, not just the project.
        requireProjectContentsAccess(project, user)

        # Check if upload is already in progress
        # (cheap check before hitting Zenodo API)
        zenodo = project['meta'].get('zenodo', {})
        if zenodo.get('status') == 'uploading':
            raise RestException(
                "An upload is already in progress for "
                "this project.",
                code=409,
            )

        # Check for token and validate
        client = self._getZenodoClient(user)
        try:
            client.validate_token()
        except ZenodoError as e:
            raise RestException(
                f"Zenodo token validation failed: {e}",
                code=400,
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

        # Mark as uploading synchronously to prevent
        # duplicate uploads from concurrent requests
        update_zenodo_meta(project['_id'], {
            'status': 'uploading',
            # In the same write: a discard before the new job is recorded
            # must see "no job yet" (and refuse), not the previous upload's
            # ended job.
            'jobId': None,
            'progress': {
                'current': 0,
                'total': 0,
                'message': 'Starting upload...',
            },
            'error': None,
        }, project_model=self._projectModel)

        # Create and schedule a local Girder job.
        # If job creation fails, roll back the status
        # so the project is not stuck in 'uploading'.
        try:
            job = JobModel().createLocalJob(
                module=(
                    'upenncontrast_annotation'
                    '.server.helpers.zenodo_job'
                ),
                title=(
                    'Zenodo Upload: %s'
                    % project['name']
                ),
                type='zenodo_upload',
                user=user,
                kwargs={
                    'projectId': str(project['_id']),
                    'userId': str(user['_id']),
                },
                asynchronous=True,
            )
            # Before scheduling, so the job can't finish before the
            # project names it.
            update_zenodo_meta(project['_id'], {
                'jobId': str(job['_id']),
            }, project_model=self._projectModel)
            JobModel().scheduleJob(job)
        except Exception:
            update_zenodo_meta(project['_id'], {
                'status': 'error',
                'error': 'Failed to create upload job',
                'progress': None,
            }, project_model=self._projectModel)
            raise

        return {
            'message': 'Upload started',
            'projectId': str(project['_id']),
            'jobId': str(job['_id']),
            'totalFiles': total_count,
            'totalSize': total_size,
        }

    @access.user
    @autoDescribeRoute(
        Description(
            "Get Zenodo upload status for a project"
        )
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
            'jobId': zenodo.get('jobId'),
        }

    @access.user
    @autoDescribeRoute(
        Description(
            "Publish a Zenodo draft deposition "
            "(mints DOI)"
        )
        .notes("""
            WARNING: Publishing is irreversible. The
            record will receive a permanent DOI and
            cannot be deleted.

            Requires ADMIN on the project and on every
            resource the upload recorded in the draft.
        """)
        .param(
            'projectId', 'The project ID',
            paramType='path',
        )
        .errorResponse('Project not found.', 404)
        .errorResponse('No draft to publish.', 400)
        .errorResponse(
            'Admin access denied on a resource in the draft.', 403)
        .errorResponse(
            'The draft predates ownership checks, or a resource '
            'in it no longer exists; discard it and upload '
            'again.', 409)
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

        # Check what the draft contains, not the project's membership by
        # now: datasets can be removed from the project after the upload.
        # A draft uploaded before resources were recorded cannot be
        # checked, so it must be uploaded again.
        uploaded = zenodo.get('uploadedResources')
        if not uploaded:
            raise RestException(
                "This draft predates ownership checks; discard it and "
                "upload again.", code=409,
            )
        recordedDatasetIds = set(uploaded.get('datasetIds', []))
        recordedCollectionIds = set(uploaded.get('collectionIds', []))
        existingDatasetIds, existingCollections = requireResourcesAccess(
            recordedDatasetIds, recordedCollectionIds, user)
        # A deleted resource cannot be checked, and the draft still holds
        # its files.
        if (recordedDatasetIds - set(existingDatasetIds)
                or recordedCollectionIds - set(existingCollections)):
            raise RestException(
                "Some datasets or collections in this draft no longer "
                "exist; discard the draft and upload again.", code=409,
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

        update_zenodo_meta(project['_id'], {
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
        }, project_model=self._projectModel)

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
        .param(
            'force',
            'Reset a project stuck in uploading even though its upload job '
            'still looks live (a Girder restart leaves a dead job RUNNING).',
            dataType='boolean', default=False, required=False,
        )
        .errorResponse('Project not found.', 404)
        .errorResponse('No draft to discard.', 400)
        .errorResponse('An upload is in progress.', 409)
    )
    def discard(self, projectId, force):
        user = self.getCurrentUser()
        project = self._projectModel.load(
            projectId, user=user,
            level=AccessType.ADMIN, exc=True,
        )

        zenodo = project['meta'].get('zenodo', {})
        if zenodo.get('status') not in (
            'draft', 'error', 'uploading'
        ):
            raise RestException(
                "No draft deposition to discard.",
                code=400,
            )

        # 'uploading' is accepted so a project whose upload job died can be
        # reset, but not while an upload may be using the deposition (its
        # job is live, or it is still starting): a stale card in another tab
        # can still ask. Girder never sweeps local jobs, so a job whose
        # thread died in a restart stays RUNNING forever; `force` is the way
        # out for that.
        if (zenodo.get('status') == 'uploading' and not force
                and upload_may_be_running(zenodo)):
            raise RestException(
                "An upload is in progress for this project.",
                code=409,
            )

        dep_id = zenodo.get('depositionId')
        if dep_id:
            client = self._getZenodoClient(user)
            try:
                client.discard(dep_id)
            except ZenodoError:
                # May fail if already discarded
                pass

        # Clear zenodo metadata but keep history
        previous_doi = zenodo.get('doi')
        new_meta = {'status': 'none'}
        if previous_doi:
            new_meta['doi'] = previous_doi
            new_meta['status'] = 'published'

        update_zenodo_meta(project['_id'], {
            'depositionId': None,
            'depositionUrl': None,
            'status': new_meta['status'],
            'doi': new_meta.get('doi'),
            'progress': None,
            'error': None,
        }, project_model=self._projectModel)

        return {'message': 'Draft discarded'}
