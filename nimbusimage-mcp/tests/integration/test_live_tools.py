"""Every tool against the local compose stack, over real HTTP.

    .venv/bin/python -m pytest -m integration

Annotation and property tools run on a throwaway dataset (no image)
owned by the run's throwaway user, so they mutate nothing real. Image
and worker tools need a dataset with an image: NI_TEST_IMAGE_DATASET (an
id the admin can read; the worker test adds and then deletes a few
annotations tagged with a unique tag).
"""

from __future__ import annotations

import base64
import io
import json
import os
import uuid

import pytest
from PIL import Image as PILImage

import nimbusimage as ni

from helpers import call_tool, rpc

pytestmark = pytest.mark.integration

IMAGE_DATASET = os.environ.get(
    "NI_TEST_IMAGE_DATASET", "6a61e58802a1e5bc6ffd14e3"
)


@pytest.fixture
def user_dataset(live):
    """A dataset folder with a configuration and view, like the app
    makes, in the throwaway user's Private folder."""
    gc = live.user_gc
    private = gc.get("folder", parameters={
        "parentType": "user", "parentId": live.user_id, "name": "Private",
    })[0]
    folder = gc.post("folder", parameters={
        "parentType": "folder", "parentId": private["_id"],
        "name": f"mcp_test_{uuid.uuid4().hex[:8]}",
        "metadata": json.dumps({"subtype": "contrastDataset"}),
    })
    collection = gc.post(
        "upenn_collection",
        parameters={"folderId": folder["_id"], "name": "mcp_test_config"},
        data={"metadata": json.dumps({
            "subtype": "contrastConfiguration", "compatibility": {},
            "layers": [], "tools": [], "propertyIds": [], "snapshots": [],
            "scales": {},
        })},
    )
    view = gc.post("dataset_view", json={
        "datasetId": folder["_id"], "configurationId": collection["_id"],
        "layerContrasts": {}, "lastLocation": {"xy": 0, "z": 0, "time": 0},
    })
    ds = ni.connect(live.api_url, api_key=live.user_key).dataset(
        folder["_id"]
    )
    polygons = [
        ni.Annotation(shape="polygon", tags=["cell"], dataset_id=ds.id,
                      coordinates=[{"x": i, "y": 0}, {"x": i + 4, "y": 0},
                                   {"x": i + 4, "y": 4}])
        for i in range(5)
    ]
    points = [
        ni.Annotation.from_point(i, i, 0, ["spot"], ds.id) for i in range(3)
    ]
    created = ds.annotations.create_many(polygons + points)
    yield ds, created
    # Deleting a folder does not delete its annotations (or their
    # property values); delete them first.
    ds.annotations.delete_many([a.id for a in created])
    for prop in ds.properties.list():
        ds.properties.delete(prop.id)
    gc.delete(f"dataset_view/{view['_id']}")
    gc.delete(f"upenn_collection/{collection['_id']}")
    gc.delete(f"folder/{folder['_id']}")


def test_live_annotation_tools(live, user_dataset):
    ds, _ = user_dataset
    key, url = live.user_key, live.url
    counts = call_tool(url, key, "ni_annotations_count",
                       {"dataset_ids": [ds.id]})
    assert counts["total"] == 8
    assert call_tool(url, key, "ni_annotations_count", {
        "dataset_ids": [ds.id], "shape": "point"})["total"] == 3
    summary = call_tool(url, key, "ni_annotations_summary",
                        {"dataset_id": ds.id})
    assert summary["by_tag"] == {"cell": 5, "spot": 3}
    assert summary["by_shape"] == {"polygon": 5, "point": 3}
    page = call_tool(url, key, "ni_annotations_list",
                     {"dataset_id": ds.id, "shape": "polygon", "limit": 2})
    assert page["total_matching"] == 5 and page["next_offset"] == 2
    assert page["annotations"][0]["vertices"] == 3

    tagged = call_tool(url, key, "ni_annotations_tag", {
        "dataset_id": ds.id, "tags": ["big"], "mode": "add",
        "match_shape": "polygon",
    })
    assert tagged == {"matched": 5, "changed": 5, "mode": "add",
                      "tags": ["big"]}
    assert ds.annotations.count(tags=["cell", "big"]) == 5
    again = call_tool(url, key, "ni_annotations_tag", {
        "dataset_id": ds.id, "tags": ["big"], "mode": "add",
        "match_shape": "polygon",
    })
    assert again["changed"] == 0
    call_tool(url, key, "ni_annotations_tag", {
        "dataset_id": ds.id, "tags": ["big"], "mode": "remove",
        "match_tags": ["big"],
    })
    assert ds.annotations.count(tags=["big"]) == 0


def test_live_property_tools(live, user_dataset):
    ds, created = user_dataset
    key, url = live.user_key, live.url
    prop = ds.properties.create(name="Test area", shape="polygon",
                                tags=["cell"])
    polygons = [a for a in created if a.shape == "polygon"]
    ds.properties.submit_values(prop.id, {
        a.id: {"Area": float(i + 1), "Shape": {"Round": 0.5}}
        for i, a in enumerate(polygons)
    })
    listed = call_tool(url, key, "ni_properties_list",
                       {"dataset_id": ds.id})["properties"]
    row, = listed
    assert row["id"] == prop.id and row["uncomputed"] == 0
    assert sorted(row["value_paths"]) == [
        [prop.id, "Area"], [prop.id, "Shape", "Round"],
    ]
    stats = call_tool(url, key, "ni_property_values_summary", {
        "dataset_id": ds.id, "property_id": prop.id,
    })["stats"]
    area = next(s for s in stats if s["path"] == "Area")
    assert area["count"] == 5 and area["mean"] == 3.0
    assert area["min"] == 1.0 and area["max"] == 5.0
    histogram = call_tool(url, key, "ni_property_histogram", {
        "dataset_id": ds.id, "property_path": [prop.id, "Area"],
        "buckets": 5,
    })
    assert histogram["total"] == 5


def test_live_image_tools(live):
    key, url = live.admin_key, live.url
    info = call_tool(url, key, "ni_dataset_info",
                     {"dataset_id": IMAGE_DATASET})
    for name, arguments in (
        ("ni_image_get_composite", {"dataset_id": IMAGE_DATASET,
                                    "max_size": 256}),
        ("ni_image_get_channel", {"dataset_id": IMAGE_DATASET,
                                  "channel": len(info["channels"]) - 1,
                                  "max_size": 256}),
    ):
        response = rpc(url, "tools/call",
                       {"name": name, "arguments": arguments}, key=key)
        result = response.json()["result"]
        assert not result.get("isError"), result
        block, = result["content"]
        assert block["type"] == "image"
        assert block["mimeType"] == "image/jpeg"
        # Downsampled for real: the longer side is at most max_size.
        picture = PILImage.open(io.BytesIO(base64.b64decode(block["data"])))
        assert max(picture.size) <= 256


def test_live_worker_run_and_wait(live):
    key, url = live.admin_key, live.url
    image = "annotations/random_squares:latest"
    images = {w["image"] for w in call_tool(
        url, key, "ni_workers_list", {"kind": "annotation"})["workers"]}
    if image not in images:
        pytest.skip(f"{image} is not available on this server")
    interface = call_tool(url, key, "ni_worker_interface", {"image": image})
    assert "Number of squares" in {p["name"] for p in interface["parameters"]}

    tag = f"mcp-test-{uuid.uuid4().hex[:8]}"
    ds = ni.connect(live.api_url, api_key=key).dataset(IMAGE_DATASET)
    try:
        job = call_tool(url, key, "ni_worker_run", {
            "dataset_id": IMAGE_DATASET, "image": image, "tags": [tag],
            "parameters": {"Number of squares": 3, "Square size": 5},
        })
        done = call_tool(url, key, "ni_job_wait",
                         {"job_id": job["job_id"], "timeout_seconds": 180})
        assert done["succeeded"], done
        # Every worker job logs at least its container start (with its
        # token redacted by nimbusimage).
        assert done["log_tail"].strip(), done
        assert ds.annotations.count(tags=[tag]) == 3
    finally:
        leftovers = ds.annotations.list(tags=[tag])
        if leftovers:
            ds.annotations.delete_many([a.id for a in leftovers])


def test_live_help_topic(live):
    article = call_tool(live.url, live.user_key, "ni_help_topic",
                        {"topic": "workflows"})
    assert "Segmentation" in article["markdown"]
