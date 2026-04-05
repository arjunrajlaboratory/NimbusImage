# Annotation Utilities

**Source**: `annotation_utilities/annotation_utilities/`

Helper functions that operate on annotation data structures. These do not make API calls — they work on annotation dicts already fetched from the server.

## annotation_tools.py

### Coordinate Conversions

These handle the critical x/y swap between NimbusImage annotations and numpy/shapely:

```python
from annotation_utilities.annotation_tools import (
    annotations_to_polygons, polygons_to_annotations,
    annotations_to_points, points_to_annotations
)
```

**annotations_to_polygons**: Annotation dicts to shapely Polygons
```python
polygons = annotations_to_polygons(annotation_list)
# or for a single annotation:
polygons = annotations_to_polygons(single_annotation)
# Internally: coords = [(point['x'], point['y']) for point in annotation['coordinates']]
# Note: does NOT swap x/y — treats x,y from annotation as-is for shapely
```

**polygons_to_annotations**: Shapely Polygons to annotation dicts
```python
annotations = polygons_to_annotations(
    polygons, datasetId,
    XY=0, Time=0, Z=0, tags=['detected'], channel=0
)
# Internally: coordinates = [{'x': float(y), 'y': float(x)} for x, y in polygon.exterior.coords]
# Note: DOES swap x/y when going from shapely back to annotation format
```

**annotations_to_points**: Annotation dicts to shapely Points
```python
points = annotations_to_points(annotation_list)
# Internally: y, x = coords['x'], coords['y']  — swaps x/y
# Returns: list of shapely Point(x, y) where x,y are in numpy row,col order
```

**points_to_annotations**: Shapely Points to annotation dicts
```python
annotations = points_to_annotations(
    points, datasetId,
    XY=0, Time=0, Z=0, tags=['detected'], channel=0
)
# Internally: coordinates = [{'x': point.y, 'y': point.x}]
```

### Tag Filtering

```python
from annotation_utilities.annotation_tools import (
    get_annotations_with_tags,
    get_annotations_with_tag
)

# Multi-tag inclusive (any matching tag)
filtered = get_annotations_with_tags(annotations, ['nucleus', 'cell'], exclusive=False)

# Multi-tag exclusive (exact tag set match)
filtered = get_annotations_with_tags(annotations, ['nucleus'], exclusive=True)

# Special case: empty tags + non-exclusive returns ALL annotations
filtered = get_annotations_with_tags(annotations, [], exclusive=False)  # returns all

# Single tag
filtered = get_annotations_with_tag(annotations, 'nucleus', exclusive=False)
```

### Location Filtering

```python
from annotation_utilities.annotation_tools import (
    filter_elements_T_XY,
    filter_elements_T_XY_Z,
    filter_elements_Z_XY,
    find_matching_annotations_by_location
)

# Filter by Time + XY
filtered = filter_elements_T_XY(annotations, time_value=0, xy_value=0)

# Filter by Time + XY + Z
filtered = filter_elements_T_XY_Z(annotations, time_value=0, xy_value=0, z_value=3)

# Filter by Z + XY
filtered = filter_elements_Z_XY(annotations, z_value=3, xy_value=0)

# Flexible location matching against a source annotation
matching = find_matching_annotations_by_location(
    source_annotation, target_list,
    Time=True, XY=True, Z=False  # Match Time and XY, any Z
)
```

### Multi-Channel Image Helpers

```python
from annotation_utilities.annotation_tools import (
    get_images_for_all_channels,
    get_layers,
    process_and_merge_channels
)

# Load all channels at a location
images = get_images_for_all_channels(tileClient, datasetId, XY=0, Z=0, Time=0)
# Returns: list of numpy arrays

# Get layer/contrast settings from the user's saved configuration
layers = get_layers(tileClient.client, datasetId)
# Returns: list of layer dicts with 'channel', 'visible', 'color', 'contrast' keys
# Note: takes the FIRST configuration found — datasets can belong to multiple configs

# Merge channels into RGB composite
merged = process_and_merge_channels(images, layers, mode='lighten')
# Returns: (H, W, 3) float64 array, values 0-1
# Supported modes: 'lighten' (max), 'add' (sum+clip), 'screen'
```

Layer structure:
```python
{
    'channel': 0,
    'visible': True,
    'color': '#ff0000',
    'contrast': {
        'mode': 'percentile',  # or 'absolute'
        'blackPoint': 0,       # percentile or absolute value
        'whitePoint': 100      # percentile or absolute value
    }
}
```

## batch_argument_parser.py

Parses user-entered range strings like "1-3, 5-8":

```python
from annotation_utilities.batch_argument_parser import process_range_list, get_batch_information

# Parse a range string (returns generator)
z_indices = process_range_list("1-3, 5-8", convert_one_to_zero_index=True)
# Yields: 0, 1, 2, 4, 5, 6, 7

z_indices = process_range_list("1-3, 5-8", convert_one_to_zero_index=False)
# Yields: 1, 2, 3, 5, 6, 7, 8

# Returns None for empty/None input
result = process_range_list(None)   # None
result = process_range_list('')     # None

# Convenience: extract batch info from worker params
batch_xy, batch_z, batch_time = get_batch_information(
    tile, workerInterface, 'Batch XY', 'Batch Z', 'Batch Time'
)
```

## units.py

Convert between physical units:

```python
from annotation_utilities.units import convert_units

result = convert_units({'unit': 'mm', 'value': 0.000219}, 'µm')
# Returns: {'unit': 'µm', 'value': 0.219}

# Supported units: 'm', 'mm', 'µm', 'nm'
```

## progress.py

Rate-limited progress reporting to avoid flooding the server:

```python
from annotation_utilities.progress import update_progress

# Only sends a message every 1% for large collections (>100 items)
for i, item in enumerate(items):
    # ... process ...
    update_progress(i + 1, len(items), "Processing annotations")
```

## point_in_polygon.py

Numba-accelerated point-in-polygon testing:

```python
from annotation_utilities.point_in_polygon import point_in_polygon

# points: (N, 2) numpy array of (x, y) coordinates
# polygon: (M, 2) numpy array of polygon vertices
is_inside = point_in_polygon(points, polygon)
# Returns: boolean array of length N
```

Uses `@njit(parallel=True)` for performance on large point sets.
