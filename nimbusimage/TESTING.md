# Testing the nimbusimage Package

## Unit Tests (no backend required)

Unit tests mock all HTTP calls and run fast (~0.6s for 217 tests).

```bash
cd nimbusimage
source .venv/bin/activate   # or create: python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"

# Run all unit tests
pytest tests/ --ignore=tests/integration -v

# Run a specific test file
pytest tests/test_annotations.py -v

# Run a specific test class or method
pytest tests/test_coordinates.py::TestAnnotationToPolygon -v
pytest tests/test_models.py::TestPixelSize::test_to_conversion -v
```

## Integration Tests (requires live backend)

Integration tests run against a real Girder backend via docker-compose. They create/modify/delete real data.

### Prerequisites

1. **Start the backend** from the repo root:

```bash
cd /path/to/UPennContrast
docker compose up -d
```

Wait for Girder to be accessible at `http://localhost:8080`.

2. **Ensure a user exists.** The default admin user is `admin`/`password`. You can also use your own account.

3. **Ensure at least one dataset exists** with image data (the worker tests need a dataset to run against).

### Running Integration Tests

```bash
cd nimbusimage
source .venv/bin/activate

# Run with default credentials (admin/password on localhost:8080)
pytest tests/integration/ -v -m integration

# Run with custom credentials
NI_API_URL=http://localhost:8080/api/v1 \
NI_TEST_USER=arjunraj \
NI_TEST_PASS=abc123 \
pytest tests/integration/ -v -m integration

# Run a specific integration test
pytest tests/integration/test_live_workers.py -v -m integration
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NI_API_URL` | `http://localhost:8080/api/v1` | Girder API URL |
| `NI_TEST_USER` | `admin` | Username for test authentication |
| `NI_TEST_PASS` | `password` | Password for test authentication |

### What Integration Tests Cover

| Test file | What it tests |
|-----------|--------------|
| `test_live_client.py` | Authentication, user info, project listing |
| `test_live_annotations.py` | Create, list, update, delete annotations (single + bulk) |
| `test_live_connections.py` | Create annotations, connect them, query, delete |
| `test_live_properties.py` | Create property definitions, submit/retrieve values, get_or_create |
| `test_live_config_images.py` | Collection fetches via /upenn_collection, layer structure, get_composite |
| `test_live_workers.py` | Worker discovery, interface fetch, annotation worker execution (random_squares) |

### Test Cleanup

Integration tests create temporary test data and clean up after themselves via pytest fixtures. If a test fails mid-run, some test data may be left behind (folders named `nimbusimage_test_dataset` in the test user's Private folder).

### Running Both Unit + Integration

```bash
# Everything
pytest tests/ -v

# Unit only (fast, no backend)
pytest tests/ --ignore=tests/integration -v

# Integration only
pytest tests/integration/ -v -m integration
```

## E2E Test Results (2026-03-16)

All major features have been e2e tested against the live backend:

| Feature | Result | Notes |
|---------|--------|-------|
| Image retrieval (single, crop, all channels, z-stack) | PASS | |
| get_composite (float64, uint8) | PASS | Uses percentile-based contrast from layer settings |
| Annotation worker (random_squares) | PASS | 5 annotations created and cleaned up |
| Property worker (blob_metrics) | PASS | Computed Area, Perimeter, Circularity, etc. for 220 annotations |
| Export JSON | PASS | Includes annotations, connections, properties, values |
| Export CSV | PASS | To bytes and to file |
| History (undo/redo) | PASS | Create → undo → redo cycle verified |
| Sharing (set_public) | PASS | Toggle public on/off |
| Connections (CRUD) | PASS | Create, get, list, delete, bulk create/delete |
| connect_to_nearest | PASS | |
| Connection update | FAIL | Backend bug [#1087](https://github.com/arjunrajlaboratory/NimbusImage/issues/1087) |
| Geometry methods | PASS | polygon, point, centroid, get_mask, get_pixels, from_polygon, from_mask |

### Bugs Found During E2E Testing

1. **`get_worker_interface` response format**: Returns the interface dict directly, not wrapped in `{"interface": ...}`
2. **`list_datasets` broken search**: `resource/search` by name prefix doesn't work; fixed to use `dataset_view` endpoint
3. **`connectTo` default**: WorkerClient requires `connectTo.tags` to exist; default must be `{"tags": []}` not `None`
4. **`connectToNearest` URL**: Backend route is `/connectTo` not `/connectToNearest`
5. **Property `id` vs `_id`**: WorkerClient reads `params.get("id")` but `to_dict()` serializes as `_id`; now remapped
6. **Connection update 500**: Backend param name mismatch ([#1087](https://github.com/arjunrajlaboratory/NimbusImage/issues/1087))

## Quick Smoke Test (manual)

To verify the package works against your backend interactively:

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
print(f"Connected as: {client.user_id}")

# List datasets
datasets = client.list_datasets()
print(f"Found {len(datasets)} datasets")
ds = client.dataset(datasets[0]["_id"])
print(f"Dataset: {ds.name}, channels: {ds.channels}, shape: {ds.shape}")

# Fetch an image
img = ds.images.get(channel=0, z=0)
print(f"Image: {img.shape} {img.dtype}")

# List annotations
anns = ds.annotations.list(limit=10)
print(f"Annotations: {len(anns)}")

# Get composite RGB using layer settings from the server
rgb = ds.images.get_composite(dtype="uint8")

# Discover workers
workers = client.list_workers()
print(f"Workers: {len(workers)}")

# Run a worker
job = ds.annotations.compute(
    image="annotations/random_squares:latest",
    channel=0, tags=["smoke-test"],
    worker_interface={"Number of squares": 3, "Square size": 10},
)
job.wait()
print(f"Worker job: {job.status_name}")

# Clean up
ds.annotations.delete_many([a.id for a in ds.annotations.list(tags=["smoke-test"])])

# Open the dataset in the browser
ds.open(z=3)
```

## End-to-End: Composite Image with Annotations Overlay

This test exercises the full pipeline: connect, load dataset metadata, fetch images, fetch layer config, build composite, fetch annotations, filter by location, and render.

```python
import os
import nimbusimage as ni
import numpy as np
from PIL import Image, ImageDraw

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# Pick a z-slice (check where annotations live)
anns = ds.annotations.list()
print(f"Total annotations: {len(anns)}")

# Find a z-slice with annotations
from collections import Counter
z_counts = Counter(a.location.z for a in anns)
z_slice = z_counts.most_common(1)[0][0] if z_counts else 0
print(f"Most populated z-slice: z={z_slice} ({z_counts[z_slice]} annotations)")

# Get composite at that z-slice using server layer settings
rgb = ds.images.get_composite(xy=0, z=z_slice, time=0, dtype="uint8")

# Filter annotations to this z-slice
local_anns = ni.filter_by_location(anns, z=z_slice)

# Draw annotations on the image
img = Image.fromarray(rgb)
draw = ImageDraw.Draw(img)

for ann in local_anns:
    if ann.shape == "polygon" and len(ann.coordinates) >= 3:
        pts = [(c["x"], c["y"]) for c in ann.coordinates]
        draw.polygon(pts, outline=(255, 255, 255), width=2)
    elif ann.shape == "point" and len(ann.coordinates) == 1:
        x, y = ann.coordinates[0]["x"], ann.coordinates[0]["y"]
        r = 3
        draw.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 0), width=2)

out = os.path.expanduser("~/Desktop/nimbusimage_annotated.png")
img.save(out)
print(f"Saved annotated image to {out}")
```

## End-to-End: Worker Execution

Run an annotation worker and a property worker end-to-end:

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# --- Annotation Worker ---
# Discover and inspect
workers = client.list_workers()
iface = client.get_worker_interface("annotations/random_squares:latest")
print(f"Interface params: {list(iface.keys())}")

# Run
job = ds.annotations.compute(
    image="annotations/random_squares:latest",
    channel=0,
    tags=["worker-test"],
    worker_interface={"Number of squares": 10, "Square size": 15},
    name="worker_test",
)
job.wait()  # prints progress to stderr
print(f"Job: {job.status_name}")

# Verify
created = ds.annotations.list(tags=["worker-test"])
print(f"Created {len(created)} annotations")

# Clean up
ds.annotations.delete_many([a.id for a in created])

# --- Property Worker ---
prop = ds.properties.get_or_create("Test Blob Metrics", shape="polygon",
                                    image="properties/blob_metrics:latest")
ds.properties.register(prop.id)

scales = ds.collections.get_raw().get("meta", {}).get("scales", {})
job = ds.properties.compute(prop, worker_interface={"Use physical units": False}, scales=scales)
job.wait()
print(f"Property job: {job.status_name}")

values = ds.properties.get_values()
print(f"Property values: {len(values)} entries")

# Clean up
ds.properties.delete_values(prop.id)
ds.properties.delete(prop.id)
```
