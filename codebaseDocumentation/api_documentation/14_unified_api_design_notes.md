# Design Notes for the Unified `ni` Package

## Goals

1. **Single import**: `import nimbusimage as ni` (or `import ni`)
2. **Clean up the coordinate mess**: handle x/y swaps and 0.5 offsets internally
3. **Simplify image access**: no `.squeeze()`, no `coordinatesToFrameIndex` boilerplate
4. **Hide girder_client**: it's an implementation detail, not part of the user-facing API
5. **Support both worker and notebook contexts**: workers need messaging; notebooks don't
6. **Prepare for MCP integration**: clean, well-documented methods that an MCP server can wrap
7. **Prepare for Claude Code skill**: the API should be predictable enough that a skill can guide correct usage

## Proposed Module Structure

```
nimbusimage/
├── __init__.py          # ni.connect(), top-level exports
├── client.py            # NimbusClient — authenticated session
├── dataset.py           # Dataset — image + annotation access for one dataset
├── annotations.py       # Annotation, Connection — data classes + operations
├── properties.py        # Property, PropertyValue — property computation helpers
├── images.py            # Image access helpers, compositing
├── coordinates.py       # Coordinate system conversions (absorbs x/y swap + 0.5 offset)
├── worker.py            # Worker-specific helpers (interface, messaging, batch processing)
└── utils.py             # Units, progress, batch range parsing
```

## Core API Surface

### Connection

```python
import nimbusimage as ni

# Username/password (notebooks)
client = ni.connect('http://localhost:8080/api/v1', username='user', password='pass')

# Token (workers)
client = ni.connect('http://localhost:8080/api/v1', token='...')

# Environment variables
client = ni.connect()  # reads NI_API_URL, NI_TOKEN
```

### Dataset Access

```python
# List datasets
datasets = client.list_datasets()
# Returns: [{'name': '...', 'id': '...', ...}, ...]

# Open a dataset
ds = client.dataset('datasetId')
# or
ds = client.dataset(name='My Dataset Name')

# Dataset metadata
ds.num_channels    # 2
ds.num_z           # 7
ds.num_time        # 4
ds.num_xy          # 6
ds.channels        # ['Brightfield', 'YFP']
ds.pixel_size      # {'unit': 'mm', 'value': 0.000219}
ds.shape           # (1022, 1024)
ds.dtype           # 'uint16'
```

### Image Access

```python
# Single image (returns clean numpy array, no squeeze needed)
image = ds.get_image(xy=0, z=3, time=0, channel=1)

# Cropped region
image = ds.get_image(xy=0, z=3, time=0, channel=1,
                     crop=(left, top, right, bottom))

# All channels at a location
images = ds.get_all_channels(xy=0, z=3, time=0)  # list of arrays

# Multi-channel composite (uses saved layer/contrast settings from UI)
rgb = ds.get_composite(xy=0, z=3, time=0, mode='lighten')

# As uint8 RGB (for vision models like SAM)
rgb_uint8 = ds.get_composite(xy=0, z=3, time=0, mode='lighten', dtype='uint8')

# Z-stack
z_stack = ds.get_stack(xy=0, time=0, channel=1, axis='z')  # (Z, H, W) array

# Time series
time_series = ds.get_stack(xy=0, z=0, channel=1, axis='time')  # (T, H, W) array

# Iterate all frames
for frame_info, image in ds.iter_frames():
    # frame_info: {'xy': 0, 'z': 0, 'time': 0, 'channel': 0}
    # image: numpy array
    pass
```

### Annotations

```python
# Fetch annotations
annotations = ds.get_annotations(shape='polygon', tags=['nucleus'])
annotations = ds.get_annotations(shape='point', limit=1000)

# Annotation objects have clean properties
ann = annotations[0]
ann.id           # '67f93a67ffbf435104bb1c8f'
ann.tags         # ['follicle', 'alive']
ann.shape        # 'polygon'
ann.location     # Location(xy=0, z=0, time=0)
ann.channel      # 0
ann.polygon      # shapely Polygon (with correct coordinate handling)
ann.coordinates  # raw coordinate dicts (for backward compatibility)

# Get the image at an annotation's location
image = ann.get_image(channel=1)

# Get pixel mask for a polygon annotation
mask = ann.get_mask(image.shape)  # boolean array
rr, cc = ann.get_pixels(image.shape)  # row, col arrays

# Create annotations
new_annotations = []
for poly in detected_polygons:
    new_annotations.append(ni.Annotation(
        shape='polygon',
        polygon=poly,  # shapely Polygon — coordinates handled internally
        tags=['detected'],
        channel=0,
        location=ni.Location(xy=0, z=3, time=0),
    ))

ds.create_annotations(new_annotations)
# or
ds.create_annotations(new_annotations, connect_to={'tags': ['nucleus'], 'channel': 0})
```

### Properties

```python
# Compute and submit
properties = {}
for ann in ds.get_annotations(shape='polygon', tags=['nucleus']):
    image = ann.get_image(channel=1)
    intensities = image[ann.get_mask(image.shape)]
    properties[ann.id] = {
        'MeanIntensity': float(np.mean(intensities)),
        'MaxIntensity': float(np.max(intensities)),
    }

ds.submit_properties(property_id, properties)

# Read back
values = ds.get_property_values()
ann_values = ds.get_property_values(annotation_id=ann.id)
```

### Property Definitions (not just values)

The current API distinguishes between **properties** (the definition/schema) and **property values** (the computed numbers). Creating a property programmatically requires creating the definition, then registering it with configurations. The `ni` package should make this simple:

```python
# Create a property definition (get-or-create by name)
prop = ds.get_or_create_property(
    name='AI properties',
    shape='polygon',          # which annotation shape this applies to
    tags=[],                  # optional tag filter
)

# Submit values
ds.submit_properties(prop.id, {ann_id: {'score': 0.95, 'class': 'cell'} for ...})

# Delete all values for a property
ds.delete_property_values(prop.id)

# List all properties in the dataset's configuration
props = ds.list_properties()  # [Property(id='...', name='blob_intensity', shape='polygon'), ...]
```

### Connections

```python
connections = ds.get_connections()
connections = ds.get_connections(parent_id=ann.id)

ds.create_connections([
    ni.Connection(parent_id=p_id, child_id=c_id, tags=['tracked'])
    for p_id, c_id in matched_pairs
])
```

### Image Processing (Write Back)

```python
with ds.new_image('output.tiff', copy_metadata=True) as output:
    for frame_info, image in ds.iter_frames():
        processed = my_function(image)
        output.add_frame(processed, **frame_info)

    output.metadata['tool'] = 'Histogram matching'
# Automatically writes, uploads, and adds metadata on exit
```

### Worker Context (for Docker workers)

```python
import nimbusimage as ni

# Parse standard worker CLI args
ctx = ni.worker_context()  # parses --apiUrl, --token, --datasetId, --request, --parameters
# ctx.dataset, ctx.params, ctx.interface_values, ctx.tags, ctx.tile, etc.

# Messaging
ctx.progress(0.5, 'Processing', 'Frame 50/100')
ctx.warning('No objects found')
ctx.error('Invalid input')

# Batch processing (replaces WorkerClient)
ctx.batch_process(
    process_fn=my_model,
    output_shape='polygon',
    channels=[0, 1],
    stack_z=True,
)
```

## Sensible Defaults

### Annotation fetch/upload limits
The current API has inconsistent limits: `getAnnotationsByDatasetId` defaults to `limit=1_000_000`, but many workers override it with `limit=0` (unlimited) or `limit=10000000`. The `ni` package should use a sensible high default (e.g., 10,000,000) so users don't have to think about it, while still preventing accidental unbounded fetches. Bulk upload via `addMultipleAnnotationPropertyValues` already batches at 10,000 entries to stay under MongoDB's 16MB document limit — this should remain an internal detail.

```python
# The ni package should just work without specifying limits:
annotations = ds.get_annotations(shape='polygon')  # default limit ~10M

# But allow override for truly massive datasets:
annotations = ds.get_annotations(shape='polygon', limit=50_000_000)
```

## Key Design Decisions

### 1. Coordinate handling must be invisible
The `ni.Annotation` class should accept shapely geometries or numpy coordinates and handle all swaps internally. Users should never need to think about x/y swapping.

### 2. `.squeeze()` must die
`ds.get_image()` should always return a clean 2D array for single-frame images.

### 3. Tags confusion must be resolved
The current split between `params['tags']` (list for annotation workers, dict for property workers) should be normalized. The `ni` API should always use a consistent interface.

### 4. The image cache should be built-in
`UPennContrastWorkerClient` has image caching — this should be in the dataset class itself, with an option to disable for memory-constrained environments.

### 5. Physical units should be first-class
```python
ds.pixel_size  # returns a proper unit-aware value
area_um2 = ann.area(units='µm')  # instead of manual conversion
```

### 6. Batch range parsing should be hidden
The "1-3, 5-8" parsing is a UI concern. The `ni` API should accept Python ranges or lists:
```python
ds.get_image_batch(xy=[0, 1, 2], z=range(5, 8), time=0, channel=1)
```

## Migration Path

The `ni` package can wrap the existing clients initially:

```python
class Dataset:
    def __init__(self, client, dataset_id):
        self._tile_client = tiles.UPennContrastDataset(...)
        self._annotation_client = annotations.UPennContrastAnnotationClient(...)

    def get_image(self, xy, z, time, channel):
        frame = self._tile_client.coordinatesToFrameIndex(xy, z, time, channel)
        return self._tile_client.getRegion(self._dataset_id, frame=frame).squeeze()
```

This allows incremental adoption — workers can start using `ni` without changing the underlying implementation.

## Skill Considerations

A Claude Code skill for NimbusImage should:
1. Know the correct import pattern: `import nimbusimage as ni`
2. Know the standard connection pattern
3. Handle the coordinate conventions automatically in generated code
4. Know the worker vs notebook context difference
5. Suggest the correct pattern based on task type (annotation, property, image processing, connection)
6. Include the critical pitfalls (tags type, 0.5 offset, x/y swap) as guardrails
