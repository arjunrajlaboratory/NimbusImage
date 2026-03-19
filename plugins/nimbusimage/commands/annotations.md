---
description: >
  Create, list, filter, update, and delete annotations on NimbusImage datasets
  using the nimbusimage Python API. Use this skill when the user wants to work
  with annotations — creating points or polygons, filtering by shape or tags,
  bulk operations, geometry conversion (shapely, numpy masks), or programmatic
  annotation manipulation. Also use when you see ds.annotations in code, or
  the user mentions spots, cells, nuclei, ROIs, polygons, or segmentation
  masks in an imaging context.
---

# NimbusImage — Annotations

Annotations are spatial markers on image datasets — points, polygons, and lines with tags, channel assignment, and location (XY/Z/Time).

Access via `ds.annotations` on a Dataset object.

## Listing and filtering

```python
# All annotations
all_anns = ds.annotations.list()

# Filter by shape
polygons = ds.annotations.list(shape="polygon")
points = ds.annotations.list(shape="point")

# Filter by tags
nuclei = ds.annotations.list(shape="polygon", tags=["nucleus"])

# Count without fetching
n = ds.annotations.count(shape="polygon", tags=["nucleus"])

# Pagination
page = ds.annotations.list(limit=100, offset=200)

# Get one by ID
ann = ds.annotations.get("annotation_id_here")
```

## Creating annotations

```python
import nimbusimage as ni

# Create a point annotation
ann = ni.Annotation.from_point(
    x=100.5, y=200.5,
    channel=0,
    tags=["spot"],
    dataset_id=ds.id,
    location=ni.Location(xy=0, z=0, time=0),
)
created = ds.annotations.create(ann)

# Create a polygon annotation manually
ann = ni.Annotation(
    shape="polygon",
    tags=["cell"],
    channel=0,
    coordinates=[
        {"x": 100, "y": 200},
        {"x": 150, "y": 200},
        {"x": 150, "y": 250},
        {"x": 100, "y": 250},
    ],
    dataset_id=ds.id,
    location=ni.Location(xy=0, z=0, time=0),
)
created = ds.annotations.create(ann)
```

### Bulk creation

Always prefer bulk operations over loops — this is critical for performance.

```python
# Create many at once (single HTTP request)
annotations = [
    ni.Annotation.from_point(x=x, y=y, channel=0, tags=["spot"], dataset_id=ds.id)
    for x, y in zip(xs, ys)
]
ds.annotations.create_many(annotations)

# With auto-connection to nearest neighbors
ds.annotations.create_many(
    annotations,
    connect_to={"tags": ["nucleus"], "channel": 0},
)
```

## Updating

```python
# Update one annotation
ds.annotations.update("ann_id", {"tags": ["nucleus", "verified"]})

# update_many has a known bug (#780) — use individual updates for now
for ann_id, changes in updates:
    ds.annotations.update(ann_id, changes)
```

## Deleting

```python
# Single delete
ds.annotations.delete("annotation_id")

# Bulk delete (single HTTP request)
ds.annotations.delete_many(["id1", "id2", "id3"])
```

## Geometry helpers

Annotations have geometry methods for converting between NimbusImage coordinates and shapely/numpy:

```python
ann = ds.annotations.list(shape="polygon")[0]

# Convert to shapely objects
polygon = ann.polygon()       # shapely Polygon
point = ann.point()           # shapely Point (or centroid for polygons)
cx, cy = ann.centroid()       # (x, y) tuple

# Convert to numpy mask
mask = ann.get_mask(ds.shape)          # boolean array (H, W)
rows, cols = ann.get_pixels(ds.shape)  # pixel index arrays

# Create annotation from shapely polygon
from shapely.geometry import Polygon
poly = Polygon([(100, 200), (150, 200), (150, 250), (100, 250)])
ann = ni.Annotation.from_polygon(poly, channel=0, tags=["cell"], dataset_id=ds.id)

# Create annotation from binary mask
ann = ni.Annotation.from_mask(mask_array, channel=0, tags=["region"], dataset_id=ds.id)
```

## Client-side filtering

The `nimbusimage` package includes filter utilities for working with annotation lists in Python:

```python
from nimbusimage import filter_by_tags, filter_by_location, group_by_location

# Filter by tags (client-side, after fetching)
tagged = filter_by_tags(annotations, tags=["nucleus"])

# Filter by location
at_z3 = filter_by_location(annotations, z=3)

# Group by location
grouped = group_by_location(annotations)  # dict of (xy, z, time) -> [annotations]
```

## Common patterns

### Extract measurements from annotations

```python
import numpy as np

for ann in ds.annotations.list(shape="polygon"):
    img = ds.images.get(channel=0, z=ann.location.z, time=ann.location.time)
    mask = ann.get_mask(ds.shape)
    intensity = img[mask].mean()
    area = mask.sum()
    print(f"Annotation {ann.id}: mean={intensity:.1f}, area={area}")
```

### Convert detection results to annotations

```python
# From a list of (x, y) detections
detections = [(150.5, 200.3), (300.1, 450.7), ...]
annotations = [
    ni.Annotation.from_point(x=x, y=y, channel=0, tags=["detected"], dataset_id=ds.id)
    for x, y in detections
]
ds.annotations.create_many(annotations)
```

## Important notes

- Coordinates use the server's convention (x/y may be swapped from numpy row/col). The geometry helpers handle this automatically.
- Tags are lists of strings. Multiple tags means AND when filtering server-side.
- `dataset_id` is required when creating annotations — it's the folder ID of the dataset.
- `location` defaults to `Location(xy=0, z=0, time=0)` if not specified.
- Use `create_many` / `delete_many` for bulk operations — never loop with individual calls.

For the full AnnotationAccessor API, read `references/annotations-api.md`.
