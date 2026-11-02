"""Links for the user: the app at a place, and export downloads."""

from __future__ import annotations

import json

from nimbusimage_mcp import links
from nimbusimage_mcp._common import READ_ONLY, client, instrumented
from nimbusimage_mcp.tools.images import check_location
from nimbusimage_mcp.tools.properties import (
    dataset_properties,
    discover_paths,
)

# Property columns in a CSV link. Each path rides in the URL, so the
# encoded link is kept under links.MAX_LINK_LENGTH.
MAX_CSV_PATHS = 100


@instrumented
def ni_view_link(
    dataset_id: str,
    xy: int = 0,
    z: int = 0,
    time: int = 0,
    x: float | None = None,
    y: float | None = None,
    zoom: float | None = None,
    width: float | None = None,
    annotation_id: str | None = None,
) -> dict:
    """A link that opens the dataset in the NimbusImage app at one XY
    position, z-slice, and time point (0-based indices; the app's "Z=2"
    is z=1), optionally centered on (x, y) in full-resolution image
    pixels, showing `width` image pixels across the viewer (or at a
    viewer zoom level). Pass annotation_id instead to open at that
    annotation's location, centered on it. Give the URL to the user when
    they want to open, see, or share a place in the app; it opens in
    their own (signed-in) app, with their annotations and settings.
    """
    nc = client()
    ds = nc.dataset(dataset_id)
    if annotation_id is not None:
        annotation = nc.girder.get(f"upenn_annotation/{annotation_id}")
        if str(annotation.get("datasetId")) != ds.id:
            raise ValueError(
                "That annotation belongs to another dataset."
            )
        location = annotation.get("location") or {}
        xy, z, time = (location.get(k, 0) for k in ("XY", "Z", "Time"))
        coordinates = annotation.get("coordinates") or []
        if coordinates:
            x = sum(c["x"] for c in coordinates) / len(coordinates)
            y = sum(c["y"] for c in coordinates) / len(coordinates)
    check_location(ds, xy, z, time)
    if (x is None) != (y is None):
        raise ValueError("Pass both x and y, or neither.")
    return {
        "url": links.view_link(
            ds, xy=xy, z=z, time=time,
            x=None if x is None else round(x, 1),
            y=None if y is None else round(y, 1), zoom=zoom,
            width=width,
        ),
        "location": links.slice_label(ds, xy, z, time),
    }


@instrumented
def ni_export_links(
    dataset_id: str,
    property_paths: list[list[str]] | None = None,
) -> dict:
    """Download links for a dataset's annotations: CSV (one row per
    annotation with its location, tags, shape, and measurement columns),
    GeoJSON (the shapes in image pixel coordinates, for QuPath or Python),
    and JSON (everything: annotations, connections, measurements). The
    CSV has the given property_paths as columns (paths as
    ni_properties_list reports them), else every measurement found, up to
    100 columns. The links download in the browser where the user is
    signed in to NimbusImage; give them to the user as they are.
    """
    nc = client()
    ds = nc.dataset(dataset_id)
    if property_paths is None:
        registered = {p.id for p in dataset_properties(ds)}
        property_paths = [
            path
            for property_id, paths in discover_paths(nc, ds.id).items()
            if property_id in registered
            for path in paths
        ]
    omitted = max(0, len(property_paths) - MAX_CSV_PATHS)
    property_paths = property_paths[:MAX_CSV_PATHS]
    name = ds.name

    def csv_link(paths):
        return links.api_link("export/csv", {
            "datasetId": ds.id,
            "propertyPaths": json.dumps(paths, separators=(",", ":")),
            "filename": f"{name}.csv",
        })

    csv = csv_link(property_paths)
    # The limit is on the encoded link, not the JSON: quoting can double it.
    while csv is not None and len(csv) > links.MAX_LINK_LENGTH:
        omitted += 1
        property_paths = property_paths[:-1]
        csv = csv_link(property_paths)
    if csv is None:
        raise ValueError(
            "This NimbusImage server has no download links configured. "
            "The user can export from the app: the Import / export data "
            f"icon in the top bar of {links.view_link(ds)}"
        )
    result = {
        "csv": csv,
        "geojson": links.api_link("export/geojson", {
            "datasetId": ds.id, "filename": f"{name}.geojson",
        }),
        "json": links.api_link("export/json", {
            "datasetId": ds.id, "filename": f"{name}.json",
        }),
        "csv_columns": len(property_paths),
        "note": links.DOWNLOAD_NOTE,
    }
    if omitted:
        result["csv_columns_omitted"] = omitted
    return result


TOOLS = [(ni_view_link, READ_ONLY), (ni_export_links, READ_ONLY)]
