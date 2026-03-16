# Getting Started

## Installation

```bash
pip install nimbusimage
```

For Docker worker development (includes `large_image` for writing TIFF files):

```bash
pip install nimbusimage[worker]
```

## Connecting to a server

```python
import nimbusimage as ni

# Option 1: Explicit credentials
client = ni.connect("http://localhost:8080/api/v1", token="your-token")

# Option 2: Username/password
client = ni.connect("http://localhost:8080/api/v1", username="admin", password="password")

# Option 3: Environment variables (NI_API_URL, NI_TOKEN)
client = ni.connect()
```

## Working with datasets

```python
# Get a dataset by ID
ds = client.dataset("64a1b2c3d4e5f6a7b8c9d0e1")

# Or look it up by name
ds = client.dataset(name="My Experiment")

# Explore metadata
print(f"Name: {ds.name}")
print(f"Shape: {ds.shape}")  # (height, width)
print(f"Channels: {ds.channels}")
print(f"Z-slices: {ds.num_z}, Time points: {ds.num_time}")
print(f"Pixel size: {ds.pixel_size.to('um').value} um")
```

## Fetching images

```python
import numpy as np

# Single frame as a 2D numpy array
img = ds.images.get(channel=0, z=0, time=0)

# All channels at one location
channels = ds.images.get_all_channels(z=0, time=0)

# Z-stack as a 3D array (Z, H, W)
stack = ds.images.get_stack(channel=0, axis="z")

# Composite RGB image using layer settings
rgb = ds.images.get_composite(dtype="uint8")
```

## Annotations

```python
# List annotations
polygons = ds.annotations.list(shape="polygon", tags=["nucleus"])
print(f"Found {len(polygons)} nuclei")

# Create annotations
ann = ni.Annotation.from_point(
    x=100.5, y=200.5,
    channel=0,
    tags=["spot"],
    dataset_id=ds.id,
    location=ni.Location(xy=0, z=0, time=0),
)
created = ds.annotations.create(ann)
print(f"Created annotation: {created.id}")

# Bulk create
annotations = [
    ni.Annotation.from_point(x=x, y=y, channel=0, tags=["spot"], dataset_id=ds.id)
    for x, y in zip(xs, ys)
]
ds.annotations.create_many(annotations)

# Delete
ds.annotations.delete(created.id)
```

## Geometry helpers

Annotations have geometry methods for converting to shapely objects and numpy masks:

```python
ann = ds.annotations.list(shape="polygon")[0]

# Shapely conversion
polygon = ann.polygon()       # shapely Polygon
point = ann.point()           # shapely Point (or centroid)
cx, cy = ann.centroid()       # (x, y) tuple

# Numpy mask
mask = ann.get_mask(ds.shape)  # boolean array
rows, cols = ann.get_pixels(ds.shape)  # pixel indices

# Create from shapely/mask
from shapely.geometry import Polygon
poly = Polygon([(100, 200), (150, 200), (150, 250), (100, 250)])
ann = ni.Annotation.from_polygon(poly, channel=0, tags=["cell"], dataset_id=ds.id)
```

## Properties

```python
# Create or find a property definition
prop = ds.properties.get_or_create("Area", shape="polygon")

# Register it with the dataset's configuration
ds.properties.register(prop.id)

# Submit computed values
values = {}
for ann in ds.annotations.list(shape="polygon"):
    mask = ann.get_mask(ds.shape)
    values[ann.id] = {"Area": float(mask.sum())}

ds.properties.submit_values(prop.id, values)
```

## Connections

```python
# Create a connection between two annotations
conn = ds.connections.create(parent_id=parent.id, child_id=child.id, tags=["lineage"])

# Auto-connect to nearest neighbors
ds.connections.connect_to_nearest(
    annotation_ids=[a.id for a in new_annotations],
    tags=["nucleus"],
    channel=0,
)
```

## Running workers

Workers are Docker containers that perform computations (segmentation,
measurements, image processing) on datasets.

### Discover available workers

```python
# List all worker images on the server
workers = client.list_workers()
for image, labels in workers.items():
    print(f"{image}: {labels.get('interfaceName', '')}")

# Get the parameter interface for a worker
interface = client.get_worker_interface("annotations/random_squares:latest")
for param, spec in interface.items():
    print(f"  {param}: type={spec['type']}, default={spec.get('default', '')}")
```

### Run an annotation worker

```python
# Submit a worker job
job = ds.annotations.compute(
    image="annotations/random_squares:latest",
    channel=0,
    tags=["detected"],
    worker_interface={
        "Number of squares": 100,
        "Square size": 15,
    },
)

# Wait for completion (prints progress to stderr)
success = job.wait()
print(f"Job {'succeeded' if success else 'failed'}")

# With auto-connection to nearest neighbors
job = ds.annotations.compute(
    image="annotations/laplacian_of_gaussian:latest",
    channel=0,
    tags=["spots"],
    worker_interface={"Sigma": 2.0},
    connect_to={"tags": ["nucleus"], "channel": 0},
)
job.wait()
```

### Run a property worker

```python
# Create and register a property
prop = ds.properties.get_or_create("Blob Intensity", shape="polygon")
ds.properties.register(prop.id)

# Run the property worker
job = ds.properties.compute(
    prop,
    worker_interface={"Channel": 0},
    scales=ds.collections.get_raw().get("meta", {}).get("scales", {}),
)
job.wait()

# Fetch the computed values
values = ds.properties.get_values()
```

### Job tracking

```python
# Non-blocking: check status manually
job = ds.annotations.compute(...)
while not job.finished:
    job.refresh()
    print(f"Status: {job.status_name}")
    time.sleep(5)

# Blocking with timeout
try:
    job.wait(timeout=300)  # 5 minute timeout
except TimeoutError:
    print("Job timed out")
```

## Export

```python
# JSON export
data = ds.export.to_json()

# CSV export to file
ds.export.to_csv(
    property_paths=[["prop_id", "Area"]],
    path="results.csv",
)
```

## Sharing and access control

```python
# Share with a user
ds.sharing.share("colleague@example.com", access="write")

# Make public
ds.sharing.set_public(True)
```

## URLs and browser integration

```python
# Open dataset in browser
ds.open(z=3, time=0)

# Get URLs without opening
print(ds.view_url())
print(ds.info_url())
print(ds.configuration_url())
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NI_API_URL` | Girder API URL | -- |
| `NI_TOKEN` | Authentication token | -- |
| `NI_FRONTEND_URL` | Frontend URL for browser links | `http://localhost:5173` |
