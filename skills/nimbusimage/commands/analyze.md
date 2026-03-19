---
description: >
  Compute properties, export data, manage connections, and share NimbusImage
  datasets using the nimbusimage Python API. Use this skill when the user
  wants to compute annotation measurements, export data as JSON or CSV,
  create connections between annotations, share datasets with collaborators,
  or manage access control. Also use when you see ds.properties, ds.export,
  ds.connections, or ds.sharing in code, or the user mentions measurements,
  statistics, data export, lineage tracking, or sharing imaging datasets.
---

# NimbusImage — Analyze

This skill covers the analysis and data management accessors: properties, export, connections, sharing, and history.

## Properties

Properties are computed measurements on annotations (e.g., area, intensity, circularity).

### Property definitions

```python
# List all property definitions
props = ds.properties.list()

# Get or create a property (finds existing by name+shape, or creates new)
prop = ds.properties.get_or_create("Area", shape="polygon")

# Create explicitly
prop = ds.properties.create(
    name="Spot Intensity",
    shape="point",
    image="properties/blob_metrics:latest",  # Docker worker image
    worker_interface={"Channel": 0},
)

# Register with the dataset's collection (required before values are visible in UI)
ds.properties.register(prop.id)

# Delete
ds.properties.delete(prop.id)
```

### Property values

```python
# Get all property values for the dataset
values = ds.properties.get_values()

# Get values for a specific annotation
values = ds.properties.get_values(annotation_id="ann_id")

# Submit computed values
# Format: {annotation_id: {property_name: value}}
computed = {}
for ann in ds.annotations.list(shape="polygon"):
    mask = ann.get_mask(ds.shape)
    img = ds.images.get(channel=0, z=ann.location.z)
    computed[ann.id] = {"Mean Intensity": float(img[mask].mean())}

ds.properties.submit_values(prop.id, computed)

# Delete all values for a property
ds.properties.delete_values(prop.id)

# Get histogram
hist = ds.properties.histogram("propertyId.Area", buckets=50)
```

### Running property workers

For server-side computation using Docker workers, see `/nimbusimage:workers`.

## Connections

Connections link annotations in parent-child relationships (e.g., cell lineage, spatial proximity).

```python
# Create a connection
conn = ds.connections.create(
    parent_id=parent_ann.id,
    child_id=child_ann.id,
    tags=["lineage"],
)

# List connections
all_conns = ds.connections.list()
parent_conns = ds.connections.list(parent_id="ann_id")
child_conns = ds.connections.list(child_id="ann_id")
either = ds.connections.list(node_id="ann_id")  # as parent or child

# Count
n = ds.connections.count()

# Bulk create
connections = [
    ni.Connection(parent_id=p.id, child_id=c.id, dataset_id=ds.id, tags=["link"])
    for p, c in pairs
]
ds.connections.create_many(connections)

# Auto-connect to nearest neighbors (server-side)
ds.connections.connect_to_nearest(
    annotation_ids=[a.id for a in new_annotations],
    tags=["nucleus"],   # find nearest among annotations with these tags
    channel=0,
)

# Delete
ds.connections.delete("connection_id")
ds.connections.delete_many(["id1", "id2", "id3"])
```

## Export

```python
# JSON export (returns dict)
data = ds.export.to_json()
data = ds.export.to_json(
    include_annotations=True,
    include_connections=True,
    include_properties=True,
    include_property_values=True,
)

# CSV export
csv_bytes = ds.export.to_csv(
    property_paths=[["property_id", "Area"]],
)

# CSV export to file
ds.export.to_csv(
    property_paths=[["property_id", "Area"], ["property_id", "Intensity"]],
    path="results.csv",
)

# With custom delimiter
ds.export.to_csv(
    property_paths=[["property_id", "Area"]],
    delimiter="\t",
    path="results.tsv",
)
```

The `property_paths` format is a list of `[property_id, value_key]` pairs. You can find property IDs from `ds.properties.list()`.

## Sharing

```python
# Share with a user (by email or username)
ds.sharing.share("colleague@example.com", access="read")
ds.sharing.share("labmate", access="write")
ds.sharing.share("pi", access="admin")

# Remove access
ds.sharing.share("former_member@example.com", access="remove")

# Toggle public access
ds.sharing.set_public(True)
ds.sharing.set_public(False)

# View current access list
access = ds.sharing.get_access()
```

Access levels: `read`, `write`, `admin`, `remove`.

## History

Undo/redo support for annotation operations:

```python
# Undo the last annotation operation
ds.history.undo()

# Redo
ds.history.redo()
```

## Collections (configurations)

Collections hold display settings — layers, tools, scales:

```python
# List collections for this dataset
collections = ds.collections.list()

# Get a specific collection
coll = ds.collections.get("collection_id")

# Get the raw collection data (includes meta with scales, propertyIds, etc.)
raw = ds.collections.get_raw()

# Get layer settings (used by get_composite)
layers = ds.collections.layers  # list of layer dicts

# List dataset views
views = ds.collections.list_views()
```

## Common patterns

### Compute statistics and export

```python
import numpy as np

# Compute measurements
prop = ds.properties.get_or_create("Area", shape="polygon")
ds.properties.register(prop.id)

values = {}
for ann in ds.annotations.list(shape="polygon"):
    mask = ann.get_mask(ds.shape)
    values[ann.id] = {"Area": float(mask.sum())}

ds.properties.submit_values(prop.id, values)

# Export to CSV
ds.export.to_csv(
    property_paths=[[prop.id, "Area"]],
    path="areas.csv",
)
```

### Build a lineage tree

```python
# Get all connections
conns = ds.connections.list()

# Build adjacency
children = {}
for c in conns:
    children.setdefault(c.parent_id, []).append(c.child_id)

# Traverse
def print_tree(ann_id, depth=0):
    print("  " * depth + ann_id)
    for child in children.get(ann_id, []):
        print_tree(child, depth + 1)
```
