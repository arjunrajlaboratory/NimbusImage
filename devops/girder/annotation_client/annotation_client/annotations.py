import girder_client
import json

PATHS = {
    "annotation": "/upenn_annotation/",
    "multiple_annotations": "/upenn_annotation/multiple",
    "annotation_by_id": "/upenn_annotation/{annotationId}",
    "annotation_by_dataset": "/upenn_annotation?datasetId={datasetId}",
    "connection": "/annotation_connection/",
    "multiple_connections": "/annotation_connection/multiple",
    "connection_by_id": "/annotation_connection/{connectionId}",
    "connect_to_nearest": "/annotation_connection/connectTo/",
    "property_by_id": "/annotation_property/{propertyId}",
    "property": "/annotation_property",
    "add_property_values": (
        "/annotation_property_values"
        "?datasetId={datasetId}"
        "&annotationId={annotationId}"
    ),
    "add_multiple_property_values": "/annotation_property_values/multiple",
    "get_dataset_properties_values": (
        "/annotation_property_values" "?datasetId={datasetId}"
    ),
    "get_annotation_property_values": (
        "/annotation_property_values"
        "?datasetId={datasetId}"
        "&annotationId={annotationId}"
    ),
    "delete_all_annotation_property_values": (
        "/annotation_property_values"
        "?propertyId={propertyId}"
        "&datasetId={datasetId}"
    ),
    "histogram": (
        "/annotation_property_values/histogram"
        "?propertyPath={propertyPath}"
        "&datasetId={datasetId}"
        "&buckets={buckets}"
    ),
    "dataset_views_by_dataset": "/dataset_view?datasetId={datasetId}",
    "item_by_id": "/item/{itemId}",
}


class UPennContrastAnnotationClient:
    """
    Helper class to exchange annotation related information from a remote
    UPennContrast girder instance.
    Most methods simply send a translated request to the girder API and return
    the result. No particular checks are done.
    """

    def __init__(self, apiUrl, token):
        """
        The constructor will initialize the client with the provided parameters

        :param str apiUrl: The api URL to the girder server
        :param str token: The girder token for authentication
        """

        self.client = girder_client.GirderClient(apiUrl=apiUrl)
        self.client.setToken(token)

    # Annotations

    def getAnnotationsByDatasetId(
        self, datasetId, shape=None, tags=None, limit=1_000_000, offset=0
    ):
        """
        Get the list of all annotations in the specified dataset

        :param str datasetId: The dataset's id
        :param str shape: optional filter by shape
        :return: A list of annotations
        """
        url = PATHS["annotation_by_dataset"].format(datasetId=datasetId)

        url = f"{url}&limit={limit}&offset{offset}"
        if shape:
            url = f"{url}&shape={shape}"
        if tags:
            url = f"{url}&tags={tags}"

        return self.client.get(url)

    def getAnnotationById(self, annotationId):
        """
        Get an annotation by its id

        :param str annotationId: The annotation's id
        :return: The annotation dict
        :rtype: dict
        """
        return self.client.get(
            PATHS["annotation_by_id"].format(annotationId=annotationId)
        )

    def createAnnotation(self, annotation):
        """
        Create an annotation with the specified metadata.
        The annotation data should match the standard UPennContrast annotation
        schema
        Note: you can add an additional 'properties' field to the annotation
        to directly specify property values.
        The 'properties' field will be extracted and added to the property
        values in the database.

        :param dict annotation: The annotation metadata
        :return: The created annotation object (Note: will contain the _id
            field)
        :rtype: dict
        """
        return self.client.post(PATHS["annotation"], json=annotation)

    def createMultipleAnnotations(self, annotations):
        """
        Create multiple annotations with the specified metadata.
        The annotations data should match the standard UPennContrast
        annotation schema
        Note: you can add an additional 'properties' field to the annotation
        to directly specify property values.
        The 'properties' field will be extracted and added to the property
        values in the database.

        :param list annotations: The list of annotations metadata
        :return: The created annotation object (Note: will contain the _id
            field)
        :rtype: dict
        """
        return self.client.post(
            PATHS["multiple_annotations"], json=annotations
        )

    def deleteMultipleAnnotations(self, annotationIds):
        """
        Delete multiple annotations by their ids
        :param list annotationIds: The list of annotations ids
        """
        return self.client.sendRestRequest(
            'DELETE',
            PATHS["multiple_annotations"],
            json=annotationIds
        )

    def createMultipleConnections(self, connections):
        """
        Create multiple connections with the specified metadata.
        The connections data should match the standard UPennContrast
        connection schema

        :param list connections: The list of connections metadata
        :return: The created connection object (Note: will contain the _id
            field)
        :rtype: dict
        """
        return self.client.post(
            PATHS["multiple_connections"], json=connections
        )

    def deleteMultipleConnections(self, connectionIds):
        """
        Delete multiple connections by their ids
        :param list connectionIds: The list of connections ids
        """
        return self.client.sendRestRequest(
            'DELETE',
            PATHS["multiple_connections"],
            json=connectionIds
        )

    def updateAnnotation(self, annotationId, annotation):
        """
        Update an annotation with the specified metadata.
        The annotation data should match the standard UPennContrast annotation
        schema
        Note: you can add an additional 'properties' field to the annotation
        to directly specify property values.
        The 'properties' field will be extracted and added to the property
        values in the database.

        :param str annotationId: The annotation id
        :param dict annotation: The annotation metadata
        :return: The updated annotation object
        :rtype: dict
        """
        return self.client.put(
            PATHS["annotation_by_id"].format(annotationId=annotationId),
            json=annotation,
        )

    def deleteAnnotation(self, annotationId):
        """
        Delete an annotation by its id
        :param str annotationId: The annotation's id
        """
        return self.client.delete(
            PATHS["annotation_by_id"].format(annotationId=annotationId)
        )

    # Connections
    def getAnnotationConnections(
        self,
        datasetId=None,
        childId=None,
        parentId=None,
        nodeId=None,
        limit=50,
        offset=0,
    ):
        """
        Search for annotation connections with various parameters

        :param str datasetId: The dataset to which connections should belong
        :param str childId: Id of the annotation to which connections should
            point
        :param str parentId: Id of the annotation from which connections
            should point
        :param str nodeId: Id of the annotation that should be either a child
            or parent in the desired connections
        :return: The resulting list of connections
        :rtype: list
        """
        query = "?"
        if datasetId:
            query += "datasetId=" + str(datasetId) + "&"

        if childId:
            query += "childId=" + str(childId) + "&"

        if parentId:
            query += "parentId=" + str(parentId) + "&"

        if nodeId:
            query += "nodeId=" + str(nodeId) + "&"

        if limit:
            query += "limit=" + str(limit) + "&"

        if offset:
            query += "offset=" + str(offset) + "&"

        return self.client.get(
            PATHS["connection"] + query,
        )

    def getAnnotationConnectionById(self, connectionId=None):
        """
        Get a connection by its id

        :param str connectionId: The connection's id
        :return: The connection dict
        :rtype: dict
        """

        return self.client.get(
            PATHS["connection_by_id"].format(connectionId=connectionId)
        )

    def createConnection(self, connection):
        """
        Create a connection with the specified metadata.
        The connection dict should match the standard UPennContrast connection
        schema

        :param dict annotation: The connection metadata
        :return: The created connection object (Note: will contain the _id
            field)
        :rtype: dict
        """
        return self.client.post(PATHS["connection"], json=connection)

    def updateConnection(self, connectionId, connection):
        """
        Update an connection with the specified metadata.
        The connection data should match the standard UPennContrast connection
        schema

        :param str connectionId: The connection id
        :param dict connection: The connection metadata
        :return: The updated connection object
        :rtype: dict
        """
        return self.client.put(
            PATHS["connection_by_id"].format(connectionId=connectionId),
            json=connection,
        )

    def deleteConnection(self, connectionId):
        """
        Delete a connection by its id.
        :param str connectionId: The connection id
        """
        return self.client.delete(
            PATHS["connection_by_id"].format(connectionId=connectionId)
        )

    def connectToNearest(self, connectTo, annotationsIds):
        """
        Automatically create connections between a list of annotations and the
        nearest annotation of a specified tag.

        :param dict connectTo: A dict of connect to nearest specifications for
            tags and layer.
        :param list annotationsIds: Annotation ids to be connected.
        """
        body = {
            "annotationsIds": annotationsIds,
            "tags": connectTo["tags"],
            "channelId": connectTo["channel"],
        }

        return self.client.post(PATHS["connect_to_nearest"], json=body)

    # Properties
    def getPropertyById(self, propertyId):
        """
        Get a property by its id
        :param str propertyId: The property's id
        :return: The property dict
        :rtype: dict
        """
        return self.client.get(
            PATHS["property_by_id"].format(propertyId=propertyId)
        )

    def createNewProperty(self, property):
        """
        Add a property to the database
        :param dict property: The property to add
        """
        return self.client.post(PATHS["property"], json=property)

    # Property values
    def addAnnotationPropertyValues(self, datasetId, annotationId, values):
        """
        Save one or multiple computed property values for the specified
        annotation
        The recursive_dict_of_numbers can be (and usually is) just a number
        :param str datasetId: The dataset id
        :param str annotationId: The annotation id
        :param dict values: A dict of values - { [propertyId]:
            recursive_dict_of_numbers }
        """
        return self.client.post(
            PATHS["add_property_values"].format(
                datasetId=datasetId, annotationId=annotationId
            ),
            json=values,
        )

    def addMultipleAnnotationPropertyValues(self, entries):
        """
        Save one or multiple computed property values for the specified annotations in batches
        to avoid MongoDB's 16MB document size limit.

        :param list entries: A list of property values for annotations. Each entry is of type 
            { "datasetId": string, "annotationId": string,
            "values": { [propertyId: string]: recursive_dict_of_numbers } }
        """
        BATCH_SIZE = 10000  # AR: Have run into trouble with 140K entries.

        for i in range(0, len(entries), BATCH_SIZE):
            batch = entries[i:i + BATCH_SIZE]
            self.client.post(PATHS["add_multiple_property_values"], json=batch)

    def deleteAnnotationPropertyValues(self, propertyId, datasetId):
        """
        Delete one or multiple computed property values for the specified
        annotations
        :param str propertyId: The property id
        :param str datasetId: The dataset id
        """
        return self.client.delete(
            PATHS["delete_all_annotation_property_values"].format(
                propertyId=propertyId, datasetId=datasetId
            ),
        )

    def getPropertyHistogram(self, propertyPath, datasetId, buckets=255):
        """
        Get a histogram of the specified property across all annotations in
        the specified dataset
        :param str propertyPath: The property path:
            '.'.join([propertyId, subId0, subId1]). Usually the propertyId
        :param str datasetId: The dataset id
        :param str buckets: The number of buckets in the histogram
        :return: The list of bins
        :rtype: list
        """
        return self.client.get(
            PATHS["histogram"].format(
                propertyPath=propertyPath, datasetId=datasetId, buckets=buckets
            )
        )

    def getPropertyValuesForDataset(self, datasetId):
        """
        Get property values for all annotations in the specified dataset
        :param str datasetId:
        :return: All property values
        :rtype: list
        """
        return self.client.get(
            PATHS["get_dataset_properties_values"].format(datasetId=datasetId)
        )

    def getPropertyValuesForAnnotation(self, datasetId, annotationId):
        """
        Get property values for an annotation
        :param str datasetId: The id of the annotation's dataset
        :param str annotationId: The annotation's id
        :return: Property values for the annotation
        """
        return self.client.get(
            PATHS["get_annotation_property_values"].format(
                annotationId=annotationId, datasetId=datasetId
            )
        )

    def setPropertiesByConfigurationId(self, configurationId, propertyIdList):
        """
        Set the properties for a configuration
        :param str configurationId: The id of the configuration
        :param list propertyIdList: The list of property ids to set
        """
        metadata = json.dumps({"propertyIds": propertyIdList})

        params = {
            'metadata': metadata
        }

        return self.client.put(
            PATHS["item_by_id"].format(
                itemId=configurationId
            ),
            parameters=params
        )

    # Configurations

    def getItemById(self, itemId):
        """
        Get the item by id
        :param str itemId: The id of the item
        """
        return self.client.get(
            PATHS["item_by_id"].format(
                itemId=itemId
            )
        )

    def getDatasetViewsByDatasetId(self, datasetId):
        """
        Get the dataset views for a dataset
        :param str datasetId: The id of the dataset
        """
        return self.client.get(
            PATHS["dataset_views_by_dataset"].format(datasetId=datasetId)
        )
