from girder_worker.docker.tasks import docker_run

from girder.api.rest import getCurrentToken
from girder.models.setting import Setting

from .workerQueues import getQueueForRequest

import datetime
import json
import re

# TODO: security: disable pickle, never pull images ?
# accept_content = ['json', 'yaml', 'girder_io']
# app.conf.update(
#   CELERY_ACCEPT_CONTENT = accept_content,
#      CELERY_TASK_SERIALIZER = 'json',
#      CELERY_RESULT_SERIALIZER = 'json',
# )


def runJobRequest(image, datasetId, params, requestType, jobTitle=None):
    # The container name and the job title are derived separately: docker
    # only accepts [a-zA-Z0-9_.-] in a name, while the title is shown to
    # users in Jobs & Logs and can keep spaces, "/" and ":". Requests with
    # no name of their own (interface requests) pass an explicit jobTitle,
    # and fall back to the request type rather than a bare "unknown".
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        name = requestType
    containerName = "_".join(
        str(part)
        for part in (
            "".join(re.findall("[a-zA-Z0-9_.-]", name)) or requestType,
            datasetId,
            datetime.datetime.now().timestamp(),
        )
        if part
    )
    params = json.dumps(params)

    containerArgs = [
        "--apiUrl",
        Setting().get("worker.api_url") or "http://localhost:8080/api/v1",
        "--token",
        getCurrentToken()["_id"],
        "--request",
        requestType,
        "--parameters",
        params,
    ]
    if datasetId:
        containerArgs.append("--datasetId")
        containerArgs.append(datasetId)

    job = (
        docker_run.apply_async(
            (image,),
            kwargs={
                "pull_image": False,
                "container_args": containerArgs,
                "remove_container": True,
                "name": containerName,
                "girder_job_title": jobTitle or name,
                # 'girder_result_hooks': [testHook]
            },
            # Route to the "cpu" or "gpu" queue by worker class; interface
            # requests always go to "cpu" (see helpers/workerQueues.py).
            queue=getQueueForRequest(image, requestType),
            # Limit tasks execution to 24h to avoid blocking tasks that
            # monopolize a worker
            time_limit=24 * 60 * 60
        ).job,
    )
    return job
