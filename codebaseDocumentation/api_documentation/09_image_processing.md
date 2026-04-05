# Writing Processed Images Back to Girder

## Overview

Image processing workers (histogram_matching, registration, deconwolf) create new images by processing each frame and uploading the result back to Girder using the `large_image` library.

## Pattern: Process All Frames and Upload

```python
import annotation_client.tiles as tiles
import large_image as li

tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

# Create a new image sink
sink = li.new()

# Process each frame
if 'frames' in tileClient.tiles:
    for i, frame in enumerate(tileClient.tiles['frames']):
        # Extract large_image index parameters
        # Converts 'IndexC' -> 'c', 'IndexZ' -> 'z', 'IndexT' -> 't', 'IndexXY' -> 'xy'
        # Skips the bare 'Index' key (len > 5 check)
        large_image_params = {
            f'{k.lower()[5:]}': v
            for k, v in frame.items()
            if k.startswith('Index') and len(k) > 5
        }
        # Result: {'c': 0, 'z': 3, 't': 0, 'xy': 0}

        # Load the original frame
        image = tileClient.getRegion(datasetId, frame=i).squeeze()

        # Apply your processing
        processed_image = your_processing_function(image)

        # Add to the output image
        sink.addTile(processed_image, 0, 0, **large_image_params)

        sendProgress(i / len(tileClient.tiles['frames']), 'Processing',
                     f"Frame {i+1}/{len(tileClient.tiles['frames'])}")

# Copy metadata from source image
if 'channels' in tileClient.tiles:
    sink.channelNames = tileClient.tiles['channels']
sink.mm_x = tileClient.tiles['mm_x']
sink.mm_y = tileClient.tiles['mm_y']
sink.magnification = tileClient.tiles['magnification']

# Write to temporary file
sink.write('/tmp/output.tiff')

# Upload to the same dataset folder
gc = tileClient.client  # girder_client.GirderClient
item = gc.uploadFileToFolder(datasetId, '/tmp/output.tiff')

# Add metadata to track provenance
gc.addMetadataToItem(item['itemId'], {
    'tool': 'Histogram matching',
    'reference_XY': reference_XY,
    'reference_Z': reference_Z,
    'reference_Time': reference_Time,
})
```

## Example: Histogram Matching (Selective Channel Processing)

```python
# Get reference images for selected channels
channels = [int(k) for k, v in allChannels.items() if v]  # from channelCheckboxes
reference_images = {}
for channel in channels:
    frame = tileClient.coordinatesToFrameIndex(reference_XY, reference_Z, reference_Time, channel)
    reference_images[channel] = tileClient.getRegion(datasetId, frame=frame).squeeze()

sink = li.new()
for i, frame in enumerate(tileClient.tiles['frames']):
    large_image_params = {f'{k.lower()[5:]}': v for k, v in frame.items()
                          if k.startswith('Index') and len(k) > 5}

    image = tileClient.getRegion(datasetId, frame=i).squeeze()

    # Only process selected channels
    if frame['IndexC'] in channels:
        image = match_histograms(image, reference_images[frame['IndexC']])

    sink.addTile(image, 0, 0, **large_image_params)
```

## Example: Deconwolf (Z-Stack Processing by Group)

Deconwolf groups frames by (XY, Time, Channel) and processes entire Z-stacks:

```python
from collections import defaultdict

# Group frames for Z-stack processing
grouped = defaultdict(list)
for i, frame in enumerate(tileClient.tiles['frames']):
    key = (frame.get('IndexXY', 0), frame.get('IndexT', 0), frame.get('IndexC', 0))
    grouped[key].append((i, frame))

sink = li.new()
for (xy, t, c), frames in grouped.items():
    # Sort by Z
    frames.sort(key=lambda f: f[1].get('IndexZ', 0))

    # Load Z-stack
    z_stack = np.stack([
        tileClient.getRegion(datasetId, frame=i).squeeze()
        for i, _ in frames
    ])

    # Process entire Z-stack at once
    deconvolved = deconvolve(z_stack, psf)

    # Write each Z slice back
    for (i, frame), deconv_slice in zip(frames, deconvolved):
        large_image_params = {f'{k.lower()[5:]}': v for k, v in frame.items()
                              if k.startswith('Index') and len(k) > 5}
        sink.addTile(deconv_slice, 0, 0, **large_image_params)
```

## Example: Registration (Subregion Loading + Transform + Upload)

Registration shows additional patterns: loading cropped subregions, computing transforms across time, and casting back to original dtype.

### Loading a subregion (crop to annotation bounding box)

```python
# Use annotation coordinates to define a crop region
x_coords = [coord['x'] for coord in annotation['coordinates']]
y_coords = [coord['y'] for coord in annotation['coordinates']]
left, right = min(x_coords), max(x_coords)
top, bottom = min(y_coords), max(y_coords)

frame = tileClient.coordinatesToFrameIndex(xy, reference_Z, time, channel)
cropped_image = tileClient.getRegion(
    datasetId, frame=frame,
    left=left, top=top, right=right, bottom=bottom,
    units="base_pixels"
).squeeze()
```

### Safe dtype casting after float operations

When transforms produce float output that needs to go back to integer format:

```python
def safe_astype(arr, dtype):
    """Cast array to dtype, clipping to valid range for integer types."""
    if np.issubdtype(dtype, np.integer):
        info = np.iinfo(dtype)
        return np.clip(arr, info.min, info.max).astype(dtype)
    return arr.astype(dtype)

# After a float transform (e.g., pystackreg)
transformed = sr.transform(image, tmat=registration_matrix)  # float64 output
image = safe_astype(transformed, image.dtype)  # back to uint16
```

### Full registration pipeline: compute transforms then apply

```python
from pystackreg import StackReg

sr = StackReg(StackReg.TRANSLATION)

# Phase 1: Compute cumulative registration matrices across time
registration_matrices = {}
for xy in xy_positions:
    registration_matrices[(xy, 0)] = np.eye(3)
    frame = tileClient.coordinatesToFrameIndex(xy, reference_Z, 0, reference_channel)
    current = tileClient.getRegion(datasetId, frame=frame).squeeze()

    for t in range(1, num_time):
        next_frame = tileClient.coordinatesToFrameIndex(xy, reference_Z, t, reference_channel)
        next_image = tileClient.getRegion(datasetId, frame=next_frame).squeeze()

        tmat = sr.register(current, next_image)
        registration_matrices[(xy, t)] = np.dot(tmat, registration_matrices[(xy, t-1)])
        current = next_image

# Phase 2: Apply transforms and write output
sink = li.new()
for i, frame in enumerate(tileClient.tiles['frames']):
    large_image_params = {f'{k.lower()[5:]}': v for k, v in frame.items()
                          if k.startswith('Index') and len(k) > 5}

    image = tileClient.getRegion(datasetId, frame=i).squeeze()

    if frame['IndexC'] in channels:
        xy_key = frame.get('IndexXY', 0)
        transformed = sr.transform(image, tmat=registration_matrices[(xy_key, frame['IndexT'])])
        image = safe_astype(transformed, image.dtype)

    sink.addTile(image, 0, 0, **large_image_params)

# Phase 3: Write, upload, add metadata (same as other workers)
if 'channels' in tileClient.tiles:
    sink.channelNames = tileClient.tiles['channels']
sink.mm_x = tileClient.tiles['mm_x']
sink.mm_y = tileClient.tiles['mm_y']
sink.magnification = tileClient.tiles['magnification']
sink.write('/tmp/registered.tiff')

gc = tileClient.client
item = gc.uploadFileToFolder(datasetId, '/tmp/registered.tiff')
gc.addMetadataToItem(item['itemId'], {'tool': 'Registration', 'algorithm': 'Translation'})
```

## End-to-End Summary: Load, Manipulate, Upload

Every image processing worker follows this skeleton:

```python
import annotation_client.tiles as tiles
import large_image as li
from annotation_client.utils import sendProgress

def compute(datasetId, apiUrl, token, params):
    # 1. CONNECT to the dataset
    tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

    # 2. READ tile metadata (dimensions, channels, etc.)
    num_frames = len(tileClient.tiles.get('frames', []))
    dtype = tileClient.tiles.get('dtype', 'uint16')

    # 3. CREATE an output image sink
    sink = li.new()

    # 4. ITERATE over all frames
    for i, frame in enumerate(tileClient.tiles['frames']):
        # Extract frame indices for the output
        large_image_params = {f'{k.lower()[5:]}': v for k, v in frame.items()
                              if k.startswith('Index') and len(k) > 5}

        # LOAD the image
        image = tileClient.getRegion(datasetId, frame=i).squeeze()

        # MANIPULATE the image (your custom processing)
        processed = your_function(image)

        # WRITE to the output sink
        sink.addTile(processed, 0, 0, **large_image_params)
        sendProgress(i / num_frames, 'Processing', f"Frame {i+1}/{num_frames}")

    # 5. COPY metadata from source
    if 'channels' in tileClient.tiles:
        sink.channelNames = tileClient.tiles['channels']
    sink.mm_x = tileClient.tiles['mm_x']
    sink.mm_y = tileClient.tiles['mm_y']
    sink.magnification = tileClient.tiles['magnification']

    # 6. WRITE to temp file
    sink.write('/tmp/output.tiff')

    # 7. UPLOAD to Girder (same dataset folder)
    gc = tileClient.client
    item = gc.uploadFileToFolder(datasetId, '/tmp/output.tiff')

    # 8. TAG with metadata for provenance
    gc.addMetadataToItem(item['itemId'], {'tool': 'MyWorkerName'})
```

## Key Details

- `sink.addTile(image, x, y, **params)` — `x` and `y` are tile offsets (usually 0, 0 for full-frame tiles)
- `sink.channelNames` must match the channel order in the frames
- The uploaded file appears as a new item in the dataset folder, viewable in the NimbusImage UI
- `gc.addMetadataToItem` is optional but recommended for tracking what generated the image
- The temp file path (`/tmp/output.tiff`) is inside the Docker container — it's cleaned up when the container exits
