# Testing the nimbusimage Package

## Unit Tests (no backend required)

Unit tests mock all HTTP calls and run fast (~0.5s for 150+ tests).

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
NI_TEST_USER=arjunraj NI_TEST_PASS=abc123 \
pytest tests/integration/test_live_config_images.py -v -m integration
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
| `test_live_config_images.py` | Config fetches via /upenn_collection, layer structure, get_composite |

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

## Quick Smoke Test (manual)

To verify the package works against your backend interactively:

```python
import os
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
print(f"Connected as: {client.user_id}")

# Pick a dataset
ds = client.dataset("YOUR_DATASET_ID")
print(f"Dataset: {ds.name}, channels: {ds.channels}, shape: {ds.shape}")

# Fetch an image
img = ds.images.get(channel=0, z=0)
print(f"Image: {img.shape} {img.dtype}")

# List annotations
anns = ds.annotations.list(limit=10)
print(f"Annotations: {len(anns)}")

# Get composite RGB using layer settings from the server
rgb = ds.images.get_composite(dtype="uint8")
from PIL import Image
Image.fromarray(rgb).save(os.path.expanduser("~/Desktop/test_composite.png"))

# Open the dataset in the browser
ds.open(z=3)  # opens image viewer at z=3
```

### End-to-End: Composite Image with Annotations Overlay

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

This verifies:
- Authentication and dataset access
- Layer configuration fetched via `/upenn_collection` (not `/item`)
- Percentile-based contrast applied correctly
- Hex color parsing for pseudocolor
- Channel compositing with lighten blend mode
- Annotation listing and client-side location filtering
- Annotation coordinate format (x=horizontal, y=vertical) renders correctly on the image

### End-to-End: URL Generation and Browser Open

Verify that URL generation works and opens the correct pages:

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# Generate URLs without opening
print(ds.info_url())               # http://localhost:5173/#/dataset/{id}
print(ds.view_url())               # http://localhost:5173/#/datasetView/{viewId}/view
print(ds.view_url(z=4))            # ...?z=4
print(ds.view_url(z=4, time=0, layer="multiple"))  # ...?z=4&time=0&layer=multiple
print(ds.configuration_url())      # http://localhost:5173/#/configuration/{configId}

# Open in browser
ds.open()           # opens image viewer at default location
ds.open(z=4)        # opens at z=4
ds.open(z=4, xy=0, time=0, layer="multiple")  # full location control

# Custom frontend URL (e.g., production server)
client = ni.connect(
    "http://localhost:8080/api/v1", username="admin", password="password",
    frontend_url="https://app.nimbusimage.com"
)
ds = client.dataset("YOUR_DATASET_ID")
print(ds.view_url(z=3))  # https://app.nimbusimage.com/#/datasetView/{viewId}/view?z=3

# Or via environment variable
# NI_FRONTEND_URL=https://app.nimbusimage.com python my_script.py
```

This verifies:
- Dataset view ID lookup from `/dataset_view` endpoint
- Configuration ID lookup
- Hash-based URL construction with query parameters
- `webbrowser.open()` integration
- Custom frontend URL via constructor or `NI_FRONTEND_URL` env var

### End-to-End: Create Annotations and View in Browser

This test exercises bulk annotation creation and verifies they appear in the NimbusImage viewer. It creates 100 randomly placed colored triangles at a specific z-slice, then opens the viewer to confirm they render correctly.

```python
import math
import nimbusimage as ni
import numpy as np

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# Generate 100 random triangles spread across the image
np.random.seed(42)
z_slice = 3
h, w = ds.shape
triangles = []

for i in range(100):
    # Random center (with margin from edges)
    cx = np.random.uniform(50, w - 50)
    cy = np.random.uniform(50, h - 50)

    # Random size and rotation
    r = np.random.uniform(8, 25)
    angle = np.random.uniform(0, 2 * math.pi)

    # 3 vertices of equilateral triangle + closing point
    coords = []
    for k in range(3):
        a = angle + k * (2 * math.pi / 3)
        coords.append({
            "x": float(cx + r * math.cos(a)),
            "y": float(cy + r * math.sin(a)),
            "z": float(z_slice),
        })
    coords.append(coords[0].copy())  # close the polygon

    triangles.append(ni.Annotation(
        id=None,
        shape="polygon",
        tags=["triangle-test"],
        channel=0,
        location=ni.Location(xy=0, z=z_slice, time=0),
        coordinates=coords,
        dataset_id=ds.id,
        color="rgb(255,0,0)",
    ))

# Bulk create
created = ds.annotations.create_many(triangles)
print(f"Created {len(created)} triangle annotations")

# Open the viewer at the z-slice to see them
ds.open(z=z_slice)

# To clean up afterwards:
# ds.annotations.delete_many([a.id for a in created])
```

Note on coordinate format: each coordinate dict must include `x` (horizontal), `y` (vertical), and `z` (matching the z-slice). The polygon should include a closing point (first point repeated at the end). The `color` field accepts `rgb(r,g,b)` format.

This verifies:
- Bulk annotation creation via `create_many`
- Annotation coordinate structure (x, y, z per point, closing point)
- Color specification via `rgb()` string
- Annotations render correctly in the NimbusImage viewer at the correct z-slice
- URL generation and browser open via `ds.open(z=...)`

### End-to-End: Update Annotation Colors

This test exercises updating existing annotations. It fetches annotations by tag, then changes the color of half of them.

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# Fetch annotations by tag
anns = ds.annotations.list(tags=["triangle-test"])
print(f"Found {len(anns)} annotations")

# Change half to blue
half = len(anns) // 2
for ann in anns[:half]:
    ds.annotations.update(ann.id, {"color": "rgb(0,100,255)"})

print(f"Changed {half} annotations to blue")

# Open the viewer to verify
ds.open(z=3)
```

**Important notes on updating annotations:**

- **Use the single-update endpoint** (`ds.annotations.update(id, updates)`) for reliability. The bulk update endpoint (`PUT /upenn_annotation/multiple`) has a known bug ([#780](https://github.com/arjunrajlaboratory/NimbusImage/issues/780)) where it expects an `"id"` field (not `"_id"`) and can return internal server errors.
- **The single PUT endpoint returns no body.** The `update()` method handles this by fetching the annotation after the update to return the current state.
- **Updating is per-annotation** (one HTTP call each), so updating many annotations is slower than bulk create/delete. For large batches, consider whether you can delete and recreate instead.

This verifies:
- Fetching annotations by tag
- Single annotation update via `PUT /upenn_annotation/{id}`
- Color changes render correctly in the viewer

### End-to-End: Create Property and Submit Values

This test exercises property definition creation, bulk value submission, value retrieval, and property registration in a collection.

```python
import nimbusimage as ni
import numpy as np

client = ni.connect("http://localhost:8080/api/v1", username="YOUR_USER", password="YOUR_PASS")
ds = client.dataset("YOUR_DATASET_ID")

# Create (or get existing) property definition
prop = ds.properties.get_or_create(name="random", shape="polygon")
print(f"Property: {prop.name} (id: {prop.id})")

# Get annotations to attach values to
anns = ds.annotations.list(tags=["YOUR_TAG"])
print(f"Found {len(anns)} annotations")

# Generate random values for each annotation
np.random.seed(123)
values = {}
for ann in anns:
    values[ann.id] = {"value": float(np.random.uniform(0, 100))}

# Bulk submit
ds.properties.submit_values(prop.id, values)
print(f"Submitted {len(values)} property values")

# Verify round-trip by fetching back
fetched = ds.properties.get_values(annotation_id=anns[0].id)
print(f"First annotation values: {fetched}")

# Register property in the collection so it shows in the UI
ds.properties.register(prop.id)

# Open to verify in the UI
ds.open(z=3)

# To clean up afterwards:
# ds.properties.delete_values(prop.id)
# ds.properties.delete(prop.id)
```

This verifies:
- `get_or_create` finds existing or creates new property definitions
- `submit_values` transforms user-friendly dict format to backend wire format and auto-batches
- `get_values` retrieves submitted values with correct structure
- `register` adds the property to the collection via `/upenn_collection/{id}/metadata`
- Property values are visible in the NimbusImage viewer's object browser

### Note on macOS Preview

When saving images for viewing with Preview, use `~/Desktop/` or another user-visible path. macOS sandboxing can prevent Preview from displaying files in `/tmp`.
