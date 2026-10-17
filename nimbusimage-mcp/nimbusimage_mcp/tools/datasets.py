"""Finding and describing datasets."""

from __future__ import annotations

from nimbusimage_mcp._common import READ_ONLY, clamp, client, instrumented

# The spike's 200 cap made a 10 KB response on 95 datasets; name_contains
# is the way to narrow, so a smaller page is enough.
MAX_DATASETS = 100

# exampleConfigurationBase().scales in src/store/model.ts: the app's
# placeholder for a scale nobody set.
_PLACEHOLDER_SCALE = {"value": 1, "unit": "m"}


def known_scale(scale: dict | None) -> dict | None:
    """A configured scale, or None for the app's placeholder or a
    non-positive value (an uncalibrated file)."""
    if not scale or scale == _PLACEHOLDER_SCALE:
        return None
    value = scale.get("value")
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return scale


def channel_names(ds) -> list[str]:
    """One name per channel, "" where the image has none. ds.channels is
    empty for images without channel names (e.g. a single frame), while
    ds.num_channels still counts them."""
    names = list(ds.channels)
    return [names[i] if i < len(names) else ""
            for i in range(ds.num_channels)]


def channel_list(ds) -> list[dict]:
    return [{"index": i, "name": name or None}
            for i, name in enumerate(channel_names(ds))]


@instrumented
def ni_datasets_list(
    name_contains: str | None = None, limit: int = 50
) -> dict:
    """List the NimbusImage datasets (image sets / experiments) the user can
    open. Returns {total, returned, datasets: [{id, name}]}. Use
    name_contains to find a dataset by part of its name (case-insensitive).
    Results are capped at `limit` (max 100); narrow with name_contains
    rather than paging.
    """
    limit = clamp(limit, 1, MAX_DATASETS)
    folders = client().list_datasets()
    if name_contains:
        needle = name_contains.lower()
        folders = [f for f in folders if needle in f["name"].lower()]
    return {
        "total": len(folders),
        "returned": min(len(folders), limit),
        "datasets": [
            {"id": f["_id"], "name": f["name"]} for f in folders[:limit]
        ],
    }


@instrumented
def ni_dataset_info(dataset_id: str) -> dict:
    """Describe one dataset: name, image size, channels, and how many
    z-slices, time points, and XY positions (fields of view) it has, plus
    pixel size (µm), z step, and bit depth; either is null when unknown.
    Use this before fetching images or running workers.
    """
    ds = client().dataset(dataset_id)
    height, width = ds.shape
    pixel = ds.pixel_size  # the app's scales; None when unknown
    return {
        "id": ds.id,
        "name": ds.name,
        "width": width,
        "height": height,
        "dtype": ds.dtype,
        "channels": channel_list(ds),
        "num_z": ds.num_z,
        "num_time": ds.num_time,
        "num_xy": ds.num_xy,
        # One unit for every dataset (files calibrate in mm, configurations
        # often in µm), so sizes compare without per-dataset conversion.
        "pixel_size_um": pixel.to("um").value if pixel else None,
        "z_step": known_scale(ds.collections.scales.get("zStep")),
        "magnification": ds.magnification,
    }


TOOLS = [(ni_datasets_list, READ_ONLY), (ni_dataset_info, READ_ONLY)]
