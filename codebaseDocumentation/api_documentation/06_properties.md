# Property Values

## Overview

Property values are computed measurements attached to annotations (e.g., intensity, area, distance). They are stored separately from annotations and keyed by a `propertyId`.

## Property Worker Pattern

Property workers follow a standard structure:

```python
def compute(datasetId, apiUrl, token, params):
    # params contains:
    #   'id': propertyId (string, server-assigned)
    #   'name': property display name
    #   'tags': {'tags': [...], 'exclusive': bool}
    #   'workerInterface': {user-supplied values}
    #   'scales': {'pixelSize': {'unit': 'mm', 'value': 0.000219}, 'tStep': ..., 'zStep': ...}

    workerClient = workers.UPennContrastWorkerClient(datasetId, apiUrl, token, params)
    # workerClient.propertyId == params['id']
```

## UPennContrastWorkerClient for Properties

**Source**: `annotation_client/workers.py`

```python
class UPennContrastWorkerClient:
    def __init__(self, datasetId, apiUrl, token, params):
        self.propertyId = params.get('id', 'unknown_property')
        self.annotationClient = UPennContrastAnnotationClient(apiUrl, token)
        self.datasetClient = UPennContrastDataset(apiUrl, token, datasetId)

    def get_annotation_list_by_shape(self, shape, limit=50, offset=0):
        """Get all annotations of a given shape in the dataset."""

    def get_annotation_list_by_id(self):
        """Get specific annotations by IDs from params['annotationIds']."""

    def get_image_for_annotation(self, annotation):
        """Get the image at the annotation's location. Uses caching."""

    def add_annotation_property_values(self, annotation, values):
        """Add property values for a single annotation."""

    def add_multiple_annotation_property_values(self, values):
        """Add property values for multiple annotations in bulk."""
```

## Computing and Submitting Property Values

### Simple flat properties (blob_metrics)

```python
workerClient = workers.UPennContrastWorkerClient(datasetId, apiUrl, token, params)

annotationList = workerClient.get_annotation_list_by_shape('polygon', limit=0)
annotationList = annotation_tools.get_annotations_with_tags(
    annotationList,
    params.get('tags', {}).get('tags', []),
    params.get('tags', {}).get('exclusive', False)
)

property_value_dict = {}
for annotation in annotationList:
    prop = {
        'Area': float(poly.area),
        'Perimeter': float(poly.length),
        'Circularity': float(4 * np.pi * poly.area / (poly.length ** 2)),
        'Elongation': float(elongation),
        # ... more metrics
    }
    property_value_dict[annotation['_id']] = prop

# Wrap with datasetId and submit
dataset_property_value_dict = {datasetId: property_value_dict}
workerClient.add_multiple_annotation_property_values(dataset_property_value_dict)
```

### Intensity properties with image access (blob_intensity)

```python
workerClient = workers.UPennContrastWorkerClient(datasetId, apiUrl, token, params)
datasetClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

channel = params['workerInterface']['Channel']

# Group by location for efficient image loading
grouped = defaultdict(list)
for annotation in annotationList:
    key = (annotation['location']['Time'], annotation['location']['Z'], annotation['location']['XY'])
    grouped[key].append(annotation)

property_value_dict = {}
for (time, z, xy), anns in grouped.items():
    frame = datasetClient.coordinatesToFrameIndex(xy, z, time, channel)
    image = datasetClient.getRegion(datasetId, frame=frame)

    for annotation in anns:
        # Extract polygon mask
        polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
        rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
        intensities = image[rr, cc]

        property_value_dict[annotation['_id']] = {
            'MeanIntensity': float(np.mean(intensities)),
            'MaxIntensity': float(np.max(intensities)),
            'MinIntensity': float(np.min(intensities)),
            'MedianIntensity': float(np.median(intensities)),
            '25thPercentileIntensity': float(np.percentile(intensities, 25)),
            '75thPercentileIntensity': float(np.percentile(intensities, 75)),
            'TotalIntensity': float(np.sum(intensities)),
        }

workerClient.add_multiple_annotation_property_values({datasetId: property_value_dict})
```

### Nested / Multi-dimensional properties (blob_intensity with Z planes)

When computing values across multiple Z planes, properties become nested dicts:

```python
# Initialize nested structure
for annotation in annotationList:
    property_value_dict[annotation['_id']] = {
        'MeanIntensity': {},   # Will hold {'z001': val, 'z002': val, ...}
        'MaxIntensity': {},
        'TotalIntensity': {},
    }

# Fill in per Z-plane
for (time, xy), anns in grouped.items():
    for z in z_planes:
        z_key = f"z{(z+1):03d}"  # 1-based, zero-padded: "z001", "z002", ...

        frame = datasetClient.coordinatesToFrameIndex(xy, z, time, channel)
        image = datasetClient.getRegion(datasetId, frame=frame)

        for annotation in anns:
            # ... compute intensities ...
            property_value_dict[annotation['_id']]['MeanIntensity'][z_key] = float(mean)
            property_value_dict[annotation['_id']]['MaxIntensity'][z_key] = float(max_val)
```

### Single annotation property values

For simpler cases (e.g., point distance workers):

```python
workerClient.add_annotation_property_values(annotation, distance_value)
# This wraps the value with the propertyId and calls addAnnotationPropertyValues
```

## Bulk Submission Internals

`add_multiple_annotation_property_values` reformats the nested dict into a list:

```python
# Input format:
{
    'datasetId': {
        'annotationId1': {'Area': 100, 'Perimeter': 50},
        'annotationId2': {'Area': 200, 'Perimeter': 80},
    }
}

# Reformatted to:
[
    {'datasetId': 'datasetId', 'annotationId': 'annotationId1', 'values': {'propertyId': {'Area': 100, 'Perimeter': 50}}},
    {'datasetId': 'datasetId', 'annotationId': 'annotationId2', 'values': {'propertyId': {'Area': 200, 'Perimeter': 80}}},
]
```

This is then sent to `/annotation_property_values/multiple` in batches of 10,000 to avoid MongoDB's 16MB document limit.

## Creating Properties Programmatically

Most property workers don't need to create properties — the property already exists in the configuration because the user set it up in the UI before running the worker. However, some workers (notably the AI analysis worker) need to **create new properties from code** and register them with the dataset's configuration.

This is a 3-step process:

### Step 1: Create the property definition

```python
annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)

new_property = {
    "image": "properties/none:latest",   # Docker image that computes this property (or "none")
    "name": "AI properties",             # Display name in the UI
    "shape": "polygon",                  # Which annotation shape this applies to
    "tags": {
        "exclusive": False,
        "tags": []                       # Tag filter (empty = all annotations)
    },
    "workerInterface": {}                # Interface parameters (empty if computed externally)
}

created_property = annotationClient.createNewProperty(new_property)
property_id = created_property['_id']
```

### Step 2: Add the property to dataset configurations

A property must be registered with the dataset's configuration(s) to appear in the UI:

```python
def add_property_to_all_configurations(annotationClient, datasetId, property_id):
    """Register a property with all configurations that reference this dataset."""
    config_list = annotationClient.getDatasetViewsByDatasetId(datasetId)

    for config in config_list:
        config_id = config['configurationId']
        configuration = annotationClient.getItemById(config_id)

        if property_id not in configuration['meta']['propertyIds']:
            configuration['meta']['propertyIds'].append(property_id)
            annotationClient.setPropertiesByConfigurationId(
                config_id, configuration['meta']['propertyIds']
            )
```

### Step 3: Submit property values using the new property ID

```python
# Build property value entries
property_values = []
for annotation_id, values_dict in computed_values.items():
    property_values.append({
        'annotationId': annotation_id,
        'datasetId': datasetId,
        'values': {
            property_id: values_dict  # {column_name: value, ...}
        }
    })

annotationClient.addMultipleAnnotationPropertyValues(property_values)
```

### Finding an existing property by name (get-or-create pattern)

```python
def get_or_create_property(annotationClient, datasetId, property_name):
    """Find a property by name, or create it if it doesn't exist."""
    # Get all properties from all configurations
    property_ids = set()
    for config in annotationClient.getDatasetViewsByDatasetId(datasetId):
        config_id = config['configurationId']
        configuration = annotationClient.getItemById(config_id)
        property_ids.update(configuration['meta'].get('propertyIds', []))

    # Check if property already exists
    for prop_id in property_ids:
        prop = annotationClient.getPropertyById(prop_id)
        if prop['name'] == property_name:
            return prop['_id']

    # Create new property
    new_prop = annotationClient.createNewProperty({
        "image": "properties/none:latest",
        "name": property_name,
        "shape": "polygon",
        "tags": {"exclusive": False, "tags": []},
        "workerInterface": {}
    })
    return new_prop['_id']
```

### Relevant API methods

| Method | Purpose |
|--------|---------|
| `annotationClient.createNewProperty(property)` | Create a property definition in the database |
| `annotationClient.getPropertyById(propertyId)` | Fetch a property definition by ID |
| `annotationClient.getDatasetViewsByDatasetId(datasetId)` | Get all configurations referencing a dataset |
| `annotationClient.getItemById(configId)` | Get configuration details (includes `meta.propertyIds`) |
| `annotationClient.setPropertiesByConfigurationId(configId, propertyIdList)` | Update which properties a configuration displays |
| `annotationClient.deleteAnnotationPropertyValues(propertyId, datasetId)` | Delete all values for a property in a dataset |

### Property definition schema

```python
{
    "_id": "server_assigned_id",
    "name": "Display Name",
    "image": "properties/blob_intensity:latest",  # Docker image
    "shape": "polygon",                            # "polygon", "point", "line"
    "tags": {
        "exclusive": False,
        "tags": ["nucleus"]                        # Filter annotations by tags
    },
    "workerInterface": {                           # Saved interface parameter values
        "Channel": 1,
        "Z planes": "1-3"
    }
}
```

**Source**: This pattern is primarily used in `workers/annotations/ai_analysis/entrypoint.py` (the Claude natural language analyzer), which is currently the only worker that creates properties programmatically.

## Reading Property Values

```python
# All property values in a dataset
all_values = annotationClient.getPropertyValuesForDataset(datasetId)

# Property values for a specific annotation
values = annotationClient.getPropertyValuesForAnnotation(datasetId, annotationId)

# Property histogram
histogram = annotationClient.getPropertyHistogram(propertyPath, datasetId, buckets=255)
```

## Deleting Property Values

```python
annotationClient.deleteAnnotationPropertyValues(propertyId, datasetId)
```

## Physical Units

Workers receive pixel scale in `params['scales']`:

```python
pixelSize = params['scales']['pixelSize']  # {'unit': 'mm', 'value': 0.000219}
tStep = params['scales']['tStep']          # {'unit': 's', 'value': 1}
zStep = params['scales']['zStep']          # {'unit': 'm', 'value': 1}

# Convert units
from annotation_utilities.units import convert_units
pixelSize_um = convert_units(pixelSize, 'µm')  # {'unit': 'µm', 'value': 0.219}
pixel_length = pixelSize_um['value']

# Apply to measurements
area_in_um2 = float(poly.area) * pixel_length ** 2
perimeter_in_um = float(poly.length) * pixel_length
```
