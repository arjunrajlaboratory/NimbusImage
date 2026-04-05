# Annotations

## Class: `UPennContrastAnnotationClient`

**Source**: `annotation_client/annotations.py`

## Annotation Data Model

An annotation is a dict with this structure:

```python
{
    '_id': '67f93a67ffbf435104bb1c8f',      # Server-assigned ID (present after creation)
    'tags': ['follicle', 'alive'],            # List of string tags
    'shape': 'polygon',                       # 'polygon', 'point', or 'line'
    'location': {'Time': 0, 'XY': 0, 'Z': 0},  # Position in the multidimensional dataset
    'channel': 0,                             # Channel index
    'coordinates': [                          # Shape-specific coordinates
        {'x': 357.45, 'y': 268.04},
        {'x': 347.11, 'y': 264.42},
        # ...
    ],
    'datasetId': '67f83afaf2173214b0e25fbb', # Parent dataset folder ID
    'color': None                             # Optional display color
}
```

### Coordinate formats by shape

**Polygon**: List of `{'x': float, 'y': float}` vertices (the polygon is implicitly closed):
```python
'coordinates': [{'x': 100.5, 'y': 200.5}, {'x': 150.5, 'y': 200.5}, {'x': 125.5, 'y': 250.5}]
```

**Point**: Single-element list with optional `z` for 3D:
```python
'coordinates': [{'x': 338.57, 'y': 427.34, 'z': 0}]
```

**Line**: List of `{'x': float, 'y': float}` vertices defining the line path:
```python
'coordinates': [{'x': 100.0, 'y': 200.0}, {'x': 300.0, 'y': 400.0}]
```

## Fetching Annotations

### All annotations in a dataset

```python
annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)

# Get all annotations (default limit is 1,000,000)
all_annotations = annotationClient.getAnnotationsByDatasetId(datasetId)
```

### Filtered by shape

```python
polygons = annotationClient.getAnnotationsByDatasetId(datasetId, shape='polygon', limit=0)
points = annotationClient.getAnnotationsByDatasetId(datasetId, shape='point', limit=0)
lines = annotationClient.getAnnotationsByDatasetId(datasetId, shape='line', limit=0)
```

**Important**: `limit=0` means unlimited. The default limit is 1,000,000, but some workers use `limit=10000000` for safety.

### Filtered by tags (server-side)

```python
import json
annotations_list = annotationClient.getAnnotationsByDatasetId(
    datasetId, shape='polygon', tags=json.dumps(['nucleus'])
)
```

### By annotation ID

```python
annotation = annotationClient.getAnnotationById(annotationId)
```

### Count annotations (without fetching)

```python
count = annotationClient.countAnnotationsByDatasetId(datasetId, shape='polygon')
# Returns: {'count': 544}
```

## Filtering Annotations (Client-Side)

Using `annotation_tools` for more flexible filtering:

```python
from annotation_utilities.annotation_tools import get_annotations_with_tags

# Inclusive: any annotation that has at least one matching tag
filtered = get_annotations_with_tags(annotation_list, ['nucleus', 'cell'], exclusive=False)

# Exclusive: only annotations whose tags exactly match the provided set
filtered = get_annotations_with_tags(annotation_list, ['nucleus'], exclusive=True)
```

### Filtering by location

```python
from annotation_utilities.annotation_tools import (
    filter_elements_T_XY,
    filter_elements_T_XY_Z,
    find_matching_annotations_by_location
)

# Filter to specific Time + XY
filtered = filter_elements_T_XY(annotations, time_value=0, xy_value=0)

# Filter to specific Time + XY + Z
filtered = filter_elements_T_XY_Z(annotations, time_value=0, xy_value=0, z_value=3)

# Flexible location matching
matching = find_matching_annotations_by_location(
    source_annotation, target_list,
    Time=True, XY=True, Z=False  # Match Time and XY, ignore Z
)
```

## Via WorkerClient (Property Workers)

Property workers typically use `UPennContrastWorkerClient` to get annotations:

```python
workerClient = workers.UPennContrastWorkerClient(datasetId, apiUrl, token, params)

# Get all polygons in the dataset
annotationList = workerClient.get_annotation_list_by_shape('polygon', limit=0)

# Then filter by tags from the worker params
annotationList = annotation_tools.get_annotations_with_tags(
    annotationList,
    params.get('tags', {}).get('tags', []),
    params.get('tags', {}).get('exclusive', False)
)
```

**Note**: In property workers, `params['tags']` is a dict `{'tags': [...], 'exclusive': bool}`, NOT a plain list. This is different from annotation workers where `params['tags']` is a plain list of strings.

## Creating Annotations

### Single annotation

```python
annotation = annotationClient.createAnnotation({
    'tags': ['nucleus'],
    'shape': 'polygon',
    'channel': 0,
    'location': {'XY': 0, 'Z': 3, 'Time': 0},
    'datasetId': datasetId,
    'coordinates': [{'x': 100.0, 'y': 200.0}, {'x': 150.0, 'y': 200.0}, {'x': 125.0, 'y': 250.0}]
})
# Returns the created annotation dict with '_id' field
```

### Multiple annotations (bulk)

```python
out_annotations = []
for polygon in detected_polygons:
    out_annotations.append({
        'tags': ['detected'],
        'shape': 'polygon',
        'channel': channel,
        'location': {'XY': xy, 'Z': z, 'Time': time},
        'datasetId': datasetId,
        'coordinates': [{'x': float(x), 'y': float(y)} for x, y in polygon.exterior.coords],
    })

created = annotationClient.createMultipleAnnotations(out_annotations)
# Returns list of created annotation dicts with '_id' fields
annotation_ids = [a['_id'] for a in created]
```

## Updating Annotations

```python
annotationClient.updateAnnotation(annotationId, {
    'tags': ['nucleus', 'validated'],
    'shape': 'polygon',
    'channel': 0,
    'location': {'XY': 0, 'Z': 3, 'Time': 0},
    'datasetId': datasetId,
    'coordinates': updated_coords
})
```

## Deleting Annotations

```python
# Single
annotationClient.deleteAnnotation(annotationId)

# Multiple
annotationClient.deleteMultipleAnnotations([id1, id2, id3])
```

## Grouping Annotations by Location

Common pattern in property workers for efficient image loading:

```python
from collections import defaultdict

grouped = defaultdict(list)
for annotation in annotationList:
    location_key = (
        annotation['location']['Time'],
        annotation['location']['Z'],
        annotation['location']['XY']
    )
    grouped[location_key].append(annotation)

# Now iterate: load image once per location, process all annotations there
for (time, z, xy), annotations_at_location in grouped.items():
    frame = datasetClient.coordinatesToFrameIndex(xy, z, time, channel)
    image = datasetClient.getRegion(datasetId, frame=frame).squeeze()

    for annotation in annotations_at_location:
        # Process each annotation using the shared image
        ...
```

## Dataset Views / Configurations

```python
views = annotationClient.getDatasetViewsByDatasetId(datasetId)
# Returns list of dataset view objects with configurationId

config = annotationClient.getItemById(configurationId)
# Returns the configuration item with layers, properties, etc.
```
