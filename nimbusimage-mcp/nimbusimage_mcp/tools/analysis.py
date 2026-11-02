"""Analysis beyond one measurement: pairs of measurements, intensity
along a line, and who a dataset or project belongs to."""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage_mcp._common import (
    READ_ONLY,
    clamp,
    client,
    instrumented,
    round_sig,
)
from nimbusimage_mcp.tools.images import check_location

Shape = Literal["point", "polygon", "line", "rectangle"]

# --- ni_property_pairs -------------------------------------------------------

# Pairs the correlations are computed from: the server's display-sample
# cap (analysis.MAX_SAMPLE_POINTS). Below it every pair is used; above it
# a deterministic sample (by a hash of each annotation id) of this many.
MAX_CORRELATION_PAIRS = 100_000
HISTOGRAM2D = "upenn_annotation/analysis/histogram2d"
DEFAULT_PAIR_SAMPLE = 300
MAX_PAIR_SAMPLE = 1_000
# The server rounds sampled values to this many decimal places
# (analysis.SAMPLE_DECIMALS).
SERVER_SAMPLE_DECIMALS = 4
# Seed of the sample of pairs shown, so a repeated call shows the same.
_SAMPLE_SEED = 0

# --- ni_image_line_scan ------------------------------------------------------

DEFAULT_LINE_SAMPLES = 100
MAX_LINE_SAMPLES = 500
# Most pixels of the region around the line read at full resolution
# (8 MB of 16-bit data); a larger bounding box is read downsampled.
MAX_LINE_REGION_PIXELS = 4_000_000
# Points the line is read at (about one per pixel up to this many), for
# min/max/mean; the profile shown is a subset.
MAX_SCAN_POINTS = 20_000
# Positions of the maximum reported when several samples tie.
MAX_PEAK_POSITIONS = 5

# --- ni_projects_list --------------------------------------------------------

MAX_PROJECTS = 100
MAX_DESCRIPTION = 200

ACCESS_LEVELS = {0: "read", 1: "write", 2: "admin"}


def check_property_path(path, name: str) -> list[str]:
    """A value path as ni_properties_list reports it; ValueError
    otherwise. Its keys become a Mongo field path on the server."""
    if not isinstance(path, list) or not path or any(
        not isinstance(key, str) or not key or "." in key or "$" in key
        for key in path
    ):
        raise ValueError(
            f"{name} must be a value path from ni_properties_list, a list "
            "of keys such as [property_id, \"Area\"] (keys cannot contain "
            "'.' or '$')."
        )
    return path


def ranks(values: np.ndarray) -> np.ndarray:
    """1-based ranks, ties sharing their average rank (as Spearman's rho
    needs)."""
    order = np.argsort(values, kind="stable")
    sorted_values = values[order]
    # Start index of each run of equal values.
    starts = np.flatnonzero(
        np.concatenate(([True], sorted_values[1:] != sorted_values[:-1]))
    )
    ends = np.append(starts[1:], len(values))
    average = (starts + ends + 1) / 2.0  # mean of ranks starts+1..ends
    result = np.empty(len(values), dtype=np.float64)
    result[order] = np.repeat(average, ends - starts)
    return result


def pearson(x: np.ndarray, y: np.ndarray) -> float | None:
    """Pearson's r; None with fewer than 2 pairs or a constant axis."""
    if len(x) < 2:
        return None
    dx, dy = x - x.mean(), y - y.mean()
    denominator = math.sqrt(float(dx @ dx) * float(dy @ dy))
    if denominator == 0:
        return None
    return max(-1.0, min(1.0, float(dx @ dy) / denominator))


def spearman(x: np.ndarray, y: np.ndarray) -> float | None:
    return pearson(ranks(x), ranks(y)) if len(x) >= 2 else None


def axis_range(edges: list[float]) -> tuple[float, float]:
    """The exact (min, max) of an axis's paired values from the 2D
    histogram's bin edges. Asked for two bins, the server returns one
    only when every value is the same, with edges 0.5 either side."""
    if len(edges) == 2:
        middle = (edges[0] + edges[1]) / 2
        return middle, middle
    return edges[0], edges[-1]


@instrumented
def ni_property_pairs(
    dataset_id: str,
    x_property: list[str],
    y_property: list[str],
    tags: list[str] | None = None,
    shape: Shape | None = None,
    sample: int = DEFAULT_PAIR_SAMPLE,
    exclusive: bool = False,
) -> dict:
    """How two measurements relate across the same annotations, e.g.
    "is nucleus area correlated with DAPI intensity?", or points for a
    scatter plot. x_property and y_property are value paths from
    ni_properties_list (e.g. [property_id, "Area"]). Optionally restrict
    to annotations of a shape and with ANY of `tags` (exactly those tags
    with exclusive=true). Only annotations with a number at both paths
    count (n_pairs).

    Returns n_pairs, Pearson and Spearman correlation, min/max/median of
    each axis, and `sample`: up to `sample` [x, y] pairs (default 300, max
    1,000), a random but repeatable subset. min/max are exact. With more
    than 100,000 pairs, correlations and medians come from a repeatable
    random sample of 100,000 (sampled=true, n_used says how many).
    """
    x_path = check_property_path(x_property, "x_property")
    y_path = check_property_path(y_property, "y_property")
    if exclusive and not tags:
        raise ValueError("exclusive=true needs tags")
    filters: dict = {}
    if shape is not None:
        filters["shape"] = shape
    if tags:
        filters["tags"] = {
            "values": list(dict.fromkeys(tags)), "exclusive": exclusive,
        }
    # One server aggregate over the whole dataset: the analysis panel's
    # 2D histogram, whose edges give the exact range of the pairs and
    # whose display sample gives the pairs themselves. No values are
    # paged through.
    result = client().girder.post(HISTOGRAM2D, json={
        "datasetId": dataset_id,
        "xAxis": {"type": "property", "path": x_path},
        "yAxis": {"type": "property", "path": y_path},
        # Two bins, so a one-value axis (which the server collapses to
        # one bin) can be told apart; see axis_range.
        "bins": {"x": 2, "y": 2},
        "upstreamGates": [],
        "filters": filters,
        "sample": {"size": MAX_CORRELATION_PAIRS},
    })
    n_pairs = int(result.get("plottedCount") or 0)
    if n_pairs == 0:
        raise ToolError(
            f"None of the {result.get('inputCount', 0)} matching "
            "annotations has a number at both paths. Check the paths with "
            "ni_properties_list, and the uncomputed counts there."
        )
    points = result.get("sample") or {}
    xs = np.asarray(points.get("x") or [], dtype=np.float64)
    ys = np.asarray(points.get("y") or [], dtype=np.float64)
    x_min, x_max = axis_range(result.get("xEdges"))
    y_min, y_max = axis_range(result.get("yEdges"))

    shown = clamp(sample, 0, MAX_PAIR_SAMPLE)
    if shown < len(xs):
        rng = np.random.default_rng(_SAMPLE_SEED)
        picked = np.sort(rng.choice(len(xs), size=shown, replace=False))
    else:
        picked = np.arange(len(xs))
    response = {
        "x_property": x_path,
        "y_property": y_path,
        "annotations_matching": result.get("inputCount"),
        "n_pairs": n_pairs,
        "n_used": len(xs),
        "sampled": len(xs) < n_pairs,
        "pearson_r": round_sig(pearson(xs, ys)),
        "spearman_r": round_sig(spearman(xs, ys)),
        "x": {"min": round_sig(x_min), "max": round_sig(x_max),
              "median": round_sig(float(np.median(xs)))},
        "y": {"min": round_sig(y_min), "max": round_sig(y_max),
              "median": round_sig(float(np.median(ys)))},
        "sample": [
            [round_sig(float(xs[i])), round_sig(float(ys[i]))]
            for i in picked
        ],
    }
    step = 10 ** -SERVER_SAMPLE_DECIMALS
    coarse = [
        name for name, low, high in (("x", x_min, x_max),
                                     ("y", y_min, y_max))
        if 0 < high - low < 100 * step
    ]
    if coarse:
        # The server sends sampled values to 4 decimal places; on an axis
        # spanning under 0.01 that rounding is over 1% of the range.
        response["note"] = (
            f"Values on {' and '.join(coarse)} span less than 0.01 and "
            "arrive rounded to 4 decimal places, so correlations, medians "
            "and the sample are coarse on that axis."
        )
    return response


# --- ni_image_line_scan ------------------------------------------------------


def region_dim_for(start, end) -> tuple[int, bool]:
    """(max_region_dim for line_scan, whether that reads full resolution):
    the whole bounding box at full resolution when it fits the pixel
    budget, else downsampled to fit it."""
    width = abs(end[0] - start[0]) + 3
    height = abs(end[1] - start[1]) + 3
    longest = math.ceil(max(width, height))
    if width * height <= MAX_LINE_REGION_PIXELS:
        return longest, True
    scale = math.sqrt(MAX_LINE_REGION_PIXELS / (width * height))
    return max(1, int(longest * scale)), False


@instrumented
def ni_image_line_scan(
    dataset_id: str,
    channel: int,
    start: tuple[float, float],
    end: tuple[float, float],
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    samples: int = DEFAULT_LINE_SAMPLES,
) -> dict:
    """Intensity profile of one channel along a straight line, e.g. across
    a nucleus or a cell boundary. start and end are (x, y) in
    full-resolution image pixels (width/height from ni_dataset_info;
    ni_image_get_channel with crop helps pick them). Intensities are the
    raw stored values at the image's true bit depth (not display
    contrast), bilinearly interpolated, read about once per pixel along
    the line (up to 20,000 points); an RGB frame gives the mean of its
    color bands.

    Returns length in pixels (and µm when the pixel size is known),
    min/max/mean over the whole line, where the maximum is (distance from
    start and x, y), and `profile`: up to `samples` evenly spaced
    [distance_px, value] points (default 100, max 500). Values off the
    image are null.
    """
    if len(start) != 2 or len(end) != 2:
        raise ValueError("start and end must each be (x, y)")
    start = (float(start[0]), float(start[1]))
    end = (float(end[0]), float(end[1]))
    ds = client().dataset(dataset_id)
    check_location(ds, xy, z, time)
    if not 0 <= channel < ds.num_channels:
        raise ValueError(
            f"channel={channel} is out of range (0..{ds.num_channels - 1})"
        )
    region_dim, full_resolution = region_dim_for(start, end)
    # line_scan reads tiles/region as a pickled array in the source dtype,
    # so 16-bit data stays 16-bit. It raises ValueError for a zero-length
    # line or one entirely off the image.
    scan = ds.images.line_scan(
        [start, end], xy=xy, z=z, time=time, channel=channel,
        max_samples=MAX_SCAN_POINTS, max_region_dim=region_dim,
    )
    distances = np.asarray(scan.distances, dtype=np.float64)
    values = np.asarray(scan.values, dtype=np.float64)
    finite = np.isfinite(values)
    if not finite.any():
        raise ValueError("the line lies entirely outside the image")
    length = float(distances[-1])
    peak = float(values[finite].max())
    peak_at = np.flatnonzero(finite & (values == peak))
    count = clamp(samples, 2, MAX_LINE_SAMPLES)
    shown = np.unique(
        np.round(np.linspace(0, len(values) - 1, count)).astype(int)
    )
    pixel = ds.pixel_size
    um_per_pixel = pixel.to("um").value if pixel else None
    response = {
        "channel": channel,
        "start": list(start),
        "end": list(end),
        "length_px": round_sig(length),
        "length_um": round_sig(length * um_per_pixel)
        if um_per_pixel else None,
        "pixel_size_um": um_per_pixel,
        "dtype": ds.dtype,
        "n_samples": len(values),
        "min": round_sig(float(values[finite].min())),
        "max": round_sig(peak),
        "mean": round_sig(float(values[finite].mean())),
        "max_at": [
            {
                "distance_px": round_sig(float(distances[i])),
                "x": round_sig(float(scan.points[i][0])),
                "y": round_sig(float(scan.points[i][1])),
            }
            for i in peak_at[:MAX_PEAK_POSITIONS]
        ],
        "profile": [
            [round_sig(float(distances[i])),
             round_sig(float(values[i])) if finite[i] else None]
            for i in shown
        ],
    }
    if not finite.all():
        response["samples_off_image"] = int((~finite).sum())
    if not full_resolution:
        response["note"] = (
            "The line spans a large area, so it was read from a "
            "downsampled image; scan shorter segments for full resolution."
        )
    return response


# --- ni_projects_list --------------------------------------------------------


def trimmed(text: str | None, limit: int = MAX_DESCRIPTION) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


@instrumented
def ni_projects_list(limit: int = 50) -> dict:
    """List the NimbusImage projects (groups of datasets, e.g. for a paper
    or an experiment series) the user can open: id, name, description
    (trimmed), how many datasets and configurations each holds, and
    status (draft, exporting, or exported to Zenodo). Returns {total,
    returned, projects}, at most `limit` (max 100), in name order.
    """
    projects = client().list_projects()
    limit = clamp(limit, 1, MAX_PROJECTS)
    return {
        "total": len(projects),
        "returned": min(len(projects), limit),
        "projects": [
            {
                "id": p["_id"],
                "name": p.get("name", ""),
                "description": trimmed(p.get("description")),
                "dataset_count": len((p.get("meta") or {}).get(
                    "datasets") or []),
                "configuration_count": len((p.get("meta") or {}).get(
                    "collections") or []),
                "status": (p.get("meta") or {}).get("status", "draft"),
            }
            for p in projects[:limit]
        ],
    }


# --- ni_dataset_access -------------------------------------------------------


def level_name(level) -> str:
    return ACCESS_LEVELS.get(level, str(level))


@instrumented
def ni_dataset_access(dataset_id: str) -> dict:
    """Who can open a dataset: whether it is public, the users and groups
    it is shared with and their level (read, write, or admin, i.e.
    owner), the caller's own level, and its configurations (with whether
    each is public). Users are given by login and name; emails are not
    shown. Share links (view-only links) are not listed here.
    """
    access = client().dataset(dataset_id).sharing.get_access()
    return {
        "dataset_id": access.get("datasetId", dataset_id),
        "public": bool(access.get("public")),
        "your_level": level_name(access.get("currentUserLevel")),
        "users": [
            {"login": u.get("login"), "name": u.get("name"),
             "level": level_name(u.get("level"))}
            for u in access.get("users") or []
        ],
        "groups": [
            {"id": g.get("id"), "name": g.get("name"),
             "level": level_name(g.get("level"))}
            for g in access.get("groups") or []
        ],
        "configurations": [
            {"id": c.get("id"), "name": c.get("name"),
             "public": bool(c.get("public"))}
            for c in access.get("configurations") or []
        ],
    }


TOOLS = [
    (ni_property_pairs, READ_ONLY),
    (ni_image_line_scan, READ_ONLY),
    (ni_projects_list, READ_ONLY),
    (ni_dataset_access, READ_ONLY),
]
