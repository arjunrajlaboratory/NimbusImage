# WorkerClient — Batch Annotation Creation

**Source**: `worker_client/worker_client/worker_client.py`

## Overview

`WorkerClient` is a high-level helper for annotation workers that need to:
1. Iterate over XY/Z/Time positions (batch mode)
2. Load images (optionally stacking multiple channels/z-planes)
3. Run a processing function on each image
4. Create annotations from the output

It wraps `UPennContrastAnnotationClient` and `UPennContrastDataset`.

## Initialization

```python
from worker_client import WorkerClient

worker = WorkerClient(datasetId, apiUrl, token, params)
```

On init, it:
1. Extracts `assignment`, `channel`, `connectTo`, `tags`, `tile`, `workerInterface` from params
2. Parses batch ranges from `workerInterface['Batch XY']`, `workerInterface['Batch Z']`, `workerInterface['Batch Time']`
3. Creates `annotationClient` and `datasetClient` instances

### Attributes after init

```python
worker.datasetId        # Dataset folder ID
worker.channel          # Channel index from params
worker.tags             # Output annotation tags (list of strings)
worker.tile             # Current tile position {'XY': 0, 'Z': 0, 'Time': 0}
worker.workerInterface  # Dict of user-supplied interface values
worker.connectTo        # Connection config {'tags': [...], 'channel': ...}
worker.batch_xy         # List of XY positions to iterate
worker.batch_z          # List of Z positions to iterate
worker.batch_time       # List of Time positions to iterate
worker.annotationClient # UPennContrastAnnotationClient instance
worker.datasetClient    # UPennContrastDataset instance
```

## The `process` Method

```python
worker.process(
    f_process,              # Function: image -> output coords
    f_annotation,           # 'point', 'polygon', or custom function
    stack_xys=None,         # None, 'all', or list of indices
    stack_zs=None,          # None, 'all', or list of indices
    stack_times=None,       # None, 'all', or list of indices
    stack_channels=None,    # None, 'all', or list of indices
    progress_text='Running Worker'
)
```

### How it works:

1. **Batch dimensions** (None for stack_*): iterates over `batch_xy/z/time` parsed from interface
2. **Stack dimensions** (not None for stack_*): stacks those dimensions into the image array instead of iterating
3. For each batch position, calls `get_image_stack()` to load the image
4. Calls `f_process(image)` to get output coordinates
5. Calls `f_annotation(location, output)` to create annotations
6. Reports progress

### Example: Cellpose (batch XY/Z/Time, stack channels)

```python
worker = WorkerClient(datasetId, apiUrl, token, params)

def run_model(image):
    # image shape: (num_channels, H, W) because stack_channels=[0, 1]
    polygons = cellpose_predict(image)
    return polygons  # list of [(x,y), (x,y), ...] per polygon

worker.process(
    run_model,
    f_annotation='polygon',
    stack_channels=[primary_channel, secondary_channel],
    progress_text='Running Cellpose'
)
```

### Example: Piscis (batch XY/Time, stack Z for 3D)

```python
worker = WorkerClient(datasetId, apiUrl, token, params)

def run_model(image):
    # image shape: (num_z, H, W) because stack_zs='all'
    coords = model.predict(image, stack=True)
    return coords  # (N, 3) array of [z, y, x]

worker.process(
    run_model,
    f_annotation='point',
    stack_zs='all',  # Stack all Z into one array
    progress_text='Running Piscis'
)
```

### Example: Random Squares (simple batch, single channel)

```python
worker = WorkerClient(datasetId, apiUrl, token, params)

def generate_squares(image):
    # Returns list of polygon coords
    return [[(x1,y1), (x2,y1), (x2,y2), (x1,y2)] for _ in range(n)]

worker.process(generate_squares, f_annotation='polygon')
```

## Image Loading

### get_image — Single frame

```python
image = worker.get_image(xy=0, z=3, time=0, channel=1)
# Defaults to worker.tile and worker.channel if args are None
```

### get_image_stack — Multi-dimensional

```python
image_stack = worker.get_image_stack(
    location=(xy, z, time, channel),
    stack_xys=None,        # None: use location's xy; 'all': all XYs; [0,1,2]: specific
    stack_zs=None,         # Same pattern
    stack_times=None,      # Same pattern
    stack_channels=[0, 1]  # Stack channels 0 and 1
)
# Returns: numpy array with shape depending on stacked dimensions
# e.g., stack_channels=[0,1] -> (2, H, W)
# e.g., stack_zs='all' with 7 Z -> (7, H, W)
```

## Annotation Creation

### create_point_annotations

```python
worker.create_point_annotations(
    location=(xy, z, time, channel),
    coords=np.array([[y1, x1], [y2, x2]])  # 2D: (N, 2) as [y, x]
    # or coords=np.array([[z1, y1, x1], [z2, y2, x2]])  # 3D: (N, 3) as [z, y, x]
)
```

Creates annotations with `worker.tags`, uploads via `createMultipleAnnotations`, then calls `connectToNearest` if `connectTo` tags are specified.

### create_polygon_annotations

```python
worker.create_polygon_annotations(
    location=(xy, z, time, channel),
    polygons=[
        [(x1, y1), (x2, y2), (x3, y3)],  # Each is a list of (x, y) tuples
        [(x4, y4), (x5, y5), (x6, y6)],
    ]
)
```

Each polygon list is converted to a shapely Polygon (for proper closure), then to annotation format.

## Accessing Internal Clients

Workers sometimes need direct access:

```python
# Access the annotation client for direct API calls
gc = worker.annotationClient.client  # girder_client.GirderClient

# Access the dataset/tile client
worker.datasetClient.tiles  # tile metadata

# Download models from Girder
utils.download_girder_model(gc, model_name)
```
