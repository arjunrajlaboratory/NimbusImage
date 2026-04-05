# Tile Client — Image Access

## Class: `UPennContrastDataset`

**Source**: `annotation_client/tiles.py`

The tile client provides access to image data stored in Girder via the large_image plugin. It maps multi-dimensional coordinates (XY, Z, Time, Channel) to frame indices and fetches image regions as numpy arrays.

## Initialization

```python
import annotation_client.tiles as tiles

tileClient = tiles.UPennContrastDataset(
    apiUrl='http://localhost:8080/api/v1',
    token='your_token',
    datasetId='folder_id'  # This is the Girder FOLDER id, not the item id
)
```

On initialization, the client:
1. Fetches the dataset folder metadata
2. Finds the selected large image item (via `meta.selectedLargeImageId` or first `largeImage` item)
3. Fetches tile metadata (`/item/{id}/tiles`)
4. Builds a coordinate-to-frame lookup map

**Important**: `tileClient.datasetId` is the **item** ID (large image), not the folder ID. The folder ID is stored as `tileClient.folderId`.

## Tile Metadata

```python
tileClient.tiles
```

Returns a dict like:

```python
{
    'IndexRange': {'IndexC': 2, 'IndexZ': 7, 'IndexT': 4, 'IndexXY': 6},
    'IndexStride': {'IndexC': 1, 'IndexZ': 2, 'IndexT': 14, 'IndexXY': 56},
    'bandCount': 1,
    'channels': ['Brightfield', 'YFP'],
    'dtype': 'uint16',
    'frames': [
        {'Frame': 0, 'Index': 0, 'IndexC': 0, 'IndexZ': 0, 'IndexT': 0, 'IndexXY': 0, 'Channel': 'Brightfield'},
        {'Frame': 1, 'Index': 0, 'IndexC': 1, 'IndexZ': 0, 'IndexT': 0, 'IndexXY': 0, 'Channel': 'YFP'},
        # ...
    ],
    'levels': 4,
    'magnification': 20.0,
    'mm_x': 0.000219,
    'mm_y': 0.000219,
    'sizeX': 1024,
    'sizeY': 1022,
    'tileWidth': 256,
    'tileHeight': 256
}
```

### Accessing Dimension Ranges

```python
num_channels = tileClient.tiles['IndexRange'].get('IndexC', 1)
num_z = tileClient.tiles['IndexRange'].get('IndexZ', 1)
num_time = tileClient.tiles['IndexRange'].get('IndexT', 1)
num_xy = tileClient.tiles['IndexRange'].get('IndexXY', 1)
```

**Pitfall**: Simple single-frame images may not have an `IndexRange` key at all. Always use `.get()`:

```python
if 'IndexRange' in tileClient.tiles:
    range_z = range(0, tileClient.tiles['IndexRange'].get('IndexZ', 1))
else:
    range_z = [0]
```

### Channel Names

```python
if 'channels' in tileClient.tiles:
    channel_names = tileClient.tiles['channels']  # ['Brightfield', 'YFP']
```

### Physical Scale

```python
mm_x = tileClient.tiles['mm_x']  # pixel size in mm (or None)
mm_y = tileClient.tiles['mm_y']
magnification = tileClient.tiles['magnification']  # e.g., 20.0
```

Note: `params['scales']['pixelSize']` in workers provides this as `{'unit': 'mm', 'value': 0.000219}`.

## Getting Images

### Single Frame

```python
# Step 1: Convert coordinates to frame index
frame = tileClient.coordinatesToFrameIndex(xy=0, z=3, time=0, channel=1)

# Step 2: Fetch the region as a numpy array
image = tileClient.getRegion(datasetId, frame=frame).squeeze()
# Returns: numpy array, e.g., shape (1022, 1024) dtype uint16
```

**Always call `.squeeze()`** — `getRegion` may return extra singleton dimensions like `(1022, 1024, 1)`.

### Subregion (Crop)

```python
image = tileClient.getRegion(
    datasetId,
    frame=frame,
    left=100, top=200, right=500, bottom=600,
    units='base_pixels'
).squeeze()
```

### Raw Image (Binary)

```python
raw_bytes = tileClient.getRawImage(XY=0, Z=0, T=0, channel=0)
# Returns: raw binary buffer of the image
```

### TIFF Format

```python
image = tileClient.getRegion(datasetId, frame=frame, use_tiff=True)
# Uses tifffile to decode instead of pickle
```

## Iterating Over All Frames

Common pattern from image processing workers (histogram_matching, registration, deconwolf):

```python
for i, frame in enumerate(tileClient.tiles['frames']):
    # Extract large_image index parameters (IndexC, IndexZ, etc.)
    large_image_params = {
        f'{k.lower()[5:]}': v
        for k, v in frame.items()
        if k.startswith('Index') and len(k) > 5
    }
    # large_image_params = {'c': 0, 'z': 0, 't': 0, 'xy': 0}

    image = tileClient.getRegion(datasetId, frame=i).squeeze()

    # Process image...

    sendProgress(i / len(tileClient.tiles['frames']), 'Processing', f"Frame {i+1}")
```

## Loading All Channels at a Location

Using the helper from `annotation_tools`:

```python
from annotation_utilities.annotation_tools import get_images_for_all_channels

images = get_images_for_all_channels(tileClient, datasetId, XY=0, Z=3, Time=0)
# Returns: list of numpy arrays, one per channel
```

Or manually:

```python
images = []
num_channels = tileClient.tiles['IndexRange'].get('IndexC', 1)
for channel in range(num_channels):
    frame = tileClient.coordinatesToFrameIndex(xy, z, time, channel)
    image = tileClient.getRegion(datasetId, frame=frame).squeeze()
    images.append(image)
```

## Multi-Channel Compositing

```python
from annotation_utilities.annotation_tools import get_layers, process_and_merge_channels

# Get layer/contrast settings from the user's configuration
layers = get_layers(tileClient.client, datasetId)

# Load all channels
images = get_images_for_all_channels(tileClient, datasetId, XY=0, Z=0, Time=0)

# Merge with contrast adjustments and pseudocolor
merged = process_and_merge_channels(images, layers, mode='lighten')
# Returns: (H, W, 3) float64 array, values 0-1
# Modes: 'lighten' (max), 'add' (sum, clipped), 'screen'
```

## Building Composite RGB Images from Layer/Contrast Settings (SAM Pattern)

SAM and SAM2 workers need RGB images that match what the user sees in the UI — with the same contrast adjustments and pseudocoloring. This is a 3-step process:

### Step 1: Load all channels

```python
from annotation_utilities.annotation_tools import get_images_for_all_channels

images = get_images_for_all_channels(tileClient, datasetId, XY, Z, Time)
# Returns: list of numpy arrays, one per channel (each is (H, W, 1) uint16)
```

### Step 2: Get layer/contrast settings

```python
from annotation_utilities.annotation_tools import get_layers

layers = get_layers(tileClient.client, datasetId)
```

`get_layers` fetches the user's saved configuration (contrast settings, pseudocolors, visibility) from the dataset view. Returns a list of layer dicts:

```python
[
    {
        'channel': 0,
        'visible': True,
        'color': '#ff0000',       # Pseudocolor
        'contrast': {
            'mode': 'percentile',  # or 'absolute'
            'blackPoint': 0,       # Low cutoff (percentile or absolute)
            'whitePoint': 100      # High cutoff (percentile or absolute)
        }
    },
    ...
]
```

**Note**: `get_layers` takes the FIRST configuration it finds. A dataset can belong to multiple configurations, so there's inherent ambiguity. The user must save their contrast settings in the UI for them to be detected.

### Step 3: Merge into RGB composite

```python
from annotation_utilities.annotation_tools import process_and_merge_channels

merged_image = process_and_merge_channels(images, layers, mode='lighten')
# Returns: (H, W, 3) float64 array, values 0-1
# Modes: 'lighten' (max), 'add' (sum, clipped to 1), 'screen'
```

This function:
1. Sorts layers by channel
2. Skips invisible layers (`visible == False`)
3. Applies contrast normalization (percentile or absolute black/white points)
4. Tints each channel with its pseudocolor
5. Merges using the specified compositing mode

### Step 4: Convert for ML models (SAM-specific)

SAM models expect `(H, W, 3)` float32 or uint8 RGB. The merged image needs dtype conversion:

```python
# For SAM2 (accepts float32):
image = merged_image.astype(np.float32)
predictor.set_image(image)

# For SAM1 / general use (uint8 RGB):
image = ensure_rgb(merged_image)
```

The `ensure_rgb` helper (defined in SAM workers, not yet in annotation_tools):

```python
def ensure_rgb(image):
    """Ensure image is (H, W, 3) uint8 RGB."""
    if image.ndim == 2:
        image = np.stack([image, image, image], axis=-1)
    elif image.ndim == 3 and image.shape[2] == 1:
        image = np.repeat(image, 3, axis=2)
    elif image.ndim == 3 and image.shape[2] == 4:
        image = image[:, :, :3]

    if image.dtype == np.float32 or image.dtype == np.float64:
        if image.max() <= 1.0 and image.min() >= 0.0:
            image = (image * 255).astype(np.uint8)
        else:
            image = np.clip(image, 0, 255).astype(np.uint8)

    return image
```

### Complete SAM/SAM2 image loading pattern

```python
from annotation_utilities import annotation_tools

# Load + merge + convert — repeated at each location
images = annotation_tools.get_images_for_all_channels(tileClient, datasetId, XY, Z, Time)
layers = annotation_tools.get_layers(tileClient.client, datasetId)
merged_image = annotation_tools.process_and_merge_channels(images, layers)
image = merged_image.astype(np.float32)  # For SAM2
# or
image = ensure_rgb(merged_image)          # For SAM1 (uint8 RGB)

predictor.set_image(image)
```

**Used by**: sam2_propagate, sam2_refine, sam2_automatic_mask_generator, sam2_fewshot_segmentation, sam_fewshot_segmentation

**Why this matters**: This is the only way to feed a multi-channel fluorescence image to a vision model that expects RGB. The contrast settings ensure the model sees what the user sees — without them, raw uint16 fluorescence data would be meaningless to SAM.

## Internal Metadata

```python
tileClient.tilesInternal
# Returns detailed internal metadata from large_image
```

## Coordinate Map

The client builds an internal map for fast frame lookup:

```python
tileClient.map[channel][time][z][xy] = frame_index
```

The `coordinatesToFrameIndex` method is a simple lookup into this map:

```python
def coordinatesToFrameIndex(self, XY, Z=0, T=0, channel=0):
    return self.map[channel][T][Z][XY]
```

## Items in a Dataset Folder

A dataset folder can contain multiple items (the main image plus worker outputs):

```python
items = tileClient.client.get(f'/item?folderId={datasetId}&limit=0')
# Returns list of items; those with 'largeImage' key are viewable images
```

## Design Notes for `ni` Package

The tile client should be simplified:

```python
ds = client.dataset(datasetId)

# Image access
image = ds.get_image(xy=0, z=3, time=0, channel=1)  # returns squeezed numpy array
image = ds.get_image(xy=0, z=3, time=0, channel=1,
                     crop=(100, 200, 500, 600))  # with crop

# Multi-channel
images = ds.get_all_channels(xy=0, z=3, time=0)  # list of arrays
merged = ds.get_composite(xy=0, z=3, time=0, mode='lighten')  # RGB composite

# Metadata
ds.num_channels  # int
ds.num_z         # int
ds.num_time      # int
ds.num_xy        # int
ds.channels      # ['Brightfield', 'YFP']
ds.pixel_size    # {'unit': 'mm', 'value': 0.000219}
ds.shape         # (1022, 1024)
ds.dtype         # 'uint16'
```
