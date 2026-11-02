"""Links to the app and downloads, annotation outlines, projections,
and undo."""

import json
from urllib.parse import parse_qs

import numpy as np
import pytest
from mcp.server.mcpserver import Image
from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage_mcp import _common, links
from nimbusimage_mcp.config import Settings
from nimbusimage_mcp.tools import history
from nimbusimage_mcp.tools import images
from nimbusimage_mcp.tools import links as link_tools

from conftest import make_settings

BROWSER_API = "https://app.test/girder/api/v1"


@pytest.fixture
def downloads():
    _common.configure(make_settings(
        frontend_url="https://app.test", browser_api_url=BROWSER_API,
    ))


@pytest.fixture
def ds(nc, monkeypatch):
    for module in (link_tools, history):
        monkeypatch.setattr(module, "client", lambda: nc)
    ds = nc.dataset.return_value
    ds.id, ds.name, ds.item_id = "d1", "HCR", "item1"
    ds.num_xy, ds.num_z, ds.num_time, ds.num_channels = 1, 7, 1, 2
    ds.shape = (1000, 2000)  # height, width
    ds.collections.default_view.return_value = {"_id": "v1"}
    ds.collections.layers = [{"visible": True}]
    return ds


def query(url):
    # App links put the query inside the hash route.
    return {k: v[0] for k, v in parse_qs(url.split("?", 1)[1]).items()}


def test_settings_read_link_urls():
    settings = Settings.from_env({
        "NI_MCP_FRONTEND_URL": "https://app.test/",
        "NI_MCP_BROWSER_API_URL": BROWSER_API,
    })
    assert settings.frontend_url == "https://app.test"
    assert settings.browser_api_url == BROWSER_API
    assert Settings.from_env({}).browser_api_url is None
    with pytest.raises(ValueError, match="NI_MCP_BROWSER_API_URL"):
        Settings.from_env({"NI_MCP_BROWSER_API_URL": "ftp://x"})


def test_view_link_falls_back_to_the_issuer_and_dataset_page(ds):
    # No frontend_url: the issuer, the site's origin.
    assert links.view_link(ds, z=1) == (
        "http://girder.test/#/datasetView/v1/view?z=1")
    ds.collections.default_view.return_value = None
    assert links.view_link(ds, z=1) == "http://girder.test/#/dataset/d1"


def test_slice_label_is_one_based_and_names_the_indices(ds):
    assert links.slice_label(ds, 0, 1, 0) == (
        "Showing Z 2 of 7 (tool indices xy=0, z=1, time=0).")


def test_ni_view_link_centers_on_an_annotation(ds, nc, downloads):
    nc.girder.get.return_value = {
        "datasetId": "d1", "location": {"XY": 0, "Z": 3, "Time": 0},
        "coordinates": [{"x": 10, "y": 20}, {"x": 30, "y": 40}],
    }
    result = link_tools.ni_view_link(dataset_id="d1", annotation_id="a1")
    url = json.loads(result)["url"]
    assert url.startswith("https://app.test/#/datasetView/v1/view?")
    assert query(url) == {
        "xy": "0", "z": "3", "time": "0", "x": "20.0", "y": "30.0"}
    nc.girder.get.return_value["datasetId"] = "other"
    with pytest.raises(ToolError, match="another dataset"):
        link_tools.ni_view_link(dataset_id="d1", annotation_id="a1")
    with pytest.raises(ToolError, match="both x and y"):
        link_tools.ni_view_link(dataset_id="d1", x=5)
    with pytest.raises(ToolError, match="z=9 is out of range"):
        link_tools.ni_view_link(dataset_id="d1", z=9)


def test_composite_links_the_app_and_a_styled_download(ds, downloads):
    ds.images.get_composite.return_value = np.full((8, 8, 3), 9, np.uint8)
    style = {"bands": [{"frame": 4, "min": 0, "max": 9,
                        "palette": ["#000000", "#ff0000"]}]}
    ds.images.composite_style.return_value = style
    image, footer = images.ni_image_get_composite(
        dataset_id="d1", z=1, crop=(100, 0, 300, 100))
    assert isinstance(image, Image)
    assert "Showing Z 2 of 7" in footer
    app = footer.split("Open in NimbusImage: ")[1].split("\n")[0]
    assert query(app)["x"] == "200.0" and query(app)["y"] == "50.0"
    download = footer.split("full resolution): ")[1].split("\n")[0]
    assert download.startswith(f"{BROWSER_API}/item/item1/tiles/region?")
    params = query(download)
    assert json.loads(params["style"]) == style
    assert params["encoding"] == "PNG"
    assert params["contentDisposition"] == "attachment"
    assert (params["left"], params["right"]) == ("100", "300")
    assert "width" not in params
    assert links.DOWNLOAD_NOTE in footer


def test_large_downloads_are_capped(ds, downloads):
    ds.shape = (60_000, 90_000)
    url = links.region_link(ds, {"bands": []})
    assert query(url)["width"] == str(links.MAX_DOWNLOAD_SIZE)


def test_no_download_link_without_a_browser_api_url(ds):
    ds.images.get_composite.return_value = np.full((8, 8, 3), 9, np.uint8)
    ds.images.composite_style.return_value = {"bands": [{"frame": 0}]}
    _, footer = images.ni_image_get_composite(dataset_id="d1")
    assert "Download" not in footer


def test_outlines_are_drawn_from_two_batch_requests(ds, nc):
    ds.images.get_composite.return_value = np.zeros((100, 200, 3), np.uint8)
    ds.images.composite_style.return_value = None
    rows = [
        {"_id": "in", "centroid": {"x": 500, "y": 500}},
        {"_id": "far", "centroid": {"x": 1990, "y": 990}},
    ]
    nc.girder.post.side_effect = lambda path, json: (
        {"total": 2, "offset": 0, "rows": rows}
        if path == "upenn_annotation/list" else [{
            "_id": "in", "shape": "polygon", "coordinates": [
                {"x": 400, "y": 400}, {"x": 600, "y": 400},
                {"x": 500, "y": 600}],
        }])
    result = images.ni_image_get_composite(
        dataset_id="d1", z=2, crop=(0, 0, 1000, 1000),
        outline_tags=["nucleus"])
    calls = nc.girder.post.call_args_list
    assert [c.args[0] for c in calls] == [
        "upenn_annotation/list", "upenn_annotation/hydrate"]
    filters = calls[0].kwargs["json"]["filters"]
    assert filters["location"] == {"XY": 0, "Z": 2, "Time": 0}
    assert filters["tags"] == {"values": ["nucleus"], "exclusive": False}
    # Only the annotation near the crop is fetched and drawn.
    assert calls[1].kwargs["json"] == ["in"]
    assert any("Outlined in yellow: 1 annotation(s)" in part
               for part in result[1:])


def test_draw_outlines_scales_to_the_shown_region():
    pixels = np.zeros((50, 50, 3), np.uint8)
    drawn = images.draw_outlines(pixels, [{
        "shape": "point", "coordinates": [{"x": 150, "y": 150}],
    }], (100, 100, 200, 200), (1000, 1000))
    ys, xs = np.nonzero(drawn[..., 0])
    # (150, 150) in full resolution is the middle of the half-size view.
    assert abs(xs.mean() - 25) < 1 and abs(ys.mean() - 25) < 1
    assert tuple(drawn[ys[0], xs[0]]) == images.OUTLINE_COLOR


def test_outline_note_says_when_capped():
    assert "not all" in images.outline_note(["a"], 3000, 5000, True)
    assert "not all" not in images.outline_note(["a"], 2, 2, False)


def test_channel_max_projection_over_every_slice(ds, downloads):
    ds.num_z = 3
    ds.images.get.side_effect = lambda **kw: np.full(
        (4, 4), kw["z"] * 10, np.uint16)
    ds.images.frame_index.side_effect = lambda **kw: kw["z"] * 2 + 1
    result = images.ni_image_get_channel(
        dataset_id="d1", channel=1, z=1, projection="max")
    assert [c.kwargs["z"] for c in ds.images.get.call_args_list] == [0, 1, 2]
    assert "Maximum projection over all 3 z-slices." in result
    assert "Z 2 of" not in result[-1]
    download = result[-1].split("full resolution): ")[1].split("\n")[0]
    bands = json.loads(query(download)["style"])["bands"]
    assert [b["frame"] for b in bands] == [1, 3, 5]
    assert {b["min"] for b in bands} == {"auto"}


def test_export_links_use_registered_measurement_paths(
        ds, nc, downloads, monkeypatch):
    prop = type("P", (), {"id": "p1"})()
    monkeypatch.setattr(link_tools, "dataset_properties", lambda d: [prop])
    monkeypatch.setattr(link_tools, "discover_paths", lambda nc, i: {
        "p1": [["p1", "Area"]], "orphan": [["orphan", "x"]]})
    result = json.loads(link_tools.ni_export_links(dataset_id="d1"))
    csv = query(result["csv"])
    assert result["csv"].startswith(f"{BROWSER_API}/export/csv?")
    assert json.loads(csv["propertyPaths"]) == [["p1", "Area"]]
    assert csv["filename"] == "HCR.csv"
    assert query(result["geojson"])["datasetId"] == "d1"
    assert result["json"].startswith(f"{BROWSER_API}/export/json?")


def test_export_links_stay_under_the_url_limit(ds, downloads):
    paths = [["p" * 24, f"measurement {i:03d}"] for i in range(150)]
    result = json.loads(link_tools.ni_export_links(
        dataset_id="d1", property_paths=paths))
    assert len(result["csv"]) < link_tools.MAX_CSV_QUERY + 500
    assert result["csv_columns"] + result["csv_columns_omitted"] == 150


def test_export_links_need_a_browser_api_url(ds):
    with pytest.raises(ToolError, match="Import / export"):
        link_tools.ni_export_links(dataset_id="d1", property_paths=[])


def test_undo_reports_the_entry_it_undoes(ds, nc):
    nc.girder.get.return_value = [
        {"actionName": "Delete multiple annotations", "actionDate": "t2",
         "isUndone": True},
        {"actionName": "Update an annotation", "actionDate": "t1",
         "isUndone": False},
    ]
    listed = json.loads(history.ni_history_list(dataset_id="d1"))
    assert listed["entries"][0]["undone"] is True
    result = json.loads(history.ni_history_undo(dataset_id="d1"))
    assert result == {"undone": {
        "action": "Update an annotation", "date": "t1",
    }, "remaining": 0}
    nc.girder.put.assert_called_once_with(
        "history/undo", parameters={"datasetId": "d1"})
    nc.girder.get.return_value = []
    with pytest.raises(ToolError, match="nothing to undo"):
        history.ni_history_undo(dataset_id="d1")
