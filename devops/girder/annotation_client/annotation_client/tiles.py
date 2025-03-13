import pickle

import girder_client

PATHS = {
    "image": "/item/{datasetId}/tiles/fzxy/{frameIndex}/0/0/0",
    "item": "/item?folderId={datasetId}&limit=0",
    "region": "/item/{itemId}/tiles/region",
    "tiles": "/item/{datasetId}/tiles",
    "tilesInternal": "/item/{datasetId}/tiles/internal_metadata",
    "dataset": "/folder/{datasetId}",
}


class UPennContrastDataset:
    """
    Helper class to get tile images from a single dataset in a remote
    UPennContrast girder instance. Most methods simply send a translated
    request to the girder API and return the result. No particular checks
    are done.
    """

    def __init__(self, apiUrl, token, datasetId):
        """
        The constructor will initialize the client, and fetch necessary
        dataset information

        :param str apiUrl: The api URL to the girder server
        :param str token: The girder token for authentication
        :param str datasetId: The id of the dataset from which images are
            downloaded
        """
        # TODO: The naming conventions in this class are confusing.
        # For instance, self.datasetId is the largeImageId, not the datasetId
        self.client = girder_client.GirderClient(apiUrl=apiUrl)
        self.client.setToken(token)

        self.folderId = datasetId
        # Get the dataset item's id
        self.dataset = self.getDataset(datasetId)
        self.datasetId = self.dataset["_id"]

        self.tiles = self.getTilesForDataset(self.datasetId)
        self.map = self.buildMap(self.tiles.get("frames", None))

        self.tilesInternal = self.getTilesInternalForDataset(self.datasetId)

    def buildMap(self, frames):
        """
        Maps Channel, XY, Z and Time locations to frame indexes, for easier
        lookup further on

        :param frames: List of frames from the /item/{id}/tiles large_image
            girder endpoint (see getTilesForDataset)
        :return: A dict mapping from [channel][T][Z][XY] to a frame index
        :rtype: dict
        """

        if not frames:
            return {0: {0: {0: {0: 0}}}}

        map = {}
        for frame in frames:
            channel = frame.get("IndexC", 0)
            XY = frame.get("IndexXY", 0)
            Z = frame.get("IndexZ", 0)
            T = frame.get("IndexT", 0)
            index = frame["Frame"]

            map.setdefault(channel, {}).setdefault(T, {}).setdefault(
                Z, {}
            ).setdefault(XY, index)
        return map

    def getDataset(self, datasetId):
        """
        Fetch the actual dataset item from a dataset id

        :param str datasetId: The dataset directory id
        :return: The dataset item
        :rtype: dict
        """
        datasetInfo = self.client.get(
            PATHS["dataset"].format(datasetId=datasetId))

        items = self.client.get(PATHS["item"].format(datasetId=datasetId))

        # Check if the key "selectedLargeImageId" exists in datasetInfo["meta"]
        if "selectedLargeImageId" in datasetInfo["meta"]:
            dataset = next(filter(
                lambda item: item["_id"] ==
                datasetInfo["meta"]["selectedLargeImageId"], items))
        else:
            # If there is no selected large image id, then choose the first
            # large image in the dataset folder.
            dataset = next(filter(lambda item: "largeImage" in item, items))
        return dataset

    def getTilesForDataset(self, datasetId):
        """
        Get the tiles metadata for a dataset (/item/{id}/tiles)

        :param str datasetId: The dataset id
        :return: The tiles metadata
        :rtype: dict
        """
        return self.client.get(PATHS["tiles"].format(datasetId=datasetId))

    def getTilesInternalForDataset(self, datasetId):
        """
        Get the tiles internal metadata for a dataset
        (/item/{id}/tiles/internal_metadata)

        :param str datasetId: The dataset id
        :return: The tiles internal metadata
        :rtype: dict
        """
        return self.client.get(
            PATHS["tilesInternal"].format(datasetId=datasetId)
        )

    def coordinatesToFrameIndex(self, XY, Z=0, T=0, channel=0):
        """
        Maps XY, Time, Z and Channel coordinates to frame indexes
        :param int XY: The XY value
        :param int Z: The Z value
        :param int T: The Time value
        :param int : The Channel value
        :return: The index of the frame to fetch for these coordinates
        :rtype: int
        """
        return self.map[channel][T][Z][XY]

    def getRawImage(self, XY, Z=0, T=0, channel=0):
        """
        Download the image at the specified coordinates
        :param int XY: The XY value
        :param int Z: The Z value
        :param int T: The Time value
        :param int : The Channel value
        :return: The downloaded image as a binary buffer
        """
        frameIndex = self.coordinatesToFrameIndex(XY, Z, T, channel)
        response = self.client.get(
            PATHS["image"].format(
                datasetId=self.datasetId, frameIndex=frameIndex
            ),
            jsonResp=False,
        )
        return response.content

    def getRegion(
        self,
        datasetId=None,
        refreshImage=False,
        protocol=pickle.HIGHEST_PROTOCOL,
        use_tiff=False,
        **kwargs
    ):
        """
        Get a region of the dataset as a numpy array.

        The kwargs can be any value that the large_image item/{id}/tiles/region
        endpoint supports:
        Frame number (this gets a specific c/z/xy/t):
            frame
        Area in the image:
            left top right bottom width height units unitsWH
        Output array size:
            regionWidth regionHeight magnification mm_x mm_y exact resample
        Options that you probably don't want in this context:
            fill style

        :param str datasetId: The dataset id.  None to use the value used when
            instantiating the class.
        :param bool refreshImage: Whether to refresh the largeImageId from the
            server or use the cached version.
        :param bool use_tiff: Whether to request TIFF format instead of pickle
        :return: The tiles metadata as a numpy array
        :rtype: numpy.ndarray
        """
        if (
            datasetId is None
            or datasetId == self.datasetId
            or datasetId == self.dataset["folderId"]
            or refreshImage is False
        ):
            itemId = self.datasetId
        else:
            itemId = self.getDataset(datasetId)["_id"]

        params = kwargs.copy()

        if use_tiff:
            import io
            import tifffile
            import numpy as np

            # Request TILED format (which is the TIFF option from your dropdown)
            params["encoding"] = "TILED"
            params.pop("format", None)

            # Get the TIFF image data
            response = self.client.get(
                PATHS["region"].format(itemId=itemId),
                parameters=params,
                jsonResp=False,
            )

            # Convert TIFF to numpy array using tifffile
            return tifffile.imread(io.BytesIO(response.content))
        else:
            # Use pickle protocol
            params["encoding"] = "pickle:" + str(protocol)
            params.pop("format", None)
            return pickle.loads(
                self.client.get(
                    PATHS["region"].format(itemId=itemId),
                    parameters=params,
                    jsonResp=False,
                ).content
            )
