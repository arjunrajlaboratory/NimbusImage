# NimbusImage Python API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `nimbusimage` Python package providing unified programmatic access to NimbusImage for notebooks, workers, and MCP integration.

**Architecture:** Accessor pattern — `ni.connect()` returns `NimbusClient`, which creates `Dataset` objects, each with sub-accessors (`ds.annotations`, `ds.images`, etc.) that handle HTTP via an internal `_girder.py` wrapper. Dataclasses own serialization; accessors own HTTP. Coordinate conventions (x/y swap, 0.5 offset) are encapsulated in `coordinates.py` and `Annotation` methods.

**Tech Stack:** Python 3.10+, girder-client, numpy, shapely, pytest, pytest-mock

**Spec:** `docs/superpowers/specs/2026-03-15-nimbusimage-python-api-design.md`

**Existing code reference:** `devops/girder/annotation_client/annotation_client/` — has the HTTP patterns and endpoint paths we replicate.

**Backend API reference:** `codebaseDocumentation/api_documentation/15_server_rest_api.md` — all endpoint routes.

---

## File Map

| File | Responsibility |
|------|---------------|
| `nimbusimage/pyproject.toml` | Package config, dependencies |
| `nimbusimage/nimbusimage/__init__.py` | Public API: `connect()`, `worker_context()`, dataclasses, filter helpers |
| `nimbusimage/nimbusimage/_girder.py` | Internal: thin wrapper around `girder_client.GirderClient` |
| `nimbusimage/nimbusimage/models.py` | Dataclasses: `Annotation`, `Connection`, `Property`, `Location`, `PixelSize`, `FrameInfo` |
| `nimbusimage/nimbusimage/coordinates.py` | Coordinate convention logic: x/y swap, 0.5 offset, mask generation |
| `nimbusimage/nimbusimage/filters.py` | `filter_by_tags()`, `filter_by_location()`, `group_by_location()` |
| `nimbusimage/nimbusimage/client.py` | `NimbusClient`: authenticated session, dataset/project access |
| `nimbusimage/nimbusimage/dataset.py` | `Dataset`: metadata properties, creates accessor sub-objects |
| `nimbusimage/nimbusimage/annotations.py` | `AnnotationAccessor`: CRUD for annotations |
| `nimbusimage/nimbusimage/connections.py` | `ConnectionAccessor`: CRUD for connections |
| `nimbusimage/nimbusimage/properties.py` | `PropertyAccessor`: definitions + values |
| `nimbusimage/nimbusimage/images.py` | `ImageAccessor`: image retrieval, stacking, compositing, writing |
| `nimbusimage/nimbusimage/config.py` | `ConfigAccessor`: views, configurations, layers |
| `nimbusimage/nimbusimage/export.py` | `ExportAccessor`: JSON/CSV export |
| `nimbusimage/nimbusimage/history.py` | `HistoryAccessor`: undo/redo |
| `nimbusimage/nimbusimage/sharing.py` | `SharingAccessor`: access control |
| `nimbusimage/nimbusimage/projects.py` | `Project` class |
| `nimbusimage/nimbusimage/worker.py` | `WorkerContext`: worker parameter parsing, messaging, batch processing |
| `nimbusimage/tests/conftest.py` | Shared test fixtures and mock helpers |
| `nimbusimage/tests/test_models.py` | Dataclass serialization round-trip tests |
| `nimbusimage/tests/test_coordinates.py` | Coordinate conversion tests (critical) |
| `nimbusimage/tests/test_filters.py` | Filter function tests |
| `nimbusimage/tests/test_client.py` | Client connection and auth tests |
| `nimbusimage/tests/test_dataset.py` | Dataset metadata parsing tests |
| `nimbusimage/tests/test_annotations.py` | Annotation accessor CRUD tests |
| `nimbusimage/tests/test_connections.py` | Connection accessor tests |
| `nimbusimage/tests/test_properties.py` | Property accessor tests |
| `nimbusimage/tests/test_images.py` | Image accessor tests |
| `nimbusimage/tests/test_config.py` | Config accessor tests |
| `nimbusimage/tests/test_export.py` | Export accessor tests |
| `nimbusimage/tests/test_history.py` | History accessor tests |
| `nimbusimage/tests/test_sharing.py` | Sharing accessor tests |
| `nimbusimage/tests/test_projects.py` | Project tests |
| `nimbusimage/tests/test_worker.py` | WorkerContext tests |
| `nimbusimage/tests/integration/conftest.py` | Live server fixtures |
| `nimbusimage/tests/integration/test_live_client.py` | Live auth tests |
| `nimbusimage/tests/integration/test_live_annotations.py` | Live annotation CRUD |
| `nimbusimage/tests/integration/test_live_images.py` | Live image fetch |
| `nimbusimage/tests/integration/test_live_connections.py` | Live connection tests |
| `nimbusimage/tests/integration/test_live_properties.py` | Live property value tests |

---

## Task 1: Project Scaffolding

**Files:**
- Create: `nimbusimage/pyproject.toml`
- Create: `nimbusimage/nimbusimage/__init__.py`
- Create: `nimbusimage/tests/__init__.py`
- Create: `nimbusimage/tests/conftest.py`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p nimbusimage/nimbusimage
mkdir -p nimbusimage/tests/integration
```

- [ ] **Step 2: Create pyproject.toml**

Create `nimbusimage/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=64", "wheel"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "nimbusimage"
version = "0.1.0"
description = "Python API for NimbusImage"
requires-python = ">=3.10"
dependencies = [
    "girder-client",
    "numpy",
    "shapely",
]

[project.optional-dependencies]
worker = ["large-image"]
dev = ["pytest", "pytest-mock"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "integration: tests requiring a live Girder backend (docker-compose)",
]
```

- [ ] **Step 3: Create empty __init__.py files**

Create `nimbusimage/nimbusimage/__init__.py`:

```python
"""NimbusImage Python API."""
```

Create `nimbusimage/tests/__init__.py` (empty file).

- [ ] **Step 4: Create test conftest.py with shared fixtures**

Create `nimbusimage/tests/conftest.py`:

```python
"""Shared test fixtures for nimbusimage unit tests."""

from unittest.mock import MagicMock

import pytest


@pytest.fixture
def mock_gc():
    """A mock girder_client.GirderClient instance.

    All HTTP methods (get, post, put, delete, sendRestRequest)
    are MagicMock objects that can be configured per-test.
    """
    gc = MagicMock()
    gc.getServerApiUrl.return_value = "http://localhost:8080/api/v1"
    gc.token = "test-token-abc123"
    return gc


@pytest.fixture
def sample_annotation_dict():
    """A sample annotation dict as returned by the server."""
    return {
        "_id": "ann_001",
        "shape": "polygon",
        "tags": ["nucleus"],
        "channel": 0,
        "location": {"Time": 0, "XY": 0, "Z": 0},
        "coordinates": [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ],
        "datasetId": "dataset_001",
        "color": None,
    }


@pytest.fixture
def sample_connection_dict():
    """A sample connection dict as returned by the server."""
    return {
        "_id": "conn_001",
        "parentId": "ann_001",
        "childId": "ann_002",
        "datasetId": "dataset_001",
        "tags": ["parent-child"],
    }


@pytest.fixture
def sample_property_dict():
    """A sample property definition dict as returned by the server."""
    return {
        "_id": "prop_001",
        "name": "Blob Intensity",
        "image": "properties/blob_intensity:latest",
        "shape": "polygon",
        "tags": {"exclusive": False, "tags": ["nucleus"]},
        "workerInterface": {"Channel": 1},
    }


@pytest.fixture
def sample_tiles_metadata():
    """Sample tiles metadata as returned by large_image /tiles endpoint."""
    return {
        "sizeX": 1024,
        "sizeY": 768,
        "levels": 1,
        "magnification": 20.0,
        "mm_x": 0.000219,
        "mm_y": 0.000219,
        "dtype": "uint16",
        "bandCount": 1,
        "frames": [
            {"Frame": 0, "IndexC": 0, "IndexT": 0, "IndexZ": 0, "IndexXY": 0, "Channel": "DAPI"},
            {"Frame": 1, "IndexC": 1, "IndexT": 0, "IndexZ": 0, "IndexXY": 0, "Channel": "GFP"},
            {"Frame": 2, "IndexC": 0, "IndexT": 0, "IndexZ": 1, "IndexXY": 0, "Channel": "DAPI"},
            {"Frame": 3, "IndexC": 1, "IndexT": 0, "IndexZ": 1, "IndexXY": 0, "Channel": "GFP"},
        ],
        "IndexRange": {"IndexC": 2, "IndexT": 1, "IndexZ": 2, "IndexXY": 1},
        "IndexStride": {"IndexC": 1, "IndexT": 4, "IndexZ": 2, "IndexXY": 1},
        "channels": ["DAPI", "GFP"],
    }
```

- [ ] **Step 5: Verify the package installs and pytest discovers tests**

```bash
cd nimbusimage
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest --collect-only
```

Expected: 0 tests collected, no errors.

- [ ] **Step 6: Commit**

```bash
git add nimbusimage/
git commit -m "feat(nimbusimage): scaffold package with pyproject.toml and test fixtures"
```

---

## Task 2: Data Models

**Files:**
- Create: `nimbusimage/nimbusimage/models.py`
- Create: `nimbusimage/tests/test_models.py`

- [ ] **Step 1: Write test_models.py**

Create `nimbusimage/tests/test_models.py`:

```python
"""Tests for nimbusimage data models."""

import pytest

from nimbusimage.models import (
    Annotation,
    Connection,
    FrameInfo,
    Location,
    PixelSize,
    Property,
)


class TestLocation:
    def test_defaults(self):
        loc = Location()
        assert loc.xy == 0
        assert loc.z == 0
        assert loc.time == 0

    def test_to_dict(self):
        loc = Location(xy=1, z=2, time=3)
        assert loc.to_dict() == {"XY": 1, "Z": 2, "Time": 3}

    def test_from_dict(self):
        loc = Location.from_dict({"XY": 1, "Z": 2, "Time": 3})
        assert loc == Location(xy=1, z=2, time=3)

    def test_from_dict_missing_keys_default_zero(self):
        loc = Location.from_dict({"XY": 5})
        assert loc == Location(xy=5, z=0, time=0)


class TestAnnotation:
    def test_from_dict(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        assert ann.id == "ann_001"
        assert ann.shape == "polygon"
        assert ann.tags == ["nucleus"]
        assert ann.channel == 0
        assert ann.location == Location(xy=0, z=0, time=0)
        assert len(ann.coordinates) == 4
        assert ann.dataset_id == "dataset_001"
        assert ann.color is None

    def test_to_dict_round_trip(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        result = ann.to_dict()
        assert result["shape"] == "polygon"
        assert result["tags"] == ["nucleus"]
        assert result["channel"] == 0
        assert result["location"] == {"Time": 0, "XY": 0, "Z": 0}
        assert result["coordinates"] == sample_annotation_dict["coordinates"]
        assert result["datasetId"] == "dataset_001"

    def test_to_dict_omits_none_id(self):
        ann = Annotation(
            id=None,
            shape="point",
            tags=["spot"],
            channel=1,
            location=Location(xy=0, z=0, time=0),
            coordinates=[{"x": 50.5, "y": 60.5}],
            dataset_id="ds_001",
        )
        result = ann.to_dict()
        assert "_id" not in result

    def test_to_dict_includes_id_when_set(self, sample_annotation_dict):
        ann = Annotation.from_dict(sample_annotation_dict)
        result = ann.to_dict()
        assert result["_id"] == "ann_001"

    def test_to_dict_includes_color_when_set(self):
        ann = Annotation(
            id=None,
            shape="point",
            tags=[],
            channel=0,
            location=Location(),
            coordinates=[{"x": 10.0, "y": 20.0}],
            dataset_id="ds_001",
            color="rgb(255,0,0)",
        )
        result = ann.to_dict()
        assert result["color"] == "rgb(255,0,0)"

    def test_empty_tags(self):
        ann = Annotation(
            id=None,
            shape="polygon",
            tags=[],
            channel=0,
            location=Location(),
            coordinates=[],
            dataset_id="ds_001",
        )
        assert ann.tags == []

    def test_from_point_classmethod(self):
        ann = Annotation.from_point(
            x=100.0, y=200.0, channel=0, tags=["spot"],
            dataset_id="ds_001", location=Location(xy=0, z=1, time=2),
        )
        assert ann.shape == "point"
        assert len(ann.coordinates) == 1
        # from_point takes image-space x,y and stores directly
        assert ann.coordinates[0]["x"] == 100.0
        assert ann.coordinates[0]["y"] == 200.0


class TestConnection:
    def test_from_dict(self, sample_connection_dict):
        conn = Connection.from_dict(sample_connection_dict)
        assert conn.id == "conn_001"
        assert conn.parent_id == "ann_001"
        assert conn.child_id == "ann_002"
        assert conn.dataset_id == "dataset_001"
        assert conn.tags == ["parent-child"]

    def test_to_dict_round_trip(self, sample_connection_dict):
        conn = Connection.from_dict(sample_connection_dict)
        result = conn.to_dict()
        assert result["parentId"] == "ann_001"
        assert result["childId"] == "ann_002"
        assert result["datasetId"] == "dataset_001"
        assert result["tags"] == ["parent-child"]

    def test_to_dict_omits_none_id(self):
        conn = Connection(
            id=None,
            parent_id="p1",
            child_id="c1",
            dataset_id="ds_001",
            tags=[],
        )
        result = conn.to_dict()
        assert "_id" not in result

    def test_default_empty_tags(self):
        conn = Connection(
            id=None, parent_id="p1", child_id="c1", dataset_id="ds_001"
        )
        assert conn.tags == []


class TestProperty:
    def test_from_dict(self, sample_property_dict):
        prop = Property.from_dict(sample_property_dict)
        assert prop.id == "prop_001"
        assert prop.name == "Blob Intensity"
        assert prop.shape == "polygon"
        assert prop.image == "properties/blob_intensity:latest"
        assert prop.tags == {"exclusive": False, "tags": ["nucleus"]}
        assert prop.worker_interface == {"Channel": 1}


class TestPixelSize:
    def test_to_conversion(self):
        ps = PixelSize(value=0.000219, unit="mm")
        result = ps.to("um")
        assert result.unit == "um"
        assert abs(result.value - 0.219) < 1e-9

    def test_to_nm(self):
        ps = PixelSize(value=0.000219, unit="mm")
        result = ps.to("nm")
        assert result.unit == "nm"
        assert abs(result.value - 219.0) < 1e-6

    def test_float(self):
        ps = PixelSize(value=0.5, unit="mm")
        assert float(ps) == 0.5

    def test_mul(self):
        ps = PixelSize(value=0.5, unit="mm")
        assert ps * 10 == 5.0

    def test_alias_micron(self):
        ps = PixelSize(value=219.0, unit="nm")
        result = ps.to("micron")
        assert result.unit == "um"  # canonical form
        assert abs(result.value - 0.219) < 1e-6

    def test_identity_conversion(self):
        ps = PixelSize(value=42.0, unit="um")
        result = ps.to("um")
        assert result.value == 42.0


class TestFrameInfo:
    def test_to_dict(self):
        fi = FrameInfo(
            index=0, xy=0, z=1, time=2, channel=0, channel_name="DAPI"
        )
        d = fi.to_dict()
        assert d == {"xy": 0, "z": 1, "time": 2, "channel": 0}

    def test_to_large_image_params(self):
        fi = FrameInfo(
            index=5, xy=1, z=2, time=3, channel=0, channel_name="GFP"
        )
        params = fi.to_large_image_params()
        assert params == {"c": 0, "z": 2, "t": 3, "xy": 1}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd nimbusimage && source .venv/bin/activate
pytest tests/test_models.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'nimbusimage.models'`

- [ ] **Step 3: Implement models.py**

Create `nimbusimage/nimbusimage/models.py`:

```python
"""Data models for the nimbusimage package."""

from __future__ import annotations

from dataclasses import dataclass, field

# Unit conversion factors to meters
_TO_METERS = {
    "m": 1.0,
    "mm": 1e-3,
    "um": 1e-6,
    "nm": 1e-9,
}

# Aliases that map to canonical unit names
_UNIT_ALIASES = {
    "µm": "um",
    "micron": "um",
    "microns": "um",
}


def _canonical_unit(unit: str) -> str:
    return _UNIT_ALIASES.get(unit, unit)


@dataclass
class Location:
    """A position in the dataset coordinate space."""

    xy: int = 0
    z: int = 0
    time: int = 0

    def to_dict(self) -> dict:
        """Serialize to the server's location format."""
        return {"XY": self.xy, "Z": self.z, "Time": self.time}

    @classmethod
    def from_dict(cls, data: dict) -> Location:
        """Deserialize from the server's location format."""
        return cls(
            xy=data.get("XY", 0),
            z=data.get("Z", 0),
            time=data.get("Time", 0),
        )


@dataclass
class Annotation:
    """A NimbusImage annotation.

    Stores raw coordinates as the server provides them.
    Geometry conversion methods (polygon, point, get_mask, etc.)
    are in the coordinates module and called via convenience methods here.
    """

    id: str | None
    shape: str
    tags: list[str]
    channel: int
    location: Location
    coordinates: list[dict]
    dataset_id: str
    color: str | None = None

    def to_dict(self) -> dict:
        """Serialize to the server's annotation format."""
        d: dict = {
            "shape": self.shape,
            "tags": self.tags,
            "channel": self.channel,
            "location": self.location.to_dict(),
            "coordinates": self.coordinates,
            "datasetId": self.dataset_id,
        }
        if self.id is not None:
            d["_id"] = self.id
        if self.color is not None:
            d["color"] = self.color
        return d

    @classmethod
    def from_dict(cls, data: dict) -> Annotation:
        """Deserialize from the server's annotation format."""
        return cls(
            id=data.get("_id"),
            shape=data["shape"],
            tags=data.get("tags", []),
            channel=data.get("channel", 0),
            location=Location.from_dict(data.get("location", {})),
            coordinates=data.get("coordinates", []),
            dataset_id=data.get("datasetId", ""),
            color=data.get("color"),
        )

    @classmethod
    def from_point(
        cls,
        x: float,
        y: float,
        channel: int,
        tags: list[str],
        dataset_id: str,
        location: Location | None = None,
        color: str | None = None,
    ) -> Annotation:
        """Create a point annotation from image-space coordinates."""
        return cls(
            id=None,
            shape="point",
            tags=tags,
            channel=channel,
            location=location or Location(),
            coordinates=[{"x": x, "y": y}],
            dataset_id=dataset_id,
            color=color,
        )

    # Geometry methods are added by coordinates.py (polygon, point,
    # centroid, get_mask, get_pixels, from_polygon, from_mask)
    # to avoid circular imports. They are attached in __init__.py.


@dataclass
class Connection:
    """A connection between two annotations."""

    id: str | None
    parent_id: str
    child_id: str
    dataset_id: str
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize to the server's connection format."""
        d: dict = {
            "parentId": self.parent_id,
            "childId": self.child_id,
            "datasetId": self.dataset_id,
            "tags": self.tags,
        }
        if self.id is not None:
            d["_id"] = self.id
        return d

    @classmethod
    def from_dict(cls, data: dict) -> Connection:
        """Deserialize from the server's connection format."""
        return cls(
            id=data.get("_id"),
            parent_id=data["parentId"],
            child_id=data["childId"],
            dataset_id=data.get("datasetId", ""),
            tags=data.get("tags", []),
        )


@dataclass
class Property:
    """A property definition (schema, not values)."""

    id: str | None
    name: str
    shape: str
    image: str
    tags: dict
    worker_interface: dict

    @classmethod
    def from_dict(cls, data: dict) -> Property:
        """Deserialize from the server's property format."""
        return cls(
            id=data.get("_id"),
            name=data.get("name", ""),
            shape=data.get("shape", ""),
            image=data.get("image", ""),
            tags=data.get("tags", {}),
            worker_interface=data.get("workerInterface", {}),
        )

    def to_dict(self) -> dict:
        """Serialize to the server's property format."""
        d: dict = {
            "name": self.name,
            "shape": self.shape,
            "image": self.image,
            "tags": self.tags,
            "workerInterface": self.worker_interface,
        }
        if self.id is not None:
            d["_id"] = self.id
        return d


@dataclass
class PixelSize:
    """Physical pixel size with unit conversion."""

    value: float
    unit: str

    def __post_init__(self):
        self.unit = _canonical_unit(self.unit)

    def to(self, unit: str) -> PixelSize:
        """Convert to a different unit."""
        target = _canonical_unit(unit)
        if self.unit == target:
            return PixelSize(value=self.value, unit=target)
        meters = self.value * _TO_METERS[self.unit]
        return PixelSize(value=meters / _TO_METERS[target], unit=target)

    def __float__(self) -> float:
        return self.value

    def __mul__(self, other) -> float:
        return self.value * other

    def __rmul__(self, other) -> float:
        return other * self.value


@dataclass
class FrameInfo:
    """Metadata for a single image frame."""

    index: int
    xy: int
    z: int
    time: int
    channel: int
    channel_name: str | None

    def to_dict(self) -> dict:
        """Dict of coordinate keys for use as **kwargs."""
        return {
            "xy": self.xy,
            "z": self.z,
            "time": self.time,
            "channel": self.channel,
        }

    def to_large_image_params(self) -> dict:
        """Dict for large_image addTile parameters."""
        return {
            "c": self.channel,
            "z": self.z,
            "t": self.time,
            "xy": self.xy,
        }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd nimbusimage && pytest tests/test_models.py -v
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nimbusimage/nimbusimage/models.py nimbusimage/tests/test_models.py
git commit -m "feat(nimbusimage): add data models — Annotation, Connection, Property, Location, PixelSize, FrameInfo"
```

---

## Task 3: Coordinate Conventions

**Files:**
- Create: `nimbusimage/nimbusimage/coordinates.py`
- Create: `nimbusimage/tests/test_coordinates.py`

This is the most critical module. It encapsulates the x/y swap between annotation coordinates and shapely/numpy coordinates, plus the 0.5 pixel-center offset for mask operations.

**Convention summary (from doc 11):**
- Annotation `{'x': 300, 'y': 500}` means 300px from left, 500px from top
- Numpy `array[row, col]` = `array[y, x]`
- Shapely `Point(x, y)` where x=horizontal, y=vertical
- We adopt: shapely x = image column = annotation x, shapely y = image row = annotation y
- So annotation→shapely: **no swap needed** (both use x=horizontal, y=vertical)
- annotation→numpy mask: `array[ann_y, ann_x]` (swap for indexing)
- 0.5 offset: annotation coords are at pixel top-left corners; scikit-image rasterizes at pixel centers

Note: The existing `annotation_tools.py` in `annotation_utilities` DOES swap x/y when converting to shapely (treating shapely x as row, shapely y as column). This is confusing but was their convention. For `nimbusimage`, we adopt the cleaner convention: shapely x = image x = horizontal, shapely y = image y = vertical. **No swap for shapely.** The swap only happens for numpy indexing.

- [ ] **Step 1: Write test_coordinates.py**

Create `nimbusimage/tests/test_coordinates.py`:

```python
"""Tests for coordinate convention handling."""

import numpy as np
import pytest
from shapely.geometry import Point, Polygon

from nimbusimage.coordinates import (
    annotation_to_polygon,
    annotation_to_point,
    polygon_to_coordinates,
    point_to_coordinates,
    coordinates_to_mask,
    mask_to_coordinates,
)
from nimbusimage.models import Annotation, Location


class TestAnnotationToPolygon:
    """annotation coords → shapely Polygon (no swap, just extract)."""

    def test_basic_rectangle(self):
        coords = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        poly = annotation_to_polygon(coords)
        assert isinstance(poly, Polygon)
        # shapely x = annotation x, shapely y = annotation y
        xs, ys = poly.exterior.xy
        assert min(xs) == pytest.approx(100.5)
        assert max(xs) == pytest.approx(150.5)
        assert min(ys) == pytest.approx(200.5)
        assert max(ys) == pytest.approx(250.5)

    def test_empty_coords_returns_none(self):
        assert annotation_to_polygon([]) is None

    def test_single_point_returns_none(self):
        assert annotation_to_polygon([{"x": 1.0, "y": 2.0}]) is None


class TestAnnotationToPoint:
    """annotation coords → shapely Point (no swap)."""

    def test_basic(self):
        coords = [{"x": 100.5, "y": 200.5}]
        pt = annotation_to_point(coords)
        assert isinstance(pt, Point)
        assert pt.x == pytest.approx(100.5)
        assert pt.y == pytest.approx(200.5)

    def test_polygon_centroid(self):
        coords = [
            {"x": 0.0, "y": 0.0},
            {"x": 10.0, "y": 0.0},
            {"x": 10.0, "y": 10.0},
            {"x": 0.0, "y": 10.0},
        ]
        pt = annotation_to_point(coords)
        assert pt.x == pytest.approx(5.0)
        assert pt.y == pytest.approx(5.0)

    def test_empty_returns_none(self):
        assert annotation_to_point([]) is None


class TestPolygonToCoordinates:
    """shapely Polygon → annotation coordinate dicts (no swap)."""

    def test_round_trip(self):
        original = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        poly = annotation_to_polygon(original)
        result = polygon_to_coordinates(poly)
        # Should have same number of coords (shapely closes the ring,
        # but we strip the duplicate closing point)
        assert len(result) == 4
        for orig, res in zip(original, result):
            assert res["x"] == pytest.approx(orig["x"])
            assert res["y"] == pytest.approx(orig["y"])


class TestPointToCoordinates:
    """shapely Point → annotation coordinate dict (no swap)."""

    def test_basic(self):
        pt = Point(100.5, 200.5)
        result = point_to_coordinates(pt)
        assert len(result) == 1
        assert result[0]["x"] == pytest.approx(100.5)
        assert result[0]["y"] == pytest.approx(200.5)


class TestCoordinatesToMask:
    """annotation coords → boolean numpy mask (with 0.5 offset)."""

    def test_small_square(self):
        # A 3x3 square from pixel (10,20) to pixel (12,22)
        # Annotation coords at top-left corners: add 0.5 for centers
        coords = [
            {"x": 10.0, "y": 20.0},
            {"x": 13.0, "y": 20.0},
            {"x": 13.0, "y": 23.0},
            {"x": 10.0, "y": 23.0},
        ]
        mask = coordinates_to_mask(coords, (100, 100))
        assert mask.shape == (100, 100)
        assert mask.dtype == bool
        # Pixels inside: rows 20-22, cols 10-12
        assert mask[20, 10] is np.True_
        assert mask[22, 12] is np.True_
        # Pixel outside
        assert mask[19, 10] is np.False_
        assert mask[23, 13] is np.False_

    def test_returns_correct_shape(self):
        coords = [
            {"x": 0.0, "y": 0.0},
            {"x": 5.0, "y": 0.0},
            {"x": 5.0, "y": 5.0},
            {"x": 0.0, "y": 5.0},
        ]
        mask = coordinates_to_mask(coords, (50, 80))
        assert mask.shape == (50, 80)


class TestMaskToCoordinates:
    """boolean numpy mask → annotation coords (with 0.5 offset back)."""

    def test_round_trip_approximate(self):
        # Create a mask, convert to coords, convert back to mask
        original_mask = np.zeros((50, 50), dtype=bool)
        original_mask[10:20, 15:25] = True

        coords = mask_to_coordinates(original_mask)
        assert len(coords) > 0

        reconstructed = coordinates_to_mask(coords, (50, 50))
        # Should overlap substantially (rasterization may differ at edges)
        intersection = np.sum(original_mask & reconstructed)
        union = np.sum(original_mask | reconstructed)
        iou = intersection / union
        assert iou > 0.9  # Allow some edge rasterization difference


class TestAnnotationGeometryMethods:
    """Test the convenience methods attached to Annotation."""

    def test_polygon_method(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 0.0, "y": 0.0},
                {"x": 10.0, "y": 0.0},
                {"x": 10.0, "y": 10.0},
                {"x": 0.0, "y": 10.0},
            ],
        )
        poly = ann.polygon()
        assert isinstance(poly, Polygon)
        assert poly.area == pytest.approx(100.0)

    def test_point_method(self):
        ann = Annotation(
            id=None, shape="point", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[{"x": 50.5, "y": 60.5}],
        )
        pt = ann.point()
        assert isinstance(pt, Point)
        assert pt.x == pytest.approx(50.5)
        assert pt.y == pytest.approx(60.5)

    def test_centroid_method(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 0.0, "y": 0.0},
                {"x": 10.0, "y": 0.0},
                {"x": 10.0, "y": 10.0},
                {"x": 0.0, "y": 10.0},
            ],
        )
        cx, cy = ann.centroid()
        assert cx == pytest.approx(5.0)
        assert cy == pytest.approx(5.0)

    def test_get_mask(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 5.0, "y": 5.0},
                {"x": 15.0, "y": 5.0},
                {"x": 15.0, "y": 15.0},
                {"x": 5.0, "y": 15.0},
            ],
        )
        mask = ann.get_mask((50, 50))
        assert mask.shape == (50, 50)
        assert mask.dtype == bool
        assert mask[10, 10] is np.True_  # center of the square
        assert mask[0, 0] is np.False_   # outside

    def test_get_pixels(self):
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=[
                {"x": 5.0, "y": 5.0},
                {"x": 15.0, "y": 5.0},
                {"x": 15.0, "y": 15.0},
                {"x": 5.0, "y": 15.0},
            ],
        )
        rows, cols = ann.get_pixels((50, 50))
        assert len(rows) == len(cols)
        assert len(rows) > 0

    def test_from_polygon(self):
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        ann = Annotation.from_polygon(
            poly, channel=0, tags=["cell"], dataset_id="ds",
            location=Location(),
        )
        assert ann.shape == "polygon"
        assert len(ann.coordinates) == 4

    def test_from_mask(self):
        mask = np.zeros((50, 50), dtype=bool)
        mask[10:20, 15:25] = True
        ann = Annotation.from_mask(
            mask, channel=0, tags=["cell"], dataset_id="ds",
            location=Location(),
        )
        assert ann.shape == "polygon"
        assert len(ann.coordinates) > 0

    def test_polygon_to_annotation_round_trip(self):
        """annotation → polygon → annotation preserves coordinates."""
        original_coords = [
            {"x": 100.5, "y": 200.5},
            {"x": 150.5, "y": 200.5},
            {"x": 150.5, "y": 250.5},
            {"x": 100.5, "y": 250.5},
        ]
        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), dataset_id="ds",
            coordinates=original_coords,
        )
        poly = ann.polygon()
        ann2 = Annotation.from_polygon(
            poly, channel=0, tags=[], dataset_id="ds", location=Location(),
        )
        for orig, result in zip(original_coords, ann2.coordinates):
            assert result["x"] == pytest.approx(orig["x"])
            assert result["y"] == pytest.approx(orig["y"])
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd nimbusimage && pytest tests/test_coordinates.py -v
```

Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement coordinates.py**

Create `nimbusimage/nimbusimage/coordinates.py`:

```python
"""Coordinate convention handling for NimbusImage annotations.

Three coordinate systems:
1. Annotation: {'x': pixel_x, 'y': pixel_y} — x horizontal, y vertical
2. Numpy: array[row, col] = array[y, x]
3. Shapely: Point(x, y) — x horizontal, y vertical

Convention in this package:
- Shapely x = annotation x = image column (horizontal)
- Shapely y = annotation y = image row (vertical)
- No x/y swap for shapely conversions
- For numpy masks: row = annotation y, col = annotation x
- 0.5 offset: annotation coords are at pixel top-left corners;
  scikit-image draws at pixel centers
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
from shapely.geometry import Point, Polygon

if TYPE_CHECKING:
    from nimbusimage.models import Annotation, Location


def annotation_to_polygon(coordinates: list[dict]) -> Polygon | None:
    """Convert annotation coordinate dicts to a shapely Polygon.

    No x/y swap — annotation x maps to shapely x (horizontal).
    """
    if len(coordinates) < 3:
        return None
    points = [(c["x"], c["y"]) for c in coordinates]
    return Polygon(points)


def annotation_to_point(coordinates: list[dict]) -> Point | None:
    """Convert annotation coordinate dicts to a shapely Point.

    For single-coordinate annotations, returns that point.
    For multi-coordinate (polygons), returns the centroid.
    """
    if not coordinates:
        return None
    if len(coordinates) == 1:
        return Point(coordinates[0]["x"], coordinates[0]["y"])
    poly = annotation_to_polygon(coordinates)
    if poly is None:
        return None
    centroid = poly.centroid
    return Point(centroid.x, centroid.y)


def polygon_to_coordinates(polygon: Polygon) -> list[dict]:
    """Convert a shapely Polygon to annotation coordinate dicts.

    Strips the duplicate closing point that shapely adds.
    """
    xs, ys = polygon.exterior.xy
    # shapely repeats the first point at the end; exclude it
    coords = [{"x": float(x), "y": float(y)} for x, y in zip(xs, ys)]
    if len(coords) > 1 and coords[-1] == coords[0]:
        coords = coords[:-1]
    return coords


def point_to_coordinates(point: Point) -> list[dict]:
    """Convert a shapely Point to annotation coordinate dicts."""
    return [{"x": float(point.x), "y": float(point.y)}]


def coordinates_to_mask(
    coordinates: list[dict], shape: tuple[int, int]
) -> np.ndarray:
    """Convert annotation coordinates to a boolean mask.

    Applies the 0.5 offset: annotation coords are at pixel top-left
    corners, but rasterization uses pixel centers.

    Args:
        coordinates: List of {'x': ..., 'y': ...} dicts.
        shape: (height, width) of the output mask.

    Returns:
        Boolean numpy array of the given shape.
    """
    from skimage.draw import polygon as draw_polygon

    mask = np.zeros(shape, dtype=bool)
    if len(coordinates) < 3:
        return mask

    # rows = annotation y - 0.5, cols = annotation x - 0.5
    rows = np.array([c["y"] - 0.5 for c in coordinates])
    cols = np.array([c["x"] - 0.5 for c in coordinates])

    rr, cc = draw_polygon(rows, cols, shape=shape)
    mask[rr, cc] = True
    return mask


def mask_to_coordinates(mask: np.ndarray) -> list[dict]:
    """Convert a boolean mask to annotation coordinates.

    Uses contour finding and adds the 0.5 offset back.

    Returns:
        List of {'x': ..., 'y': ...} dicts forming the polygon boundary.
    """
    from skimage.measure import find_contours

    contours = find_contours(mask.astype(np.uint8), 0.5)
    if not contours:
        return []

    # Take the longest contour
    contour = max(contours, key=len)

    # contour is (N, 2) array of (row, col) at pixel centers
    # Add 0.5 to convert back to annotation coords (top-left corner)
    coords = []
    for row, col in contour:
        coords.append({"x": float(col + 0.5), "y": float(row + 0.5)})
    return coords


# --- Methods to attach to Annotation class ---


def _annotation_polygon(self) -> Polygon | None:
    """Return this annotation as a shapely Polygon."""
    return annotation_to_polygon(self.coordinates)


def _annotation_point(self) -> Point | None:
    """Return this annotation as a shapely Point (or centroid)."""
    return annotation_to_point(self.coordinates)


def _annotation_centroid(self) -> tuple[float, float]:
    """Return the centroid as (x, y) in annotation space."""
    pt = annotation_to_point(self.coordinates)
    if pt is None:
        return (0.0, 0.0)
    return (pt.x, pt.y)


def _annotation_get_mask(self, shape: tuple[int, int]) -> np.ndarray:
    """Return a boolean mask for this annotation."""
    return coordinates_to_mask(self.coordinates, shape)


def _annotation_get_pixels(
    self, shape: tuple[int, int]
) -> tuple[np.ndarray, np.ndarray]:
    """Return (rows, cols) arrays of pixels inside this annotation."""
    mask = coordinates_to_mask(self.coordinates, shape)
    return np.where(mask)


def _annotation_from_polygon(
    polygon: Polygon,
    channel: int,
    tags: list[str],
    dataset_id: str,
    location: Location | None = None,
    color: str | None = None,
) -> Annotation:
    """Create an Annotation from a shapely Polygon."""
    from nimbusimage.models import Annotation, Location as Loc

    return Annotation(
        id=None,
        shape="polygon",
        tags=tags,
        channel=channel,
        location=location or Loc(),
        coordinates=polygon_to_coordinates(polygon),
        dataset_id=dataset_id,
        color=color,
    )


def _annotation_from_mask(
    mask: np.ndarray,
    channel: int,
    tags: list[str],
    dataset_id: str,
    location: Location | None = None,
    color: str | None = None,
) -> Annotation:
    """Create an Annotation from a boolean mask."""
    from nimbusimage.models import Annotation, Location as Loc

    return Annotation(
        id=None,
        shape="polygon",
        tags=tags,
        channel=channel,
        location=location or Loc(),
        coordinates=mask_to_coordinates(mask),
        dataset_id=dataset_id,
        color=color,
    )


def attach_geometry_methods():
    """Attach geometry methods to the Annotation class.

    Called once during package initialization.
    """
    from nimbusimage.models import Annotation

    Annotation.polygon = _annotation_polygon
    Annotation.point = _annotation_point
    Annotation.centroid = _annotation_centroid
    Annotation.get_mask = _annotation_get_mask
    Annotation.get_pixels = _annotation_get_pixels
    Annotation.from_polygon = classmethod(
        lambda cls, *a, **kw: _annotation_from_polygon(*a, **kw)
    )
    Annotation.from_mask = classmethod(
        lambda cls, *a, **kw: _annotation_from_mask(*a, **kw)
    )
```

- [ ] **Step 4: Update __init__.py to attach geometry methods**

Update `nimbusimage/nimbusimage/__init__.py`:

```python
"""NimbusImage Python API."""

from nimbusimage.coordinates import attach_geometry_methods

# Attach geometry methods (polygon, point, get_mask, etc.) to Annotation
attach_geometry_methods()
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd nimbusimage && pip install scikit-image && pytest tests/test_coordinates.py -v
```

Note: `scikit-image` is needed for `draw.polygon` and `find_contours`. Add it to dependencies in pyproject.toml:

Update `nimbusimage/pyproject.toml` dependencies to include `scikit-image`:

```toml
dependencies = [
    "girder-client",
    "numpy",
    "shapely",
    "scikit-image",
]
```

Then: `pip install -e ".[dev]" && pytest tests/test_coordinates.py -v`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add nimbusimage/nimbusimage/coordinates.py nimbusimage/nimbusimage/__init__.py \
    nimbusimage/tests/test_coordinates.py nimbusimage/pyproject.toml
git commit -m "feat(nimbusimage): add coordinate convention handling with geometry methods on Annotation"
```

---

## Task 4: Client-Side Filters

**Files:**
- Create: `nimbusimage/nimbusimage/filters.py`
- Create: `nimbusimage/tests/test_filters.py`

- [ ] **Step 1: Write test_filters.py**

Create `nimbusimage/tests/test_filters.py`:

```python
"""Tests for client-side filter helpers."""

import pytest

from nimbusimage.filters import (
    filter_by_tags,
    filter_by_location,
    group_by_location,
)
from nimbusimage.models import Annotation, Location


def _ann(tags, xy=0, z=0, time=0):
    """Helper to create a minimal annotation."""
    return Annotation(
        id=None, shape="point", tags=tags, channel=0,
        location=Location(xy=xy, z=z, time=time),
        coordinates=[{"x": 0, "y": 0}], dataset_id="ds",
    )


class TestFilterByTags:
    def test_inclusive_match(self):
        anns = [_ann(["a", "b"]), _ann(["b", "c"]), _ann(["d"])]
        result = filter_by_tags(anns, tags=["b"])
        assert len(result) == 2

    def test_inclusive_no_match(self):
        anns = [_ann(["a"]), _ann(["b"])]
        result = filter_by_tags(anns, tags=["c"])
        assert len(result) == 0

    def test_exclusive_exact_match(self):
        anns = [_ann(["a", "b"]), _ann(["a"]), _ann(["b", "a"])]
        result = filter_by_tags(anns, tags=["a", "b"], exclusive=True)
        # exclusive: annotation tags must exactly match (order independent)
        assert len(result) == 2  # first and third

    def test_exclusive_no_match(self):
        anns = [_ann(["a", "b", "c"])]
        result = filter_by_tags(anns, tags=["a", "b"], exclusive=True)
        assert len(result) == 0

    def test_empty_tags_returns_all(self):
        anns = [_ann(["a"]), _ann(["b"])]
        result = filter_by_tags(anns, tags=[])
        assert len(result) == 2

    def test_empty_list(self):
        result = filter_by_tags([], tags=["a"])
        assert result == []


class TestFilterByLocation:
    def test_match_all_specified(self):
        anns = [_ann([], xy=0, z=1, time=2), _ann([], xy=0, z=0, time=2)]
        result = filter_by_location(anns, xy=0, z=1, time=2)
        assert len(result) == 1

    def test_none_means_any(self):
        anns = [
            _ann([], xy=0, z=0, time=0),
            _ann([], xy=0, z=1, time=0),
            _ann([], xy=0, z=2, time=0),
        ]
        result = filter_by_location(anns, xy=0, z=None, time=0)
        assert len(result) == 3

    def test_all_none_returns_all(self):
        anns = [_ann([], xy=0, z=0, time=0), _ann([], xy=1, z=1, time=1)]
        result = filter_by_location(anns, xy=None, z=None, time=None)
        assert len(result) == 2


class TestGroupByLocation:
    def test_basic_grouping(self):
        anns = [
            _ann(["a"], xy=0, z=0, time=0),
            _ann(["b"], xy=0, z=0, time=0),
            _ann(["c"], xy=1, z=0, time=0),
        ]
        groups = group_by_location(anns)
        assert len(groups) == 2
        assert len(groups[(0, 0, 0)]) == 2
        assert len(groups[(0, 0, 1)]) == 1

    def test_empty_list(self):
        groups = group_by_location([])
        assert groups == {}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd nimbusimage && pytest tests/test_filters.py -v
```

- [ ] **Step 3: Implement filters.py**

Create `nimbusimage/nimbusimage/filters.py`:

```python
"""Client-side filtering helpers for annotation lists."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nimbusimage.models import Annotation


def filter_by_tags(
    annotations: list[Annotation],
    tags: list[str],
    exclusive: bool = False,
) -> list[Annotation]:
    """Filter annotations by tags.

    Args:
        annotations: List of Annotation objects.
        tags: Tags to filter by.
        exclusive: If False (default), annotation must have at least one
            matching tag. If True, annotation tags must exactly match
            (order independent).

    Returns:
        Filtered list.
    """
    if not tags:
        return list(annotations)

    tag_set = set(tags)
    if exclusive:
        return [a for a in annotations if set(a.tags) == tag_set]
    else:
        return [a for a in annotations if tag_set & set(a.tags)]


def filter_by_location(
    annotations: list[Annotation],
    xy: int | None = None,
    z: int | None = None,
    time: int | None = None,
) -> list[Annotation]:
    """Filter annotations by location. None means any value.

    Args:
        annotations: List of Annotation objects.
        xy: XY position to match, or None for any.
        z: Z position to match, or None for any.
        time: Time position to match, or None for any.

    Returns:
        Filtered list.
    """
    result = []
    for a in annotations:
        if xy is not None and a.location.xy != xy:
            continue
        if z is not None and a.location.z != z:
            continue
        if time is not None and a.location.time != time:
            continue
        result.append(a)
    return result


def group_by_location(
    annotations: list[Annotation],
) -> dict[tuple[int, int, int], list[Annotation]]:
    """Group annotations by (time, z, xy) location.

    Returns:
        Dict mapping (time, z, xy) tuples to lists of annotations.
    """
    groups: dict[tuple[int, int, int], list[Annotation]] = {}
    for a in annotations:
        key = (a.location.time, a.location.z, a.location.xy)
        groups.setdefault(key, []).append(a)
    return groups
```

- [ ] **Step 4: Run tests**

```bash
cd nimbusimage && pytest tests/test_filters.py -v
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add nimbusimage/nimbusimage/filters.py nimbusimage/tests/test_filters.py
git commit -m "feat(nimbusimage): add client-side filter helpers — filter_by_tags, filter_by_location, group_by_location"
```

---

## Task 5: Internal Girder Wrapper

**Files:**
- Create: `nimbusimage/nimbusimage/_girder.py`

No separate tests — this is a thin internal wrapper tested through the accessors that use it.

- [ ] **Step 1: Implement _girder.py**

Create `nimbusimage/nimbusimage/_girder.py`:

```python
"""Internal wrapper around girder_client.GirderClient.

This module is an implementation detail. Users should never import from it.
All HTTP communication goes through this wrapper so that endpoint paths
and error handling are centralized.
"""

from __future__ import annotations

import os

import girder_client


def create_client(
    api_url: str | None = None,
    token: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> girder_client.GirderClient:
    """Create and authenticate a GirderClient.

    Connection modes (tried in order):
    1. Explicit token
    2. Username + password
    3. Environment variables NI_API_URL and NI_TOKEN

    Args:
        api_url: Girder API URL (e.g., 'http://localhost:8080/api/v1').
        token: Pre-existing authentication token.
        username: Username for interactive auth.
        password: Password for interactive auth.

    Returns:
        Authenticated GirderClient instance.

    Raises:
        ValueError: If no valid authentication method is provided.
    """
    if api_url is None:
        api_url = os.environ.get("NI_API_URL")
    if api_url is None:
        raise ValueError(
            "api_url must be provided or set NI_API_URL environment variable"
        )

    gc = girder_client.GirderClient(apiUrl=api_url)

    if token is not None:
        gc.setToken(token)
    elif username is not None and password is not None:
        gc.authenticate(username=username, password=password)
    else:
        env_token = os.environ.get("NI_TOKEN")
        if env_token is not None:
            gc.setToken(env_token)
        else:
            raise ValueError(
                "Provide token=, username=/password=, or set NI_TOKEN "
                "environment variable"
            )

    return gc
```

- [ ] **Step 2: Commit**

```bash
git add nimbusimage/nimbusimage/_girder.py
git commit -m "feat(nimbusimage): add internal girder_client wrapper"
```

---

## Task 6: NimbusClient

**Files:**
- Create: `nimbusimage/nimbusimage/client.py`
- Create: `nimbusimage/tests/test_client.py`

- [ ] **Step 1: Write test_client.py**

Create `nimbusimage/tests/test_client.py`:

```python
"""Tests for NimbusClient."""

import os
from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.client import NimbusClient


class TestNimbusClientInit:
    def test_connect_with_token(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            client = NimbusClient(
                api_url="http://localhost:8080/api/v1", token="tok123"
            )
            assert client.api_url == "http://localhost:8080/api/v1"
            mock_gc.setToken.assert_called_with("tok123")

    def test_connect_with_username_password(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            client = NimbusClient(
                api_url="http://localhost:8080/api/v1",
                username="admin",
                password="password",
            )
            mock_gc.authenticate.assert_called_with(
                username="admin", password="password"
            )

    def test_connect_with_env_vars(self):
        with patch("nimbusimage._girder.girder_client.GirderClient") as MockGC:
            mock_gc = MagicMock()
            MockGC.return_value = mock_gc
            mock_gc.get.return_value = {"_id": "user123", "login": "admin"}

            with patch.dict(os.environ, {
                "NI_API_URL": "http://env:8080/api/v1",
                "NI_TOKEN": "envtoken",
            }):
                client = NimbusClient()
                assert client.api_url == "http://env:8080/api/v1"
                mock_gc.setToken.assert_called_with("envtoken")

    def test_connect_no_credentials_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="api_url must be provided"):
                NimbusClient()


class TestNimbusClientProperties:
    def test_girder_escape_hatch(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        assert client.girder is mock_gc

    def test_token_property(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"
        assert client.token == "test-token-abc123"


class TestNimbusClientDataset:
    def test_dataset_by_id(self, mock_gc):
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"

        ds = client.dataset("folder_123")
        assert ds.id == "folder_123"

    def test_dataset_by_name(self, mock_gc):
        mock_gc.get.return_value = [
            {"_id": "folder_123", "name": "My Dataset", "meta": {}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"

        ds = client.dataset(name="My Dataset")
        assert ds.id == "folder_123"

    def test_dataset_by_name_not_found(self, mock_gc):
        mock_gc.get.return_value = []
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"

        with pytest.raises(ValueError, match="not found"):
            client.dataset(name="Nonexistent")


class TestNimbusClientListDatasets:
    def test_list_datasets(self, mock_gc):
        mock_gc.get.return_value = [
            {"_id": "f1", "name": "Dataset A", "meta": {"subtype": "contrastDataset"}},
            {"_id": "f2", "name": "Dataset B", "meta": {"subtype": "contrastDataset"}},
        ]
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc
        client._api_url = "http://localhost:8080/api/v1"

        datasets = client.list_datasets()
        assert len(datasets) == 2
        assert datasets[0]["name"] == "Dataset A"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd nimbusimage && pytest tests/test_client.py -v
```

- [ ] **Step 3: Implement client.py**

Create `nimbusimage/nimbusimage/client.py`:

```python
"""NimbusClient — authenticated entry point for the NimbusImage API."""

from __future__ import annotations

from typing import Any

from nimbusimage._girder import create_client
from nimbusimage.dataset import Dataset
from nimbusimage.projects import Project


class NimbusClient:
    """Authenticated session to a NimbusImage server.

    Create via ni.connect():
        client = ni.connect(api_url, token=...)
        client = ni.connect(api_url, username=..., password=...)
        client = ni.connect()  # from NI_API_URL + NI_TOKEN env vars
    """

    def __init__(
        self,
        api_url: str | None = None,
        token: str | None = None,
        username: str | None = None,
        password: str | None = None,
    ):
        self._gc = create_client(
            api_url=api_url,
            token=token,
            username=username,
            password=password,
        )
        self._api_url = api_url or self._gc.getServerApiUrl()

    @property
    def api_url(self) -> str:
        return self._api_url

    @property
    def token(self) -> str:
        return self._gc.token

    @property
    def user_id(self) -> str:
        me = self._gc.get("user/me")
        return me["_id"]

    @property
    def girder(self):
        """Raw girder_client.GirderClient escape hatch."""
        return self._gc

    # --- Datasets ---

    def dataset(
        self, dataset_id: str | None = None, *, name: str | None = None
    ) -> Dataset:
        """Get a Dataset object.

        Args:
            dataset_id: The folder ID of the dataset.
            name: Look up dataset by name (searches all accessible folders).

        Returns:
            Dataset object (lazy — no HTTP call until data is accessed).
        """
        if dataset_id is not None:
            return Dataset(self._gc, dataset_id)
        if name is not None:
            # Search for folders with this name that are datasets
            results = self._gc.get(
                "resource/search",
                parameters={"q": name, "mode": "prefix", "types": '["folder"]'},
            )
            folders = results.get("folder", [])
            for f in folders:
                if f.get("name") == name:
                    return Dataset(self._gc, f["_id"])
            raise ValueError(f"Dataset with name '{name}' not found")
        raise ValueError("Provide either dataset_id or name=")

    def list_datasets(self) -> list[dict]:
        """List all accessible datasets.

        Returns:
            List of dataset info dicts with _id, name, meta.
        """
        # Use the resource search to find dataset folders
        # This is a simplified approach; the full implementation
        # may need to search through user folders
        return self._gc.get(
            "resource/search",
            parameters={
                "q": "contrastDataset",
                "mode": "prefix",
                "types": '["folder"]',
            },
        ).get("folder", [])

    # --- Projects ---

    def list_projects(self) -> list[dict]:
        """List all accessible projects."""
        return self._gc.get("project")

    def create_project(
        self, name: str, description: str = ""
    ) -> Project:
        """Create a new project."""
        data = self._gc.post(
            "project",
            parameters={"name": name, "description": description},
        )
        return Project(self._gc, data)

    def project(self, project_id: str) -> Project:
        """Get a Project by ID."""
        data = self._gc.get(f"project/{project_id}")
        return Project(self._gc, data)
```

- [ ] **Step 4: Run tests**

```bash
cd nimbusimage && pytest tests/test_client.py -v
```

Expected: Some tests may fail due to Dataset import. We implement Dataset next.

- [ ] **Step 5: Commit (even if Dataset is a stub)**

```bash
git add nimbusimage/nimbusimage/client.py nimbusimage/tests/test_client.py
git commit -m "feat(nimbusimage): add NimbusClient with connect, dataset, project access"
```

---

## Task 7: Dataset

**Files:**
- Create: `nimbusimage/nimbusimage/dataset.py`
- Create: `nimbusimage/tests/test_dataset.py`

- [ ] **Step 1: Write test_dataset.py**

Create `nimbusimage/tests/test_dataset.py`:

```python
"""Tests for Dataset class."""

import pytest

from nimbusimage.dataset import Dataset
from nimbusimage.models import FrameInfo, PixelSize


class TestDatasetMetadata:
    def test_lazy_no_http_on_init(self, mock_gc):
        ds = Dataset(mock_gc, "folder_123")
        assert ds.id == "folder_123"
        mock_gc.get.assert_not_called()

    def test_metadata_fetched_on_first_access(self, mock_gc, sample_tiles_metadata):
        # Mock the folder endpoint (to find the large image item)
        mock_gc.get.side_effect = [
            # GET /folder/{id}
            {"_id": "folder_123", "name": "Test Dataset", "meta": {}},
            # GET /item?folderId={id}&limit=0
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            # GET /item/{id}/tiles
            sample_tiles_metadata,
        ]

        ds = Dataset(mock_gc, "folder_123")
        assert ds.name == "Test Dataset"
        assert ds.num_channels == 2
        assert ds.num_z == 2
        assert ds.num_time == 1
        assert ds.num_xy == 1
        assert ds.channels == ["DAPI", "GFP"]
        assert ds.shape == (768, 1024)
        assert ds.dtype == "uint16"

    def test_pixel_size(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        ps = ds.pixel_size
        assert isinstance(ps, PixelSize)
        assert ps.unit == "mm"
        assert ps.value == pytest.approx(0.000219)

    def test_frames(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        frames = ds.frames
        assert len(frames) == 4
        assert isinstance(frames[0], FrameInfo)
        assert frames[0].channel == 0
        assert frames[0].channel_name == "DAPI"

    def test_metadata_cached_after_first_access(self, mock_gc, sample_tiles_metadata):
        mock_gc.get.side_effect = [
            {"_id": "folder_123", "name": "Test", "meta": {}},
            [{"_id": "item_456", "largeImage": {"fileId": "f1"}}],
            sample_tiles_metadata,
        ]
        ds = Dataset(mock_gc, "folder_123")
        _ = ds.name
        _ = ds.num_channels
        _ = ds.shape
        # Only 3 calls total (folder, items, tiles), not re-fetched
        assert mock_gc.get.call_count == 3


class TestDatasetAccessors:
    def test_has_all_accessors(self, mock_gc):
        ds = Dataset(mock_gc, "folder_123")
        assert hasattr(ds, "images")
        assert hasattr(ds, "annotations")
        assert hasattr(ds, "connections")
        assert hasattr(ds, "properties")
        assert hasattr(ds, "config")
        assert hasattr(ds, "export")
        assert hasattr(ds, "history")
        assert hasattr(ds, "sharing")
```

- [ ] **Step 2: Implement dataset.py**

Create `nimbusimage/nimbusimage/dataset.py`:

```python
"""Dataset — central object for accessing one NimbusImage dataset."""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.config import ConfigAccessor
from nimbusimage.connections import ConnectionAccessor
from nimbusimage.export import ExportAccessor
from nimbusimage.history import HistoryAccessor
from nimbusimage.images import ImageAccessor
from nimbusimage.models import FrameInfo, PixelSize
from nimbusimage.properties import PropertyAccessor
from nimbusimage.sharing import SharingAccessor

if TYPE_CHECKING:
    import girder_client


class Dataset:
    """Access point for a single NimbusImage dataset.

    Metadata is fetched lazily on first access to any property.
    """

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._id = dataset_id
        self._metadata: dict | None = None
        self._tiles: dict | None = None
        self._item_id: str | None = None
        self._folder_data: dict | None = None

        # Create accessor sub-objects
        self.images = ImageAccessor(self)
        self.annotations = AnnotationAccessor(gc, dataset_id)
        self.connections = ConnectionAccessor(gc, dataset_id)
        self.properties = PropertyAccessor(gc, dataset_id)
        self.config = ConfigAccessor(gc, dataset_id)
        self.export = ExportAccessor(gc, dataset_id)
        self.history = HistoryAccessor(gc, dataset_id)
        self.sharing = SharingAccessor(gc, dataset_id)

    def _ensure_metadata(self):
        """Fetch and cache metadata if not already loaded."""
        if self._tiles is not None:
            return

        # Get folder info
        self._folder_data = self._gc.get(f"folder/{self._id}")

        # Find the large image item in this folder
        items = self._gc.get(f"item?folderId={self._id}&limit=0")
        selected_id = self._folder_data.get("meta", {}).get(
            "selectedLargeImageId"
        )
        if selected_id:
            item = next(
                (i for i in items if i["_id"] == selected_id), None
            )
        else:
            item = next(
                (i for i in items if "largeImage" in i), None
            )

        if item is None:
            raise ValueError(
                f"No large image found in dataset {self._id}"
            )

        self._item_id = item["_id"]

        # Fetch tiles metadata
        self._tiles = self._gc.get(f"item/{self._item_id}/tiles")

    @property
    def id(self) -> str:
        return self._id

    @property
    def name(self) -> str:
        self._ensure_metadata()
        return self._folder_data["name"]

    @property
    def num_channels(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexC", 1)

    @property
    def num_z(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexZ", 1)

    @property
    def num_time(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexT", 1)

    @property
    def num_xy(self) -> int:
        self._ensure_metadata()
        return self._tiles.get("IndexRange", {}).get("IndexXY", 1)

    @property
    def channels(self) -> list[str]:
        self._ensure_metadata()
        return self._tiles.get("channels", [])

    @property
    def pixel_size(self) -> PixelSize:
        self._ensure_metadata()
        mm_x = self._tiles.get("mm_x")
        if mm_x is not None:
            return PixelSize(value=mm_x, unit="mm")
        return PixelSize(value=1.0, unit="um")

    @property
    def shape(self) -> tuple[int, int]:
        self._ensure_metadata()
        return (self._tiles["sizeY"], self._tiles["sizeX"])

    @property
    def dtype(self) -> str:
        self._ensure_metadata()
        return self._tiles.get("dtype", "uint8")

    @property
    def mm_x(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("mm_x")

    @property
    def mm_y(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("mm_y")

    @property
    def magnification(self) -> float | None:
        self._ensure_metadata()
        return self._tiles.get("magnification")

    @property
    def frames(self) -> list[FrameInfo]:
        self._ensure_metadata()
        result = []
        channels = self._tiles.get("channels", [])
        for f in self._tiles.get("frames", []):
            ch_idx = f.get("IndexC", 0)
            result.append(FrameInfo(
                index=f["Frame"],
                xy=f.get("IndexXY", 0),
                z=f.get("IndexZ", 0),
                time=f.get("IndexT", 0),
                channel=ch_idx,
                channel_name=channels[ch_idx] if ch_idx < len(channels) else None,
            ))
        return result
```

- [ ] **Step 3: Create stub accessor files so Dataset imports work**

We need stub files for all accessors. Create these minimal stubs (they'll be fleshed out in later tasks):

Create `nimbusimage/nimbusimage/annotations.py`:
```python
"""AnnotationAccessor — stub, implemented in Task 8."""

class AnnotationAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/connections.py`:
```python
"""ConnectionAccessor — stub, implemented in Task 9."""

class ConnectionAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/properties.py`:
```python
"""PropertyAccessor — stub, implemented in Task 10."""

class PropertyAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/images.py`:
```python
"""ImageAccessor — stub, implemented in Task 11."""

class ImageAccessor:
    def __init__(self, dataset):
        self._dataset = dataset
```

Create `nimbusimage/nimbusimage/config.py`:
```python
"""ConfigAccessor — stub, implemented in Task 12."""

class ConfigAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/export.py`:
```python
"""ExportAccessor — stub, implemented in Task 12."""

class ExportAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/history.py`:
```python
"""HistoryAccessor — stub, implemented in Task 12."""

class HistoryAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/sharing.py`:
```python
"""SharingAccessor — stub, implemented in Task 12."""

class SharingAccessor:
    def __init__(self, gc, dataset_id):
        self._gc = gc
        self._dataset_id = dataset_id
```

Create `nimbusimage/nimbusimage/projects.py`:
```python
"""Project — stub, implemented in Task 13."""

class Project:
    def __init__(self, gc, data):
        self._gc = gc
        self._data = data
```

- [ ] **Step 4: Run tests**

```bash
cd nimbusimage && pytest tests/test_dataset.py tests/test_client.py -v
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add nimbusimage/nimbusimage/
git commit -m "feat(nimbusimage): add Dataset with lazy metadata and accessor stubs"
```

---

## Task 8: AnnotationAccessor

**Files:**
- Modify: `nimbusimage/nimbusimage/annotations.py` (replace stub)
- Create: `nimbusimage/tests/test_annotations.py`

**Backend endpoints (from doc 15):**
- `GET /upenn_annotation?datasetId=&shape=&tags=&limit=&offset=`
- `GET /upenn_annotation/{id}`
- `GET /upenn_annotation/count?datasetId=&shape=&tags=`
- `POST /upenn_annotation` (single)
- `POST /upenn_annotation/multiple` (bulk)
- `PUT /upenn_annotation/{id}` (single update)
- `PUT /upenn_annotation/multiple` (bulk update)
- `DELETE /upenn_annotation/{id}`
- `DELETE /upenn_annotation/multiple` (body: array of IDs)

- [ ] **Step 1: Write test_annotations.py**

Create `nimbusimage/tests/test_annotations.py`:

```python
"""Tests for AnnotationAccessor."""

import json

import pytest

from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.models import Annotation, Location


class TestAnnotationList:
    def test_list_all(self, mock_gc, sample_annotation_dict):
        mock_gc.get.return_value = [sample_annotation_dict]
        accessor = AnnotationAccessor(mock_gc, "dataset_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Annotation)
        assert result[0].id == "ann_001"
        mock_gc.get.assert_called_once()
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=dataset_001" in call_url
        assert "limit=0" in call_url

    def test_list_with_filters(self, mock_gc):
        mock_gc.get.return_value = []
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        accessor.list(shape="polygon", tags=["nucleus"], limit=100)
        call_url = mock_gc.get.call_args[0][0]
        assert "shape=polygon" in call_url
        assert "limit=100" in call_url


class TestAnnotationGet:
    def test_get_by_id(self, mock_gc, sample_annotation_dict):
        mock_gc.get.return_value = sample_annotation_dict
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = accessor.get("ann_001")
        assert isinstance(ann, Annotation)
        assert ann.id == "ann_001"
        mock_gc.get.assert_called_with("/upenn_annotation/ann_001")


class TestAnnotationCount:
    def test_count(self, mock_gc):
        mock_gc.get.return_value = {"count": 42}
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        result = accessor.count(shape="polygon")
        assert result == 42


class TestAnnotationCreate:
    def test_create_single(self, mock_gc, sample_annotation_dict):
        mock_gc.post.return_value = sample_annotation_dict
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=["nucleus"], channel=0,
            location=Location(), coordinates=[{"x": 1, "y": 2}],
            dataset_id="ds_001",
        )
        result = accessor.create(ann)
        assert isinstance(result, Annotation)
        assert result.id == "ann_001"
        mock_gc.post.assert_called_once()

    def test_create_many(self, mock_gc, sample_annotation_dict):
        mock_gc.post.return_value = [sample_annotation_dict]
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), coordinates=[], dataset_id="ds_001",
        )
        result = accessor.create_many([ann])
        assert len(result) == 1
        mock_gc.post.assert_called_once()
        call_url = mock_gc.post.call_args[0][0]
        assert "multiple" in call_url

    def test_create_many_with_connect_to(self, mock_gc, sample_annotation_dict):
        # First call: create annotations
        mock_gc.post.side_effect = [
            [sample_annotation_dict],  # create multiple
            None,  # connect to nearest
        ]
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        ann = Annotation(
            id=None, shape="polygon", tags=[], channel=0,
            location=Location(), coordinates=[], dataset_id="ds_001",
        )
        result = accessor.create_many(
            [ann], connect_to={"tags": ["cell"], "channel": 0}
        )
        assert len(result) == 1
        assert mock_gc.post.call_count == 2


class TestAnnotationUpdate:
    def test_update_single(self, mock_gc, sample_annotation_dict):
        updated = {**sample_annotation_dict, "tags": ["updated"]}
        mock_gc.put.return_value = updated
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        result = accessor.update("ann_001", {"tags": ["updated"]})
        assert isinstance(result, Annotation)
        assert result.tags == ["updated"]

    def test_update_many(self, mock_gc):
        mock_gc.put.return_value = []
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        accessor.update_many([("id1", {"tags": ["a"]}), ("id2", {"tags": ["b"]})])
        call_url = mock_gc.put.call_args[0][0]
        assert "multiple" in call_url


class TestAnnotationDelete:
    def test_delete_single(self, mock_gc):
        accessor = AnnotationAccessor(mock_gc, "ds_001")
        accessor.delete("ann_001")
        mock_gc.delete.assert_called_with("/upenn_annotation/ann_001")

    def test_delete_many(self, mock_gc):
        accessor = AnnotationAccessor(mock_gc, "ds_001")
        accessor.delete_many(["id1", "id2", "id3"])
        mock_gc.sendRestRequest.assert_called_once()
        args = mock_gc.sendRestRequest.call_args
        assert args[0][0] == "DELETE"
        assert "multiple" in args[0][1]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd nimbusimage && pytest tests/test_annotations.py -v
```

- [ ] **Step 3: Implement annotations.py**

Replace `nimbusimage/nimbusimage/annotations.py`:

```python
"""AnnotationAccessor — CRUD operations for annotations."""

from __future__ import annotations

import json
from typing import Any, TYPE_CHECKING

from nimbusimage.models import Annotation

if TYPE_CHECKING:
    import girder_client


class AnnotationAccessor:
    """Access annotations for a specific dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> list[Annotation]:
        """List annotations in this dataset.

        Args:
            shape: Filter by shape ('polygon', 'point', 'line').
            tags: Filter by tags (JSON-encoded array sent to server).
            limit: Max results. 0 = unlimited.
            offset: Skip this many results.

        Returns:
            List of Annotation objects.
        """
        url = (
            f"/upenn_annotation?datasetId={self._dataset_id}"
            f"&limit={limit}&offset={offset}"
        )
        if shape:
            url += f"&shape={shape}"
        if tags:
            url += f"&tags={json.dumps(tags)}"

        data = self._gc.get(url)
        return [Annotation.from_dict(d) for d in data]

    def get(self, annotation_id: str) -> Annotation:
        """Get a single annotation by ID."""
        data = self._gc.get(f"/upenn_annotation/{annotation_id}")
        return Annotation.from_dict(data)

    def count(
        self,
        shape: str | None = None,
        tags: list[str] | None = None,
    ) -> int:
        """Count annotations matching filters."""
        url = f"/upenn_annotation/count?datasetId={self._dataset_id}"
        if shape:
            url += f"&shape={shape}"
        if tags:
            url += f"&tags={json.dumps(tags)}"
        return self._gc.get(url)["count"]

    def create(self, annotation: Annotation) -> Annotation:
        """Create a single annotation."""
        data = self._gc.post("/upenn_annotation/", json=annotation.to_dict())
        return Annotation.from_dict(data)

    def create_many(
        self,
        annotations: list[Annotation],
        connect_to: dict | None = None,
    ) -> list[Annotation]:
        """Create multiple annotations in bulk.

        Args:
            annotations: List of Annotation objects to create.
            connect_to: If provided, auto-connect created annotations
                to nearest matching annotation. Dict with 'tags' and
                'channel' keys.

        Returns:
            List of created Annotations (with server-assigned IDs).
        """
        dicts = [a.to_dict() for a in annotations]
        data = self._gc.post("/upenn_annotation/multiple", json=dicts)
        created = [Annotation.from_dict(d) for d in data]

        if connect_to is not None:
            annotation_ids = [a.id for a in created if a.id]
            if annotation_ids:
                self._gc.post(
                    "/annotation_connection/connectToNearest",
                    json={
                        "annotationsIds": annotation_ids,
                        "tags": connect_to["tags"],
                        "channelId": connect_to["channel"],
                    },
                )

        return created

    def update(self, annotation_id: str, updates: dict) -> Annotation:
        """Update a single annotation."""
        data = self._gc.put(
            f"/upenn_annotation/{annotation_id}", json=updates
        )
        return Annotation.from_dict(data)

    def update_many(
        self, updates: list[tuple[str, dict]]
    ) -> list[Annotation]:
        """Update multiple annotations.

        Args:
            updates: List of (annotation_id, updates_dict) tuples.
        """
        payload = [
            {"_id": aid, **upd} for aid, upd in updates
        ]
        data = self._gc.put("/upenn_annotation/multiple", json=payload)
        return [Annotation.from_dict(d) for d in (data or [])]

    def delete(self, annotation_id: str) -> None:
        """Delete a single annotation."""
        self._gc.delete(f"/upenn_annotation/{annotation_id}")

    def delete_many(self, annotation_ids: list[str]) -> None:
        """Delete multiple annotations."""
        self._gc.sendRestRequest(
            "DELETE", "/upenn_annotation/multiple", json=annotation_ids
        )
```

- [ ] **Step 4: Run tests**

```bash
cd nimbusimage && pytest tests/test_annotations.py -v
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add nimbusimage/nimbusimage/annotations.py nimbusimage/tests/test_annotations.py
git commit -m "feat(nimbusimage): implement AnnotationAccessor with full CRUD"
```

---

## Task 9: ConnectionAccessor

**Files:**
- Modify: `nimbusimage/nimbusimage/connections.py` (replace stub)
- Create: `nimbusimage/tests/test_connections.py`

- [ ] **Step 1: Write test_connections.py**

Create `nimbusimage/tests/test_connections.py`:

```python
"""Tests for ConnectionAccessor."""

import pytest

from nimbusimage.connections import ConnectionAccessor
from nimbusimage.models import Connection


class TestConnectionList:
    def test_list_all(self, mock_gc, sample_connection_dict):
        mock_gc.get.return_value = [sample_connection_dict]
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Connection)

    def test_list_with_filters(self, mock_gc):
        mock_gc.get.return_value = []
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        accessor.list(parent_id="p1", child_id="c1", limit=50)
        call_url = mock_gc.get.call_args[0][0]
        assert "parentId=p1" in call_url
        assert "childId=c1" in call_url
        assert "limit=50" in call_url


class TestConnectionGet:
    def test_get_by_id(self, mock_gc, sample_connection_dict):
        mock_gc.get.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        conn = accessor.get("conn_001")
        assert conn.parent_id == "ann_001"


class TestConnectionCount:
    def test_count(self, mock_gc):
        mock_gc.get.return_value = {"count": 10}
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        assert accessor.count() == 10


class TestConnectionCreate:
    def test_create_single(self, mock_gc, sample_connection_dict):
        mock_gc.post.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.create("ann_001", "ann_002", tags=["link"])
        assert isinstance(result, Connection)

    def test_create_many(self, mock_gc, sample_connection_dict):
        mock_gc.post.return_value = [sample_connection_dict]
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        conn = Connection(
            id=None, parent_id="p1", child_id="c1",
            dataset_id="ds_001", tags=[],
        )
        result = accessor.create_many([conn])
        assert len(result) == 1

    def test_connect_to_nearest(self, mock_gc):
        mock_gc.post.return_value = None
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        accessor.connect_to_nearest(
            ["ann_001", "ann_002"], tags=["nucleus"], channel=0
        )
        call_args = mock_gc.post.call_args
        body = call_args[1]["json"]
        assert body["annotationsIds"] == ["ann_001", "ann_002"]
        assert body["tags"] == ["nucleus"]
        assert body["channelId"] == 0


class TestConnectionUpdate:
    def test_update(self, mock_gc, sample_connection_dict):
        mock_gc.put.return_value = sample_connection_dict
        accessor = ConnectionAccessor(mock_gc, "ds_001")

        result = accessor.update("conn_001", {"tags": ["new"]})
        assert isinstance(result, Connection)


class TestConnectionDelete:
    def test_delete_single(self, mock_gc):
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        accessor.delete("conn_001")
        mock_gc.delete.assert_called_with("/annotation_connection/conn_001")

    def test_delete_many(self, mock_gc):
        accessor = ConnectionAccessor(mock_gc, "ds_001")
        accessor.delete_many(["c1", "c2"])
        mock_gc.sendRestRequest.assert_called_once()
```

- [ ] **Step 2: Implement connections.py**

Replace `nimbusimage/nimbusimage/connections.py`:

```python
"""ConnectionAccessor — CRUD operations for annotation connections."""

from __future__ import annotations

from typing import TYPE_CHECKING

from nimbusimage.models import Connection

if TYPE_CHECKING:
    import girder_client


class ConnectionAccessor:
    """Access connections for a specific dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(
        self,
        parent_id: str | None = None,
        child_id: str | None = None,
        node_id: str | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> list[Connection]:
        """List connections in this dataset."""
        url = f"/annotation_connection/?datasetId={self._dataset_id}"
        if parent_id:
            url += f"&parentId={parent_id}"
        if child_id:
            url += f"&childId={child_id}"
        if node_id:
            url += f"&nodeAnnotationId={node_id}"
        url += f"&limit={limit}&offset={offset}"

        data = self._gc.get(url)
        return [Connection.from_dict(d) for d in data]

    def get(self, connection_id: str) -> Connection:
        """Get a single connection by ID."""
        data = self._gc.get(f"/annotation_connection/{connection_id}")
        return Connection.from_dict(data)

    def count(self) -> int:
        """Count connections in this dataset."""
        url = f"/annotation_connection/count?datasetId={self._dataset_id}"
        return self._gc.get(url)["count"]

    def create(
        self,
        parent_id: str,
        child_id: str,
        tags: list[str] | None = None,
    ) -> Connection:
        """Create a single connection."""
        body = {
            "parentId": parent_id,
            "childId": child_id,
            "datasetId": self._dataset_id,
            "tags": tags or [],
        }
        data = self._gc.post("/annotation_connection/", json=body)
        return Connection.from_dict(data)

    def create_many(self, connections: list[Connection]) -> list[Connection]:
        """Create multiple connections in bulk."""
        dicts = [c.to_dict() for c in connections]
        data = self._gc.post(
            "/annotation_connection/multiple", json=dicts
        )
        return [Connection.from_dict(d) for d in data]

    def connect_to_nearest(
        self,
        annotation_ids: list[str],
        tags: list[str],
        channel: int,
    ) -> None:
        """Auto-connect annotations to nearest neighbors.

        Server-side operation. Translates 'channel' to 'channelId'
        in the wire format.
        """
        self._gc.post(
            "/annotation_connection/connectToNearest",
            json={
                "annotationsIds": annotation_ids,
                "tags": tags,
                "channelId": channel,
            },
        )

    def update(self, connection_id: str, updates: dict) -> Connection:
        """Update a single connection."""
        data = self._gc.put(
            f"/annotation_connection/{connection_id}", json=updates
        )
        return Connection.from_dict(data)

    def delete(self, connection_id: str) -> None:
        """Delete a single connection."""
        self._gc.delete(f"/annotation_connection/{connection_id}")

    def delete_many(self, connection_ids: list[str]) -> None:
        """Delete multiple connections."""
        self._gc.sendRestRequest(
            "DELETE", "/annotation_connection/multiple", json=connection_ids
        )
```

- [ ] **Step 3: Run tests**

```bash
cd nimbusimage && pytest tests/test_connections.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/connections.py nimbusimage/tests/test_connections.py
git commit -m "feat(nimbusimage): implement ConnectionAccessor with full CRUD"
```

---

## Task 10: PropertyAccessor

**Files:**
- Modify: `nimbusimage/nimbusimage/properties.py` (replace stub)
- Create: `nimbusimage/tests/test_properties.py`

**Key implementation detail:** `submit_values` takes user-friendly `{ann_id: {key: val}}` and transforms to backend format `[{"datasetId": ..., "annotationId": ..., "values": {property_id: {...}}}]`, auto-batching at 10K entries.

- [ ] **Step 1: Write test_properties.py**

Create `nimbusimage/tests/test_properties.py`:

```python
"""Tests for PropertyAccessor."""

import pytest

from nimbusimage.properties import PropertyAccessor
from nimbusimage.models import Property


class TestPropertyDefinitions:
    def test_list(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = [sample_property_dict]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.list()
        assert len(result) == 1
        assert isinstance(result[0], Property)
        assert result[0].name == "Blob Intensity"

    def test_get(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = sample_property_dict
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get("prop_001")
        assert result.id == "prop_001"

    def test_create(self, mock_gc, sample_property_dict):
        mock_gc.post.return_value = sample_property_dict
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.create(
            name="Blob Intensity", shape="polygon",
        )
        assert isinstance(result, Property)

    def test_get_or_create_existing(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = [sample_property_dict]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_or_create(
            name="Blob Intensity", shape="polygon"
        )
        assert result.id == "prop_001"
        mock_gc.post.assert_not_called()

    def test_get_or_create_new(self, mock_gc, sample_property_dict):
        mock_gc.get.return_value = []  # no existing
        mock_gc.post.return_value = sample_property_dict
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_or_create(
            name="Blob Intensity", shape="polygon"
        )
        assert result.id == "prop_001"
        mock_gc.post.assert_called_once()

    def test_delete(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")
        accessor.delete("prop_001")
        mock_gc.delete.assert_called_with("/annotation_property/prop_001")


class TestPropertyValues:
    def test_get_values_for_dataset(self, mock_gc):
        mock_gc.get.return_value = [{"annotationId": "a1", "values": {}}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.get_values()
        assert len(result) == 1
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=ds_001" in call_url

    def test_get_values_for_annotation(self, mock_gc):
        mock_gc.get.return_value = [{"annotationId": "a1", "values": {}}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.get_values(annotation_id="a1")
        call_url = mock_gc.get.call_args[0][0]
        assert "annotationId=a1" in call_url

    def test_submit_values_transforms_format(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")

        accessor.submit_values("prop_001", {
            "ann_a": {"Area": 100, "Perimeter": 50},
            "ann_b": {"Area": 200, "Perimeter": 75},
        })

        call_args = mock_gc.post.call_args
        payload = call_args[1]["json"]
        assert len(payload) == 2
        assert payload[0]["datasetId"] == "ds_001"
        assert payload[0]["annotationId"] == "ann_a"
        assert payload[0]["values"]["prop_001"]["Area"] == 100

    def test_submit_values_batches_at_10k(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")

        # Create 15000 entries
        values = {f"ann_{i}": {"v": i} for i in range(15000)}
        accessor.submit_values("prop_001", values)

        # Should have been called twice (10K + 5K)
        assert mock_gc.post.call_count == 2

    def test_delete_values(self, mock_gc):
        accessor = PropertyAccessor(mock_gc, "ds_001")
        accessor.delete_values("prop_001")
        call_url = mock_gc.delete.call_args[0][0]
        assert "propertyId=prop_001" in call_url
        assert "datasetId=ds_001" in call_url

    def test_histogram(self, mock_gc):
        mock_gc.get.return_value = [{"min": 0, "max": 100, "count": 50}]
        accessor = PropertyAccessor(mock_gc, "ds_001")

        result = accessor.histogram("prop_001.Area", buckets=128)
        call_url = mock_gc.get.call_args[0][0]
        assert "propertyPath=prop_001.Area" in call_url
        assert "buckets=128" in call_url
```

- [ ] **Step 2: Implement properties.py**

Replace `nimbusimage/nimbusimage/properties.py`:

```python
"""PropertyAccessor — property definitions and computed values."""

from __future__ import annotations

from typing import Any, TYPE_CHECKING

from nimbusimage.models import Property

if TYPE_CHECKING:
    import girder_client

_BATCH_SIZE = 10000


class PropertyAccessor:
    """Access property definitions and values for a dataset."""

    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    # --- Definitions ---

    def list(self) -> list[Property]:
        """List all property definitions accessible to the user."""
        data = self._gc.get("/annotation_property")
        return [Property.from_dict(d) for d in data]

    def get(self, property_id: str) -> Property:
        """Get a property definition by ID."""
        data = self._gc.get(f"/annotation_property/{property_id}")
        return Property.from_dict(data)

    def create(
        self,
        name: str,
        shape: str = "polygon",
        tags: list[str] | None = None,
        image: str = "properties/none:latest",
        worker_interface: dict | None = None,
    ) -> Property:
        """Create a new property definition."""
        body = {
            "name": name,
            "shape": shape,
            "image": image,
            "tags": {"exclusive": False, "tags": tags or []},
            "workerInterface": worker_interface or {},
        }
        data = self._gc.post("/annotation_property", json=body)
        return Property.from_dict(data)

    def get_or_create(
        self,
        name: str,
        shape: str = "polygon",
        **kwargs,
    ) -> Property:
        """Get existing property by name+shape, or create it."""
        existing = self.list()
        for p in existing:
            if p.name == name and p.shape == shape:
                return p
        return self.create(name=name, shape=shape, **kwargs)

    def register(self, property_id: str) -> None:
        """Add property to all configurations for this dataset.

        Fetches current config, appends property_id if not present,
        and saves.
        """
        # Get configurations (dataset views) for this dataset
        views = self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )
        for view in views:
            config_id = view.get("configurationId")
            if not config_id:
                continue
            config = self._gc.get(f"/item/{config_id}")
            prop_ids = config.get("meta", {}).get("propertyIds", [])
            if property_id not in prop_ids:
                prop_ids.append(property_id)
                import json
                self._gc.put(
                    f"/item/{config_id}",
                    parameters={"metadata": json.dumps(
                        {"propertyIds": prop_ids}
                    )},
                )

    def delete(self, property_id: str) -> None:
        """Delete a property definition."""
        self._gc.delete(f"/annotation_property/{property_id}")

    # --- Values ---

    def get_values(self, annotation_id: str | None = None) -> list[dict]:
        """Get property values.

        Args:
            annotation_id: If provided, get values for this annotation only.
                Otherwise, get all values for the dataset.
        """
        url = f"/annotation_property_values?datasetId={self._dataset_id}"
        if annotation_id:
            url += f"&annotationId={annotation_id}"
        return self._gc.get(url)

    def submit_values(
        self, property_id: str, values: dict[str, dict]
    ) -> None:
        """Submit property values in bulk.

        Transforms user-friendly format to backend wire format and
        auto-batches at 10K entries.

        Args:
            property_id: The property these values belong to.
            values: Dict mapping annotation_id to {key: value} dicts.
                Example: {"ann_1": {"Area": 100}, "ann_2": {"Area": 200}}
        """
        entries = []
        for ann_id, ann_values in values.items():
            entries.append({
                "datasetId": self._dataset_id,
                "annotationId": ann_id,
                "values": {property_id: ann_values},
            })

        for i in range(0, len(entries), _BATCH_SIZE):
            batch = entries[i:i + _BATCH_SIZE]
            self._gc.post(
                "/annotation_property_values/multiple", json=batch
            )

    def delete_values(self, property_id: str) -> None:
        """Delete all values for a property in this dataset."""
        self._gc.delete(
            f"/annotation_property_values"
            f"?propertyId={property_id}&datasetId={self._dataset_id}"
        )

    def histogram(
        self, property_path: str, buckets: int = 255
    ) -> list[dict]:
        """Get histogram for a property across all annotations."""
        return self._gc.get(
            f"/annotation_property_values/histogram"
            f"?propertyPath={property_path}"
            f"&datasetId={self._dataset_id}"
            f"&buckets={buckets}"
        )
```

- [ ] **Step 3: Run tests**

```bash
cd nimbusimage && pytest tests/test_properties.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/properties.py nimbusimage/tests/test_properties.py
git commit -m "feat(nimbusimage): implement PropertyAccessor with definitions, values, and auto-batching"
```

---

## Task 11: ImageAccessor

**Files:**
- Modify: `nimbusimage/nimbusimage/images.py` (replace stub)
- Create: `nimbusimage/tests/test_images.py`

- [ ] **Step 1: Write test_images.py**

Create `nimbusimage/tests/test_images.py`:

```python
"""Tests for ImageAccessor."""

import pickle
from unittest.mock import MagicMock, patch, PropertyMock

import numpy as np
import pytest

from nimbusimage.images import ImageAccessor
from nimbusimage.models import FrameInfo


def _make_dataset(mock_gc, tiles_meta):
    """Create a mock Dataset with tiles metadata."""
    from nimbusimage.dataset import Dataset
    ds = Dataset.__new__(Dataset)
    ds._gc = mock_gc
    ds._id = "folder_001"
    ds._item_id = "item_001"
    ds._tiles = tiles_meta
    ds._folder_data = {"_id": "folder_001", "name": "Test"}
    ds.images = ImageAccessor(ds)
    return ds


class TestFrameIndexResolution:
    def test_build_frame_map(self, mock_gc, sample_tiles_metadata):
        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        accessor = ds.images
        accessor._ensure_frame_map()

        # channel=0, time=0, z=0, xy=0 -> frame 0
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0
        # channel=1, time=0, z=0, xy=0 -> frame 1
        assert accessor._frame_index(channel=1, time=0, z=0, xy=0) == 1
        # channel=0, time=0, z=1, xy=0 -> frame 2
        assert accessor._frame_index(channel=0, time=0, z=1, xy=0) == 2

    def test_no_frames_defaults(self, mock_gc):
        tiles = {"sizeX": 100, "sizeY": 100, "dtype": "uint8"}
        ds = _make_dataset(mock_gc, tiles)
        accessor = ds.images
        accessor._ensure_frame_map()
        assert accessor._frame_index(channel=0, time=0, z=0, xy=0) == 0


class TestImageGet:
    def test_get_returns_squeezed_2d(self, mock_gc, sample_tiles_metadata):
        # Mock getRegion to return a 3D array (with singleton dimension)
        img_3d = np.random.randint(0, 1000, (1, 768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img_3d)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get(xy=0, z=0, time=0, channel=0)

        assert result.ndim == 2
        assert result.shape == (768, 1024)

    def test_get_all_channels(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_all_channels(xy=0, z=0, time=0)

        # 2 channels in sample metadata
        assert len(result) == 2
        assert all(r.shape == (768, 1024) for r in result)

    def test_get_stack_z(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        result = ds.images.get_stack(xy=0, time=0, channel=0, axis="z")

        # 2 z-slices in sample metadata
        assert result.shape == (2, 768, 1024)


class TestIterFrames:
    def test_iter_frames(self, mock_gc, sample_tiles_metadata):
        img = np.zeros((768, 1024), dtype=np.uint16)
        mock_response = MagicMock()
        mock_response.content = pickle.dumps(img)
        mock_gc.get.return_value = mock_response

        ds = _make_dataset(mock_gc, sample_tiles_metadata)
        frames = list(ds.images.iter_frames())

        assert len(frames) == 4  # 2 channels x 2 z-slices
        assert isinstance(frames[0][0], FrameInfo)
        assert frames[0][1].shape == (768, 1024)
```

- [ ] **Step 2: Implement images.py**

Replace `nimbusimage/nimbusimage/images.py`:

```python
"""ImageAccessor — image retrieval, stacking, compositing."""

from __future__ import annotations

import pickle
from typing import TYPE_CHECKING, Iterator

import numpy as np

from nimbusimage.models import FrameInfo

if TYPE_CHECKING:
    from nimbusimage.dataset import Dataset


class ImageAccessor:
    """Access images for a dataset."""

    def __init__(self, dataset: Dataset):
        self._dataset = dataset
        self._frame_map: dict | None = None

    def _ensure_frame_map(self):
        """Build channel→time→z→xy→frame_index map lazily."""
        if self._frame_map is not None:
            return
        self._dataset._ensure_metadata()
        frames = self._dataset._tiles.get("frames", None)
        if not frames:
            self._frame_map = {0: {0: {0: {0: 0}}}}
            return
        m: dict = {}
        for f in frames:
            ch = f.get("IndexC", 0)
            t = f.get("IndexT", 0)
            z = f.get("IndexZ", 0)
            xy = f.get("IndexXY", 0)
            idx = f["Frame"]
            m.setdefault(ch, {}).setdefault(t, {}).setdefault(
                z, {}
            ).setdefault(xy, idx)
        self._frame_map = m

    def _frame_index(
        self, channel: int = 0, time: int = 0, z: int = 0, xy: int = 0
    ) -> int:
        self._ensure_frame_map()
        return self._frame_map[channel][time][z][xy]

    def _get_region(self, frame: int, **kwargs) -> np.ndarray:
        """Fetch a region as a numpy array via pickle protocol."""
        params = {"frame": frame, "encoding": "pickle:5"}
        params.update(kwargs)
        response = self._dataset._gc.get(
            f"/item/{self._dataset._item_id}/tiles/region",
            parameters=params,
            jsonResp=False,
        )
        return pickle.loads(response.content)

    def get(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        crop: tuple[float, float, float, float] | None = None,
    ) -> np.ndarray:
        """Get a single image frame as a 2D numpy array.

        Always returns a squeezed 2D array.

        Args:
            xy, z, time, channel: Coordinates.
            crop: Optional (left, top, right, bottom) crop region.

        Returns:
            2D numpy array.
        """
        frame = self._frame_index(channel, time, z, xy)
        kwargs = {}
        if crop is not None:
            left, top, right, bottom = crop
            kwargs.update({
                "left": left, "top": top,
                "right": right, "bottom": bottom,
            })
        img = self._get_region(frame, **kwargs)
        return img.squeeze()

    def get_all_channels(
        self, xy: int = 0, z: int = 0, time: int = 0
    ) -> list[np.ndarray]:
        """Get all channels at one location as a list of 2D arrays."""
        self._dataset._ensure_metadata()
        n_ch = self._dataset.num_channels
        return [
            self.get(xy=xy, z=z, time=time, channel=ch)
            for ch in range(n_ch)
        ]

    def get_stack(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        channel: int = 0,
        axis: str = "z",
    ) -> np.ndarray:
        """Get a stack along one axis as a 3D array.

        Args:
            axis: 'z' or 'time'. The other coordinates are fixed.

        Returns:
            3D numpy array: (N, H, W) where N is the axis size.
        """
        self._dataset._ensure_metadata()
        if axis == "z":
            n = self._dataset.num_z
            images = [
                self.get(xy=xy, z=i, time=time, channel=channel)
                for i in range(n)
            ]
        elif axis == "time":
            n = self._dataset.num_time
            images = [
                self.get(xy=xy, z=z, time=i, channel=channel)
                for i in range(n)
            ]
        else:
            raise ValueError(f"axis must be 'z' or 'time', got '{axis}'")
        return np.stack(images, axis=0)

    def get_composite(
        self,
        xy: int = 0,
        z: int = 0,
        time: int = 0,
        mode: str = "lighten",
        dtype: str | None = None,
    ) -> np.ndarray:
        """Get a composite RGB image merging visible channels.

        Uses layer settings from ds.config.layers for contrast and color.

        Args:
            mode: Blend mode ('lighten' default).
            dtype: Output dtype. None = match source. 'float64' = [0,1].
                'uint8' = [0,255].

        Returns:
            (H, W, 3) numpy array.
        """
        self._dataset._ensure_metadata()
        source_dtype = self._dataset.dtype
        target_dtype = dtype or source_dtype

        layers = self._dataset.config.layers
        h, w = self._dataset.shape
        composite = np.zeros((h, w, 3), dtype=np.float64)

        for layer in layers:
            ch = layer.get("channel", 0)
            if not layer.get("visible", True):
                continue

            img = self.get(xy=xy, z=z, time=time, channel=ch).astype(
                np.float64
            )

            # Apply contrast
            cmin = layer.get("contrastMin", 0)
            cmax = layer.get("contrastMax", img.max() or 1)
            if cmax > cmin:
                img = (img - cmin) / (cmax - cmin)
            img = np.clip(img, 0.0, 1.0)

            # Apply pseudocolor
            color = layer.get("color", "white")
            r, g, b = _parse_color(color)

            channel_rgb = np.stack([img * r, img * g, img * b], axis=-1)

            if mode == "lighten":
                composite = np.maximum(composite, channel_rgb)
            else:
                composite += channel_rgb

        composite = np.clip(composite, 0.0, 1.0)

        # Convert to target dtype
        if target_dtype == "float64":
            return composite
        elif target_dtype == "uint8":
            return (composite * 255).astype(np.uint8)
        elif target_dtype == "uint16":
            return (composite * 65535).astype(np.uint16)
        else:
            max_val = np.iinfo(np.dtype(target_dtype)).max
            return (composite * max_val).astype(target_dtype)

    def iter_frames(self) -> Iterator[tuple[FrameInfo, np.ndarray]]:
        """Iterate over all frames in the dataset.

        Yields:
            (FrameInfo, 2D numpy array) tuples.
        """
        for fi in self._dataset.frames:
            img = self.get(
                xy=fi.xy, z=fi.z, time=fi.time, channel=fi.channel
            )
            yield fi, img

    def new_writer(self, copy_metadata: bool = True):
        """Create an ImageWriter for writing processed images.

        Requires the [worker] extra (large_image).
        """
        try:
            from nimbusimage.images import ImageWriter
        except ImportError:
            raise ImportError(
                "ImageWriter requires large_image. "
                "Install with: pip install nimbusimage[worker]"
            )
        return ImageWriter(self._dataset, copy_metadata=copy_metadata)


def _parse_color(color: str) -> tuple[float, float, float]:
    """Parse a color string to (r, g, b) floats in [0, 1]."""
    if color == "white":
        return (1.0, 1.0, 1.0)
    if color.startswith("rgb("):
        parts = color[4:-1].split(",")
        return (
            int(parts[0]) / 255.0,
            int(parts[1]) / 255.0,
            int(parts[2]) / 255.0,
        )
    if color.startswith("#") and len(color) == 7:
        return (
            int(color[1:3], 16) / 255.0,
            int(color[3:5], 16) / 255.0,
            int(color[5:7], 16) / 255.0,
        )
    return (1.0, 1.0, 1.0)


class ImageWriter:
    """Write processed images back to the dataset.

    Requires the [worker] extra (large_image package).
    Can be used as a context manager or explicitly.
    """

    def __init__(self, dataset: Dataset, copy_metadata: bool = True):
        import large_image

        self._dataset = dataset
        self._sink = large_image.new()
        self._metadata: dict = {}
        self._filename = "output.tiff"

        if copy_metadata:
            dataset._ensure_metadata()
            tiles = dataset._tiles
            if tiles:
                self._sink.channelNames = tiles.get("channels", [])
                if tiles.get("mm_x"):
                    self._sink.mm_x = tiles["mm_x"]
                if tiles.get("mm_y"):
                    self._sink.mm_y = tiles["mm_y"]
                if tiles.get("magnification"):
                    self._sink.magnification = tiles["magnification"]

    def add_frame(self, image: np.ndarray, **kwargs) -> None:
        """Add a frame to the output.

        kwargs should include c, z, t, xy for frame positioning.
        """
        self._sink.addTile(image, 0, 0, **kwargs)

    def set_metadata(self, **kwargs) -> None:
        """Set metadata that will be added to the uploaded item."""
        self._metadata.update(kwargs)

    def write(self, filename: str = "output.tiff") -> None:
        """Write the TIFF and upload to the dataset folder."""
        import tempfile
        import os

        self._filename = filename
        path = os.path.join(tempfile.gettempdir(), filename)
        self._sink.write(path)

        gc = self._dataset._gc
        item = gc.uploadFileToFolder(self._dataset._id, path)
        if self._metadata and item:
            item_id = item.get("itemId", item.get("_id"))
            if item_id:
                gc.addMetadataToItem(item_id, self._metadata)

        os.remove(path)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is None:
            self.write(self._filename)
        return False
```

- [ ] **Step 3: Run tests**

```bash
cd nimbusimage && pytest tests/test_images.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/images.py nimbusimage/tests/test_images.py
git commit -m "feat(nimbusimage): implement ImageAccessor with get, get_stack, get_composite, iter_frames, ImageWriter"
```

---

## Task 12: Config, Export, History, Sharing Accessors

**Files:**
- Modify: `nimbusimage/nimbusimage/config.py`, `export.py`, `history.py`, `sharing.py` (replace stubs)
- Create: `nimbusimage/tests/test_config.py`, `test_export.py`, `test_history.py`, `test_sharing.py`

These are all thin REST wrappers. Implementing them together since each is small.

- [ ] **Step 1: Write tests for all four**

Create `nimbusimage/tests/test_config.py`:

```python
"""Tests for ConfigAccessor."""

import pytest
from nimbusimage.config import ConfigAccessor


class TestConfigAccessor:
    def test_list_views(self, mock_gc):
        mock_gc.get.return_value = [{"_id": "v1", "configurationId": "c1"}]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        result = accessor.list_views()
        assert len(result) == 1

    def test_get_configuration(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],  # views
            {"_id": "c1", "meta": {"layers": [{"channel": 0}]}},  # item
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        result = accessor.get_configuration()
        assert result["_id"] == "c1"

    def test_layers_property(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],
            {"_id": "c1", "meta": {"layers": [{"channel": 0, "visible": True}]}},
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        layers = accessor.layers
        assert len(layers) == 1
        assert layers[0]["channel"] == 0

    def test_property_ids(self, mock_gc):
        mock_gc.get.side_effect = [
            [{"_id": "v1", "configurationId": "c1"}],
            {"_id": "c1", "meta": {"propertyIds": ["p1", "p2"]}},
        ]
        accessor = ConfigAccessor(mock_gc, "ds_001")
        assert accessor.property_ids == ["p1", "p2"]
```

Create `nimbusimage/tests/test_export.py`:

```python
"""Tests for ExportAccessor."""

import pytest
from nimbusimage.export import ExportAccessor


class TestExportAccessor:
    def test_to_json(self, mock_gc):
        mock_gc.get.return_value = {"annotations": [], "connections": []}
        accessor = ExportAccessor(mock_gc, "ds_001")
        result = accessor.to_json()
        assert "annotations" in result
        call_url = mock_gc.get.call_args[0][0]
        assert "datasetId=ds_001" in call_url

    def test_to_csv(self, mock_gc):
        mock_gc.post.return_value = b"Id,Channel\nann1,0"
        accessor = ExportAccessor(mock_gc, "ds_001")
        result = accessor.to_csv(property_paths=[["prop1", "Area"]])
        assert isinstance(result, bytes)

    def test_to_csv_with_path(self, mock_gc, tmp_path):
        mock_gc.post.return_value = b"Id,Channel\nann1,0"
        accessor = ExportAccessor(mock_gc, "ds_001")
        out_file = tmp_path / "export.csv"
        accessor.to_csv(
            property_paths=[["prop1"]], path=str(out_file)
        )
        assert out_file.read_bytes() == b"Id,Channel\nann1,0"
```

Create `nimbusimage/tests/test_history.py`:

```python
"""Tests for HistoryAccessor."""

import pytest
from nimbusimage.history import HistoryAccessor


class TestHistoryAccessor:
    def test_list(self, mock_gc):
        mock_gc.get.return_value = [{"action": "create", "timestamp": "2026-01-01"}]
        accessor = HistoryAccessor(mock_gc, "ds_001")
        result = accessor.list()
        assert len(result) == 1

    def test_undo(self, mock_gc):
        accessor = HistoryAccessor(mock_gc, "ds_001")
        accessor.undo()
        mock_gc.put.assert_called_once()
        call_url = mock_gc.put.call_args[0][0]
        assert "history/undo" in call_url

    def test_redo(self, mock_gc):
        accessor = HistoryAccessor(mock_gc, "ds_001")
        accessor.redo()
        call_url = mock_gc.put.call_args[0][0]
        assert "history/redo" in call_url
```

Create `nimbusimage/tests/test_sharing.py`:

```python
"""Tests for SharingAccessor."""

import pytest
from nimbusimage.sharing import SharingAccessor


class TestSharingAccessor:
    def test_share_read(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="read")
        mock_gc.post.assert_called_once()
        body = mock_gc.post.call_args[1]["json"]
        assert body["userMailOrUsername"] == "user@test.com"
        assert body["accessType"] == 0  # READ

    def test_share_write(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="write")
        body = mock_gc.post.call_args[1]["json"]
        assert body["accessType"] == 1  # WRITE

    def test_share_remove(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.share("user@test.com", access="remove")
        body = mock_gc.post.call_args[1]["json"]
        assert body["accessType"] == -1

    def test_set_public(self, mock_gc):
        accessor = SharingAccessor(mock_gc, "ds_001")
        accessor.set_public(True)
        mock_gc.post.assert_called_once()

    def test_get_access(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        accessor = SharingAccessor(mock_gc, "ds_001")
        result = accessor.get_access()
        assert "public" in result
```

- [ ] **Step 2: Implement all four accessors**

Replace `nimbusimage/nimbusimage/config.py`:

```python
"""ConfigAccessor — dataset views and configurations."""

from __future__ import annotations
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class ConfigAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id
        self._config_cache: dict | None = None

    def list_views(self) -> list[dict]:
        """List dataset views for this dataset."""
        return self._gc.get(
            f"/dataset_view?datasetId={self._dataset_id}"
        )

    def get_configuration(self, config_id: str | None = None) -> dict:
        """Get a configuration. If config_id is None, gets the first one."""
        if config_id is None:
            views = self.list_views()
            if not views:
                return {}
            config_id = views[0].get("configurationId")
            if not config_id:
                return {}
        return self._gc.get(f"/item/{config_id}")

    def _ensure_config(self):
        if self._config_cache is None:
            self._config_cache = self.get_configuration()

    @property
    def layers(self) -> list[dict]:
        """Layer settings from the first configuration."""
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("layers", [])

    @property
    def property_ids(self) -> list[str]:
        """Property IDs registered in the first configuration."""
        self._ensure_config()
        return self._config_cache.get("meta", {}).get("propertyIds", [])
```

Replace `nimbusimage/nimbusimage/export.py`:

```python
"""ExportAccessor — JSON and CSV export."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class ExportAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def to_json(
        self,
        include_annotations: bool = True,
        include_connections: bool = True,
        include_properties: bool = True,
        include_property_values: bool = True,
    ) -> dict:
        """Export dataset as JSON."""
        params = (
            f"includeAnnotations={'true' if include_annotations else 'false'}"
            f"&includeConnections={'true' if include_connections else 'false'}"
            f"&includeProperties={'true' if include_properties else 'false'}"
            f"&includePropertyValues={'true' if include_property_values else 'false'}"
        )
        return self._gc.get(
            f"/export/json?datasetId={self._dataset_id}&{params}"
        )

    def to_csv(
        self,
        property_paths: list[list[str]],
        delimiter: str = ",",
        undefined_value: str = "",
        path: str | None = None,
    ) -> bytes:
        """Export dataset as CSV.

        Args:
            property_paths: List of property path lists (e.g., [["propId", "Area"]]).
            delimiter: CSV delimiter.
            undefined_value: Value for undefined fields.
            path: If provided, write to this file path.

        Returns:
            CSV bytes (also written to path if provided).
        """
        body = {
            "datasetId": self._dataset_id,
            "propertyPaths": property_paths,
            "delimiter": delimiter,
            "undefinedValue": undefined_value,
        }
        data = self._gc.post("/export/csv", json=body)

        if isinstance(data, str):
            data = data.encode("utf-8")

        if path is not None:
            with open(path, "wb") as f:
                f.write(data)

        return data
```

Replace `nimbusimage/nimbusimage/history.py`:

```python
"""HistoryAccessor — undo/redo operations."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client


class HistoryAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def list(self) -> list[dict]:
        """List history entries for this dataset."""
        return self._gc.get(
            f"/history?datasetId={self._dataset_id}"
        )

    def undo(self) -> None:
        """Undo the last action."""
        self._gc.put(
            f"/history/undo?datasetId={self._dataset_id}"
        )

    def redo(self) -> None:
        """Redo the last undone action."""
        self._gc.put(
            f"/history/redo?datasetId={self._dataset_id}"
        )
```

Replace `nimbusimage/nimbusimage/sharing.py`:

```python
"""SharingAccessor — dataset access control."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client

_ACCESS_MAP = {"read": 0, "write": 1, "remove": -1}


class SharingAccessor:
    def __init__(self, gc: girder_client.GirderClient, dataset_id: str):
        self._gc = gc
        self._dataset_id = dataset_id

    def share(
        self, user_email_or_name: str, access: str = "read"
    ) -> None:
        """Share this dataset with a user.

        Args:
            user_email_or_name: User's email or username.
            access: 'read', 'write', or 'remove'.
        """
        self._gc.post(
            "/dataset_view/share",
            json={
                "datasetId": self._dataset_id,
                "userMailOrUsername": user_email_or_name,
                "accessType": _ACCESS_MAP[access],
            },
        )

    def set_public(self, public: bool = True) -> None:
        """Set whether this dataset is publicly accessible."""
        self._gc.post(
            f"/dataset_view/set_public"
            f"?datasetId={self._dataset_id}"
            f"&public={'true' if public else 'false'}"
        )

    def get_access(self) -> dict:
        """Get the access list for this dataset."""
        return self._gc.get(
            f"/dataset_view/access/{self._dataset_id}"
        )
```

- [ ] **Step 3: Run all tests**

```bash
cd nimbusimage && pytest tests/test_config.py tests/test_export.py tests/test_history.py tests/test_sharing.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/config.py nimbusimage/nimbusimage/export.py \
    nimbusimage/nimbusimage/history.py nimbusimage/nimbusimage/sharing.py \
    nimbusimage/tests/test_config.py nimbusimage/tests/test_export.py \
    nimbusimage/tests/test_history.py nimbusimage/tests/test_sharing.py
git commit -m "feat(nimbusimage): implement Config, Export, History, Sharing accessors"
```

---

## Task 13: Project

**Files:**
- Modify: `nimbusimage/nimbusimage/projects.py` (replace stub)
- Create: `nimbusimage/tests/test_projects.py`

- [ ] **Step 1: Write test_projects.py**

Create `nimbusimage/tests/test_projects.py`:

```python
"""Tests for Project class."""

import pytest
from nimbusimage.projects import Project


def _make_project(mock_gc):
    data = {
        "_id": "proj_001",
        "name": "Test Project",
        "description": "A test",
        "meta": {"status": "draft"},
    }
    return Project(mock_gc, data)


class TestProjectProperties:
    def test_id(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.id == "proj_001"

    def test_name(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.name == "Test Project"

    def test_status(self, mock_gc):
        proj = _make_project(mock_gc)
        assert proj.status == "draft"


class TestProjectDatasetManagement:
    def test_add_dataset(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.add_dataset("ds_001")
        mock_gc.post.assert_called_once()
        assert "dataset" in mock_gc.post.call_args[0][0]

    def test_remove_dataset(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.remove_dataset("ds_001")
        mock_gc.delete.assert_called_once()

    def test_add_configuration(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.add_configuration("cfg_001")
        mock_gc.post.assert_called_once()

    def test_remove_configuration(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.remove_configuration("cfg_001")
        mock_gc.delete.assert_called_once()


class TestProjectUpdate:
    def test_update(self, mock_gc):
        mock_gc.put.return_value = {"_id": "proj_001", "name": "New Name", "meta": {}}
        proj = _make_project(mock_gc)
        proj.update(name="New Name")
        mock_gc.put.assert_called_once()

    def test_set_status(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.set_status("exported")
        assert "status" in mock_gc.put.call_args[0][0]

    def test_delete(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.delete()
        mock_gc.delete.assert_called_with("project/proj_001")


class TestProjectSharing:
    def test_share(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.share("user@test.com", access="write")
        mock_gc.post.assert_called_once()

    def test_set_public(self, mock_gc):
        proj = _make_project(mock_gc)
        proj.set_public(True)
        mock_gc.post.assert_called_once()

    def test_get_access(self, mock_gc):
        mock_gc.get.return_value = {"users": [], "public": False}
        proj = _make_project(mock_gc)
        result = proj.get_access()
        assert "public" in result
```

- [ ] **Step 2: Implement projects.py**

Replace `nimbusimage/nimbusimage/projects.py`:

```python
"""Project — grouping datasets and configurations."""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client

_ACCESS_MAP = {"read": 0, "write": 1, "remove": -1}


class Project:
    """A NimbusImage project."""

    def __init__(self, gc: girder_client.GirderClient, data: dict):
        self._gc = gc
        self._data = data

    @property
    def id(self) -> str:
        return self._data["_id"]

    @property
    def name(self) -> str:
        return self._data.get("name", "")

    @property
    def status(self) -> str:
        return self._data.get("meta", {}).get("status", "draft")

    def add_dataset(self, dataset_id: str) -> None:
        self._gc.post(
            f"project/{self.id}/dataset",
            json={"datasetId": dataset_id},
        )

    def remove_dataset(self, dataset_id: str) -> None:
        self._gc.delete(f"project/{self.id}/dataset/{dataset_id}")

    def add_configuration(self, config_id: str) -> None:
        self._gc.post(
            f"project/{self.id}/collection",
            json={"collectionId": config_id},
        )

    def remove_configuration(self, config_id: str) -> None:
        self._gc.delete(f"project/{self.id}/collection/{config_id}")

    def update(
        self, name: str | None = None, description: str | None = None
    ) -> None:
        params = {}
        if name is not None:
            params["name"] = name
        if description is not None:
            params["description"] = description
        self._data = self._gc.put(
            f"project/{self.id}", parameters=params
        )

    def set_status(self, status: str) -> None:
        self._gc.put(
            f"project/{self.id}/status",
            json={"status": status},
        )

    def update_metadata(self, metadata: dict) -> None:
        self._gc.put(
            f"project/{self.id}/metadata", json=metadata
        )

    def share(
        self, user_email_or_name: str, access: str = "read"
    ) -> None:
        self._gc.post(
            f"project/{self.id}/share",
            json={
                "userMailOrUsername": user_email_or_name,
                "accessType": _ACCESS_MAP[access],
            },
        )

    def set_public(self, public: bool = True) -> None:
        self._gc.post(
            f"project/{self.id}/set_public",
            json={"public": public},
        )

    def get_access(self) -> dict:
        return self._gc.get(f"project/{self.id}/access")

    def delete(self) -> None:
        self._gc.delete(f"project/{self.id}")
```

- [ ] **Step 3: Run tests**

```bash
cd nimbusimage && pytest tests/test_projects.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/projects.py nimbusimage/tests/test_projects.py
git commit -m "feat(nimbusimage): implement Project with dataset/config management and sharing"
```

---

## Task 14: WorkerContext

**Files:**
- Create: `nimbusimage/nimbusimage/worker.py`
- Create: `nimbusimage/tests/test_worker.py`

- [ ] **Step 1: Write test_worker.py**

Create `nimbusimage/tests/test_worker.py`:

```python
"""Tests for WorkerContext."""

import json
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.worker import WorkerContext


def _make_params(**overrides):
    """Create a typical worker params dict."""
    params = {
        "configurationId": "cfg_001",
        "datasetId": "ds_001",
        "tile": {"XY": 0, "Z": 0, "Time": 0},
        "channel": 1,
        "assignment": {"XY": 0, "Z": 0, "Time": 0},
        "tags": ["nucleus", "cell"],
        "workerInterface": {"Channel": 0, "Diameter": 10},
        "scales": {"pixelSize": {"unit": "mm", "value": 0.000219}},
        "connectTo": {"tags": ["cell"], "channel": 0},
    }
    params.update(overrides)
    return params


class TestWorkerContextParsing:
    def test_basic_attributes(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_gc = MagicMock()
            mock_create.return_value = mock_gc

            ctx = WorkerContext(
                dataset_id="ds_001",
                api_url="http://localhost:8080/api/v1",
                token="tok",
                params=_make_params(),
            )

            assert ctx.channel == 1
            assert ctx.interface == {"Channel": 0, "Diameter": 10}
            assert ctx.scales["pixelSize"]["value"] == 0.000219

    def test_tags_normalized_from_list(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(tags=["a", "b"]),
            )
            assert ctx.tags == ["a", "b"]
            assert ctx.exclusive_tags is False

    def test_tags_normalized_from_dict(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    tags={"tags": ["x", "y"], "exclusive": True}
                ),
            )
            assert ctx.tags == ["x", "y"]
            assert ctx.exclusive_tags is True

    def test_tile_location(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(tile={"XY": 1, "Z": 2, "Time": 3}),
            )
            assert ctx.tile.xy == 1
            assert ctx.tile.z == 2
            assert ctx.tile.time == 3

    def test_connect_to(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            assert ctx.connect_to == {"tags": ["cell"], "channel": 0}

    def test_connect_to_none_when_absent(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            params = _make_params()
            del params["connectTo"]
            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=params,
            )
            assert ctx.connect_to is None


class TestWorkerContextMessaging:
    def test_progress(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.progress(0.5, "Processing", "Frame 50/100")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["progress"] == 0.5
            assert msg["title"] == "Processing"

    def test_warning(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.warning("No objects found")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["warning"] == "No objects found"

    def test_error(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.error("Model failed")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["error"] == "Model failed"


class TestWorkerContextBatchLocations:
    def test_single_location(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    assignment={"XY": 0, "Z": 0, "Time": 0}
                ),
            )
            locs = list(ctx.batch_locations())
            assert len(locs) == 1
            assert locs[0].xy == 0

    def test_range_assignment(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    assignment={"XY": "0-2", "Z": 0, "Time": 0}
                ),
            )
            locs = list(ctx.batch_locations())
            assert len(locs) == 3
            assert [l.xy for l in locs] == [0, 1, 2]


class TestWorkerContextSetInterface:
    def test_set_interface(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_gc = MagicMock()
            mock_create.return_value = mock_gc

            ctx = WorkerContext(api_url="url", token="tok", params={})
            ctx.set_interface("myimage:latest", {
                "Channel": {"type": "channel", "required": True},
            })
            mock_gc.post.assert_called_once()
```

- [ ] **Step 2: Implement worker.py**

Create `nimbusimage/nimbusimage/worker.py`:

```python
"""WorkerContext — helper for Docker worker scripts."""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
from typing import Iterator, TYPE_CHECKING

from nimbusimage._girder import create_client
from nimbusimage.dataset import Dataset
from nimbusimage.models import Annotation, Location

if TYPE_CHECKING:
    pass


class WorkerContext:
    """Context for a NimbusImage worker execution.

    Parses worker parameters, provides typed access to interface values,
    messaging helpers, and batch processing utilities.
    """

    def __init__(
        self,
        dataset_id: str | None = None,
        api_url: str | None = None,
        token: str | None = None,
        params: dict | None = None,
    ):
        self._gc = create_client(api_url=api_url, token=token)
        self._params = params or {}
        self._dataset_id = dataset_id

        # Parse tags — normalize from either list or dict format
        raw_tags = self._params.get("tags", [])
        if isinstance(raw_tags, dict):
            self._tags = raw_tags.get("tags", [])
            self._exclusive_tags = raw_tags.get("exclusive", False)
        else:
            self._tags = list(raw_tags)
            self._exclusive_tags = False

        # Lazy dataset
        self._dataset: Dataset | None = None

    @property
    def dataset(self) -> Dataset:
        if self._dataset is None:
            if self._dataset_id is None:
                raise ValueError("No dataset_id provided to WorkerContext")
            self._dataset = Dataset(self._gc, self._dataset_id)
        return self._dataset

    @property
    def interface(self) -> dict:
        return self._params.get("workerInterface", {})

    @property
    def tags(self) -> list[str]:
        return self._tags

    @property
    def exclusive_tags(self) -> bool:
        return self._exclusive_tags

    @property
    def tile(self) -> Location:
        return Location.from_dict(self._params.get("tile", {}))

    @property
    def channel(self) -> int:
        return self._params.get("channel", 0)

    @property
    def scales(self) -> dict:
        return self._params.get("scales", {})

    @property
    def connect_to(self) -> dict | None:
        return self._params.get("connectTo")

    @property
    def params(self) -> dict:
        return self._params

    # --- Messaging ---

    def progress(
        self, fraction: float, title: str = "", info: str = ""
    ) -> None:
        print(json.dumps({
            "progress": fraction, "title": title, "info": info
        }))
        sys.stdout.flush()

    def warning(
        self, message: str, title: str = "Warning", info: str | None = None
    ) -> None:
        print(json.dumps({
            "warning": message, "title": title, "info": info,
            "type": "warning",
        }))
        sys.stdout.flush()

    def error(
        self, message: str, title: str = "Error", info: str | None = None
    ) -> None:
        print(json.dumps({
            "error": message, "title": title, "info": info,
            "type": "error",
        }))
        sys.stdout.flush()

    # --- Batch processing ---

    def batch_locations(self) -> Iterator[Location]:
        """Yield Location objects for each position in the assignment ranges.

        Parses range strings like "0-2" or "1-3, 5-8" from the
        assignment dict.
        """
        assignment = self._params.get("assignment", {})
        xy_range = _parse_range(assignment.get("XY", 0))
        z_range = _parse_range(assignment.get("Z", 0))
        time_range = _parse_range(assignment.get("Time", 0))

        for t in time_range:
            for z in z_range:
                for xy in xy_range:
                    yield Location(xy=xy, z=z, time=t)

    def get_filtered_annotations(
        self, shape: str | None = None
    ) -> list[Annotation]:
        """Get annotations filtered by this worker's tag configuration."""
        from nimbusimage.filters import filter_by_tags

        anns = self.dataset.annotations.list(shape=shape)
        if self._tags:
            anns = filter_by_tags(
                anns, self._tags, exclusive=self._exclusive_tags
            )
        return anns

    def submit_property_values(
        self, property_id: str, values: dict[str, dict]
    ) -> None:
        """Submit property values via the dataset's property accessor."""
        self.dataset.properties.submit_values(property_id, values)

    # --- Interface registration ---

    def set_interface(self, image: str, interface: dict) -> None:
        """Register worker interface metadata for a Docker image."""
        encoded_image = urllib.parse.quote(image, safe="")
        self._gc.post(
            f"/worker_interface?image={encoded_image}",
            json=interface,
        )

    def batch_process(
        self,
        process_fn,
        output_shape: str = "polygon",
        channels: list[int] | None = None,
        stack_z: bool = False,
        progress_text: str = "Processing",
    ) -> None:
        """High-level batch processing.

        Iterates batch_locations, loads images (stacking channels/z as
        requested), calls process_fn, creates annotations from results,
        and optionally connects them.

        Args:
            process_fn: Callable that takes ndarray and returns
                annotation coordinate data.
            output_shape: 'polygon' or 'point'.
            channels: Channel indices to stack. None = use self.channel.
            stack_z: Whether to stack all z-planes.
            progress_text: Text shown in progress bar.
        """
        if channels is None:
            channels = [self.channel]

        locations = list(self.batch_locations())
        total = len(locations)

        all_annotations = []

        for i, loc in enumerate(locations):
            self.progress(i / max(total, 1), progress_text,
                          f"{i + 1}/{total}")

            # Load and stack images
            if len(channels) == 1 and not stack_z:
                image = self.dataset.images.get(
                    xy=loc.xy, z=loc.z, time=loc.time, channel=channels[0]
                )
            else:
                imgs = []
                for ch in channels:
                    if stack_z:
                        stack = self.dataset.images.get_stack(
                            xy=loc.xy, time=loc.time, channel=ch, axis="z"
                        )
                        imgs.append(stack)
                    else:
                        imgs.append(self.dataset.images.get(
                            xy=loc.xy, z=loc.z, time=loc.time, channel=ch
                        ))
                import numpy as np
                image = np.stack(imgs, axis=0) if len(imgs) > 1 else imgs[0]

            # Run model
            result = process_fn(image)

            # Convert result to annotations
            if result is not None:
                for coords in result:
                    ann = Annotation(
                        id=None, shape=output_shape,
                        tags=self._tags, channel=channels[0],
                        location=loc,
                        coordinates=coords if isinstance(coords, list) else [],
                        dataset_id=self._dataset_id,
                    )
                    all_annotations.append(ann)

        # Bulk create
        if all_annotations:
            self.dataset.annotations.create_many(
                all_annotations, connect_to=self.connect_to
            )

        self.progress(1.0, progress_text, "Complete")


def _parse_range(value) -> list[int]:
    """Parse a range value — int, str like "0-2", or "1-3, 5-8"."""
    if isinstance(value, int):
        return [value]
    if isinstance(value, str):
        result = []
        for part in value.split(","):
            part = part.strip()
            if "-" in part:
                start, end = part.split("-", 1)
                result.extend(range(int(start), int(end) + 1))
            else:
                result.append(int(part))
        return result
    return [int(value)]
```

- [ ] **Step 3: Run tests**

```bash
cd nimbusimage && pytest tests/test_worker.py -v
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/worker.py nimbusimage/tests/test_worker.py
git commit -m "feat(nimbusimage): implement WorkerContext with param parsing, messaging, batch processing"
```

---

## Task 15: Package __init__.py — Public API Exports

**Files:**
- Modify: `nimbusimage/nimbusimage/__init__.py`

- [ ] **Step 1: Update __init__.py with all public exports**

Replace `nimbusimage/nimbusimage/__init__.py`:

```python
"""NimbusImage Python API.

Usage:
    import nimbusimage as ni

    client = ni.connect(api_url, token=...)
    ds = client.dataset(dataset_id)
    img = ds.images.get(channel=0)
    anns = ds.annotations.list(shape='polygon')
"""

from nimbusimage.client import NimbusClient
from nimbusimage.coordinates import attach_geometry_methods
from nimbusimage.dataset import Dataset
from nimbusimage.filters import filter_by_tags, filter_by_location, group_by_location
from nimbusimage.models import (
    Annotation,
    Connection,
    FrameInfo,
    Location,
    PixelSize,
    Property,
)
from nimbusimage.worker import WorkerContext

# Attach geometry methods (polygon, point, get_mask, etc.) to Annotation
attach_geometry_methods()


def connect(
    api_url: str | None = None,
    token: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> NimbusClient:
    """Connect to a NimbusImage server.

    Args:
        api_url: Girder API URL. Or set NI_API_URL env var.
        token: Auth token. Or set NI_TOKEN env var.
        username: Username for interactive auth.
        password: Password for interactive auth.

    Returns:
        Authenticated NimbusClient.
    """
    return NimbusClient(
        api_url=api_url, token=token,
        username=username, password=password,
    )


def worker_context(
    dataset_id: str | None = None,
    api_url: str | None = None,
    token: str | None = None,
    params: dict | None = None,
) -> WorkerContext:
    """Create a worker context for Docker worker scripts.

    Args:
        dataset_id: The dataset folder ID.
        api_url: Girder API URL.
        token: Auth token.
        params: Worker parameters dict (from the job).

    Returns:
        WorkerContext with parsed parameters and dataset access.
    """
    return WorkerContext(
        dataset_id=dataset_id, api_url=api_url,
        token=token, params=params,
    )


__all__ = [
    # Connection
    "connect",
    "worker_context",
    # Classes
    "NimbusClient",
    "Dataset",
    "WorkerContext",
    # Data models
    "Annotation",
    "Connection",
    "Property",
    "Location",
    "PixelSize",
    "FrameInfo",
    # Filters
    "filter_by_tags",
    "filter_by_location",
    "group_by_location",
]
```

- [ ] **Step 2: Verify imports work**

```bash
cd nimbusimage && python -c "import nimbusimage as ni; print(dir(ni))"
```

Expected: All exported names visible.

- [ ] **Step 3: Run full test suite**

```bash
cd nimbusimage && pytest tests/ -v --ignore=tests/integration
```

Expected: All unit tests PASS.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/nimbusimage/__init__.py
git commit -m "feat(nimbusimage): finalize public API exports in __init__.py"
```

---

## Task 16: Integration Tests

**Files:**
- Create: `nimbusimage/tests/integration/__init__.py`
- Create: `nimbusimage/tests/integration/conftest.py`
- Create: `nimbusimage/tests/integration/test_live_client.py`
- Create: `nimbusimage/tests/integration/test_live_annotations.py`
- Create: `nimbusimage/tests/integration/test_live_connections.py`
- Create: `nimbusimage/tests/integration/test_live_properties.py`

These tests require `docker compose up` running the backend.

- [ ] **Step 1: Create integration conftest**

Create `nimbusimage/tests/integration/__init__.py` (empty).

Create `nimbusimage/tests/integration/conftest.py`:

```python
"""Fixtures for integration tests against a live Girder backend."""

import json
import os

import pytest

import nimbusimage as ni


@pytest.fixture(scope="session")
def api_url():
    return os.environ.get("NI_API_URL", "http://localhost:8080/api/v1")


@pytest.fixture(scope="session")
def client(api_url):
    """Authenticated client for integration tests."""
    username = os.environ.get("NI_TEST_USER", "admin")
    password = os.environ.get("NI_TEST_PASS", "password")
    return ni.connect(api_url, username=username, password=password)


@pytest.fixture
def test_dataset(client):
    """Create a temporary test dataset folder and clean up after.

    Note: This creates a folder with dataset metadata but no actual
    image data. Tests that need images should upload a test image.
    """
    gc = client.girder
    # Create a folder in the admin's public folder
    user = gc.get("user/me")
    public_folder = gc.get(
        "folder",
        parameters={
            "parentType": "user",
            "parentId": user["_id"],
            "name": "Public",
        },
    )[0]

    folder = gc.post(
        "folder",
        parameters={
            "parentType": "folder",
            "parentId": public_folder["_id"],
            "name": "nimbusimage_test_dataset",
            "metadata": json.dumps({"subtype": "contrastDataset"}),
        },
    )

    yield client.dataset(folder["_id"])

    # Cleanup
    gc.delete(f"folder/{folder['_id']}")
```

- [ ] **Step 2: Create integration test files**

Create `nimbusimage/tests/integration/test_live_client.py`:

```python
"""Integration tests for NimbusClient."""

import pytest

pytestmark = pytest.mark.integration


class TestLiveClient:
    def test_connect_and_get_user(self, client):
        assert client.user_id is not None
        assert len(client.user_id) > 0

    def test_list_projects(self, client):
        projects = client.list_projects()
        assert isinstance(projects, list)
```

Create `nimbusimage/tests/integration/test_live_annotations.py`:

```python
"""Integration tests for annotation CRUD."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveAnnotations:
    def test_create_and_list(self, test_dataset):
        ds = test_dataset

        ann = ni.Annotation(
            id=None, shape="point", tags=["test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 50.5, "y": 60.5}],
            dataset_id=ds.id,
        )

        created = ds.annotations.create(ann)
        assert created.id is not None

        listed = ds.annotations.list(shape="point", tags=["test"])
        assert len(listed) >= 1
        assert any(a.id == created.id for a in listed)

        # Cleanup
        ds.annotations.delete(created.id)

    def test_create_many_and_delete_many(self, test_dataset):
        ds = test_dataset

        anns = [
            ni.Annotation(
                id=None, shape="point", tags=["batch"],
                channel=0, location=ni.Location(),
                coordinates=[{"x": float(i), "y": float(i)}],
                dataset_id=ds.id,
            )
            for i in range(5)
        ]

        created = ds.annotations.create_many(anns)
        assert len(created) == 5

        count = ds.annotations.count(tags=["batch"])
        assert count >= 5

        ids = [a.id for a in created]
        ds.annotations.delete_many(ids)

    def test_update(self, test_dataset):
        ds = test_dataset

        ann = ni.Annotation(
            id=None, shape="point", tags=["update_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 1.0, "y": 2.0}],
            dataset_id=ds.id,
        )
        created = ds.annotations.create(ann)

        updated = ds.annotations.update(
            created.id, {"tags": ["updated"]}
        )
        assert "updated" in updated.tags

        ds.annotations.delete(created.id)
```

Create `nimbusimage/tests/integration/test_live_connections.py`:

```python
"""Integration tests for connection CRUD."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveConnections:
    def test_create_and_list(self, test_dataset):
        ds = test_dataset

        # Create two annotations to connect
        a1 = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["conn_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 10.0, "y": 10.0}],
            dataset_id=ds.id,
        ))
        a2 = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["conn_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 20.0, "y": 20.0}],
            dataset_id=ds.id,
        ))

        conn = ds.connections.create(a1.id, a2.id, tags=["test_link"])
        assert conn.id is not None

        listed = ds.connections.list()
        assert any(c.id == conn.id for c in listed)

        # Cleanup
        ds.connections.delete(conn.id)
        ds.annotations.delete_many([a1.id, a2.id])
```

Create `nimbusimage/tests/integration/test_live_properties.py`:

```python
"""Integration tests for property definitions and values."""

import pytest

import nimbusimage as ni

pytestmark = pytest.mark.integration


class TestLiveProperties:
    def test_create_property_and_submit_values(self, test_dataset):
        ds = test_dataset

        # Create a property
        prop = ds.properties.create(
            name="test_property", shape="point",
        )
        assert prop.id is not None

        # Create an annotation
        ann = ds.annotations.create(ni.Annotation(
            id=None, shape="point", tags=["prop_test"],
            channel=0, location=ni.Location(),
            coordinates=[{"x": 10.0, "y": 10.0}],
            dataset_id=ds.id,
        ))

        # Submit values
        ds.properties.submit_values(prop.id, {
            ann.id: {"score": 0.95},
        })

        # Retrieve values
        values = ds.properties.get_values(annotation_id=ann.id)
        assert len(values) >= 1

        # Cleanup
        ds.properties.delete_values(prop.id)
        ds.annotations.delete(ann.id)
        ds.properties.delete(prop.id)

    def test_get_or_create(self, test_dataset):
        ds = test_dataset

        prop1 = ds.properties.get_or_create(
            name="unique_test_prop", shape="polygon"
        )
        prop2 = ds.properties.get_or_create(
            name="unique_test_prop", shape="polygon"
        )
        assert prop1.id == prop2.id

        # Cleanup
        ds.properties.delete(prop1.id)
```

- [ ] **Step 3: Run integration tests (requires backend)**

```bash
cd nimbusimage && pytest tests/integration/ -v -m integration
```

Expected: PASS if docker-compose is running, SKIP otherwise.

- [ ] **Step 4: Commit**

```bash
git add nimbusimage/tests/integration/
git commit -m "feat(nimbusimage): add integration tests for live backend CRUD operations"
```

---

## Task 17: Final Verification

- [ ] **Step 1: Run full unit test suite**

```bash
cd nimbusimage && pytest tests/ -v --ignore=tests/integration
```

Expected: All unit tests PASS.

- [ ] **Step 2: Verify package imports cleanly**

```bash
cd nimbusimage && python -c "
import nimbusimage as ni
print('connect:', ni.connect)
print('Annotation:', ni.Annotation)
print('Location:', ni.Location)
print('filter_by_tags:', ni.filter_by_tags)
print('worker_context:', ni.worker_context)
# Verify geometry methods are attached
ann = ni.Annotation(id=None, shape='polygon', tags=[], channel=0,
    location=ni.Location(), coordinates=[
        {'x': 0, 'y': 0}, {'x': 10, 'y': 0},
        {'x': 10, 'y': 10}, {'x': 0, 'y': 10}
    ], dataset_id='test')
poly = ann.polygon()
print('polygon:', poly)
print('centroid:', ann.centroid())
mask = ann.get_mask((50, 50))
print('mask sum:', mask.sum())
print('ALL OK')
"
```

Expected: All prints successful, "ALL OK" at the end.

- [ ] **Step 3: Final commit**

```bash
git add -A nimbusimage/
git commit -m "feat(nimbusimage): complete nimbusimage package — full API with unit and integration tests"
```
