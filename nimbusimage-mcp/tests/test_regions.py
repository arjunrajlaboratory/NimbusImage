"""Region queries, bulk create/delete, and connection summaries, against an
in-memory stand-in for the plugin's annotation and connection endpoints."""

from __future__ import annotations

import itertools
import json
from unittest.mock import MagicMock

import pytest
from mcp.server.mcpserver.exceptions import ToolError

import nimbusimage as ni
from nimbusimage_mcp.tools import regions

DATASET = "d" * 24


class FakeAnnotationGirder:
    """The plugin endpoints these tools call, over in-memory documents.

    Mirrors the server: POST upenn_annotation/list matches tags with ANY,
    or ALL with all=true, pages by offset (limit clamped to 10,000) in _id
    order, and returns stub rows without coordinates plus a centroid.
    Every request is recorded in ``calls`` as (method, path).
    """

    def __init__(self, width=1000, height=800, num_z=5):
        self.tiles = {
            "sizeX": width, "sizeY": height,
            "IndexRange": {"IndexZ": num_z, "IndexXY": 2, "IndexC": 3},
        }
        self.annotations: dict[str, dict] = {}
        self.connections: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self._ids = itertools.count(1)

    def new_id(self) -> str:
        return f"{next(self._ids):024x}"

    def add(self, x, y, tags=("nucleus",), shape="point", z=0, xy=0,
            time=0, vertices=None) -> str:
        annotation_id = self.new_id()
        self.annotations[annotation_id] = {
            "_id": annotation_id, "datasetId": DATASET, "shape": shape,
            "tags": list(tags), "channel": 0,
            "location": {"XY": xy, "Z": z, "Time": time},
            "coordinates": vertices or [{"x": x, "y": y}],
        }
        return annotation_id

    def connect(self, parent, child):
        self.connections.append({
            "_id": self.new_id(), "parentId": parent, "childId": child,
            "datasetId": DATASET, "tags": [],
        })

    def _matching(self, filters):
        tags = (filters.get("tags") or {}).get("values") or []
        location = filters.get("location") or {}
        for annotation_id in sorted(self.annotations):
            a = self.annotations[annotation_id]
            wanted = set(tags)
            if tags and (filters["tags"].get("all") and not wanted <= set(
                    a["tags"]) or not wanted & set(a["tags"])):
                continue
            if filters.get("shape") and a["shape"] != filters["shape"]:
                continue
            if any(a["location"][k] != v for k, v in location.items()):
                continue
            yield a

    # girder_client surface ------------------------------------------

    def get(self, path, parameters=None):
        self.calls.append(("GET", path.split("?")[0]))
        if path == f"folder/{DATASET}":
            return {"_id": DATASET, "name": "ds",
                    "meta": {"selectedLargeImageId": "item1"}}
        if path == "item/item1":
            return {"_id": "item1"}
        if path == "item/item1/tiles":
            return self.tiles
        if path.startswith("annotation_connection/count"):
            return {"count": len(self.connections)}
        if path == "annotation_connection":
            assert parameters["sort"] == "_id"
            after = parameters.get("afterId")
            rows = [c for c in sorted(self.connections,
                                      key=lambda c: c["_id"])
                    if after is None or c["_id"] > after]
            return [dict(c) for c in rows[:parameters["limit"]]]
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path, json=None):
        self.calls.append(("POST", path))
        if path == "upenn_annotation/list":
            assert json["datasetId"] == DATASET
            matched = list(self._matching(json["filters"]))
            offset = json["offset"]
            limit = min(10_000, max(1, json["limit"]))
            rows = []
            for a in matched[offset:offset + limit]:
                row = {k: v for k, v in a.items() if k != "coordinates"}
                n = len(a["coordinates"])
                row["centroid"] = {
                    "x": sum(c["x"] for c in a["coordinates"]) / n,
                    "y": sum(c["y"] for c in a["coordinates"]) / n,
                }
                rows.append(row)
            return {"total": len(matched), "offset": offset, "rows": rows}
        if path == "upenn_annotation/list/ids":
            matched = list(self._matching(json["filters"]))
            return {"total": len(matched),
                    "ids": [a["_id"] for a in matched]}
        if path == "upenn_annotation/hydrate":
            return [self.annotations[i] for i in json
                    if i in self.annotations]
        if path == "upenn_annotation/multiple":
            created = []
            for doc in json:
                doc = dict(doc, _id=self.new_id())
                self.annotations[doc["_id"]] = doc
                created.append(doc)
            return created
        raise AssertionError(f"unexpected POST {path}")

    def sendRestRequest(self, method, path, json=None):
        self.calls.append((method, path))
        assert (method, path) == ("DELETE", "upenn_annotation/multiple")
        removed = set(json)
        for annotation_id in removed:
            self.annotations.pop(annotation_id, None)
        self.connections = [
            c for c in self.connections
            if not {c["parentId"], c["childId"]} & removed
        ]


@pytest.fixture
def girder(monkeypatch):
    fake = FakeAnnotationGirder()
    nc = MagicMock(name="NimbusClient")
    nc.girder = fake
    nc.dataset.side_effect = lambda dataset_id: ni.Dataset(fake, dataset_id)
    monkeypatch.setattr(regions, "client", lambda: nc)
    return fake


def loads(text):
    assert isinstance(text, str)
    return json.loads(text)


def count(fake, method, path):
    return sum(1 for call in fake.calls if call == (method, path))


# --- ni_annotations_in_region -------------------------------------------


def test_region_keeps_annotations_whose_center_is_inside(girder):
    inside = girder.add(10, 10)
    girder.add(500, 500)
    on_edge = girder.add(100, 50)
    # A polygon whose vertices straddle the edge but whose center is in.
    square = girder.add(0, 0, shape="polygon", vertices=[
        {"x": 80, "y": 0}, {"x": 120, "y": 0}, {"x": 120, "y": 40},
        {"x": 80, "y": 40}])
    girder.add(10, 10, z=1)  # another slice
    result = loads(regions.ni_annotations_in_region(
        dataset_id=DATASET, region=(0, 0, 100, 50)))
    assert result["matched"] == 3
    assert {a["id"] for a in result["annotations"]} == \
        {inside, on_edge, square}
    assert result["scanned"] == result["total_at_location"] == 4
    assert result["incomplete"] is False
    row = next(a for a in result["annotations"] if a["id"] == square)
    assert row == {"id": square, "shape": "polygon", "tags": ["nucleus"],
                   "center": [100.0, 20.0], "vertex_count": 4}
    # Vertex counts come from one batch hydrate, not one call per row.
    assert count(girder, "POST", "upenn_annotation/hydrate") == 1


def test_without_a_region_the_server_total_is_exact(girder):
    for i in range(30):
        girder.add(i, i, z=2)
    girder.add(1, 1, z=0)
    result = loads(regions.ni_annotations_in_region(
        dataset_id=DATASET, z=2, limit=5))
    assert result["matched"] == 30
    assert result["returned"] == 5
    assert result["incomplete"] is False
    assert count(girder, "POST", "upenn_annotation/list") == 1


def test_region_tags_match_all_and_shape_filters(girder):
    """ALL of the tags, as ni_annotations_count counts them."""
    girder.add(5, 5, tags=["nucleus"])
    b = girder.add(6, 6, tags=["nucleus", "dim", "extra"])
    girder.add(7, 7, tags=["dim"])
    girder.add(8, 8, tags=["nucleus", "dim"], shape="polygon")
    result = loads(regions.ni_annotations_in_region(
        dataset_id=DATASET, region=(0, 0, 50, 50),
        tags=["nucleus", "dim"], shape="point"))
    assert {r["id"] for r in result["annotations"]} == {b}


def test_delete_matches_all_tags_like_count(girder):
    girder.add(1, 1, tags=["dapi"])
    reject = girder.add(2, 2, tags=["dapi", "reject"])
    result = loads(regions.ni_annotations_delete(
        dataset_id=DATASET, tags=["dapi", "reject"], expected_count=-1))
    assert result["matching"] == 1
    loads(regions.ni_annotations_delete(
        dataset_id=DATASET, tags=["dapi", "reject"], expected_count=1))
    assert reject not in girder.annotations and len(girder.annotations) == 1


def test_region_scan_stops_at_its_cap(girder, monkeypatch):
    monkeypatch.setattr(regions, "MAX_REGION_SCAN", 25)
    monkeypatch.setattr(regions, "LIST_PAGE", 10)
    for i in range(40):
        girder.add(i, 0)
    result = loads(regions.ni_annotations_in_region(
        dataset_id=DATASET, region=(0, 0, 1000, 800), limit=200))
    assert result["scanned"] == 25
    assert result["matched"] == 25
    assert result["total_at_location"] == 40
    assert result["incomplete"] is True
    # Pages of 10, 10, then the 5 left under the cap.
    assert count(girder, "POST", "upenn_annotation/list") == 3


def test_region_rows_are_capped(girder):
    for i in range(250):
        girder.add(i, 1)
    result = loads(regions.ni_annotations_in_region(
        dataset_id=DATASET, region=(0, 0, 1000, 800), limit=1000))
    assert result["matched"] == 250
    assert result["returned"] == 200


@pytest.mark.parametrize("kwargs, fragment", [
    ({"region": (10, 0, 5, 50)}, "left <= right"),
    ({"z": 5}, "z=5 is out of range"),
    ({"xy": -1}, "XY must be"),
    ({"tags": "nucleus"}, "list of tag names"),
])
def test_region_refuses_bad_input(girder, kwargs, fragment):
    with pytest.raises(ToolError, match=fragment):
        regions.ni_annotations_in_region(dataset_id=DATASET, **kwargs)


# --- ni_annotations_create ----------------------------------------------


def test_create_sends_one_bulk_request(girder):
    result = loads(regions.ni_annotations_create(
        dataset_id=DATASET, z=3, channel=1, annotations=[
            {"shape": "point", "coordinates": [[10, 20]],
             "tags": ["spot"]},
            {"shape": "polygon", "coordinates": [[0, 0], [10, 0], [5, 8]],
             "tags": ["nucleus", "nucleus"]},
            {"shape": "rectangle",
             "coordinates": [[0, 0], [1000, 0], [1000, 800], [0, 800]]},
        ]))
    assert result["created"] == 3 and len(result["ids"]) == 3
    assert count(girder, "POST", "upenn_annotation/multiple") == 1
    docs = [girder.annotations[i] for i in result["ids"]]
    assert docs[0]["location"] == {"XY": 0, "Z": 3, "Time": 0}
    assert docs[0]["channel"] == 1
    assert docs[0]["datasetId"] == DATASET
    assert docs[0]["coordinates"] == [{"x": 10.0, "y": 20.0}]
    assert docs[1]["tags"] == ["nucleus"]
    assert docs[2]["tags"] == []


def test_create_caps_returned_ids(girder):
    result = loads(regions.ni_annotations_create(
        dataset_id=DATASET,
        annotations=[{"shape": "point", "coordinates": [[1, 1]]}] * 250))
    assert result["created"] == 250
    assert len(result["ids"]) == 200 and result["ids_truncated"]


@pytest.mark.parametrize("annotation, fragment", [
    ({"shape": "point", "coordinates": [[1, 1], [2, 2]]}, "exactly 1"),
    ({"shape": "polygon", "coordinates": [[1, 1], [2, 2]]}, "at least 3"),
    ({"shape": "line", "coordinates": [[1, 1]]}, "at least 2"),
    ({"shape": "rectangle", "coordinates": [[0, 0], [1, 0], [1, 1]]},
     "exactly 4"),
    ({"shape": "circle", "coordinates": [[1, 1]]}, "shape must be"),
    ({"shape": "point", "coordinates": [[1001, 1]]}, "outside the image"),
    ({"shape": "point", "coordinates": [[1, -1]]}, "outside the image"),
    ({"shape": "point", "coordinates": [[1]]}, r"\[x, y\]"),
    ({"shape": "point", "coordinates": [[1, 1]], "tags": "a"},
     "tag names"),
])
def test_create_refuses_invalid_annotations(girder, annotation, fragment):
    with pytest.raises(ToolError, match=fragment):
        regions.ni_annotations_create(
            dataset_id=DATASET,
            annotations=[{"shape": "point", "coordinates": [[1, 1]]},
                         annotation])
    # Nothing is created when any entry is invalid.
    assert girder.annotations == {}


def test_create_refuses_too_many_and_bad_location(girder):
    with pytest.raises(ToolError, match="At most 1000"):
        regions.ni_annotations_create(
            dataset_id=DATASET,
            annotations=[{"shape": "point", "coordinates": [[1, 1]]}] * 1001)
    with pytest.raises(ToolError, match="channel=3 is out of range"):
        regions.ni_annotations_create(
            dataset_id=DATASET, channel=3,
            annotations=[{"shape": "point", "coordinates": [[1, 1]]}])
    assert girder.annotations == {}


# --- ni_annotations_delete ----------------------------------------------


def test_delete_counts_first_and_then_deletes_in_one_request(girder):
    doomed = [girder.add(i, i, tags=["junk"], z=1) for i in range(3)]
    kept = girder.add(1, 1, tags=["junk"], z=2)
    girder.add(1, 1, tags=["nucleus"], z=1)
    girder.connect(doomed[0], kept)
    counted = loads(regions.ni_annotations_delete(
        dataset_id=DATASET, expected_count=-1, tags=["junk"], z=1))
    assert counted["deleted"] == 0 and counted["matching"] == 3
    assert "expected_count=3" in counted["message"]
    assert len(girder.annotations) == 5

    result = loads(regions.ni_annotations_delete(
        dataset_id=DATASET, expected_count=3, tags=["junk"], z=1))
    assert result == {"deleted": 3, "matching": 3}
    assert not set(doomed) & set(girder.annotations)
    assert kept in girder.annotations
    assert count(girder, "DELETE", "upenn_annotation/multiple") == 1


def test_delete_refuses_a_wrong_count_and_names_the_real_one(girder):
    for i in range(4):
        girder.add(i, i, tags=["junk"])
    with pytest.raises(ToolError, match="4 annotations match"):
        regions.ni_annotations_delete(
            dataset_id=DATASET, expected_count=3, tags=["junk"])
    assert len(girder.annotations) == 4
    assert count(girder, "DELETE", "upenn_annotation/multiple") == 0


def test_delete_needs_a_filter(girder):
    girder.add(1, 1)
    with pytest.raises(ToolError, match="at least one filter"):
        regions.ni_annotations_delete(dataset_id=DATASET, expected_count=1)
    assert girder.calls == []


def test_delete_refuses_over_the_cap(girder, monkeypatch):
    monkeypatch.setattr(regions, "MAX_DELETE", 2)
    for i in range(3):
        girder.add(i, i, tags=["junk"])
    counted = loads(regions.ni_annotations_delete(
        dataset_id=DATASET, expected_count=-1, tags=["junk"]))
    assert "more than the 2" in counted["message"]
    with pytest.raises(ToolError, match="more than the 2"):
        regions.ni_annotations_delete(
            dataset_id=DATASET, expected_count=3, tags=["junk"])
    assert len(girder.annotations) == 3


def test_delete_with_nothing_matching(girder):
    result = loads(regions.ni_annotations_delete(
        dataset_id=DATASET, expected_count=0, shape="line"))
    assert result == {"deleted": 0, "matching": 0}
    assert count(girder, "DELETE", "upenn_annotation/multiple") == 0


# --- ni_connections_summary ---------------------------------------------


def test_connections_summary_groups_linked_objects(girder, monkeypatch):
    monkeypatch.setattr(regions, "CONNECTION_PAGE", 2)
    a = [girder.add(i, i) for i in range(12)]
    # A chain of 3 across slices, a pair, a star of 6, and a self-link.
    girder.connect(a[0], a[1])
    girder.connect(a[1], a[2])
    girder.connect(a[3], a[4])
    for leaf in a[6:11]:
        girder.connect(a[5], leaf)
    girder.connect(a[11], a[11])
    result = loads(regions.ni_connections_summary(dataset_id=DATASET))
    assert result == {
        "connections": 9,
        "linked_objects": 3,
        "annotations_linked": 11,
        "largest_object": 6,
        "size_histogram": {"2": 1, "3": 1, "4": 0, "5": 0, "6+": 1},
    }
    # Paged by cursor: 9 connections in pages of 2.
    assert count(girder, "GET", "annotation_connection") == 5


def test_connections_summary_merges_components_joined_later(girder):
    a = [girder.add(i, i) for i in range(4)]
    girder.connect(a[0], a[1])
    girder.connect(a[2], a[3])
    girder.connect(a[1], a[2])
    result = loads(regions.ni_connections_summary(dataset_id=DATASET))
    assert result["linked_objects"] == 1
    assert result["size_histogram"]["4"] == 1


def test_connections_summary_only_counts_past_its_cap(girder, monkeypatch):
    monkeypatch.setattr(regions, "MAX_CONNECTIONS_SCANNED", 1)
    a = [girder.add(i, i) for i in range(3)]
    girder.connect(a[0], a[1])
    girder.connect(a[1], a[2])
    result = loads(regions.ni_connections_summary(dataset_id=DATASET))
    assert result["connections"] == 2
    assert "linked_objects" not in result
    assert count(girder, "GET", "annotation_connection") == 0


def test_connections_summary_without_connections(girder):
    result = loads(regions.ni_connections_summary(dataset_id=DATASET))
    assert result["connections"] == 0
    assert result["linked_objects"] == 0
    assert result["largest_object"] == 0


def test_tool_hints():
    hints = {fn.__name__: h for fn, h in regions.TOOLS}
    assert hints["ni_annotations_in_region"].read_only_hint
    assert hints["ni_connections_summary"].read_only_hint
    assert hints["ni_annotations_create"].destructive_hint
    assert hints["ni_annotations_delete"].destructive_hint
