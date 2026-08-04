"""Local Girder job that builds a dataset's Zarr columnar property store.

Invoked via ``createLocalJob(module=...)`` (same pattern as ``zenodo_job``).
Reads the dataset's property-value docs from Mongo, writes the AnnData-style
Zarr group, then flips the dataset's ``nimbusValueStore`` state to ``ready`` at
a bumped generation. On failure the state is marked ``dirty`` so reads fall
back to Mongo rather than serving a half-built store.

kwargs: ``datasetId``, ``userId``.
"""

import logging

from girder.models.folder import Folder
from girder.models.user import User
from girder_jobs.constants import JobStatus
from girder_jobs.models.job import Job

from . import valueStoreState as state
from . import zarrValueStore as store
from ..models.propertyValues import (
    AnnotationPropertyValues as PropertyValuesModel,
)

log = logging.getLogger(__name__)


def run(job):
    job_model = Job()
    job_model.updateJob(
        job,
        status=JobStatus.RUNNING,
        log="Building columnar property-value store...\n",
    )

    kwargs = job.get("kwargs", {})
    dataset_id = kwargs["datasetId"]
    user_id = kwargs["userId"]

    user = User().load(user_id, force=True)
    dataset = Folder().load(dataset_id, force=True)
    if not dataset or not user:
        _fail(job, job_model, dataset, "Dataset or user not found")
        return

    try:
        store.require_backend()
    except RuntimeError as exc:
        _fail(job, job_model, dataset, str(exc))
        return

    generation = state.get_generation(dataset) + 1
    try:
        state.mark_building(dataset)
        # Stream the dataset's value docs from Mongo. The compound
        # (datasetId, _id) index backs this scan.
        value_docs = PropertyValuesModel().find(
            {"datasetId": dataset["_id"]},
            fields={"_id": 0, "annotationId": 1, "values": 1},
        )
        rows, columns = store.build_store(
            dataset["_id"], value_docs, generation
        )
        # Reload: mark_building persisted a metadata change, so the in-memory
        # doc is stale for the next write.
        dataset = Folder().load(dataset_id, force=True)
        state.mark_ready(dataset, generation, rows, columns)
        job_model.updateJob(
            job,
            status=JobStatus.SUCCESS,
            log="Built store: %d annotations x %d columns (gen %d).\n"
            % (rows, columns, generation),
        )
    except Exception as exc:
        log.exception("Zarr value store build failed")
        _fail(job, job_model, dataset, "Build failed: %s" % exc)


def _fail(job, job_model, dataset, message):
    if dataset is not None:
        try:
            # Reload before writing: earlier transitions in this run mutated
            # the folder metadata.
            fresh = Folder().load(dataset["_id"], force=True)
            if fresh is not None:
                state.mark_dirty(fresh)
        except Exception:
            log.exception("Failed to mark dataset dirty after build failure")
    job_model.updateJob(
        job,
        status=JobStatus.ERROR,
        log=message + "\n",
    )
