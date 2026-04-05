# Architecture Overview

## Current Package Landscape

NimbusImage's Python API is currently split across three packages and one underlying library:

### 1. `annotation_client` (lives in NimbusImage/UPennContrast repo)

The core API client. Contains four modules:

| Module | Class / Functions | Purpose |
|--------|-------------------|---------|
| `annotations.py` | `UPennContrastAnnotationClient` | CRUD for annotations, connections, properties, property values |
| `tiles.py` | `UPennContrastDataset` | Image access via large_image (frames, regions, metadata) |
| `workers.py` | `UPennContrastWorkerPreviewClient` | Set worker UI interfaces |
| `workers.py` | `UPennContrastWorkerClient` | Property worker helper (get annotations, submit property values) |
| `utils.py` | `sendProgress`, `sendWarning`, `sendError` | Worker-to-frontend messaging via stdout JSON |

All classes wrap `girder_client.GirderClient` for HTTP communication.

### 2. `annotation_utilities` (lives in ImageAnalysisProject repo)

Helper functions that operate on annotation data structures:

| Module | Key Functions | Purpose |
|--------|---------------|---------|
| `annotation_tools.py` | `annotations_to_polygons`, `polygons_to_annotations`, `annotations_to_points`, `points_to_annotations` | Convert between annotation dicts and shapely geometries (handles x/y swap) |
| `annotation_tools.py` | `get_annotations_with_tags`, `filter_elements_T_XY`, `find_matching_annotations_by_location` | Filter annotation lists |
| `annotation_tools.py` | `get_images_for_all_channels`, `get_layers`, `process_and_merge_channels` | Multi-channel image loading and compositing |
| `batch_argument_parser.py` | `process_range_list`, `get_batch_information` | Parse "1-3, 5-8" range strings |
| `units.py` | `convert_units` | Convert pixel sizes between physical units |
| `progress.py` | `update_progress` | Rate-limited progress reporting |
| `point_in_polygon.py` | `point_in_polygon` | Numba-accelerated point-in-polygon test |

### 3. `worker_client` (lives in ImageAnalysisProject repo)

High-level annotation worker helper:

| Class | Purpose |
|-------|---------|
| `WorkerClient` | Manages batch iteration over XY/Z/Time, image loading/stacking, and annotation creation (points and polygons). Wraps both `UPennContrastAnnotationClient` and `UPennContrastDataset`. |

### 4. `girder_client` (external dependency)

The underlying HTTP client that all NimbusImage clients use. Provides authentication, REST method helpers, file upload/download.

## How They're Used Together

```
                    girder_client.GirderClient
                         |
         +---------------+----------------+
         |               |                |
  UPennContrastDataset   |   UPennContrastAnnotationClient
  (tiles.py)             |   (annotations.py)
  - Image access         |   - Annotation CRUD
  - Frame mapping        |   - Connection CRUD
  - Region fetching      |   - Property value CRUD
         |               |                |
         +-------+-------+      +---------+
                 |               |
          WorkerClient      UPennContrastWorkerClient
          (worker_client)   (workers.py)
          - Batch mode      - Property worker helper
          - Image stacking  - Annotation list retrieval
          - Annotation      - Property value submission
            creation
                 |               |
                 +-------+-------+
                         |
                  annotation_utilities
                  - Coordinate conversions
                  - Tag filtering
                  - Channel merging
                  - Batch parsing
```

## Who Uses What

| Consumer | annotation_client | annotation_utilities | worker_client |
|----------|:-:|:-:|:-:|
| **Annotation workers (batch mode)**: cellpose, cellposesam, piscis, random_squares | workers.PreviewClient | (via WorkerClient) | WorkerClient |
| **Annotation workers (direct)**: stardist, sam2_propagate | annotations, tiles, workers.PreviewClient | annotation_tools | - |
| **Image processing workers**: histogram_matching, registration, deconwolf | tiles, workers.PreviewClient | - | - |
| **Property workers**: blob_intensity, blob_metrics, point_circle_intensity | workers.WorkerClient, tiles | annotation_tools, batch_argument_parser, progress | - |
| **Connection workers**: connect_to_nearest, connect_timelapse | annotations, workers.PreviewClient | annotation_tools | - |
| **Notebooks / interactive use** | annotations, tiles, workers | annotation_tools | - |

## The Case for Unification

Current pain points:
1. **Three separate packages** with overlapping concerns (e.g., annotation creation in both `annotation_client` and `worker_client`)
2. **Worker-specific assumptions** baked into supposedly general-purpose classes (`UPennContrastWorkerClient` hardcodes `params` structure)
3. **Coordinate handling** is scattered — some in `annotation_tools`, some inline in every worker
4. **No single entry point** — notebooks must `import annotation_client.annotations as annotations`, `import annotation_client.tiles as tiles`, etc.
5. **Image access boilerplate** — every consumer repeats `coordinatesToFrameIndex` + `getRegion` + `squeeze()`
6. **The `girder_client` dependency** is explicit everywhere instead of being an implementation detail

A unified `ni` package would provide:
- `ni.connect(apiUrl, token=...)` — single entry point
- `ni.Dataset(datasetId)` — wraps tile + annotation access
- `ni.Annotation`, `ni.Connection`, `ni.Property` — clean data models
- Coordinate handling built-in (no manual x/y swaps)
- Image access that returns clean numpy arrays without `.squeeze()` boilerplate
