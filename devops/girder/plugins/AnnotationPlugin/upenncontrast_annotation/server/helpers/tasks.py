from girder_worker.docker.tasks import docker_run

from girder.api.rest import getCurrentToken
from girder.models.setting import Setting

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


def runJobRequest(image, datasetId, params, request):
    name = params.get("name", "unknown")
    # Make sure name is a valid name for a docker container
    name = "".join(re.findall("[a-zA-Z0-9_.-]", name))
    params = json.dumps(params)

    containerArgs = [
        "--apiUrl",
        Setting().get("worker.api_url") or "http://localhost:8080/api/v1",
        "--token",
        getCurrentToken()["_id"],
        "--request",
        request,
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
                "name": "{}_{}_{}".format(
                    name, datasetId, datetime.datetime.now().timestamp()
                ),
                # 'girder_result_hooks': [testHook]
            },
            # Limit tasks execution to 24h to avoid blocking tasks that
            # monopolize a worker
            time_limit=24 * 60 * 60
        ).job,
    )
    return job
