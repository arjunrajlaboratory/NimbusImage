# NimbusImage Python API (`nimbusimage`) — Design Spec

## Overview

A unified Python API package for programmatic access to NimbusImage. Replaces the fragmented `annotation_client`, `annotation_utilities`, and `worker_client` packages with a single, clean `import nimbusimage as ni` interface. Designed for notebooks, workers, and future MCP tool integration.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Full namespace (doc 17) | Cover everything in one pass |
| Package name | `nimbusimage` (aliased `ni`) | Discoverable, no PyPI collision |
| Repo location | `nimbusimage/` at repo root | First-class citizen alongside `src/`, `devops/`, `itk/` |
| HTTP layer | `girder-client` dependency | Battle-tested, already in all worker containers |
| Geometry | `shapely` as core dependency | Always available, no conditional imports |
| Implementation | Fresh (not wrapping `annotation_client`) | Existing code is small; clean slate avoids compat layers |
| Testing | Unit (mocked) + integration (docker-compose) | `@pytest.mark.integration` for live backend tests |

## Package Structure

```
nimbusimage/                          # At repo root
├── pyproject.toml
├── README.md
├── nimbusimage/
│   ├── __init__.py                   # connect(), worker_context(), dataclasses, filter helpers
│   ├── client.py                     # NimbusClient
│   ├── dataset.py                    # Dataset
│   ├── images.py                     # ImageAccessor
│   ├── annotations.py               # AnnotationAccessor
│   ├── connections.py                # ConnectionAccessor
│   ├── properties.py                 # PropertyAccessor
│   ├── projects.py                   # Project + client-level methods
│   ├── export.py                     # ExportAccessor
│   ├── history.py                    # HistoryAccessor
│   ├── sharing.py                    # SharingAccessor
│   ├── config.py                     # ConfigAccessor
│   ├── worker.py                     # WorkerContext
│   ├── models.py                     # Dataclasses
│   ├── coordinates.py                # x/y swap, 0.5 offset logic
│   ├── filters.py                    # filter_by_tags, filter_by_location, group_by_location
│   └── _girder.py                    # Internal girder_client wrapper
└── tests/
    ├── conftest.py
    ├── test_client.py
    ├── test_dataset.py
    ├── test_images.py
    ├── test_annotations.py
    ├── test_connections.py
    ├── test_properties.py
    ├── test_projects.py
    ├── test_export.py
    ├── test_history.py
    ├── test_sharing.py
    ├── test_config.py
    ├── test_worker.py
    ├── test_coordinates.py
    ├── test_models.py
    ├── test_filters.py
    └── integration/
        ├── conftest.py
        ├── test_live_client.py
        ├── test_live_annotations.py
        ├── test_live_images.py
        ├── test_live_connections.py
        └── test_live_properties.py
```

## Dependencies

**pyproject.toml:**

```toml
[project]
name = "nimbusimage"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "girder-client",
    "numpy",
    "shapely",
]

[project.optional-dependencies]
worker = ["large-image"]
dev = ["pytest", "pytest-mock"]
```

## API Design

### Connection

```python
import nimbusimage as ni

client = ni.connect("http://localhost:8080/api/v1", token="abc123")
client = ni.connect("http://localhost:8080/api/v1", username="admin", password="password")
client = ni.connect()  # reads NI_API_URL + NI_TOKEN env vars

# Custom frontend URL (default: http://localhost:5173)
client = ni.connect(..., frontend_url="https://app.nimbusimage.com")
# Or via env var: NI_FRONTEND_URL
```

`NimbusClient` wraps `girder_client.GirderClient` internally. Exposes:
- `.user_id` — str
- `.token` — str (read-only)
- `.api_url` — str (read-only)
- `.frontend_url` — str (read-only, default `http://localhost:5173`)
- `.girder` — raw GirderClient (escape hatch)
- `.list_datasets()` → `list[DatasetInfo]`
- `.dataset(id)` or `.dataset(name="...")` → `Dataset`
- `.list_projects()` → `list[ProjectInfo]`
- `.create_project(name, description="")` → `Project`
- `.project(id)` → `Project`

### Dataset

Lazy — no HTTP call until a property or accessor method is used.

```python
ds = client.dataset(dataset_id)
```

**Metadata** (fetched once from large_image tiles endpoint, cached):
- `.id`, `.name` — str
- `.num_channels`, `.num_z`, `.num_time`, `.num_xy` — int
- `.channels` — list[str]
- `.pixel_size` — PixelSize
- `.shape` — tuple[int, int] (height, width)
- `.dtype` — str
- `.mm_x`, `.mm_y`, `.magnification` — float | None
- `.frames` — list[FrameInfo]

**Accessor sub-objects** (created in `__init__`, hold reference to girder client + dataset ID):
- `ds.images` — ImageAccessor
- `ds.annotations` — AnnotationAccessor
- `ds.connections` — ConnectionAccessor
- `ds.properties` — PropertyAccessor
- `ds.config` — ConfigAccessor
- `ds.export` — ExportAccessor
- `ds.history` — HistoryAccessor
- `ds.sharing` — SharingAccessor

### ImageAccessor — `ds.images`

```python
ds.images.get(xy=0, z=0, time=0, channel=0)                    # → np.ndarray (2D, squeezed)
ds.images.get(xy=0, z=0, time=0, channel=0,
              crop=(left, top, right, bottom))                   # → np.ndarray (cropped)
ds.images.get_all_channels(xy=0, z=0, time=0)                   # → list[np.ndarray]
ds.images.get_stack(xy=0, time=0, channel=0, axis='z')          # → np.ndarray (Z, H, W)
ds.images.get_stack(xy=0, z=0, channel=0, axis='time')          # → np.ndarray (T, H, W)
ds.images.get_composite(xy=0, z=0, time=0, mode='lighten')      # → np.ndarray (H, W, 3)
ds.images.iter_frames()                                          # → Iterator[(FrameInfo, np.ndarray)]
ds.images.new_writer(copy_metadata=True)                         # → ImageWriter (requires [worker])
```

**`get_composite` dtype handling:**
- Default: matches source dataset dtype (e.g., uint16 → uint16 range)
- `dtype='float64'` → [0, 1] range
- `dtype='uint8'` → [0, 255] range
- Contrast normalization and pseudocolor math happens in float64 internally, converts at the end

**Frame index resolution:** Builds `map[channel][time][z][xy] → frame_index` lazily from tiles metadata.

**ImageWriter** (requires `large-image`):
```python
# As context manager (auto-writes + uploads on exit):
with ds.images.new_writer(copy_metadata=True) as w:
    for frame_info, img in ds.images.iter_frames():
        w.add_frame(process(img), **frame_info.to_dict())
    w.set_metadata(tool='Registration')

# Or explicit control:
writer = ds.images.new_writer(copy_metadata=True)
writer.add_frame(processed_img, xy=0, z=0, time=0, channel=0)
writer.set_metadata(tool='MyTool')
writer.write(filename='output.tiff')    # writes TIFF + uploads to dataset folder
```

### AnnotationAccessor — `ds.annotations`

```python
ds.annotations.list(shape='polygon', tags=['nucleus'], limit=0)           # → list[Annotation]
ds.annotations.get(annotation_id)                                         # → Annotation
ds.annotations.count(shape='polygon', tags=['nucleus'])                   # → int
ds.annotations.create(annotation)                                         # → Annotation (with id)
ds.annotations.create_many(annotation_list)                               # → list[Annotation]
ds.annotations.create_many(annotation_list,
                           connect_to={'tags': ['cell'], 'channel': 0})   # create + auto-connect
ds.annotations.update(annotation_id, updates)                             # → Annotation
ds.annotations.update_many([(id1, updates1), (id2, updates2), ...])        # → list[Annotation]
ds.annotations.delete(annotation_id)
ds.annotations.delete_many([id1, id2, ...])
```

- `list()` defaults to `limit=0` (unlimited — the server interprets 0 as no limit)
- `create_many()` with `connect_to` does bulk create then `connect_to_nearest` (two HTTP calls); returns only the created annotations (connections are a side effect)
- `update()` uses the single `PUT /upenn_annotation/{id}` endpoint, which returns no body — the method fetches the annotation after updating to return current state
- `update_many()` uses `PUT /upenn_annotation/multiple` — **known bug** ([#780](https://github.com/arjunrajlaboratory/NimbusImage/issues/780)): the bulk endpoint expects `"id"` (not `"_id"`) and `"datasetId"` per entry, and may return internal server errors. Prefer single `update()` in a loop until this is fixed.
- All methods accept/return `Annotation` dataclass instances

### ConnectionAccessor — `ds.connections`

```python
ds.connections.list(parent_id=None, child_id=None, node_id=None, limit=0)
ds.connections.get(connection_id)                                          # → Connection
ds.connections.count()                                                     # → int
ds.connections.create(parent_id, child_id, tags=[])                        # → Connection
ds.connections.create_many(connection_list)                                 # → list[Connection]
ds.connections.connect_to_nearest(annotation_ids, tags=['nucleus'], channel=0)
ds.connections.update(connection_id, updates)                              # → Connection
ds.connections.delete(connection_id)
ds.connections.delete_many([id1, id2, ...])
```

**`connect_to_nearest` wire format:** Translates `channel` to `channelId` and automatically
includes the dataset ID in the request body. The backend parameter is `annotationsIds` (note plural).

### PropertyAccessor — `ds.properties`

Handles both property definitions and property values.

```python
# Definitions
ds.properties.list()                                                       # → list[Property]
ds.properties.get(property_id)                                             # → Property
ds.properties.create(name='AI Score', shape='polygon',
                     tags=[], image='properties/none:latest')              # → Property
ds.properties.get_or_create(name='AI Score', shape='polygon')              # → Property
ds.properties.register(property_id)                                        # adds to all configs
ds.properties.delete(property_id)

# Values
ds.properties.get_values(annotation_id=None)                               # → list[dict]
ds.properties.submit_values(property_id, {ann_id: {key: val, ...}, ...})   # bulk, auto-batches at 10K
ds.properties.delete_values(property_id)
ds.properties.histogram(property_path='propId.Area', buckets=255)          # → dict
```

**`submit_values` wire format transformation:**
The user-facing `{ann_id: {key: val}}` dict is transformed internally to the backend format:
`[{"datasetId": ds_id, "annotationId": ann_id, "values": {property_id: {key: val}}}]`.
The accessor provides `dataset_id` (from its parent Dataset) and wraps values under `property_id`
automatically. Entries are chunked into batches of 10,000 to stay under MongoDB's 16MB document limit.

```python
```

### ConfigAccessor — `ds.config`

```python
ds.config.list_views()                              # → list[dict]
ds.config.get_configuration(config_id=None)         # → dict (first config if None)
ds.config.layers                                    # → list[dict] (from first config)
ds.config.property_ids                              # → list[str]
```

### ExportAccessor — `ds.export`

```python
ds.export.to_json(include_annotations=True, include_connections=True,
                  include_properties=True, include_property_values=True)    # → dict
ds.export.to_csv(property_paths, delimiter=',', undefined_value='',
                 path=None)                                                # → bytes, or writes to path
```

### HistoryAccessor — `ds.history`

```python
ds.history.list()    # → list[dict]
ds.history.undo()
ds.history.redo()
```

### SharingAccessor — `ds.sharing`

```python
ds.sharing.share(user_email_or_name, access='read')    # 'read', 'write', 'remove'
ds.sharing.set_public(True)
ds.sharing.get_access()                                 # → dict
```

### URLs — `ds` methods

```python
ds.info_url()                                            # → frontend URL for dataset info page
ds.view_url()                                            # → frontend URL for image viewer
ds.view_url(z=4, time=0, layer='multiple')               # → viewer at specific location
ds.configuration_url()                                   # → frontend URL for configuration page
ds.open()                                                # → opens viewer in default browser
ds.open(z=4, xy=0, time=2)                               # → opens at specific location
```

**View URL query parameters:** `xy`, `z`, `time`, `layer` ('single'/'multiple'/'unroll'), `unroll_xy`, `unroll_z`, `unroll_t`.

Frontend URL defaults to `http://localhost:5173`. Override via `NimbusClient(frontend_url=...)` or `NI_FRONTEND_URL` env var (e.g., `app.nimbusimage.com`).

### Project

Accessed from client, not dataset:

```python
project = client.create_project('My Analysis', description='...')
project = client.project(project_id)

project.id, project.name, project.status
project.add_dataset(dataset_id)
project.remove_dataset(dataset_id)
project.add_configuration(config_id)
project.remove_configuration(config_id)
project.update(name='New Name', description='Updated')
project.set_status('exported')
project.update_metadata({'custom_key': 'value'})
project.share(user_email_or_name, access='write')
project.set_public(True)
project.get_access()
project.delete()

# URLs
project.url()                   # → frontend URL for project page
project.open()                  # → opens in default browser
```

### WorkerContext

Replaces argparse boilerplate + WorkerClient + messaging utils.

```python
import nimbusimage as ni

def compute(dataset_id, api_url, token, params):
    ctx = ni.worker_context(
        dataset_id=dataset_id, api_url=api_url, token=token, params=params
    )

    ctx.dataset          # → Dataset
    ctx.interface        # → dict (parsed workerInterface values)
    ctx.tags             # → list[str] (normalized from any format)
    ctx.exclusive_tags   # → bool
    ctx.tile             # → Location
    ctx.channel          # → int
    ctx.scales           # → dict
    ctx.connect_to       # → dict | None
    ctx.params           # → dict (raw)

    ctx.progress(0.5, 'Processing', 'Frame 50/100')
    ctx.warning('No objects found')
    ctx.error('Model failed')

    # Batch iteration
    for location in ctx.batch_locations():
        img = ctx.dataset.images.get(**location.to_dict(), channel=ctx.channel)

    # High-level batch processing
    ctx.batch_process(
        process_fn=my_model,
        output_shape='polygon',
        channels=[ctx.channel],
        stack_z=False,
    )

    # Property worker helpers
    annotations = ctx.get_filtered_annotations(shape='polygon')
    ctx.submit_property_values(property_id, {
        ann.id: {'Area': compute_area(ann)} for ann in annotations
    })
```

**Interface registration:**
```python
def interface(image, api_url, token):
    ctx = ni.worker_context(api_url=api_url, token=token)
    ctx.set_interface(image, {
        'Channel': {'type': 'channel', 'required': True},
        'Diameter': {'type': 'number', 'min': 0, 'max': 200, 'default': 10},
    })
```

### Client-side filter helpers (top-level exports)

```python
ni.filter_by_tags(annotation_list, tags=['nucleus'], exclusive=False)
ni.filter_by_location(annotation_list, xy=0, z=None, time=0)       # None = any
ni.group_by_location(annotation_list)                                # → dict[(xy, z, time), list]
```

## Data Classes

### Annotation

```python
@dataclass
class Annotation:
    id: str | None                    # None before creation
    shape: str                        # 'polygon', 'point', 'line'
    tags: list[str]
    channel: int
    location: Location
    coordinates: list[dict]           # raw {'x': ..., 'y': ...}
    dataset_id: str
    color: str | None = None          # optional override color

    # Geometry (handles x/y swap internally)
    def polygon(self) -> Polygon | None
    def point(self) -> Point | None
    def centroid(self) -> tuple[float, float]

    # Image interaction (handles 0.5 offset internally)
    def get_mask(self, shape: tuple[int, int]) -> np.ndarray
    def get_pixels(self, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]

    # Serialization
    def to_dict(self) -> dict
    @classmethod
    def from_dict(cls, data: dict) -> 'Annotation'

    # Construction (handles coordinate conventions)
    @classmethod
    def from_polygon(cls, polygon: Polygon, ...) -> 'Annotation'
    @classmethod
    def from_point(cls, x: float, y: float, ...) -> 'Annotation'
    @classmethod
    def from_mask(cls, mask: np.ndarray, ...) -> 'Annotation'
```

### Other dataclasses

```python
@dataclass
class Location:
    xy: int = 0
    z: int = 0
    time: int = 0
    def to_dict(self) -> dict

@dataclass
class Connection:
    id: str | None
    parent_id: str
    child_id: str
    dataset_id: str
    tags: list[str] = field(default_factory=list)
    def to_dict(self) -> dict
    @classmethod
    def from_dict(cls, data: dict) -> 'Connection'

@dataclass
class Property:
    id: str | None
    name: str
    shape: str
    image: str
    tags: dict                        # {'exclusive': False, 'tags': [...]}
    worker_interface: dict
    @classmethod
    def from_dict(cls, data: dict) -> 'Property'

@dataclass
class PixelSize:
    value: float
    unit: str                         # canonical: 'm', 'mm', 'um', 'nm'
    def to(self, unit: str) -> 'PixelSize'   # accepts aliases: 'µm', 'micron', etc.
    def __float__(self) -> float
    def __mul__(self, other) -> float

@dataclass
class FrameInfo:
    index: int
    xy: int
    z: int
    time: int
    channel: int
    channel_name: str | None
    def to_dict(self) -> dict
    def to_large_image_params(self) -> dict
```

## Coordinate Conventions

All coordinate swaps and offsets are encapsulated in `coordinates.py` and `Annotation` methods. Users never think about them.

**The three systems:**
1. NimbusImage annotations: `{'x': pixel_x, 'y': pixel_y}` — x horizontal, y vertical
2. Numpy arrays: `array[row, col]` = `array[y, x]`
3. Shapely: `Point(x, y)`, `Polygon([(x1,y1), ...])`

**Annotation ↔ Shapely:**
- `Annotation.polygon()`: swaps x/y so shapely x = image column, shapely y = image row
- `Annotation.from_polygon()`: swaps back

**Annotation ↔ Numpy masks:**
- `Annotation.get_mask()`: subtracts 0.5 from coords before rasterizing (pixel center convention)
- `Annotation.from_mask()`: adds 0.5 to rasterized coords

**Round-trip invariants (tested):**
- `annotation → polygon → annotation` preserves coordinates exactly
- `annotation → mask → annotation` preserves shape within rasterization tolerance

## Testing Strategy

### Unit tests (no backend)

Mock at `girder_client.GirderClient` boundary. Key areas:

- **`test_coordinates.py`** — Every conversion path, round-trips, edge cases
- **`test_models.py`** — Serialization/deserialization round-trips for all dataclasses
- **`test_worker.py`** — Param parsing, tag normalization, batch range parsing, messaging
- **`test_filters.py`** — Tag filtering (inclusive/exclusive), location filtering, grouping
- **`test_images.py`** — Frame index resolution, squeeze, stack assembly, composite math
- **`test_client.py`** — Connection modes (token, user/pass, env vars)
- **`test_annotations.py`** — CRUD calls, bulk operations, connect_to flow
- **`test_connections.py`** — CRUD, connect_to_nearest
- **`test_properties.py`** — Definitions, values, auto-batching at 10K, get_or_create
- **`test_projects.py`** — CRUD, dataset/config management
- **`test_export.py`** — to_json, to_csv
- **`test_history.py`** — list, undo, redo
- **`test_sharing.py`** — share, set_public, get_access
- **`test_config.py`** — list_views, get_configuration, layers, property_ids

### Integration tests (`@pytest.mark.integration`)

Run against `docker compose up`:
1. `conftest.py` — connects to local Girder, creates test user + test folder
2. Full round-trip tests for annotations, connections, images, properties, client auth
3. Cleanup in fixtures

### Running

```bash
cd nimbusimage
pip install -e ".[dev]"
pytest                              # unit tests
pytest -m integration               # integration only
pytest -m "not integration"         # unit only
```

## MCP Tool Mapping

Each method maps to one MCP tool with `ni_{noun}_{verb}` naming:

```
ni_connect                     → ni.connect(...)
ni_datasets_list               → client.list_datasets()
ni_dataset_info                → dataset metadata
ni_image_get                   → ds.images.get(...)
ni_image_get_stack             → ds.images.get_stack(...)
ni_image_get_composite         → ds.images.get_composite(...)
ni_image_upload                → ds.images.new_writer(...)
ni_annotations_list            → ds.annotations.list(...)
ni_annotations_get             → ds.annotations.get(...)
ni_annotations_count           → ds.annotations.count(...)
ni_annotations_create          → ds.annotations.create_many(...)
ni_annotations_update          → ds.annotations.update(...)
ni_annotations_update_many     → ds.annotations.update_many(...)
ni_annotations_delete          → ds.annotations.delete_many(...)
ni_connections_list            → ds.connections.list(...)
ni_connections_create          → ds.connections.create_many(...)
ni_connections_connect_nearest → ds.connections.connect_to_nearest(...)
ni_connections_delete          → ds.connections.delete_many(...)
ni_properties_list             → ds.properties.list()
ni_properties_create           → ds.properties.create(...)
ni_property_values_get         → ds.properties.get_values(...)
ni_property_values_submit      → ds.properties.submit_values(...)
ni_property_values_delete      → ds.properties.delete_values(...)
ni_property_histogram          → ds.properties.histogram(...)
ni_export_json                 → ds.export.to_json(...)
ni_export_csv                  → ds.export.to_csv(...)
ni_projects_list               → client.list_projects()
ni_project_create              → client.create_project(...)
ni_project_add_dataset         → project.add_dataset(...)
ni_project_share               → project.share(...)
ni_history_undo                → ds.history.undo()
ni_history_redo                → ds.history.redo()
ni_dataset_share               → ds.sharing.share(...)
ni_dataset_set_public          → ds.sharing.set_public(...)
```
