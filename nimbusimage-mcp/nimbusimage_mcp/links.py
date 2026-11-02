"""Links in tool results: the app at a location, and downloads.

The app link opens the caller's view of the dataset. A download link
points at Girder as the user's browser reaches it (browser_api_url) on a
route that accepts Girder's auth cookie, so it works in the browser where
the user is signed in to NimbusImage and carries no credential itself.
"""

from __future__ import annotations

import json
from urllib.parse import urlencode

from nimbusimage.urls import dataset_info_url, dataset_view_url

from nimbusimage_mcp import _common

# Longest side of a downloaded image; past this, crop. A full-resolution
# slide can be 100,000 pixels across.
MAX_DOWNLOAD_SIZE = 8192
# Longest link handed out: browsers and proxies refuse longer request
# lines (8 KB is common), and a style with many frames grows fast.
MAX_LINK_LENGTH = 7500
DOWNLOAD_NOTE = (
    "Download links work in the browser where the user is signed in to "
    "NimbusImage; they carry no credential, so they show nothing to "
    "anyone else."
)


def app_base() -> str:
    settings = _common.settings()
    return settings.frontend_url or settings.issuer_url


def view_link(ds, xy=None, z=None, time=None, x=None, y=None,
              zoom=None, width=None) -> str:
    """The app at this location, in the caller's view of the dataset;
    the dataset's page (where a view is made) when they have none."""
    view = ds.collections.default_view()
    if view is None:
        return dataset_info_url(ds.id, app_base())
    return dataset_view_url(
        view["_id"], app_base(), xy=xy, z=z, time=time, x=x, y=y, zoom=zoom,
        width=width,
    )


# Longest download file name kept: a dataset name is user text, and must
# not decide whether a link fits.
MAX_FILENAME = 100


def download_filename(name: str, suffix: str) -> str:
    return f"{name[:MAX_FILENAME - len(suffix)]}{suffix}"


def downloads_enabled() -> bool:
    return _common.settings().browser_api_url is not None


def api_link(path: str, params: dict) -> str | None:
    """A browser link to a Girder route; None when the server does not
    know Girder's public address."""
    base = _common.settings().browser_api_url
    if base is None:
        return None
    query = urlencode({k: v for k, v in params.items() if v is not None})
    return f"{base}/{path}?{query}"


def region_link(ds, style: dict, crop=None, filename="image.png",
                frame: int = 0) -> str | None:
    """The image a style draws, as a PNG at full resolution (capped at
    MAX_DOWNLOAD_SIZE on the longer side), optionally cropped."""
    if _common.settings().browser_api_url is None:
        return None
    params = {
        "frame": frame,
        "style": json.dumps(style, separators=(",", ":")),
        "encoding": "PNG",
        "contentDisposition": "attachment",
        "contentDispositionFilename": download_filename(
            filename.rsplit(".", 1)[0], ".png"),
    }
    height, width = ds.shape
    if crop is not None:
        left, top, right, bottom = crop
        params.update(left=left, top=top, right=right, bottom=bottom)
        width, height = right - left, bottom - top
    if max(width, height) > MAX_DOWNLOAD_SIZE:
        params.update(width=MAX_DOWNLOAD_SIZE, height=MAX_DOWNLOAD_SIZE)
    url = api_link(f"item/{ds.item_id}/tiles/region", params)
    return url if url is None or len(url) <= MAX_LINK_LENGTH else None


def slice_label(ds, xy: int, z: int, time: int,
                projected: bool = False) -> str:
    """The location as the app labels it (1-based), with the 0-based
    indices the tools take, so "Z=2" is never off by one. projected:
    every z-slice is shown, so z is not named."""
    parts = []
    for name, value, size in (("XY", xy, ds.num_xy), ("Z", z, ds.num_z),
                              ("Time", time, ds.num_time)):
        if name == "Z" and projected:
            parts.append(f"all {size} z-slices")
        elif size > 1:
            parts.append(f"{name} {value + 1} of {size}")
    shown = ", ".join(parts) or "the only frame"
    return f"Showing {shown} (tool indices xy={xy}, z={z}, time={time})."
