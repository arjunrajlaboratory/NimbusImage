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

import orjson

from bson import ObjectId
from girder.constants import AccessType
from girder.models.file import File
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

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
from ..models.datasetView import (
    DatasetView as DatasetViewModel,
)
from ..models.project import Project as ProjectModel
from ..models.property import (
    AnnotationProperty as PropertyModel,
)
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)

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
            project_model, client,
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
    """Mark both the job and project as failed."""
    job_model.updateJob(
        job,
        status=JobStatus.ERROR,
        log=json.dumps({
            'error': error_msg,
            'title': 'Zenodo Upload Error',
        }) + '\n',
    )
    _update_zenodo_meta(project_id, project_model, {
        'status': 'error',
        'error': error_msg,
        'progress': None,
    })


def _update_zenodo_meta(project_id, project_model,
                        zenodo_data):
    """Update the project's meta.zenodo field."""
    update_zenodo_meta(
        project_id, zenodo_data,
        project_model=project_model,
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
            _update_zenodo_meta(
                project_id, project_model, {
                    'progress': {
                        'current': current,
                        'total': total,
                        'message': message,
                    },
                },
            )


def _do_upload(job, job_model, project, user, project_id,
               project_model, client):
    """Perform the full Zenodo upload."""
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
    _update_zenodo_meta(project_id, project_model, {
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
    })

    uploaded_files = []
    file_count = 0
    # Track used filenames to detect collisions.
    # In practice Girder enforces unique item names
    # within a folder, so collisions within a single
    # dataset cannot occur.  Cross-dataset collisions
    # (two datasets with the same folder name) are
    # possible in theory, so we guard against them by
    # appending the dataset ID on conflict.
    seen_filenames = set()

    # Count total files for progress — count actual
    # File documents, not Items, because one Item can
    # contain multiple Files (e.g. sidecar files).
    total_files = 0
    for d in project['meta']['datasets']:
        folder = Folder().load(
            d['datasetId'], force=True
        )
        if folder:
            items = list(Item().find(
                {'folderId': folder['_id']}
            ))
            for item in items:
                total_files += len(list(File().find(
                    {'itemId': item['_id']}
                )))
        total_files += 1  # annotation JSON
    total_files += len(
        project['meta']['collections']
    )
    total_files += 1  # manifest

    # Models for annotation export
    annotation_model = AnnotationModel()
    connection_model = ConnectionModel()
    collection_model = CollectionModel()
    dataset_view_model = DatasetViewModel()
    property_model = PropertyModel()
    property_values_model = PropertyValuesModel()

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
                msg = f"Uploading {f['name']}..."
                _report_progress(
                    job, job_model,
                    file_count, total_files, msg,
                    project_id=project_id,
                    project_model=project_model,
                )

                stream = File().download(
                    f, headers=False
                )
                filename = (
                    f"{folder_name}--{f['name']}"
                )
                if filename in seen_filenames:
                    filename = (
                        f"{folder_name}"
                        f"__{dataset_id}"
                        f"--{f['name']}"
                    )
                seen_filenames.add(filename)
                result = client.upload_file(
                    bucket_url, filename, stream(),
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
            dataset_id, annotation_model,
            connection_model, collection_model,
            dataset_view_model, property_model,
            property_values_model,
        )
        ann_filename = (
            f"{folder_name}_annotations.json"
        )
        if ann_filename in seen_filenames:
            ann_filename = (
                f"{folder_name}"
                f"__{dataset_id}"
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
            'datasetId': str(dataset_id),
        })

    # Upload collection configs
    for c in project['meta']['collections']:
        coll_id = c['collectionId']
        coll = collection_model.load(
            coll_id, force=True
        )
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

        config_json = _build_collection_config(
            coll_id, collection_model,
        )
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
        project, uploaded_files, collection_model,
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

    # Done - mark as draft (ready to publish)
    _update_zenodo_meta(project_id, project_model, {
        'depositionId': dep_id,
        'depositionUrl': deposition['links']['html'],
        'status': 'draft',
        'sandbox': client.base_url != (
            "https://zenodo.org"
        ),
        'progress': None,
    })

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
    collection_model, dataset_view_model,
    property_model, property_values_model,
):
    """Build annotation export JSON for a dataset."""
    ds_oid = (
        ObjectId(dataset_id)
        if isinstance(dataset_id, str)
        else dataset_id
    )

    annotations = list(
        annotation_model.find({'datasetId': ds_oid})
    )
    connections = list(
        connection_model.find({'datasetId': ds_oid})
    )

    dataset_views = list(
        dataset_view_model.collection.find(
            {'datasetId': ds_oid}
        )
    )
    config_ids = {
        dv['configurationId'] for dv in dataset_views
    }
    property_ids = set()
    for config_id in config_ids:
        config = collection_model.load(
            config_id, force=True
        )
        if (config and 'meta' in config
                and 'propertyIds' in config['meta']):
            for pid in config['meta']['propertyIds']:
                property_ids.add(ObjectId(pid))

    properties = []
    if property_ids:
        properties = list(property_model.find(
            {'_id': {'$in': list(property_ids)}}
        ))

    prop_values = {}
    cursor = property_values_model.find(
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


def _build_collection_config(collection_id,
                             collection_model):
    """Build a JSON config export for a collection."""
    coll = collection_model.load(
        collection_id, force=True
    )
    if not coll:
        return orjson.dumps({})
    data = {
        'name': coll.get('name', ''),
        'description': coll.get('description', ''),
        'meta': coll.get('meta', {}),
    }
    return orjson.dumps(data, default=orJsonDefaults)


def _build_manifest(project, uploaded_files,
                    collection_model):
    """Build a manifest JSON describing the project."""
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
        coll = collection_model.load(
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
