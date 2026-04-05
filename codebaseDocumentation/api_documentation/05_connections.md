# Annotation Connections

## Overview

Connections represent parent-child relationships between annotations. They are stored as separate objects linking two annotation IDs.

## Connection Data Model

```python
{
    '_id': 'connection_id',
    'datasetId': 'dataset_folder_id',
    'parentId': 'parent_annotation_id',
    'childId': 'child_annotation_id',
    'tags': ['connection_tag']  # Optional
}
```

## Fetching Connections

```python
annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)

# All connections in a dataset
connections = annotationClient.getAnnotationConnections(datasetId=datasetId, limit=1000000)

# Connections for a specific annotation
as_child = annotationClient.getAnnotationConnections(childId=annotation_id)
as_parent = annotationClient.getAnnotationConnections(parentId=annotation_id)
either = annotationClient.getAnnotationConnections(nodeId=annotation_id)  # child OR parent

# By ID
connection = annotationClient.getAnnotationConnectionById(connectionId)

# Count
count = annotationClient.countConnectionsByDatasetId(datasetId)
```

## Creating Connections

### Single connection

```python
annotationClient.createConnection({
    'datasetId': datasetId,
    'parentId': parent_annotation_id,
    'childId': child_annotation_id,
    'tags': ['tracked']
})
```

### Multiple connections (bulk)

```python
new_connections = []
for parent_id, child_id in matched_pairs:
    new_connections.append({
        'datasetId': datasetId,
        'parentId': parent_id,
        'childId': child_id,
        'tags': combined_tags
    })

annotationClient.createMultipleConnections(new_connections)
```

### Connect to nearest (server-side)

After creating annotations, auto-connect each to the nearest annotation with specific tags:

```python
# connectTo comes from worker params
connectTo = params['connectTo']  # {'tags': ['nucleus'], 'channel': 0}

created = annotationClient.createMultipleAnnotations(out_annotations)
annotation_ids = [a['_id'] for a in created]

if len(connectTo['tags']) > 0:
    annotationClient.connectToNearest(connectTo, annotation_ids)
```

The `connectToNearest` method sends:
```python
{
    'annotationsIds': [list of new annotation IDs],
    'tags': ['nucleus'],       # Tags of annotations to connect to
    'channelId': 0              # Channel of target annotations
}
```

## Updating and Deleting Connections

```python
# Update
annotationClient.updateConnection(connectionId, updated_connection_dict)

# Delete single
annotationClient.deleteConnection(connectionId)

# Delete multiple
annotationClient.deleteMultipleConnections([id1, id2, id3])
```

## Common Pattern: Connect Across Time (connect_timelapse worker)

```python
# For each time point, find objects and connect them to the nearest
# object at the next time point
for t in range(num_time - 1):
    current = filter_elements_T_XY(annotations, time_value=t, xy_value=xy)
    next_frame = filter_elements_T_XY(annotations, time_value=t+1, xy_value=xy)

    # Use spatial matching (e.g., nearest centroid)
    for curr_ann in current:
        nearest = find_nearest(curr_ann, next_frame)
        connections.append({
            'datasetId': datasetId,
            'parentId': curr_ann['_id'],
            'childId': nearest['_id'],
            'tags': ['time_tracked']
        })

annotationClient.createMultipleConnections(connections)
```
