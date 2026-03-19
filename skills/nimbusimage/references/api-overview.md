# NimbusImage API — Quick Reference

## Object hierarchy

```
ni.connect() → NimbusClient
    ├── client.dataset(id) → Dataset
    │       ├── ds.images        → ImageAccessor
    │       ├── ds.annotations   → AnnotationAccessor
    │       ├── ds.connections   → ConnectionAccessor
    │       ├── ds.properties    → PropertyAccessor
    │       ├── ds.collections   → CollectionAccessor
    │       ├── ds.export        → ExportAccessor
    │       ├── ds.history       → HistoryAccessor
    │       └── ds.sharing       → SharingAccessor
    ├── client.list_datasets()
    ├── client.list_projects()
    ├── client.project(id) → Project
    ├── client.list_workers()
    ├── client.get_worker_interface(image)
    ├── client.list_collections()
    └── client.collection(id)
```

## Data models (all Pydantic BaseModel)

| Class | Key fields | Aliases |
|-------|-----------|---------|
| `Annotation` | id, shape, tags, channel, location, coordinates, dataset_id | `_id`, `datasetId` |
| `Connection` | id, parent_id, child_id, dataset_id, tags | `_id`, `parentId`, `childId`, `datasetId` |
| `Property` | id, name, shape, image, tags, worker_interface | `_id`, `workerInterface` |
| `Location` | xy, z, time | `XY`, `Z`, `Time` |
| `PixelSize` | value, unit | — |
| `FrameInfo` | index, xy, z, time, channel, channel_name | — |
| `Job` | status, finished, status_name, log | — |

All models have `to_dict()` / `from_dict()` for serialization.

## AnnotationAccessor (ds.annotations)

| Method | Signature | Returns |
|--------|-----------|---------|
| `list` | `(shape?, tags?, limit=0, offset=0)` | `list[Annotation]` |
| `get` | `(annotation_id)` | `Annotation` |
| `count` | `(shape?, tags?)` | `int` |
| `create` | `(annotation)` | `Annotation` |
| `create_many` | `(annotations, connect_to?)` | `list[Annotation]` |
| `update` | `(annotation_id, updates)` | `Annotation` |
| `delete` | `(annotation_id)` | `None` |
| `delete_many` | `(annotation_ids)` | `None` |
| `compute` | `(image, channel, tags, ...)` | `Job` |

## ImageAccessor (ds.images)

| Method | Signature | Returns |
|--------|-----------|---------|
| `get` | `(xy=0, z=0, time=0, channel=0, crop?)` | `np.ndarray` (2D) |
| `get_all_channels` | `(xy=0, z=0, time=0)` | `list[np.ndarray]` |
| `get_stack` | `(channel=0, axis="z", ...)` | `np.ndarray` (3D) |
| `get_composite` | `(xy=0, z=0, time=0, mode="lighten", dtype?)` | `np.ndarray` (H,W,3) |
| `iter_frames` | `()` | `Iterator[(FrameInfo, np.ndarray)]` |
| `new_writer` | `(copy_metadata=True)` | `ImageWriter` |

## ConnectionAccessor (ds.connections)

| Method | Signature | Returns |
|--------|-----------|---------|
| `list` | `(parent_id?, child_id?, node_id?, limit=0, offset=0)` | `list[Connection]` |
| `get` | `(connection_id)` | `Connection` |
| `count` | `()` | `int` |
| `create` | `(parent_id, child_id, tags?)` | `Connection` |
| `create_many` | `(connections)` | `list[Connection]` |
| `connect_to_nearest` | `(annotation_ids, tags, channel)` | `None` |
| `delete` | `(connection_id)` | `None` |
| `delete_many` | `(connection_ids)` | `None` |

## PropertyAccessor (ds.properties)

| Method | Signature | Returns |
|--------|-----------|---------|
| `list` | `()` | `list[Property]` |
| `get` | `(property_id)` | `Property` |
| `create` | `(name, shape, tags?, image?, worker_interface?)` | `Property` |
| `get_or_create` | `(name, shape, **kwargs)` | `Property` |
| `register` | `(property_id)` | `None` |
| `delete` | `(property_id)` | `None` |
| `get_values` | `(annotation_id?)` | `list[dict]` |
| `submit_values` | `(property_id, values)` | `None` |
| `delete_values` | `(property_id)` | `None` |
| `histogram` | `(property_path, buckets=255)` | `list[dict]` |
| `compute` | `(property, worker_interface?, scales?)` | `Job` |

## ExportAccessor (ds.export)

| Method | Signature | Returns |
|--------|-----------|---------|
| `to_json` | `(include_annotations=True, ...)` | `dict` |
| `to_csv` | `(property_paths, delimiter=",", path?)` | `bytes` |

## SharingAccessor (ds.sharing)

| Method | Signature | Returns |
|--------|-----------|---------|
| `share` | `(user_email_or_name, access="read")` | `None` |
| `set_public` | `(public=True)` | `None` |
| `get_access` | `()` | `dict` |

## Annotation geometry methods (attached dynamically)

| Method | Returns | Notes |
|--------|---------|-------|
| `ann.polygon()` | `shapely.Polygon` | For polygon annotations |
| `ann.point()` | `shapely.Point` | For point annotations, or centroid of polygon |
| `ann.centroid()` | `(x, y)` tuple | |
| `ann.get_mask(shape)` | `np.ndarray` (bool) | Shape is `(H, W)` = `ds.shape` |
| `ann.get_pixels(shape)` | `(rows, cols)` | Pixel index arrays |
| `Annotation.from_polygon(poly, ...)` | `Annotation` | From shapely Polygon |
| `Annotation.from_mask(mask, ...)` | `Annotation` | From boolean array |

## Filter utilities

```python
from nimbusimage import filter_by_tags, filter_by_location, group_by_location
```

| Function | Signature | Returns |
|----------|-----------|---------|
| `filter_by_tags` | `(annotations, tags)` | `list[Annotation]` |
| `filter_by_location` | `(annotations, xy?, z?, time?)` | `list[Annotation]` |
| `group_by_location` | `(annotations)` | `dict[(xy,z,time), list]` |
