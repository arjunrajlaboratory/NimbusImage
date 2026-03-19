# NimbusImage Python API

A Python package for programmatic access to [NimbusImage](https://app.nimbusimage.com), a web-based platform for visualizing and annotating large multidimensional scientific images.

## Features

- **Dataset access** -- browse images, metadata, channels, and frames
- **Annotations** -- create, query, update, and delete point/polygon annotations
- **Connections** -- link annotations with parent-child relationships
- **Properties** -- define computed properties and submit values in bulk
- **Image retrieval** -- fetch single frames, z-stacks, time series, and composites as numpy arrays
- **Coordinate utilities** -- convert between annotation, numpy, and shapely coordinate systems
- **Export** -- download annotations and property values as JSON or CSV
- **Sharing** -- manage dataset access control and public visibility
- **Projects** -- organize datasets and configurations into projects
- **Worker support** -- `WorkerContext` for writing Docker-based image processing workers
- **URL generation** -- open datasets, configurations, and projects in the browser

## Quick start

```python
import nimbusimage as ni

# Connect to a NimbusImage server
client = ni.connect("http://localhost:8080/api/v1", token="your-token")

# Access a dataset
ds = client.dataset("dataset_folder_id")

# Get an image as a numpy array
img = ds.images.get(channel=0, z=0, time=0)

# List annotations
annotations = ds.annotations.list(shape="polygon", tags=["nucleus"])

# Create a point annotation
ann = ni.Annotation.from_point(
    x=100.5, y=200.5, channel=0, tags=["spot"],
    dataset_id=ds.id,
)
created = ds.annotations.create(ann)

# Open the dataset in the browser
ds.open(z=3)
```

## Installation

```bash
pip install nimbusimage
```

For Docker worker development:

```bash
pip install nimbusimage[worker]
```
