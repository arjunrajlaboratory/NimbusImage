# Coordinate Conventions (Critical)

## The Three Coordinate Systems

### 1. NimbusImage Annotations
- Use `{'x': pixel_x, 'y': pixel_y}` where x is horizontal, y is vertical
- Origin at top-left of the image
- Sub-pixel precision (floats)

### 2. Numpy / scikit-image Arrays
- Indexed as `array[row, col]` which is `array[y, x]`
- Pixel centers are at integer coordinates
- Origin at top-left

### 3. Shapely Geometries
- Use `Point(x, y)` and `Polygon([(x1, y1), (x2, y2), ...])`
- x is first coordinate, y is second
- No inherent pixel interpretation

## The X/Y Swap

The most common source of bugs. When converting between annotations and numpy:

```
Annotation {'x': 300, 'y': 500}
means: 300 pixels from the left, 500 pixels from the top
In numpy: array[500, 300] = array[y, x] = array[row, col]
```

### How annotation_tools handles this

**annotations_to_points**:
```python
coords = annotation['coordinates'][0]
y, x = coords['x'], coords['y']  # SWAP: annotation x → shapely y
point = Point(x, y)               # Point in (row, col) order
```

**points_to_annotations**:
```python
coordinates = [{'x': point.y, 'y': point.x}]  # SWAP back
```

**polygons_to_annotations**:
```python
coordinates = [{'x': float(y), 'y': float(x)} for x, y in polygon.exterior.coords]
# SWAP: shapely x (row) → annotation y, shapely y (col) → annotation x
```

**annotations_to_polygons** (does NOT swap):
```python
coords = [(point['x'], point['y']) for point in annotation['coordinates']]
polygon = Polygon(coords)
# Here x,y from annotation are used as-is — shapely treats them as (x, y) = (col, row)
```

### When creating annotations directly in workers

Different workers handle this differently depending on where their coordinates come from:

**From scikit-image operations** (blob_intensity, where polygon vertices are in row,col order):
```python
polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
```

**From rasterio/shapely** (stardist, where polygons are already in x,y order):
```python
coordinates = [{"x": float(x), "y": float(y)} for x, y in polygon.exterior.coords]
```

**From WorkerClient** (cellpose, piscis — WorkerClient handles the swap internally):
```python
# WorkerClient.create_polygon_annotations expects (x, y) tuples
# WorkerClient.create_point_annotations expects [y, x] or [z, y, x] numpy arrays
```

## The 0.5 Pixel Offset

scikit-image pixel coordinates are at pixel **centers** (integer values), while NimbusImage annotation coordinates refer to the top-left corner of pixels.

### When using annotation coordinates with scikit-image:

```python
# Subtract 0.5 to convert from annotation coords to pixel centers
polygon = np.array([
    [coordinate['y'] - 0.5, coordinate['x'] - 0.5]
    for coordinate in annotation['coordinates']
])

rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
intensities = image[rr, cc]
```

### When creating annotations from scikit-image results:

```python
# Add 0.5 to convert from pixel centers to annotation coords
coords[:, -2:] += 0.5  # (as done in piscis)
```

## Summary Table

| From → To | X handling | Y handling | Offset |
|-----------|-----------|-----------|--------|
| Annotation → `draw.polygon()` | `coord['x'] - 0.5` → col | `coord['y'] - 0.5` → row | -0.5 |
| Annotation → shapely Polygon | `coord['x']` → x | `coord['y']` → y | none |
| Shapely → Annotation | `shapely_y` → `{'x': ...}` | `shapely_x` → `{'y': ...}` | none |
| Numpy (row, col) → Annotation | `col` → `{'x': col}` | `row` → `{'y': row}` | +0.5 if from pixel centers |
| WorkerClient point input | Array columns: `[y, x]` or `[z, y, x]` | | handled internally |
| WorkerClient polygon input | List of `(x, y)` tuples | | handled internally |

## Common Mistakes

1. **Forgetting the x/y swap** when extracting annotation coordinates for numpy operations
2. **Forgetting the 0.5 offset** when using `draw.polygon` on annotation coordinates
3. **Applying the swap twice** — if using `annotation_tools` converters, don't also swap manually
4. **Inconsistent coordinate order** — `WorkerClient.create_point_annotations` expects `[y, x]` arrays, but `create_polygon_annotations` expects `(x, y)` tuples
