# NimbusImage API — Quick Reference

## Contents

- [Object hierarchy](#object-hierarchy)
- [Data models](#data-models-all-pydantic-basemodel)
- [AnnotationAccessor](#annotationaccessor-dsannotations)
- [ImageAccessor](#imageaccessor-dsimages)
- [ConnectionAccessor](#connectionaccessor-dsconnections)
- [PropertyAccessor](#propertyaccessor-dsproperties)
- [ExportAccessor](#exportaccessor-dsexport)
- [SpatialAccessor](#spatialaccessor-dsspatial)
- [SharingAccessor](#sharingaccessor-dssharing)
- [Annotation geometry methods](#annotation-geometry-methods-attached-dynamically)
- [Filter utilities](#filter-utilities)

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
| `list` | `(shape?, tags?, limit=0, offset=0, after_id?, sort?, sortdir=1)` | `list[Annotation]` |
| `iter_all` | `(shape?, tags?, page_size=1000)` | `Iterator[Annotation]` |
| `get` | `(annotation_id)` | `Annotation` |
| `count` | `(shape?, tags?)` | `int` |
| `create` | `(annotation)` | `Annotation` |
| `create_many` | `(annotations, connect_to?)` | `list[Annotation]` |
| `update` | `(annotation_id, updates)` | `Annotation` |
| `update_many` | `(list[(annotation_id, updates)])` | `None` |
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
| `to_geojson` | `(annotation_ids=None, path?)` | `dict` (FeatureCollection; `None` = all, `[]` = none) |

## SpatialAccessor (ds.spatial)

Needs the `upenncontrast_spatial` plugin. A registered **table** (AnnData `spatial.zarr.zip`)
and **transcript store** (10x `transcripts.zarr.zip`) are independent halves.

| Method | Signature | Returns / notes |
|--------|-----------|---------|
| `info` | `(verify=False)` | schema (`nObs`, `nVar`, `pixelSize`, `transform`, `label`) or `None`; `verify` adds `liveAnnotations` (~1.5 s at 700K) |
| `upload_and_register` / `register` / `unregister` | `(path)` / `(item_id)` / `()` | registration refuses duplicate ids/symbols, non-finite X, `.`/`$` in symbols |
| `features` | `(search="", limit=25)` | `[{symbol, featureType}]` |
| `column` / `row` | `(symbol)` / `(annotation_id)` | non-zero values |
| `aggregate` | `(symbols, filters=None)` | mean and fraction expressing over a list-filter object |
| `materialize` | `(symbols, property_name="Gene Expression", wait=True)` | dense sub-values of a property (server job) |
| `score` | `(symbols, name, method="mean")` | gene-set score property |
| `differential` | `(filters_a, filters_b=None, max_features=50, method="welch")` | ranked table (`"wilcoxon"` too) |
| `virtual_path` | `(symbol)` | `["spatial", symbol]`, usable as any property path |
| `transcripts` / `transcript_genes` / `transcript_points` | `()` / `(search)` / `(genes, tiles, level=0, min_qv=0)` | molecules in image pixels |
| `register_transcripts` | `(item_id, pixel_size, transform=None)` | `transform`: 3×3 source-grid px → this image's px (H&E: `M⁻¹`) |
| `staleness` / `recompute` | `()` / `(label, scope="all"\|"dirty", min_qv=20, tags=None, embeddings=False)` | dirty runs refuse changed settings; the old table stays a version |
| `versions` / `activate_version` / `forget_version` | `()` / `(item_id)` | |
| `compute_neighborhood` / `neighborhood` | `(radius_pixels, exclude_tags=None)` / `()` | per-cell neighbor fractions + enrichment matrix |
| `region_summary` | `(region_tag=None, region_ids=None, features=None, exclude_tags=None)` | cells counted by centroid inside each region |

Polygons tagged `region` are never cells for any of these.

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
