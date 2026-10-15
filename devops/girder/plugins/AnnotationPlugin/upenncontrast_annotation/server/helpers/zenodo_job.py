"""
Zenodo upload job module for Girder local jobs.

This module is invoked by Girder's local job handler via
createLocalJob(module=...). The run(job) function performs
the full Zenodo upload workflow and reports progress via
Job().updateJob() notifications (SSE).
"""

import datetime
import io
import json
import logging
from collections import defaultdict

import orjson

from bson import ObjectId
from girder.exceptions import AccessException
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from .access_helpers import (
    ProjectContents,
    requireProjectContentsAccess,
    requireResourcesAccess,
)
from .serialization import orJsonDefaults
from .zenodo_client import (
    get_zenodo_client_for_user,
    update_zenodo_meta,
)
from ..models.annotation import Annotation as AnnotationModel
from ..models.collection import (
    Collection as CollectionModel,
)
from ..models.connections import (
    AnnotationConnection as ConnectionModel,
)
from ..models.project import Project as ProjectModel
from ..models.property import (
    AnnotationProperty as PropertyModel,
)
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)

log = logging.getLogger(__name__)


LIVE_JOB_STATUSES = (
    JobStatus.INACTIVE, JobStatus.QUEUED, JobStatus.RUNNING,
)


def upload_may_be_running(zenodo):
    """Whether a project in 'uploading' may have an upload job using its
    deposition: its recorded job is still live (a local job is INACTIVE
    until its thread marks it RUNNING), or no job is recorded yet.

    No jobId means the upload endpoint is between its 'uploading' write
    (which clears the previous jobId) and recording the new job, so fail
    closed. A project stuck from before job ids were recorded also reads
    this way; discard's force flag resets it.

    The project records the job id because job kwargs can't serve: Girder
    stores them serialized and exposes them only to site admins.
    """
    jobId = zenodo.get('jobId')
    if not jobId:
        return True
    # force: an internal state check, not a read on the caller's behalf
    # (a project co-owner may not own the job).
    job = Job().load(jobId, force=True)
    return job is not None and job['status'] in LIVE_JOB_STATUSES


def run(job):
    """Entry point for the local job handler.

    Called by Girder's scheduleLocal with the job document.
    Expects job['kwargs'] to contain:
      - projectId: str
      - userId: str
    """
    job_model = Job()
    job_model.updateJob(
        job,
        status=JobStatus.RUNNING,
        log='Starting Zenodo upload...\n',
    )

    kwargs = job.get('kwargs', {})
    project_id = kwargs['projectId']
    user_id = kwargs['userId']

    project_model = ProjectModel()
    user = User().load(user_id, force=True)
    project = project_model.load(
        project_id, force=True
    )

    if not project or not user:
        _fail(
            job, job_model, project_id, project_model,
            'Project or user not found',
        )
        return

    # The upload endpoint checked ownership, but anyone with WRITE on the
    # project can add resources before this reload: check the snapshot
    # this job actually exports.
    try:
        contents = requireProjectContentsAccess(project, user)
    except AccessException as e:
        _fail(
            job, job_model, project_id, project_model,
            str(e),
        )
        return

    try:
        client = get_zenodo_client_for_user(user)
    except Exception as e:
        _fail(
            job, job_model, project_id, project_model,
            str(e),
        )
        return

    try:
        _do_upload(
            job, job_model,
            project, user, project_id,
            project_model, client, contents,
        )
    except Exception as e:
        log.exception(
            "Zenodo upload failed for project %s",
            project_id,
        )
        _fail(
            job, job_model, project_id, project_model,
            str(e),
        )


def _fail(job, job_model, project_id, project_model,
          error_msg):
    """Mark both the job and project as failed.

    The project is updated first, as on success: the ERROR status reaches
    the frontend over SSE, which then re-reads the project and must not
    find it still 'uploading'.
    """
    update_zenodo_meta(project_id, {
        'status': 'error',
        'error': error_msg,
        'progress': None,
    }, project_model=project_model)
    job_model.updateJob(
        job,
        status=JobStatus.ERROR,
        log=json.dumps({
            'error': error_msg,
            'title': 'Zenodo Upload Error',
        }) + '\n',
    )


# How often to persist progress to MongoDB (every N files)
_META_PROGRESS_INTERVAL = 5


def _report_progress(job, job_model, current, total,
                     message, project_id=None,
                     project_model=None):
    """Report progress via job log (SSE) and optionally
    persist to project metadata.

    SSE progress is always sent. MongoDB project metadata
    is updated every _META_PROGRESS_INTERVAL files to
    reduce write load, plus always on the first and last
    file.
    """
    job_model.updateJob(
        job,
        log=json.dumps({
            'progress': current / total if total else 0,
            'current': current,
            'total': total,
            'message': message,
        }) + '\n',
    )

    if project_id and project_model:
        should_persist = (
            current <= 1
            or current >= total
            or current % _META_PROGRESS_INTERVAL == 0
        )
        if should_persist:
            update_zenodo_meta(
                project_id, {
                    'progress': {
                        'current': current,
                        'total': total,
                        'message': message,
                    },
                },
                project_model=project_model,
            )


def batch_load_project_data(project):
    """Batch load all folders, items, and files for a
    project's datasets in minimal DB round-trips.

    Returns (folders_by_id, items_by_folder,
    files_by_item, total_file_count).
    """
    datasets = project['meta'].get('datasets', [])
    dataset_ids = [
        ObjectId(d['datasetId']) for d in datasets
    ]

    # Batch load folders
    folders_by_id = {}
    if dataset_ids:
        for f in Folder().find(
            {'_id': {'$in': dataset_ids}}
        ):
            folders_by_id[f['_id']] = f

    # Batch load items
    items_by_folder = defaultdict(list)
    if dataset_ids:
        for item in Item().find(
            {'folderId': {'$in': dataset_ids}}
        ):
            items_by_folder[item['folderId']].append(
                item
            )

    # Batch load files
    all_item_ids = [
        item['_id']
        for items in items_by_folder.values()
        for item in items
    ]
    files_by_item = defaultdict(list)
    total_file_count = 0
    if all_item_ids:
        for f in File().find(
            {'itemId': {'$in': all_item_ids}}
        ):
            files_by_item[f['itemId']].append(f)
            total_file_count += 1

    return (
        folders_by_id, items_by_folder,
        files_by_item, total_file_count,
    )


def _batch_load_collections(project, collection_model):
    """Batch load all collections for a project.

    Returns a dict of collection_id -> collection doc.
    """
    collections = project['meta'].get('collections', [])
    coll_ids = [
        ObjectId(c['collectionId']) for c in collections
    ]
    colls_by_id = {}
    if coll_ids:
        for coll in collection_model.find(
            {'_id': {'$in': coll_ids}}
        ):
            colls_by_id[coll['_id']] = coll
    return colls_by_id


def _do_upload(job, job_model, project, user, project_id,
               project_model, client, contents):
    """Perform the full Zenodo upload.

    :param contents: What requireProjectContentsAccess checked. The export
        uses its configurations instead of re-querying views that may have
        changed, and the draft records its ids for the publish check.
    """
    zenodo_meta = project['meta'].get('zenodo', {})

    # Create deposition or new version
    existing_id = zenodo_meta.get('depositionId')
    if (existing_id
            and zenodo_meta.get('status')
            == 'published'):
        log.info(
            "Creating new version of deposition %s",
            existing_id,
        )
        deposition = client.create_new_version(
            existing_id
        )
        client.delete_all_files(deposition['id'])
    else:
        deposition = client.create_deposition()

    dep_id = deposition['id']
    bucket_url = deposition['links']['bucket']

    # Update project with deposition info
    update_zenodo_meta(project_id, {
        'depositionId': dep_id,
        'depositionUrl': deposition['links']['html'],
        'status': 'uploading',
        'sandbox': client.base_url != (
            "https://zenodo.org"
        ),
        'progress': {
            'current': 0,
            'total': 0,
            'message': 'Starting upload...',
        },
    }, project_model=project_model)

    # Ownership was checked before the Zenodo calls above, which can take
    # a while; check again immediately before reading any data, so access
    # revoked meanwhile stops the export. (Revocation during the file
    # uploads themselves still blocks publishing: publish rechecks.)
    existing_dataset_ids, existing_collections = requireResourcesAccess(
        contents.datasetIds, contents.collectionIds, user
    )
    existing_dataset_ids = set(existing_dataset_ids)
    # Drop anything deleted since the first check, so it is neither
    # exported from the stale snapshot nor recorded (publish refuses
    # recorded resources that no longer exist).
    contents = ProjectContents(
        datasetIds=[
            ds_id for ds_id in contents.datasetIds
            if ds_id in existing_dataset_ids
        ],
        collectionIds=[
            coll_id for coll_id in contents.collectionIds
            if coll_id in existing_collections
        ],
        configsByDataset={
            ds_id: [
                config for config in configs
                if config['_id'] in existing_collections
            ]
            for ds_id, configs in contents.configsByDataset.items()
        },
    )

    # Batch load all project data upfront
    (folders_by_id, items_by_folder,
     files_by_item, image_file_count) = (
        batch_load_project_data(project)
    )

    collection_model = CollectionModel()
    colls_by_id = _batch_load_collections(
        project, collection_model
    )

    # Models for annotation export
    annotation_model = AnnotationModel()
    connection_model = ConnectionModel()
    property_model = PropertyModel()
    property_values_model = PropertyValuesModel()

    # Count total files for progress
    datasets = project['meta'].get('datasets', [])
    collections_meta = project['meta'].get(
        'collections', []
    )
    total_files = (
        image_file_count
        + len(datasets)  # annotation JSONs
        + len(collections_meta)  # config JSONs
        + 1  # manifest
    )

    uploaded_files = []
    file_count = 0
    seen_filenames = set()

    # Upload dataset files
    for d in datasets:
        ds_id = ObjectId(d['datasetId'])
        folder = folders_by_id.get(ds_id)
        if not folder:
            continue

        folder_name = folder['name']

        # Upload source image files
        for item in items_by_folder.get(ds_id, []):
            for f in files_by_item.get(
                item['_id'], []
            ):
                file_count += 1
                msg = f"Uploading {f['name']}..."
                _report_progress(
                    job, job_model,
                    file_count, total_files, msg,
                    project_id=project_id,
                    project_model=project_model,
                )

                filename = (
                    f"{folder_name}--{f['name']}"
                )
                if filename in seen_filenames:
                    filename = (
                        f"{folder_name}"
                        f"__{ds_id}"
                        f"--{f['name']}"
                    )
                seen_filenames.add(filename)
                with File().open(f) as fh:
                    result = client.upload_file(
                        bucket_url, filename, fh,
                        size=f.get('size', 0),
                    )
                uploaded_files.append({
                    'name': filename,
                    'type': 'image',
                    'datasetId': str(ds_id),
                    'checksum': result.get(
                        'checksum', ''
                    ),
                })

        # Upload annotation JSON
        file_count += 1
        msg = (
            f"Exporting annotations for "
            f"{folder_name}..."
        )
        _report_progress(
            job, job_model,
            file_count, total_files, msg,
            project_id=project_id,
            project_model=project_model,
        )

        ann_json = _build_annotation_json(
            ds_id, annotation_model, connection_model,
            contents.configsByDataset.get(ds_id, []),
            property_model, property_values_model,
        )
        ann_filename = (
            f"{folder_name}_annotations.json"
        )
        if ann_filename in seen_filenames:
            ann_filename = (
                f"{folder_name}"
                f"__{ds_id}"
                f"_annotations.json"
            )
        seen_filenames.add(ann_filename)
        client.upload_file(
            bucket_url, ann_filename,
            io.BytesIO(ann_json),
        )
        uploaded_files.append({
            'name': ann_filename,
            'type': 'annotations',
            'datasetId': str(ds_id),
        })

    # Upload collection configs
    for c in collections_meta:
        coll_id = ObjectId(c['collectionId'])
        coll = colls_by_id.get(coll_id)
        if not coll:
            continue

        file_count += 1
        coll_name = coll['name']
        msg = (
            f"Uploading config for {coll_name}..."
        )
        _report_progress(
            job, job_model,
            file_count, total_files, msg,
            project_id=project_id,
            project_model=project_model,
        )

        config_json = _build_collection_config(coll)
        config_filename = (
            f"{coll_name}_config.json"
        )
        if config_filename in seen_filenames:
            config_filename = (
                f"{coll_name}"
                f"__{coll_id}"
                f"_config.json"
            )
        seen_filenames.add(config_filename)
        client.upload_file(
            bucket_url, config_filename,
            io.BytesIO(config_json),
        )
        uploaded_files.append({
            'name': config_filename,
            'type': 'config',
            'collectionId': str(coll_id),
        })

    # Upload manifest
    file_count += 1
    msg = "Uploading manifest..."
    _report_progress(
        job, job_model,
        file_count, total_files, msg,
        project_id=project_id,
        project_model=project_model,
    )
    manifest_json = _build_manifest(
        project, uploaded_files,
        folders_by_id, colls_by_id,
    )
    client.upload_file(
        bucket_url, 'manifest.json',
        io.BytesIO(manifest_json),
    )

    # Set metadata
    _report_progress(
        job, job_model,
        file_count, total_files,
        "Setting metadata...",
    )
    zenodo_metadata = _build_zenodo_metadata(project)
    client.set_metadata(dep_id, zenodo_metadata)

    # Done - mark as draft (ready to publish). Publishing checks the
    # resources recorded here, which is what the draft contains, not the
    # project's membership by then. Record only what was uploaded: a
    # resource deleted after the check was skipped above, and publish
    # refuses recorded resources that no longer exist.
    uploaded_dataset_ids = [
        ds_id for ds_id in contents.datasetIds if ds_id in folders_by_id
    ]
    uploaded_collection_ids = {
        coll_id for coll_id in contents.collectionIds
        if coll_id in colls_by_id
    } | {
        config['_id']
        for ds_id in uploaded_dataset_ids
        for config in contents.configsByDataset.get(ds_id, [])
    }
    update_zenodo_meta(project_id, {
        'uploadedResources': {
            'datasetIds': uploaded_dataset_ids,
            'collectionIds': list(uploaded_collection_ids),
        },
        'depositionId': dep_id,
        'depositionUrl': deposition['links']['html'],
        'status': 'draft',
        'sandbox': client.base_url != (
            "https://zenodo.org"
        ),
        'progress': None,
    }, project_model=project_model)

    job_model.updateJob(
        job,
        status=JobStatus.SUCCESS,
        log=json.dumps({
            'progress': 1.0,
            'current': total_files,
            'total': total_files,
            'message': 'Upload complete',
        }) + '\n',
    )

    log.info(
        "Zenodo upload complete for project %s, "
        "deposition %s",
        project_id, dep_id,
    )


# --- Data building helpers ---

def _build_annotation_json(
    dataset_id, annotation_model, connection_model,
    configs, property_model, property_values_model,
):
    """Build annotation export JSON for a dataset.

    Follows the same format as the Export endpoint's
    JSON export (annotations, connections, properties,
    property values).
    """
    ds_oid = ObjectId(dataset_id)

    annotations = list(
        annotation_model.find({'datasetId': ds_oid})
    )
    connections = list(
        connection_model.find({'datasetId': ds_oid})
    )

    # Properties of the configurations this dataset's views use
    # (same pattern as export.py _getProperties), as checked at the
    # start of the job: never re-query views here.
    property_ids = set()
    for config in configs:
        for pid in config.get('meta', {}).get('propertyIds', []):
            property_ids.add(ObjectId(pid))

    properties = []
    if property_ids:
        properties = property_model.findClientFields(property_ids)

    # Get property values
    # (same pattern as export.py _getPropertyValues)
    # Only values of the properties defined above: values of a property
    # whose configuration was left out would ship without a definition.
    exported_property_ids = {str(pid) for pid in property_ids}
    prop_values = {}
    for doc in property_values_model.find(
        {'datasetId': ds_oid}
    ):
        ann_id = str(doc['annotationId'])
        prop_values[ann_id] = {
            pid: value
            for pid, value in doc.get('values', {}).items()
            if pid in exported_property_ids
        }

    data = {
        'annotations': annotations,
        'annotationConnections': connections,
        'annotationProperties': properties,
        'annotationPropertyValues': prop_values,
    }
    return orjson.dumps(data, default=orJsonDefaults)


def _build_collection_config(coll):
    """Build a JSON config export for a collection.

    Takes an already-loaded collection document.
    """
    data = {
        'name': coll.get('name', ''),
        'description': coll.get('description', ''),
        'meta': coll.get('meta', {}),
    }
    return orjson.dumps(data, default=orJsonDefaults)


def _build_manifest(project, uploaded_files,
                    folders_by_id, colls_by_id):
    """Build a manifest JSON describing the project.

    Uses pre-loaded folders and collections dicts to
    avoid additional DB queries.
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

    for d in project['meta'].get('datasets', []):
        ds_id = ObjectId(d['datasetId'])
        folder = folders_by_id.get(ds_id)
        manifest['datasets'].append({
            'datasetId': str(ds_id),
            'name': (
                folder['name'] if folder else 'unknown'
            ),
            'addedDate': str(d['addedDate']),
        })

    for c in project['meta'].get('collections', []):
        coll_id = ObjectId(c['collectionId'])
        coll = colls_by_id.get(coll_id)
        manifest['collections'].append({
            'collectionId': str(coll_id),
            'name': (
                coll['name'] if coll else 'unknown'
            ),
            'addedDate': str(c['addedDate']),
        })

    return orjson.dumps(
        manifest, default=orJsonDefaults
    )


def _build_zenodo_metadata(project):
    """Map project metadata to Zenodo metadata schema."""
    meta = project['meta'].get('metadata', {})

    creators = []
    authors_str = meta.get('authors', '')
    if authors_str:
        for author in authors_str.split(','):
            name = author.strip()
            if name:
                creators.append({'name': name})
    if not creators:
        creators = [{'name': 'Unknown'}]

    # Map license to Zenodo format.  Fall back to
    # cc-by-4.0 for unrecognised values.
    license_map = {
        "CC-BY-4.0": "cc-by-4.0",
        "CC-BY-SA-4.0": "cc-by-sa-4.0",
        "CC-BY-NC-4.0": "cc-by-nc-4.0",
        "CC0-1.0": "cc-zero",
        "MIT": "mit-license",
        "Apache-2.0": "apache-2.0",
    }
    project_license = meta.get(
        'license', 'CC-BY-4.0'
    )
    zenodo_license = license_map.get(
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
