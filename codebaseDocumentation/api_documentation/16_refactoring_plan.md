# Refactoring Plan: Unified `ni` Package Migration

## Overview

This document outlines the plan for migrating workers from the current 3-package API (`annotation_client`, `annotation_utilities`, `worker_client`) to a unified `ni` (nimbusimage) package. The key principle: **build comprehensive tests first, then wrap, then migrate.**

## Current State

- **59 workers** total (34 annotation, 25 property/line/connection)
- **27 have tests** (46%), but major gaps in ML workers and coordinate handling
- **5 distinct API usage patterns** across workers
- Tests that exist are well-structured (mock clients, verify call signatures)

## Phase 0: Comprehensive Test Coverage (DO FIRST)

Before any refactoring, we need tests that will catch regressions. Priority order:

### 0A: Coordinate Convention Tests (Critical)

The 0.5 pixel offset and x/y swap are the most dangerous sources of silent regressions — incorrect coordinates produce wrong results without errors.

**Create a dedicated test module**: `annotation_utilities/tests/test_coordinate_conventions.py`

```python
# Test the full round-trip: annotation coords → numpy → back to annotation
# These tests encode the GROUND TRUTH behavior that must be preserved.

def test_polygon_annotation_to_numpy_and_back():
    """Verify the 0.5 offset convention for polygon masking."""
    annotation = {
        'coordinates': [{'x': 10.0, 'y': 20.0}, {'x': 15.0, 'y': 20.0}, {'x': 12.5, 'y': 25.0}]
    }
    # The convention: subtract 0.5 when going to scikit-image pixel coords
    polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
    assert polygon[0, 0] == 19.5  # y → row
    assert polygon[0, 1] == 9.5   # x → col

    # Verify draw.polygon produces correct mask region
    image = np.zeros((30, 30))
    rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
    assert 20 in rr  # row 20 should be inside the triangle
    assert 10 in cc  # col 10 should be inside

def test_annotations_to_polygons_coordinate_order():
    """annotations_to_polygons does NOT swap x/y."""
    ann = {'coordinates': [{'x': 100, 'y': 200}, {'x': 150, 'y': 200}, {'x': 125, 'y': 250}]}
    polys = annotations_to_polygons(ann)
    # Shapely polygon has coords as-is from annotation
    coords = list(polys[0].exterior.coords)
    assert coords[0] == (100.0, 200.0)  # (x, y) preserved

def test_polygons_to_annotations_swaps_xy():
    """polygons_to_annotations DOES swap x/y."""
    from shapely.geometry import Polygon
    poly = Polygon([(10, 20), (15, 20), (12, 25)])  # shapely (x, y)
    anns = polygons_to_annotations([poly], 'ds1')
    # In annotation format: shapely x→annotation y, shapely y→annotation x
    assert anns[0]['coordinates'][0]['x'] == 20.0  # shapely y → annotation x
    assert anns[0]['coordinates'][0]['y'] == 10.0  # shapely x → annotation y

def test_annotations_to_points_swaps_xy():
    """annotations_to_points swaps: annotation x → shapely y."""
    ann = {'coordinates': [{'x': 300, 'y': 500}]}
    points = annotations_to_points(ann)
    # Point should be in (row, col) = (annotation_x_as_row?, ...)
    # Actually: y, x = coords['x'], coords['y'] → Point(x=coords['y'], y=coords['x'])
    assert points[0].x == 500.0  # annotation y → shapely x
    assert points[0].y == 300.0  # annotation x → shapely y

def test_points_to_annotations_swaps_back():
    """Round-trip: annotation → point → annotation preserves coordinates."""
    original = {'coordinates': [{'x': 300, 'y': 500}]}
    points = annotations_to_points(original)
    result = points_to_annotations(points, 'ds1')
    assert result[0]['coordinates'][0]['x'] == 300.0
    assert result[0]['coordinates'][0]['y'] == 500.0

def test_worker_client_point_creation_coordinate_order():
    """WorkerClient.create_point_annotations expects [y, x] numpy arrays."""
    # 2D case: coords are [y, x]
    # When it creates annotations: {'x': float(x), 'y': float(y)}
    # So coords[y, x] → annotation {'x': x, 'y': y} — correct

def test_worker_client_polygon_creation_coordinate_order():
    """WorkerClient.create_polygon_annotations expects (x, y) tuple lists."""
    # Polygons passed as [(x1,y1), (x2,y2), ...]
    # Converted to Polygon, then coords extracted
    # Output: {'x': float(x), 'y': float(y)} — no swap needed

def test_intensity_calculation_with_known_image():
    """End-to-end: known image + known polygon → known intensity."""
    image = np.zeros((100, 100), dtype=np.uint16)
    image[40:60, 20:40] = 1000  # Known bright region

    # Annotation covering part of the bright region
    # Annotation coords are in (x=col, y=row) space
    annotation = {
        'coordinates': [
            {'x': 20.5, 'y': 40.5},
            {'x': 39.5, 'y': 40.5},
            {'x': 39.5, 'y': 59.5},
            {'x': 20.5, 'y': 59.5},
        ]
    }
    polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
    rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
    mean_intensity = np.mean(image[rr, cc])
    assert mean_intensity == 1000.0  # Entire polygon is in the bright region
```

**Also test the composite RGB pipeline** (SAM pattern):

```python
def test_process_and_merge_channels_output_shape_and_range():
    """Merged image should be (H, W, 3) with values in [0, 1]."""

def test_process_and_merge_channels_percentile_contrast():
    """Percentile contrast mode should normalize based on image percentiles."""

def test_process_and_merge_channels_invisible_layers_excluded():
    """Layers with visible=False should not appear in output."""

def test_ensure_rgb_from_float_0_1():
    """Float [0,1] → uint8 [0, 255]."""

def test_ensure_rgb_from_grayscale():
    """2D grayscale → (H, W, 3) RGB."""
```

### 0B: ML Worker Smoke Tests (High Priority)

These don't test the models — they test the API plumbing around the models.

**Workers to add tests for** (in priority order):

1. **cellpose** — Most-used ML worker
2. **cellposesam** — Second most-used
3. **piscis/predict** — Point detection
4. **stardist** — Direct annotation creation (no WorkerClient)
5. **sam2_propagate** — Complex: composite RGB + annotations + connections
6. **sam2_refine** — Uses layer settings for image composition
7. **sam2_automatic_mask_generator** — Simpler SAM pattern

**Test pattern for ML workers** (mock the model, test the plumbing):

```python
# test_cellpose.py

@pytest.fixture
def mock_clients(mocker):
    mock_preview = mocker.patch('annotation_client.workers.UPennContrastWorkerPreviewClient')
    mock_worker_client = mocker.patch('worker_client.WorkerClient')
    mock_tiles = mocker.patch('annotation_client.tiles.UPennContrastDataset')
    return mock_preview, mock_worker_client, mock_tiles

def test_interface_has_required_fields(mock_clients):
    """Interface should define Model, Diameter, Channels, Batch fields."""
    from entrypoint import interface
    interface('test_image', 'http://api', 'token')
    call_args = mock_clients[0].return_value.setWorkerImageInterface.call_args
    iface = call_args[0][1]
    assert 'Model' in iface
    assert 'Diameter' in iface
    assert 'Primary Channel' in iface
    assert 'Batch XY' in iface

def test_compute_calls_worker_process(mock_clients, mocker):
    """Compute should call worker.process with f_annotation='polygon'."""
    mocker.patch('entrypoint.cellpose_segmentation')
    mock_wc = mock_clients[1].return_value
    mock_wc.workerInterface = {
        'Model': 'cyto3', 'Primary Channel': 0, 'Secondary Channel': -1,
        'Diameter': 10, 'Tile Size': 1024, 'Tile Overlap': 0.1,
        'Padding': 0, 'Smoothing': 0.7,
    }
    mock_wc.channel = 0

    from entrypoint import compute
    compute('ds1', 'http://api', 'token', sample_params)

    mock_wc.process.assert_called_once()
    call_kwargs = mock_wc.process.call_args
    assert call_kwargs[1]['f_annotation'] == 'polygon'
    assert 0 in call_kwargs[1]['stack_channels']

def test_compute_with_secondary_channel(mock_clients, mocker):
    """When secondary channel is set, stack_channels should include both."""
    # ... similar but with secondary_channel=1
    # Verify stack_channels=[0, 1]

def test_compute_no_primary_channel_sends_error(mock_clients, mocker):
    """Missing primary channel should call sendError."""
    mock_send_error = mocker.patch('entrypoint.sendError')
    mock_wc = mock_clients[1].return_value
    mock_wc.workerInterface = {'Model': 'cyto3', 'Primary Channel': None, ...}

    with pytest.raises(ValueError):
        compute('ds1', 'http://api', 'token', sample_params)
    mock_send_error.assert_called_once()
```

**Test pattern for SAM workers** (test the composite image pipeline):

```python
# test_sam2_propagate.py

def test_loads_composite_rgb_image(mock_clients, mocker):
    """Should call get_images_for_all_channels → get_layers → process_and_merge_channels."""
    mock_get_all = mocker.patch('annotation_tools.get_images_for_all_channels',
                                 return_value=[np.zeros((100, 100, 1))])
    mock_get_layers = mocker.patch('annotation_tools.get_layers',
                                    return_value=[{'channel': 0, 'visible': True,
                                                   'color': '#ffffff',
                                                   'contrast': {'mode': 'percentile',
                                                                'blackPoint': 0, 'whitePoint': 100}}])
    mock_merge = mocker.patch('annotation_tools.process_and_merge_channels',
                               return_value=np.zeros((100, 100, 3)))
    # ... trigger compute ...
    mock_get_all.assert_called()
    mock_get_layers.assert_called()
    mock_merge.assert_called()

def test_creates_annotations_and_connections(mock_clients):
    """Should call createMultipleAnnotations then createMultipleConnections."""
    # Verify both are called and connection parentId/childId reference real annotation IDs
```

**Test pattern for stardist** (direct annotation creation, no WorkerClient):

```python
def test_creates_polygon_annotations_directly(mock_clients):
    """Stardist uses annotationClient.createMultipleAnnotations, not WorkerClient."""
    # Verify annotations have correct structure:
    # shape='polygon', correct location, correct coordinate format

def test_annotation_coordinates_from_rasterio(mock_clients):
    """When polygons come from rasterio, coordinates should NOT be swapped."""
    # This is a key difference from workers using annotation_tools converters
```

### 0C: Untested Property Workers (Medium Priority)

These are mostly variations of tested workers. Tests can be templated:

| Worker | Based On | Key Difference to Test |
|--------|----------|----------------------|
| `blob_intensity_percentile_worker` | `blob_intensity_worker` | Different percentile calculations |
| `point_intensity_worker` | `point_circle_intensity_worker` | Single-pixel intensity vs circle |
| `point_to_nearest_point_distance` | `point_to_nearest_blob_distance` | Point-to-point vs point-to-polygon |
| `point_to_nearest_connected_point_distance` | above | Filters by connection |
| `point_threshold_intensity_mean_worker` | `point_circle_intensity_worker` | Thresholding logic |
| `point_circle_intensity_mean_worker` | `point_circle_intensity_worker` | Mean vs individual stats |
| `blob_colony_two_color_intensity_worker` | `blob_intensity_worker` | Two-channel calculation |
| `blob_point_count_3D_projection_worker` | `blob_point_count_worker` | Z-projection logic |
| `line_length_worker` | new pattern | Line-specific coordinate handling |
| `line_scan_worker` | new pattern | Line profile extraction |

### 0D: Integration-Style Coordinate Tests (Medium Priority)

Create a test dataset with **known geometry** and verify end-to-end:

```python
# tests/test_coordinate_integration.py

def test_polygon_mask_covers_expected_pixels():
    """A 10x10 pixel square annotation at known coords should mask exactly 100 pixels."""
    image = np.ones((100, 100), dtype=np.uint16) * 42
    annotation = {
        'coordinates': [
            {'x': 10.5, 'y': 10.5}, {'x': 20.5, 'y': 10.5},
            {'x': 20.5, 'y': 20.5}, {'x': 10.5, 'y': 20.5}
        ]
    }
    polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
    rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
    # Should cover rows 10-20, cols 10-20 = 10*10 = 100 pixels
    assert len(rr) == 100
    assert np.all(image[rr, cc] == 42)

def test_point_annotation_round_trip_through_shapely():
    """Point at annotation (x=300, y=500) should survive conversion to shapely and back."""
    original = [{'coordinates': [{'x': 300.0, 'y': 500.0}]}]
    points = annotations_to_points(original)
    result = points_to_annotations(points, 'ds1')
    assert abs(result[0]['coordinates'][0]['x'] - 300.0) < 1e-10
    assert abs(result[0]['coordinates'][0]['y'] - 500.0) < 1e-10

def test_polygon_round_trip_through_shapely():
    """Polygon coordinates should survive annotation → shapely → annotation."""
    original = [{'coordinates': [
        {'x': 100.0, 'y': 200.0}, {'x': 150.0, 'y': 200.0}, {'x': 125.0, 'y': 250.0}
    ]}]
    polys = annotations_to_polygons(original)
    result = polygons_to_annotations(polys, 'ds1')
    # Round-trip should preserve coordinates
    for orig_c, result_c in zip(original[0]['coordinates'], result[0]['coordinates']):
        assert abs(orig_c['x'] - result_c['x']) < 1e-10
        assert abs(orig_c['y'] - result_c['y']) < 1e-10
```

## Phase 1: Build the `ni` Package as a Wrapper

**Goal**: Create `ni` in the NimbusImage repo that wraps existing clients with zero behavioral change.

### 1A: Core module structure

```
nimbusimage/
├── __init__.py           # ni.connect()
├── client.py             # NimbusClient — wraps girder_client authentication
├── dataset.py            # Dataset — wraps UPennContrastDataset + annotation access
├── annotations.py        # Wraps UPennContrastAnnotationClient
├── properties.py         # Wraps property creation + value submission
├── images.py             # get_image (with auto-squeeze), get_composite, iter_frames
├── coordinates.py        # Absorbs x/y swap + 0.5 offset into clean helpers
├── worker.py             # WorkerContext for Docker workers (replaces WorkerClient)
└── utils.py              # Units, progress, batch range parsing
```

### 1B: Implementation approach

Each `ni` method calls the existing client method underneath:

```python
class Dataset:
    def __init__(self, client, dataset_id):
        self._tile_client = tiles.UPennContrastDataset(
            apiUrl=client._api_url, token=client._token, datasetId=dataset_id)
        self._annotation_client = annotations.UPennContrastAnnotationClient(
            apiUrl=client._api_url, token=client._token)
        self._dataset_id = dataset_id

    def get_image(self, xy=0, z=0, time=0, channel=0, crop=None):
        frame = self._tile_client.coordinatesToFrameIndex(xy, z, time, channel)
        kwargs = {'frame': frame}
        if crop:
            kwargs.update(left=crop[0], top=crop[1], right=crop[2], bottom=crop[3],
                          units='base_pixels')
        return self._tile_client.getRegion(self._dataset_id, **kwargs).squeeze()
```

### 1C: Test the wrapper

Tests for `ni` should verify it produces identical results to direct client calls:

```python
def test_ni_get_image_matches_direct_client(mock_tile_client):
    """ni.Dataset.get_image should return same array as direct getRegion().squeeze()."""
    ds = ni.connect(apiUrl, token=token).dataset(datasetId)
    ni_image = ds.get_image(xy=0, z=0, time=0, channel=0)

    frame = mock_tile_client.coordinatesToFrameIndex(0, 0, 0, 0)
    direct_image = mock_tile_client.getRegion(datasetId, frame=frame).squeeze()

    np.testing.assert_array_equal(ni_image, direct_image)
```

## Phase 2: Incremental Worker Migration

**Goal**: Migrate workers one at a time, starting with the simplest and best-tested.

### Migration order (by risk, lowest first):

**Batch 1: Test/sample workers** (have tests, simple logic)
1. `random_squares` — simplest WorkerClient user
2. `sample_interface` — tests all interface types

**Batch 2: Property workers with good tests**
3. `blob_metrics_worker` — no image access, pure geometry
4. `blob_intensity_worker` — image access + property submission
5. `blob_annulus_intensity_worker` — variation of above
6. `point_circle_intensity_worker` — point-based variant

**Batch 3: Image processing workers with good tests**
7. `histogram_matching` — full load/process/upload cycle
8. `gaussian_blur` — simpler variant
9. `registration` — complex but well-tested

**Batch 4: Connection workers**
10. `connect_to_nearest`
11. `connect_timelapse`
12. `connect_sequential`

**Batch 5: ML annotation workers** (add tests first per Phase 0B)
13. `cellpose`
14. `piscis/predict`
15. `stardist`
16. `cellposesam`

**Batch 6: SAM workers** (most complex, add tests first)
17. `sam2_refine`
18. `sam2_propagate`
19. `sam2_automatic_mask_generator`
20. `sam2_fewshot_segmentation`

**Batch 7: Remaining workers** (GPU, training, niche)
21-59. Everything else

### Per-worker migration checklist:

- [ ] Worker has passing tests before migration
- [ ] Replace imports: `annotation_client.*` → `ni.*`
- [ ] Replace client initialization with `ni.connect()` / `ni.Dataset()`
- [ ] Replace image access with `ds.get_image()` / `ds.get_composite()`
- [ ] Replace annotation creation with `ds.create_annotations()`
- [ ] Replace property submission with `ds.submit_properties()`
- [ ] Run existing tests — must pass with no changes to test assertions
- [ ] Run Docker build and test: `./build_workers.sh --build-and-run-tests worker_name`
- [ ] Manual smoke test on a real dataset (for ML workers)

## Phase 3: Deprecate Old Packages

Once all workers are migrated:

1. Mark `annotation_client`, `annotation_utilities`, `worker_client` as deprecated
2. Keep them importable (backward compat for external users / notebooks)
3. Have them emit deprecation warnings pointing to `ni`
4. Eventually remove after one release cycle

## Effort Estimates

| Phase | Scope | Effort |
|-------|-------|--------|
| 0A: Coordinate tests | ~50 test cases | 1-2 days |
| 0B: ML worker smoke tests | ~7 workers × ~5 tests each | 2-3 days |
| 0C: Untested property workers | ~10 workers × ~5 tests each | 2-3 days |
| 0D: Integration coordinate tests | ~15 test cases | 1 day |
| 1: Build `ni` wrapper | Core modules + tests | 3-5 days |
| 2: Migrate workers (batches 1-4) | ~12 workers, mechanical | 2-3 days |
| 2: Migrate workers (batches 5-7) | ~20 workers, more careful | 3-5 days |
| 3: Deprecation | Wrapper + warnings | 1 day |

**Total: ~15-22 days of focused work**, front-loaded on testing.

## Risk Mitigation

1. **The wrapper approach means zero risk during Phase 1** — same code paths, just new entry points
2. **Phase 0 tests serve double duty** — they validate current behavior AND catch future regressions
3. **Docker-based test execution** means tests run in the actual worker environment
4. **Workers can be migrated independently** — no big-bang switchover
5. **Old imports can coexist** — `ni` and `annotation_client` can both work during transition

## What NOT to Change During Refactoring

- Don't fix the coordinate swap convention — it's confusing but consistent. Document it, don't redesign it.
- Don't change the 0.5 offset behavior — it's correct for scikit-image interop.
- Don't change property value dict structure — the server expects a specific format.
- Don't change the `params` dict structure — it comes from the job runner, not from us.
- Don't merge `WorkerClient` batch logic into `ni` in Phase 1 — wrap it as-is, redesign later.
