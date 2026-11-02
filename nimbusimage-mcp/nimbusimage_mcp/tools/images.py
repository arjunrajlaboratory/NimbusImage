"""Looking at the image: the app's composite, or one raw channel, with
annotation outlines on request and links to the app and a download."""

from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Literal

import numpy as np
from mcp.server.mcpserver import Image
from PIL import Image as PILImage
from PIL import ImageDraw

from nimbusimage_mcp import links
from nimbusimage_mcp._common import READ_ONLY, clamp, client, instrumented

DEFAULT_MAX_SIZE = 1024
# Outlines drawn on one image; the list endpoint's centers are scanned in
# pages of LIST_PAGE, at most MAX_OUTLINE_SCAN of them.
MAX_OUTLINES = 3000
LIST_PAGE = 10_000
MAX_OUTLINE_SCAN = 20_000
OUTLINE_COLOR = (255, 255, 0)
# A z max projection reads every slice (PROJECTION_WORKERS at a time).
MAX_PROJECTION_SLICES = 100
PROJECTION_WORKERS = 6
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


def open_view(
    dataset_id: str,
    xy: int,
    z: int,
    time: int,
    max_size: int,
    crop: tuple[int, int, int, int] | None,
    nc=None,
):
    """What both image tools start with: the dataset, with the location
    checked, max_size clamped and crop clipped to the image. Returns
    (ds, max_size, crop)."""
    max_size = clamp(max_size, 64, MAX_IMAGE_SIZE)
    ds = (nc or client()).dataset(dataset_id)
    check_location(ds, xy, z, time)
    if crop is not None:
        height, width = ds.shape
        crop = check_crop(crop, width, height)
    return ds, max_size, crop


def encode_jpeg(pixels: np.ndarray) -> bytes:
    # JPEG, not PNG: noisy microscopy compresses badly losslessly (a 1024 px
    # PNG measured 1.1-1.2 MB in the spike; JPEG q85 is ~5x smaller).
    buf = io.BytesIO()
    PILImage.fromarray(pixels).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def contrast_bounds(frame: np.ndarray) -> tuple[float, float]:
    """The intensities a raw frame is stretched between: two percentiles
    of its own pixels."""
    if frame.ndim == 3:
        frame = frame[..., 0]
    low, high = (float(v) for v in np.percentile(frame, CHANNEL_CONTRAST))
    return low, high if high > low else low + 1


def stretch(frame: np.ndarray, low: float | None = None,
            high: float | None = None) -> np.ndarray:
    """A raw frame as uint8, stretched between low and high (by default
    contrast_bounds of the frame)."""
    if low is None or high is None:
        low, high = contrast_bounds(frame)
    scaled = (frame.astype(np.float64) - low) / (high - low)
    return (np.clip(scaled, 0, 1) * 255).astype(np.uint8)


def outlines(nc, ds, tags, xy, z, time, crop) -> tuple[list, int, bool]:
    """Annotations with any of `tags` at this location whose center is in
    the shown region (with a margin, so edge objects are drawn): two
    requests, the list's centers then the chosen ones' coordinates.
    Returns (annotations, matched near the region, whether every
    annotation at the location was scanned)."""
    height, width = ds.shape
    left, top, right, bottom = crop or (0, 0, width, height)
    margin = 0.1 * max(right - left, bottom - top)
    filters = {
        "location": {"XY": xy, "Z": z, "Time": time},
        "tags": {"values": tags, "exclusive": False},
    }
    ids, offset, total = [], 0, None
    while offset < MAX_OUTLINE_SCAN and (total is None or offset < total):
        page = nc.girder.post("upenn_annotation/list", json={
            "datasetId": ds.id, "filters": filters,
            "limit": LIST_PAGE, "offset": offset,
        })
        total = page["total"]
        for row in page["rows"]:
            center = row.get("centroid") or {}
            cx, cy = center.get("x"), center.get("y")
            if cx is None or cy is None or (
                left - margin <= cx <= right + margin
                and top - margin <= cy <= bottom + margin
            ):
                ids.append(row["_id"])
        if not page["rows"]:
            break
        offset += len(page["rows"])
    scan_complete = offset >= (total or 0)
    if len(ids) > MAX_OUTLINES:
        # An even spread over the list, not its first entries, which
        # would cluster in one part of the image.
        step = len(ids) / MAX_OUTLINES
        ids_drawn = [ids[int(i * step)] for i in range(MAX_OUTLINES)]
    else:
        ids_drawn = ids
    drawn = nc.girder.post(
        "upenn_annotation/hydrate", json=ids_drawn
    ) if ids_drawn else []
    return drawn, len(ids), scan_complete


def draw_outlines(pixels: np.ndarray, annotations: list, crop,
                  full_size: tuple[int, int]) -> np.ndarray:
    """Outline each annotation on an RGB image of the region `crop` (full
    resolution pixels) shown at pixels' size."""
    height, width = full_size
    left, top, right, bottom = crop or (0, 0, width, height)
    sx = pixels.shape[1] / (right - left)
    sy = pixels.shape[0] / (bottom - top)
    image = PILImage.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    stroke = max(1, round(max(pixels.shape[:2]) / 700))

    def place(c):
        return ((c["x"] - left) * sx, (c["y"] - top) * sy)

    for annotation in annotations:
        points = [place(c) for c in annotation.get("coordinates") or []]
        if not points:
            continue
        shape = annotation.get("shape")
        if shape == "point" or len(points) == 1:
            x, y = points[0]
            r = 2 * stroke + 1
            draw.ellipse((x - r, y - r, x + r, y + r),
                         outline=OUTLINE_COLOR, width=stroke)
        elif shape == "line":
            draw.line(points, fill=OUTLINE_COLOR, width=stroke)
        else:
            draw.polygon(points, outline=OUTLINE_COLOR, width=stroke)
    return np.asarray(image)


def outline_note(tags, drawn: int, matched: int,
                 scan_complete: bool = True) -> str:
    note = f"Outlined in yellow: {drawn} annotation(s) tagged any of {tags}"
    if not scan_complete:
        note += (
            f" (an even sample: more than {matched} are in view, since "
            f"only the first {MAX_OUTLINE_SCAN} at this location were "
            "read; crop to a smaller region to see every outline)"
        )
    elif drawn < matched:
        note += (
            f" (an even sample of the {matched} in view; at most "
            f"{MAX_OUTLINES} are drawn, so crop to see every outline)"
        )
    return note + "."


def footer(ds, xy, z, time, crop, download: str | None,
           projected: bool = False, can_download: bool = True) -> str:
    """Where the image is, a link to open it in the app, and a download
    link; the user sees these, while the image itself may sit folded
    inside the tool call."""
    center = {}
    if crop is not None:
        left, top, right, bottom = crop
        # The crop's center and width, so the app shows what the image did.
        center = {"x": round((left + right) / 2, 1),
                  "y": round((top + bottom) / 2, 1),
                  "width": right - left}
    lines = [
        links.slice_label(ds, xy, z, time, projected),
        f"Open in NimbusImage: "
        f"{links.view_link(ds, xy=xy, z=z, time=time, **center)}",
    ]
    if download:
        lines.append(f"Download (PNG, full resolution): {download}")
        lines.append(links.DOWNLOAD_NOTE)
    elif can_download and links.downloads_enabled():
        # The style was built but its link would be too long.
        lines.append(
            "No download link: this image draws too many frames to fit in "
            "a link. The user can export it from the app."
        )
    return "\n".join(lines)


@instrumented
def ni_image_get_composite(
    dataset_id: str,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    max_size: int = DEFAULT_MAX_SIZE,
    crop: tuple[int, int, int, int] | None = None,
    outline_tags: list[str] | None = None,
) -> list:
    """Show the image: a color composite of the dataset's visible channels
    at one XY position, z-slice, and time point, rendered the way the user
    sees it in NimbusImage (their channel colors, contrast, and layer
    settings such as max projections). Returns a JPEG (with a note if it
    is entirely black) whose longer side is
    at most max_size pixels (default 1024, max 2048). To zoom in, pass
    crop=(left, top, right, bottom) in full-resolution image pixels (see
    width/height from ni_dataset_info). To see one channel on its own,
    use ni_image_get_channel.

    xy, z, and time are 0-based indices; the app numbers them from 1, so
    the user's "Z=2" is z=1. outline_tags draws the annotations having
    any of those tags at this location in yellow, e.g. ["nucleus"], so
    you (and the user) can see a segmentation.

    The result also has a link that opens the app at this location
    (centered on the crop) and, when available, a link to download the
    composite as a full-resolution PNG. The user may not see the image
    itself (clients often fold it into the tool call): when they ask to
    see, open, or download it, give them these links.
    """
    nc = client()
    ds, max_size, crop = open_view(
        dataset_id, xy, z, time, max_size, crop, nc
    )
    if not any(layer.get("visible", True) for layer in ds.collections.layers):
        raise ValueError(
            "This dataset has no visible layers to show; use "
            "ni_image_get_channel to see a channel."
        )
    rgb = ds.images.get_composite(
        xy=xy, z=z, time=time, dtype="uint8", max_size=max_size, crop=crop
    )
    notes = []
    if not rgb.any():
        # Black is ambiguous: get_composite also returns black when no
        # layer draws here (e.g. an offset slice out of range). Show it,
        # and say so, rather than refuse a frame that may really be dark.
        notes.append(BLACK_NOTE)
    if outline_tags:
        drawn, matched, scanned = outlines(
            nc, ds, outline_tags, xy, z, time, crop
        )
        rgb = draw_outlines(rgb, drawn, crop, ds.shape)
        notes.append(outline_note(outline_tags, len(drawn), matched, scanned))
    # Only when a link can be made: building the style reads each layer's
    # histogram (cached from get_composite above).
    style = ds.images.composite_style(xy=xy, z=z, time=time) \
        if links.downloads_enabled() else None
    download = links.region_link(
        ds, style, crop, suffix=" composite.png"
    ) if style else None
    return [
        Image(data=encode_jpeg(rgb), format="jpeg"),
        *notes,
        # Nothing draws here: the black note already says so.
        footer(ds, xy, z, time, crop, download, can_download=bool(style)),
    ]


@instrumented
def ni_image_get_channel(
    dataset_id: str,
    channel: int,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    max_size: int = DEFAULT_MAX_SIZE,
    crop: tuple[int, int, int, int] | None = None,
    projection: Literal["none", "max"] = "none",
    outline_tags: list[str] | None = None,
) -> list:
    """Show one channel (stain) on its own, in grayscale, at one XY
    position, z-slice, and time point. Contrast is stretched automatically
    from the 0.5th to the 99.5th percentile of the shown pixels, not the
    user's display settings (use ni_image_get_composite for what the user
    sees). Channel indices come from ni_dataset_info. Returns a JPEG whose
    longer side is at most max_size (default 1024, max 2048); crop=(left,
    top, right, bottom) in full-resolution pixels zooms in.

    projection="max" shows the maximum intensity over every z-slice (z is
    then ignored), the usual way to see spots in a z-stack. xy, z, and
    time are 0-based (the app's "Z=2" is z=1). outline_tags draws the
    annotations having any of those tags at this location in yellow (for
    a projection, those on slice z).
    The result links to the app at this location and, when available, to
    a full-resolution PNG download of the channel; give the user these
    links when they ask to see, open, or download the image.
    """
    nc = client()
    ds, max_size, crop = open_view(
        dataset_id, xy, z, time, max_size, crop, nc
    )
    if not 0 <= channel < ds.num_channels:
        raise ValueError(
            f"channel={channel} is out of range (0..{ds.num_channels - 1})"
        )
    zs = range(ds.num_z) if projection == "max" else [z]
    if len(zs) > MAX_PROJECTION_SLICES:
        raise ValueError(
            f"This stack has {ds.num_z} z-slices; a projection here is "
            f"limited to {MAX_PROJECTION_SLICES}. Open it in the app "
            "instead, where a layer can show a z max projection."
        )

    def fetch(zi):
        return ds.images.get(xy=xy, z=zi, time=time, channel=channel,
                             crop=crop, max_size=max_size)

    # The slices are independent; fetch a few at a time, folding each into
    # a running maximum as it lands, so at most a few planes are held.
    frame = None
    with ThreadPoolExecutor(max_workers=PROJECTION_WORKERS) as pool:
        for future in as_completed([pool.submit(fetch, zi) for zi in zs]):
            plane = future.result()
            frame = plane if frame is None else np.maximum(frame, plane)
            del plane
    if frame.ndim == 3:
        # A multi-band (e.g. RGB brightfield) frame: show its first band.
        frame = frame[..., 0]
    low, high = contrast_bounds(frame)
    pixels = stretch(frame, low, high)
    notes = []
    if projection == "max":
        notes.append(
            f"Maximum projection over all {ds.num_z} z-slices."
        )
    if outline_tags:
        drawn, matched, scanned = outlines(
            nc, ds, outline_tags, xy, z, time, crop
        )
        pixels = draw_outlines(
            np.stack([pixels] * 3, axis=-1), drawn, crop, ds.shape
        )
        notes.append(outline_note(outline_tags, len(drawn), matched, scanned))
    download = links.region_link(
        ds, channel_style(ds, channel, xy, zs, time, low, high), crop,
        suffix=f" channel {channel}.png",
    ) if links.downloads_enabled() else None
    return [
        Image(data=encode_jpeg(pixels), format="jpeg"),
        *notes,
        footer(ds, xy, z, time, crop, download, projection == "max"),
    ]


def channel_style(ds, channel: int, xy: int, zs, time: int,
                  low: float, high: float) -> dict:
    """One channel in gray at the preview's contrast, its frames combined
    by maximum (a projection when there are several). Every band shares
    the bounds: windowing each frame on its own range would let a dim
    slice outshine a bright one."""
    return {"bands": [
        {"frame": ds.images.frame_index(
            xy=xy, z=zi, time=time, channel=channel),
         "min": low, "max": high, "palette": ["#000000", "#ffffff"]}
        for zi in zs
    ]}


TOOLS = [
    (ni_image_get_composite, READ_ONLY),
    (ni_image_get_channel, READ_ONLY),
]
