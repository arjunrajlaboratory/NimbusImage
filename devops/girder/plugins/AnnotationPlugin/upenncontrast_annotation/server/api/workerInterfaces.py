from girder.api import access
from girder.api.describe import Description, describeRoute
from girder.api.rest import Resource
from ..models.workerInterfaces import WorkerInterfaceModel as InterfaceModel
from girder.exceptions import RestException
from girder import logger

import docker
from docker.errors import DockerException


class WorkerInterfaces(Resource):

    def __init__(self):
        super().__init__()
        self.dockerClient = None
        self.resourceName = "worker_interface"
        self._interfaceModel = InterfaceModel()

        self.route("GET", (), self.find)
        self.route("GET", ("available",), self.getAvailableImages)
        self.route("POST", (), self.update)
        self.route("POST", ("request",), self.requestWorkerUpdate)

    def getDockerClient(self):
        if self.dockerClient:
            return self.dockerClient
        try:
            self.dockerClient = docker.from_env()
            return self.dockerClient
        except DockerException:
            logger.error(
                "Could not connect to Docker client, jobs will be disabled.")
            return None

    @describeRoute(
        Description("Update an existing image interface")
        .param("image", "The docker image name for the worker.")
        .param(
            "body", "A JSON object describing the interface.", paramType="body"
        )
    )
    @access.user
    def update(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._interfaceModel.updateWorkerInterface(
            self.getCurrentUser(), image, self.getBodyJson()
        )

    @access.user
    @describeRoute(
        Description("Search for image interfaces").param(
            "image", "The docker image name for the worker."
        )
    )
    def find(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._interfaceModel.getImageInterface(image)

    @access.user
    @describeRoute(
        Description(
            "List available worker images and their corresponding labels"
        )
    )
    def getAvailableImages(self, params):
        dockerClient = self.getDockerClient()
        if not dockerClient:
            return {}

        images = dockerClient.images.list()

        def labelFilter(image):
            return "isUPennContrastWorker" in image.labels and image.tags

        def mapTagAndLabels(image):
            return (image.tags[0], image.labels)

        return dict(map(mapTagAndLabels, filter(labelFilter, images)))

    @access.user
    @describeRoute(
        Description("Ask the worker to update its interface data").param(
            "image", "The docker image name for the worker."
        )
    )
    def requestWorkerUpdate(self, params):
        if "image" not in params:
            raise RestException(code=400, message="Missing 'image' parameter")
        image = params.get("image")
        return self._interfaceModel.requestWorkerUpdate(image)
