---
description: >
  Fetch image data from NimbusImage datasets as numpy arrays using the
  nimbusimage Python API. Use this skill when the user wants to retrieve
  image frames, composites, z-stacks, crops, or channel data from a
  NimbusImage dataset. Also use when you see ds.images in code, or the user
  mentions getting pixel data, viewing channels, making composites, or
  processing image arrays from their imaging server.
---

# NimbusImage — Images

The `ds.images` accessor retrieves image data as numpy arrays from a NimbusImage dataset. Images are fetched from the Girder large_image backend via a pickle-encoded region API.

## Single frame

```python
import numpy as np

# Get one frame as a 2D numpy array (H, W)
img = ds.images.get(channel=0, z=0, time=0)
print(f"Shape: {img.shape}, dtype: {img.dtype}")

# Specify XY position (for multi-position datasets)
img = ds.images.get(channel=0, z=0, time=0, xy=1)
```

## Cropping

```python
# Crop to a region: (left, top, right, bottom) in pixel coordinates
crop = ds.images.get(channel=0, z=0, time=0, crop=(100, 200, 500, 600))
```

## All channels

```python
# Get all channels at one location as a list of 2D arrays
channels = ds.images.get_all_channels(z=0, time=0)
for i, ch in enumerate(channels):
    print(f"Channel {i}: shape={ch.shape}")
```

## Z-stacks and time series

```python
# Z-stack as a 3D array (N_z, H, W)
z_stack = ds.images.get_stack(channel=0, axis="z")

# Time series as a 3D array (N_t, H, W)
time_series = ds.images.get_stack(channel=0, axis="time")

# At specific location
z_stack = ds.images.get_stack(channel=0, axis="z", xy=0, time=0)
```

## Composite image

Creates an RGB composite merging visible channels using layer settings (contrast, pseudocolor) from the dataset's collection configuration:

```python
# Composite as (H, W, 3) numpy array
rgb = ds.images.get_composite(dtype="uint8")   # [0, 255]
rgb_f = ds.images.get_composite(dtype="float64")  # [0.0, 1.0]

# At specific location
rgb = ds.images.get_composite(z=3, time=0, dtype="uint8")
```

The composite uses layer settings from `ds.collections.layers` — channel visibility, contrast (percentile-based blackPoint/whitePoint), and pseudocolor. It blends with "lighten" mode by default.

## Iterating all frames

```python
# Iterate over every frame in the dataset
for frame_info, img in ds.images.iter_frames():
    print(f"Frame {frame_info.index}: ch={frame_info.channel}, "
          f"z={frame_info.z}, t={frame_info.time}, shape={img.shape}")
```

## Writing images (worker context)

For Docker workers that need to write processed images back:

```python
# Requires pip install nimbusimage[worker]
with ds.images.new_writer() as writer:
    for frame_info, img in ds.images.iter_frames():
        processed = some_processing(img)
        writer.add_frame(processed, **frame_info.to_large_image_params())
# Automatically writes TIFF and uploads to dataset folder on context exit
```

## Common patterns

### Save a frame as PNG

```python
from PIL import Image

img = ds.images.get(channel=0, z=0, time=0)
# Normalize to 0-255 if needed
if img.dtype != np.uint8:
    img = ((img - img.min()) / (img.max() - img.min()) * 255).astype(np.uint8)
Image.fromarray(img).save("frame.png")
```

### Save composite as PNG

```python
from PIL import Image

rgb = ds.images.get_composite(dtype="uint8")
Image.fromarray(rgb).save("composite.png")
```

### Maximum intensity projection

```python
z_stack = ds.images.get_stack(channel=0, axis="z")
mip = z_stack.max(axis=0)  # (H, W)
```

## Key details

- All image methods return numpy arrays (squeezed to 2D for single frames).
- The dataset's `dtype` property tells you the source data type (e.g., `uint8`, `uint16`).
- `ds.shape` returns `(height, width)` — numpy convention, not `(width, height)`.
- Composite requires layer settings in the dataset's collection. If no layers are configured, it returns a blank image.
- Frame coordinates: `channel`, `z`, `time`, `xy` are all 0-indexed integers.
