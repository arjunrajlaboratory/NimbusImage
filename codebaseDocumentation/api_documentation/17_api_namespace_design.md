# `ni` Package Namespace Design

## Design Principles

### MCP-Friendly
MCP tools are flat lists of discrete operations with typed parameters. The `ni` API should map cleanly to MCP tool names:

```
ni_connect           → ni.connect(...)
ni_list_datasets     → client.list_datasets()
ni_get_image         → dataset.get_image(...)
ni_get_annotations   → dataset.annotations.list(...)
ni_create_annotation → dataset.annotations.create(...)
```

Each method should be **one logical operation** with clear inputs and outputs — no multi-step orchestration hidden inside a single call.

### Skill-Friendly
A Claude Code skill needs to generate correct code from natural language. This means:
- **Few entry points**: `ni.connect()` → `client.dataset()` → everything else
- **Consistent patterns**: if `dataset.annotations.list()` works, `dataset.connections.list()` should too
- **No gotchas**: coordinates handled internally, no `.squeeze()`, no manual frame indexing
- **Discoverable**: `dataset.` tab-completion should reveal all capabilities
- **Predictable return types**: lists return lists, single items return objects, images return numpy arrays

### General
- **Lazy by default**: `client.dataset(id)` doesn't fetch anything until you ask for data
- **Explicit over implicit**: no hidden state changes, no magic caching
- **Composable**: operations return data you can pass to other operations

---

## Top-Level Namespace

```python
import nimbusimage as ni

# --- Connection ---
client = ni.connect(api_url, token=...)
client = ni.connect(api_url, username=..., password=...)
client = ni.connect()  # from NI_API_URL + NI_TOKEN env vars

# --- Quick access (for notebooks) ---
ni.connect(...)        # returns NimbusClient
```

### `ni` module exports

```python
# Core
ni.connect            # → NimbusClient
ni.Dataset            # class (for type hints)
ni.Annotation         # class (for constructing annotations to create)
ni.Connection         # class (for constructing connections to create)
ni.Property           # class
ni.Location           # namedtuple(xy, z, time)

# Worker context (for Docker workers only)
ni.worker_context     # → WorkerContext (parses CLI args)
```

---

## `NimbusClient`

Authenticated session. Entry point for everything.

```python
client = ni.connect(api_url, token=token)
```

### Datasets

```python
client.list_datasets()                        # → list[DatasetInfo]
client.dataset(dataset_id)                    # → Dataset
client.dataset(name='My Dataset')             # → Dataset (convenience lookup)
```

### Projects

```python
client.list_projects()                        # → list[ProjectInfo]
client.create_project(name, description='')   # → Project
client.project(project_id)                    # → Project
```

### Admin / User

```python
client.user_id                                # str
client.token                                  # str (read-only)
client.api_url                                # str (read-only)
client.girder                                 # raw girder_client.GirderClient (escape hatch)
```

---

## `Dataset`

Central object. All data access for one dataset goes through here.

```python
ds = client.dataset(dataset_id)
```

### Metadata

```python
ds.id                    # str — the folder ID
ds.name                  # str
ds.num_channels          # int
ds.num_z                 # int
ds.num_time              # int
ds.num_xy                # int
ds.channels              # list[str] — ['Brightfield', 'YFP']
ds.pixel_size            # PixelSize — has .value, .unit, conversion methods
ds.shape                 # tuple[int, int] — (height, width)
ds.dtype                 # str — 'uint16'
ds.mm_x                  # float | None
ds.mm_y                  # float | None
ds.magnification         # float | None
ds.frames                # list[FrameInfo] — raw frame metadata
```

### Images — `ds.images`

```python
ds.images.get(xy=0, z=0, time=0, channel=0)              # → np.ndarray (2D, squeezed)
ds.images.get(xy=0, z=0, time=0, channel=0,
              crop=(left, top, right, bottom))             # → np.ndarray (cropped)
ds.images.get_all_channels(xy=0, z=0, time=0)             # → list[np.ndarray]
ds.images.get_stack(xy=0, time=0, channel=0, axis='z')    # → np.ndarray (3D: Z×H×W)
ds.images.get_stack(xy=0, z=0, channel=0, axis='time')    # → np.ndarray (3D: T×H×W)
ds.images.get_composite(xy=0, z=0, time=0,
                        mode='lighten', dtype='float64')   # → np.ndarray (H×W×3)
ds.images.iter_frames()                                    # → Iterator[(FrameInfo, np.ndarray)]
```

**MCP mapping**: `ni_get_image`, `ni_get_image_stack`, `ni_get_composite`, etc.

### Image Upload — `ds.images`

```python
writer = ds.images.new_writer(copy_metadata=True)          # → ImageWriter context
writer.add_frame(image, xy=0, z=0, time=0, channel=0)
writer.set_metadata(tool='MyTool', custom_key='value')
writer.write(filename='output.tiff')                       # uploads to dataset folder

# Or as context manager:
with ds.images.new_writer(copy_metadata=True) as w:
    for info, img in ds.images.iter_frames():
        w.add_frame(process(img), **info)
    w.set_metadata(tool='Registration')
# Automatically writes + uploads on exit
```

### Annotations — `ds.annotations`

```python
# Read
ds.annotations.list(shape='polygon', tags=['nucleus'], limit=10_000_000)  # → list[Annotation]
ds.annotations.get(annotation_id)                                         # → Annotation
ds.annotations.count(shape='polygon', tags=['nucleus'])                   # → int

# Create
ds.annotations.create(annotation)                                # → Annotation (with _id)
ds.annotations.create_many(annotation_list)                      # → list[Annotation]
ds.annotations.create_many(annotation_list,
                           connect_to={'tags': ['cell'], 'channel': 0})  # create + auto-connect

# Update
ds.annotations.update(annotation_id, updates)                   # → Annotation
ds.annotations.update_many([(id, updates), ...])                 # → list[Annotation]

# Delete
ds.annotations.delete(annotation_id)
ds.annotations.delete_many([id1, id2, ...])

# Filtering helpers (client-side, on already-fetched lists)
ni.filter_by_tags(annotation_list, tags, exclusive=False)        # → list[Annotation]
ni.filter_by_location(annotation_list, xy=0, z=None, time=0)    # → list[Annotation]
ni.group_by_location(annotation_list)                            # → dict[(time,z,xy), list]
```

### Connections — `ds.connections`

```python
ds.connections.list(dataset_id=None, parent_id=None,
                    child_id=None, node_id=None, limit=10_000_000)  # → list[Connection]
ds.connections.get(connection_id)                                    # → Connection
ds.connections.count()                                               # → int

ds.connections.create(parent_id, child_id, tags=[])                  # → Connection
ds.connections.create_many(connection_list)                           # → list[Connection]
ds.connections.connect_to_nearest(annotation_ids, tags, channel)     # server-side nearest

ds.connections.delete(connection_id)
ds.connections.delete_many([id1, id2, ...])
```

### Properties — `ds.properties`

```python
# Property definitions (schema)
ds.properties.list()                                              # → list[Property]
ds.properties.get(property_id)                                    # → Property
ds.properties.create(name, shape='polygon', tags=[], image='properties/none:latest')  # → Property
ds.properties.get_or_create(name, shape='polygon')                # → Property
ds.properties.delete(property_id)

# Register property with all configurations
ds.properties.register(property_id)                               # adds to all configs

# Property values
ds.properties.get_values(annotation_id=None)                      # → list[PropertyValue]
ds.properties.submit_values(property_id, values_dict)             # bulk submit
    # values_dict = {annotation_id: {key: value, ...}, ...}
ds.properties.delete_values(property_id)                          # delete all values for this property
ds.properties.histogram(property_path, buckets=255)               # → HistogramData
```

### Configurations — `ds.config`

```python
ds.config.list_views()                                  # → list[DatasetView]
ds.config.get_configuration(config_id=None)             # → Configuration (first if None)
ds.config.layers                                        # → list[LayerSettings] (from first config)
ds.config.property_ids                                  # → list[str]
```

### Export — `ds.export`

```python
ds.export.to_json(include_annotations=True, include_connections=True,
                  include_properties=True, include_property_values=True)  # → dict
ds.export.to_csv(property_paths, filename='export.csv',
                 delimiter=',', undefined_value='')                       # → bytes or writes file
```

### History — `ds.history`

```python
ds.history.list()    # → list[HistoryEntry]
ds.history.undo()
ds.history.redo()
```

### Sharing — `ds.sharing`

```python
ds.sharing.share(user_email_or_name, access='read')    # 'read', 'write', or 'remove'
ds.sharing.set_public(True)
ds.sharing.get_access()                                 # → AccessInfo
```

---

## `Project`

```python
project = client.create_project('My Analysis')

project.id
project.name
project.status                                  # 'draft', 'exporting', 'exported'

project.add_dataset(dataset_or_id)
project.remove_dataset(dataset_or_id)
project.add_configuration(config_id)
project.remove_configuration(config_id)

project.share(user_email_or_name, access='write')
project.set_public(True)
project.get_access()

project.update(name=None, description=None)
project.set_status('exported')
project.update_metadata({...})
project.delete()
```

---

## Data Classes

### `Annotation`

```python
@dataclass
class Annotation:
    id: str | None                    # None before creation, set after
    shape: str                        # 'polygon', 'point', 'line'
    tags: list[str]
    channel: int
    location: Location                # Location(xy=0, z=0, time=0)
    coordinates: list[dict]           # Raw {'x': ..., 'y': ...} dicts
    dataset_id: str

    # Convenience (computed from coordinates)
    def polygon(self) -> Polygon | None:       # shapely Polygon (handles x/y swap internally)
    def point(self) -> Point | None:           # shapely Point
    def centroid(self) -> tuple[float, float]: # (x, y) in annotation space

    # Image interaction
    def get_mask(self, shape) -> np.ndarray:        # boolean mask (handles 0.5 offset)
    def get_pixels(self, shape) -> tuple[np.ndarray, np.ndarray]:  # (rows, cols)

    # Serialization
    def to_dict(self) -> dict:                 # for createAnnotation API

    # Construction helpers
    @classmethod
    def from_polygon(cls, polygon: Polygon, ...) -> 'Annotation':  # handles coord swap
    @classmethod
    def from_point(cls, x, y, ...) -> 'Annotation':
    @classmethod
    def from_mask(cls, mask: np.ndarray, ...) -> 'Annotation':     # mask → polygon
```

The key insight: **all coordinate swaps and offsets are encapsulated in `Annotation` methods**. Users never need to think about them.

### `Location`

```python
@dataclass
class Location:
    xy: int = 0
    z: int = 0
    time: int = 0
```

### `Connection`

```python
@dataclass
class Connection:
    id: str | None
    parent_id: str
    child_id: str
    dataset_id: str
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
```

### `Property`

```python
@dataclass
class Property:
    id: str | None
    name: str
    shape: str                    # 'polygon', 'point', 'line'
    image: str                    # Docker image that computes this
    tags: dict                    # {'exclusive': False, 'tags': [...]}
    worker_interface: dict        # saved interface params
```

### `PixelSize`

```python
@dataclass
class PixelSize:
    value: float
    unit: str                     # 'm', 'mm', 'µm', 'nm'

    def to(self, unit: str) -> 'PixelSize':       # unit conversion
    def __float__(self) -> float:                  # raw value
    def __mul__(self, other) -> float:             # for area/length calculations
```

### `FrameInfo`

```python
@dataclass
class FrameInfo:
    index: int
    xy: int
    z: int
    time: int
    channel: int
    channel_name: str | None

    def to_large_image_params(self) -> dict:       # {'c': 0, 'z': 0, 't': 0, 'xy': 0}
```

---

## Worker Context (for Docker Workers)

Replaces the current `argparse` boilerplate and `WorkerClient`.

```python
import nimbusimage as ni

def interface(image, api_url, token):
    ctx = ni.worker_context(api_url=api_url, token=token)
    ctx.set_interface(image, {
        'Channel': {'type': 'channel', 'required': True},
        'Diameter': {'type': 'number', 'min': 0, 'max': 200, 'default': 10},
    })

def compute(dataset_id, api_url, token, params):
    ctx = ni.worker_context(
        dataset_id=dataset_id, api_url=api_url, token=token, params=params
    )

    # Access parsed interface values
    channel = ctx.interface['Channel']          # int
    diameter = ctx.interface['Diameter']         # float
    tags = ctx.tags                              # list[str] — normalized, always a list
    tile = ctx.tile                              # Location(xy=0, z=0, time=0)

    # Access dataset
    ds = ctx.dataset                             # Dataset object

    # Messaging
    ctx.progress(0.5, 'Processing', 'Frame 50/100')
    ctx.warning('No objects found')
    ctx.error('Invalid input')

    # Batch processing (replaces WorkerClient.process)
    ctx.batch_process(
        process_fn=my_model,         # image → coords/polygons
        output_shape='polygon',       # 'polygon' or 'point'
        channels=[channel],           # stack these channels
        stack_z=False,                # or True/'all'
        progress_text='Running Model'
    )

    # Or manual iteration over batch ranges
    for location in ctx.batch_locations():       # yields Location objects
        image = ds.images.get(**location, channel=channel)
        # ... process ...

    # Property worker conveniences
    annotations = ctx.get_filtered_annotations(shape='polygon')  # applies tag filtering from params
    ctx.submit_property_values(values_dict)                       # wraps with propertyId + datasetId
```

---

## MCP Tool Mapping

Each `ni` method maps to one MCP tool. The naming convention is `ni_{noun}_{verb}`:

```
# Connection
ni_connect                    → ni.connect(api_url, token)

# Dataset discovery
ni_datasets_list              → client.list_datasets()
ni_dataset_info               → dataset metadata properties

# Images
ni_image_get                  → ds.images.get(xy, z, time, channel)
ni_image_get_stack            → ds.images.get_stack(...)
ni_image_get_composite        → ds.images.get_composite(...)
ni_image_upload               → ds.images.new_writer() flow

# Annotations
ni_annotations_list           → ds.annotations.list(shape, tags, limit)
ni_annotations_get            → ds.annotations.get(id)
ni_annotations_count          → ds.annotations.count(shape, tags)
ni_annotations_create         → ds.annotations.create_many(list)
ni_annotations_update         → ds.annotations.update(id, updates)
ni_annotations_delete         → ds.annotations.delete_many(ids)

# Connections
ni_connections_list           → ds.connections.list(...)
ni_connections_create         → ds.connections.create_many(list)
ni_connections_delete         → ds.connections.delete_many(ids)
ni_connections_connect_nearest → ds.connections.connect_to_nearest(...)

# Properties
ni_properties_list            → ds.properties.list()
ni_properties_create          → ds.properties.create(name, shape)
ni_property_values_get        → ds.properties.get_values(...)
ni_property_values_submit     → ds.properties.submit_values(...)
ni_property_values_delete     → ds.properties.delete_values(property_id)
ni_property_histogram         → ds.properties.histogram(path, buckets)

# Export
ni_export_json                → ds.export.to_json(...)
ni_export_csv                 → ds.export.to_csv(...)

# Projects
ni_projects_list              → client.list_projects()
ni_project_create             → client.create_project(name)
ni_project_add_dataset        → project.add_dataset(id)
ni_project_share              → project.share(user, access)

# History
ni_history_undo               → ds.history.undo()
ni_history_redo               → ds.history.redo()

# Sharing
ni_dataset_share              → ds.sharing.share(user, access)
ni_dataset_set_public         → ds.sharing.set_public(True/False)
```

### MCP Tool Parameter Design

Each tool should have:
- **Required params**: the minimum needed (e.g., `dataset_id`, `shape`)
- **Optional params with sensible defaults**: `limit=10_000_000`, `tags=[]`
- **No compound objects as params**: flatten nested structures

Example MCP tool definition:

```json
{
    "name": "ni_image_get",
    "description": "Get a single image frame from a NimbusImage dataset as a numpy array",
    "parameters": {
        "dataset_id": {"type": "string", "required": true},
        "xy": {"type": "integer", "default": 0},
        "z": {"type": "integer", "default": 0},
        "time": {"type": "integer", "default": 0},
        "channel": {"type": "integer", "default": 0},
        "crop_left": {"type": "number"},
        "crop_top": {"type": "number"},
        "crop_right": {"type": "number"},
        "crop_bottom": {"type": "number"}
    }
}
```

---

## Skill Pattern Guide

A Claude Code skill for NimbusImage should recognize task types and generate the correct pattern:

### Pattern recognition → code template

| User says | Pattern | Skill generates |
|-----------|---------|-----------------|
| "get the image at z=3" | Single image access | `ds.images.get(z=3, channel=...)` |
| "segment the cells" | ML annotation worker | `ctx.batch_process(model, 'polygon', channels=[...])` |
| "compute intensity" | Property computation | `for ann in ds.annotations.list(...): ... ds.properties.submit_values(...)` |
| "register the time series" | Image processing | `with ds.images.new_writer() as w: ...` |
| "connect spots to nearest cell" | Connection creation | `ds.connections.connect_to_nearest(ids, tags, channel)` |
| "export the data" | Export | `ds.export.to_json()` or `ds.export.to_csv(...)` |
| "show me what datasets exist" | Discovery | `client.list_datasets()` |
| "create a property for my scores" | Property definition | `ds.properties.get_or_create(name, shape)` |

### What the skill must encode

1. **Connection boilerplate**: `ni.connect()` with env vars or explicit credentials
2. **The coordinate convention**: `Annotation.get_mask()` handles it — never manual x/y swap
3. **Tags normalization**: `ctx.tags` is always `list[str]`, never `{'tags': [...], 'exclusive': bool}`
4. **Image squeeze**: `ds.images.get()` always returns 2D — never mention `.squeeze()`
5. **Limit defaults**: don't specify `limit=` unless the user has millions of annotations
6. **Progress reporting**: `ctx.progress()` in workers, nothing needed in notebooks
7. **Property creation vs values**: creating the Property definition is separate from submitting values

---

## Namespace Summary

```
ni
├── connect() → NimbusClient
├── worker_context() → WorkerContext
├── Annotation, Connection, Property, Location (data classes)
├── filter_by_tags(), filter_by_location(), group_by_location() (utilities)
│
├── NimbusClient
│   ├── .list_datasets() → list[DatasetInfo]
│   ├── .dataset(id) → Dataset
│   ├── .list_projects() → list[ProjectInfo]
│   ├── .create_project(name) → Project
│   ├── .project(id) → Project
│   ├── .user_id, .token, .api_url, .girder
│   │
│   └── Dataset
│       ├── .id, .name, .num_channels, .num_z, .num_time, .num_xy
│       ├── .channels, .pixel_size, .shape, .dtype, .frames
│       │
│       ├── .images
│       │   ├── .get(xy, z, time, channel, crop) → ndarray
│       │   ├── .get_all_channels(xy, z, time) → list[ndarray]
│       │   ├── .get_stack(axis, ...) → ndarray
│       │   ├── .get_composite(xy, z, time, mode, dtype) → ndarray
│       │   ├── .iter_frames() → Iterator
│       │   └── .new_writer(copy_metadata) → ImageWriter
│       │
│       ├── .annotations
│       │   ├── .list(shape, tags, limit) → list[Annotation]
│       │   ├── .get(id) → Annotation
│       │   ├── .count(shape, tags) → int
│       │   ├── .create(annotation) → Annotation
│       │   ├── .create_many(list, connect_to) → list[Annotation]
│       │   ├── .update(id, updates) → Annotation
│       │   ├── .delete(id)
│       │   └── .delete_many(ids)
│       │
│       ├── .connections
│       │   ├── .list(...) → list[Connection]
│       │   ├── .get(id) → Connection
│       │   ├── .count() → int
│       │   ├── .create(parent_id, child_id, tags) → Connection
│       │   ├── .create_many(list) → list[Connection]
│       │   ├── .connect_to_nearest(ids, tags, channel)
│       │   ├── .delete(id)
│       │   └── .delete_many(ids)
│       │
│       ├── .properties
│       │   ├── .list() → list[Property]
│       │   ├── .get(id) → Property
│       │   ├── .create(name, shape, ...) → Property
│       │   ├── .get_or_create(name, shape) → Property
│       │   ├── .register(property_id)
│       │   ├── .delete(id)
│       │   ├── .get_values(annotation_id) → list
│       │   ├── .submit_values(property_id, values_dict)
│       │   ├── .delete_values(property_id)
│       │   └── .histogram(property_path, buckets) → HistogramData
│       │
│       ├── .config
│       │   ├── .list_views() → list[DatasetView]
│       │   ├── .get_configuration(id) → Configuration
│       │   ├── .layers → list[LayerSettings]
│       │   └── .property_ids → list[str]
│       │
│       ├── .export
│       │   ├── .to_json(...) → dict
│       │   └── .to_csv(property_paths, ...) → bytes
│       │
│       ├── .history
│       │   ├── .list() → list[HistoryEntry]
│       │   ├── .undo()
│       │   └── .redo()
│       │
│       └── .sharing
│           ├── .share(user, access)
│           ├── .set_public(bool)
│           └── .get_access() → AccessInfo
│
├── Project
│   ├── .id, .name, .status
│   ├── .add_dataset(id), .remove_dataset(id)
│   ├── .add_configuration(id), .remove_configuration(id)
│   ├── .share(user, access), .set_public(bool), .get_access()
│   ├── .update(name, description), .set_status(status)
│   ├── .update_metadata(dict)
│   └── .delete()
│
└── WorkerContext
    ├── .dataset → Dataset
    ├── .interface → dict (parsed workerInterface values)
    ├── .tags → list[str] (normalized)
    ├── .tile → Location
    ├── .params → dict (raw)
    ├── .progress(fraction, title, info)
    ├── .warning(message), .error(message)
    ├── .batch_process(fn, output_shape, channels, ...)
    ├── .batch_locations() → Iterator[Location]
    ├── .get_filtered_annotations(shape) → list[Annotation]
    └── .submit_property_values(values_dict)
```
