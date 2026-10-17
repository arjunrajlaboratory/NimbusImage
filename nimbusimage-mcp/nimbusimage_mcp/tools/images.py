"""Looking at the image: the app's composite, or one raw channel."""

from __future__ import annotations

import io

import numpy as np
from mcp.server.mcpserver import Image
from PIL import Image as PILImage

from nimbusimage_mcp._common import READ_ONLY, clamp, client, instrumented

DEFAULT_MAX_SIZE = 1024
MAX_IMAGE_SIZE = 2048
# Percentiles of the returned pixels used to stretch a raw channel.
CHANNEL_CONTRAST = (0.5, 99.5)


BLACK_NOTE = (
    "The composite is entirely black. Either no visible layer draws at "
    "this xy/z/time (e.g. a layer set to an offset slice past the end), "
    "or the frame is dark at the user's contrast; ni_image_get_channel "
    "shows a channel with automatic contrast."
)


def check_crop(crop, width: int, height: int) -> tuple[int, int, int, int]:
    """The crop, clipped to the image; ValueError (shown to the model)
    when it is empty or entirely outside the image."""
    left, top, right, bottom = crop
    left, right = max(0, left), min(width, right)
    top, bottom = max(0, top), min(height, bottom)
    if right <= left or bottom <= top:
        raise ValueError(
            f"crop {tuple(crop)} is empty or outside the image "
            f"(width {width}, height {height}); use "
            "left < right and top < bottom within those bounds."
        )
    return left, top, right, bottom


def check_location(ds, xy: int, z: int, time: int) -> None:
    sizes = {"xy": ds.num_xy, "z": ds.num_z, "time": ds.num_time}
    for axis, value in {"xy": xy, "z": z, "time": time}.items():
        if not 0 <= value < sizes[axis]:
            raise ValueError(
                f"{axis}={value} is out of range (0..{sizes[axis] - 1})"
            )


def encode_jpeg(pixels: np.ndarray) -> bytes:
    # JPEG, not PNG: noisy microscopy compresses badly losslessly (a 1024 px
    # PNG measured 1.1-1.2 MB in the spike; JPEG q85 is ~5x smaller).
    buf = io.BytesIO()
    PILImage.fromarray(pixels).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def stretch(frame: np.ndarray) -> np.ndarray:
    """A raw frame as uint8, stretched between two percentiles of its
    own pixels."""
    low, high = (float(v) for v in np.percentile(frame, CHANNEL_CONTRAST))
    if high <= low:
        high = low + 1
    scaled = (frame.astype(np.float64) - low) / (high - low)
    return (np.clip(scaled, 0, 1) * 255).astype(np.uint8)


@instrumented
def ni_image_get_composite(
    dataset_id: str,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    max_size: int = DEFAULT_MAX_SIZE,
    crop: tuple[int, int, int, int] | None = None,
) -> Image:
    """Show the image: a color composite of the dataset's visible channels
    at one XY position, z-slice, and time point, rendered the way the user
    sees it in NimbusImage (their channel colors, contrast, and layer
    settings such as max projections). Returns a JPEG (with a note if it
    is entirely black) whose longer side is
    at most max_size pixels (default 1024, max 2048). To zoom in, pass
    crop=(left, top, right, bottom) in full-resolution image pixels (see
    width/height from ni_dataset_info). To see one channel on its own,
    use ni_image_get_channel.
    """
    max_size = clamp(max_size, 64, MAX_IMAGE_SIZE)
    ds = client().dataset(dataset_id)
    check_location(ds, xy, z, time)
    if crop is not None:
        height, width = ds.shape
        crop = check_crop(crop, width, height)
    if not any(layer.get("visible", True) for layer in ds.collections.layers):
        raise ValueError(
            "This dataset has no visible layers to show; use "
            "ni_image_get_channel to see a channel."
        )
    rgb = ds.images.get_composite(
        xy=xy, z=z, time=time, dtype="uint8", max_size=max_size, crop=crop
    )
    image = Image(data=encode_jpeg(rgb), format="jpeg")
    if not rgb.any():
        # Black is ambiguous: get_composite also returns black when no
        # layer draws here (e.g. an offset slice out of range). Show it,
        # and say so, rather than refuse a frame that may really be dark.
        return [image, BLACK_NOTE]
    return image


@instrumented
def ni_image_get_channel(
    dataset_id: str,
    channel: int,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    max_size: int = DEFAULT_MAX_SIZE,
    crop: tuple[int, int, int, int] | None = None,
) -> Image:
    """Show one channel (stain) on its own, in grayscale, at one XY
    position, z-slice, and time point. Contrast is stretched automatically
    from the 0.5th to the 99.5th percentile of the shown pixels, not the
    user's display settings (use ni_image_get_composite for what the user
    sees). Channel indices come from ni_dataset_info. Returns a JPEG whose
    longer side is at most max_size (default 1024, max 2048); crop=(left,
    top, right, bottom) in full-resolution pixels zooms in.
    """
    max_size = clamp(max_size, 64, MAX_IMAGE_SIZE)
    ds = client().dataset(dataset_id)
    check_location(ds, xy, z, time)
    if not 0 <= channel < ds.num_channels:
        raise ValueError(
            f"channel={channel} is out of range (0..{ds.num_channels - 1})"
        )
    if crop is not None:
        height, width = ds.shape
        crop = check_crop(crop, width, height)
    frame = ds.images.get(
        xy=xy, z=z, time=time, channel=channel, crop=crop, max_size=max_size
    )
    if frame.ndim == 3:
        # A multi-band (e.g. RGB brightfield) frame: show its first band.
        frame = frame[..., 0]
    return Image(data=encode_jpeg(stretch(frame)), format="jpeg")


TOOLS = [
    (ni_image_get_composite, READ_ONLY),
    (ni_image_get_channel, READ_ONLY),
]
