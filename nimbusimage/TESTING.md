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
NI_TEST_PASS=sysbio \
pytest tests/integration/ -v -m integration

# Run a specific integration test
NI_TEST_USER=arjunraj NI_TEST_PASS=sysbio \
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
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", username="arjunraj", password="sysbio")
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

# Note: save to ~/Desktop (not /tmp) — macOS Preview may not display /tmp files
```

### Note on macOS Preview

When saving images for viewing with Preview, use `~/Desktop/` or another user-visible path. macOS sandboxing can prevent Preview from displaying files in `/tmp`.
