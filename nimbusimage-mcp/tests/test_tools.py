"""Tool logic with a mocked nimbusimage client: shapes, caps, errors."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import girder_client
import numpy as np
import pytest
from mcp.server.mcpserver import Image
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.utilities.func_metadata import func_metadata

import nimbusimage as ni
from nimbusimage_mcp import _common
from nimbusimage_mcp.server import build_server
from nimbusimage_mcp.tools import annotations, datasets, help, images, \
    properties, workers
from nimbusimage_mcp.tools import TOOLS

from conftest import make_settings


def http_error(status: int, message: str = "") -> girder_client.HttpError:
    return girder_client.HttpError(
        status, json.dumps({"message": message}), "http://g", "GET"
    )


def annotation(i: int, tags=("cell",), shape="polygon") -> ni.Annotation:
    return ni.Annotation(
        _id=f"a{i}", shape=shape, tags=list(tags),
        coordinates=[{"x": 0, "y": 0}, {"x": 2, "y": 4}],
    )


def run_tool(tool, **kwargs):
    """Call an async tool from a sync test."""
    return asyncio.run(tool(**kwargs))


def loads(text: str):
    assert isinstance(text, str)
    return json.loads(text)


# --- plumbing -----------------------------------------------------------


def test_result_size_matches_sdk_wire_format():
    meta = func_metadata(lambda: None, structured_output=False)
    text = _common.compact({"total": 3, "datasets": [{"id": "a"}]})
    wire = meta.convert_result(text)
    assert wire.structured_content is None
    assert wire.content[0].text == text
    assert _common.result_size(text) == len(text.encode())
    # Compact, unlike the SDK's indent=2 default for dicts.
    assert "\n" not in text and ": " not in text
    # Images travel base64-encoded.
    assert _common.result_size(Image(data=b"x" * 10, format="jpeg")) == 16


def test_every_tool_is_registered_with_its_annotations():
    server = build_server(make_settings())
    listed = {t.name: t for t in asyncio.run(server.list_tools())}
    assert set(listed) == {fn.__name__ for fn, _ in TOOLS}
    writers = {name for name, t in listed.items()
               if t.annotations and t.annotations.destructive_hint}
    assert writers == {"ni_annotations_tag", "ni_worker_run",
                       "ni_property_compute"}
    for name, tool in listed.items():
        assert tool.output_schema is None, name
        if name not in writers | {"ni_worker_interface"}:
            assert tool.annotations.read_only_hint, name
    # Registering a worker's interface writes server state (a job).
    assert listed["ni_worker_interface"].annotations.read_only_hint is False


@pytest.mark.parametrize("status, fragment", [
    (401, "scope"), (403, "denied"), (400, "No such folder"),
    (404, "Not found"), (500, "server error"), (504, "took too long"),
])
def test_girder_errors_become_tool_errors(nc, status, fragment):
    nc.dataset.side_effect = http_error(status, "No such folder")
    with pytest.raises(ToolError, match=fragment):
        datasets.ni_dataset_info(dataset_id="x")


def test_a_401_for_an_oauth_caller_says_reconnect(nc, monkeypatch):
    # An OAuth session is full-access: a 401 means the connection ended,
    # not a missing API-key scope.
    from mcp.server.auth.provider import AccessToken
    monkeypatch.setattr(_common, "get_access_token", lambda: AccessToken(
        token="t", client_id="nimbusimage-claude", scopes=["nimbusimage"]))
    nc.dataset.side_effect = http_error(401)
    with pytest.raises(ToolError, match="sign-in has ended") as raised:
        datasets.ni_dataset_info(dataset_id="x")
    assert "API key" not in str(raised.value)


def test_unwritable_call_log_does_not_fail_the_call(nc, tmp_path, caplog):
    _common.configure(make_settings(call_log=str(tmp_path)))  # a directory
    nc.list_datasets.return_value = [{"_id": "d1", "name": "x"}]
    assert loads(datasets.ni_datasets_list())["total"] == 1
    assert "Could not write the call log" in caplog.text


def test_a_body_that_stalls_is_a_timeout(monkeypatch):
    """Headers arrive, then the body stalls: requests reports that read
    timeout as a ConnectionError; it is still a timeout to the user."""
    import socket
    import threading
    from types import SimpleNamespace as Token

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    held = []

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            held.append(conn)
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n"
                         b"Content-Type: application/json\r\n\r\n{")

    threading.Thread(target=serve, daemon=True).start()
    port = listener.getsockname()[1]
    _common.configure(make_settings(
        api_url=f"http://127.0.0.1:{port}/api/v1"))
    monkeypatch.setattr(_common, "get_access_token", lambda: Token(
        claims={"girder_token": "t"}, subject="u"))
    monkeypatch.setattr(_common, "HTTP_TIMEOUT", (1, 0.3))
    threading.Timer(5, lambda: [c.close() for c in held]).start()
    try:
        with pytest.raises(ToolError, match="took too long"):
            datasets.ni_dataset_info(dataset_id="d")
    finally:
        _close_listener(listener)
        for conn in held:
            conn.close()


def _close_listener(listener):
    import socket
    try:
        # Wakes a thread blocked in accept() on Linux; macOS raises
        # ENOTCONN for a listening socket, and close() wakes it there.
        listener.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    listener.close()


def test_dropped_connections_are_still_retried():
    """Only read timeouts lose their retries: a keep-alive connection
    Girder closed before answering is retried as before (NIM-006)."""
    import socket
    import threading

    import nimbusimage._girder as girder_module

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    connections = []

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            connections.append(conn)
            conn.recv(65536)
            if len(connections) == 1:
                conn.close()  # dropped before any response
            else:
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                             b"Content-Type: application/json\r\n\r\n{}")
                conn.close()

    threading.Thread(target=serve, daemon=True).start()
    session = girder_module._build_retry_session()
    _common._bound_requests(session)
    try:
        port = listener.getsockname()[1]
        response = session.get(f"http://127.0.0.1:{port}/x")
        assert response.status_code == 200 and len(connections) == 2
    finally:
        _close_listener(listener)


@pytest.mark.parametrize("first, requests_made", [(504, 1), (503, 2)])
def test_a_proxy_timeout_is_not_retried(first, requests_made):
    """A 504 is a proxy's timeout (the request already waited it out):
    one request, not six. A 503 is still retried."""
    import socket
    import threading

    import nimbusimage._girder as girder_module

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    connections = []

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            connections.append(conn)
            conn.recv(65536)
            status = first if len(connections) == 1 else 200
            conn.sendall(f"HTTP/1.1 {status} X\r\nContent-Length: 2\r\n"
                         "Connection: close\r\n\r\n{}".encode())
            conn.close()

    threading.Thread(target=serve, daemon=True).start()
    session = girder_module._build_retry_session()
    _common._bound_requests(session)
    try:
        port = listener.getsockname()[1]
        from unittest import mock
        with mock.patch("time.sleep"):
            response = session.get(f"http://127.0.0.1:{port}/x")
        assert len(connections) == requests_made
        assert response.status_code == (504 if first == 504 else 200)
    finally:
        _close_listener(listener)
    # The nimbusimage package itself still retries 504 (NIM-006).
    assert 504 in girder_module._build_retry_session().adapters[
        "http://"].max_retries.status_forcelist


def test_settings_refuse_a_nonpositive_job_wait():
    from nimbusimage_mcp.config import Settings
    for value in ("0", "nan", "inf"):
        with pytest.raises(ValueError, match="at least 1 second"):
            Settings.from_env({"NI_MCP_MAX_JOB_WAIT": value})


def test_settings_introspection_secret():
    from nimbusimage_mcp.config import Settings
    from nimbusimage_mcp.server import build_verifier
    # Too short, or not header-safe (the plugin's setting has the same
    # rule: testSecretMustBeHeaderSafe).
    for bad in ("short", "é" * 40, "a" * 31 + " " + "a", "a" * 40 + "\n"):
        with pytest.raises(ValueError, match="at least 32 printable"):
            Settings.from_env({"NI_MCP_INTROSPECTION_SECRET": bad})
    secret = "s" * 40
    settings = Settings.from_env({"NI_MCP_INTROSPECTION_SECRET": secret})
    assert settings.introspection_secret == secret
    assert secret not in repr(settings)
    assert build_verifier(settings)._oauth is not None
    # Unset: OAuth is off and only API keys are accepted.
    assert build_verifier(Settings.from_env({}))._oauth is None


def test_known_scale_drops_placeholders():
    assert datasets.known_scale({"value": 1, "unit": "m"}) is None
    assert datasets.known_scale({"value": 0, "unit": "mm"}) is None
    assert datasets.known_scale({"value": None, "unit": "mm"}) is None
    assert datasets.known_scale(None) is None
    real = {"value": 10, "unit": "µm"}
    assert datasets.known_scale(real) == real


def test_round_sig():
    assert _common.round_sig(1234.5678) == 1235.0
    assert _common.round_sig(0.000123456) == 0.0001235
    assert _common.round_sig(None) is None
    assert _common.round_sig(0) == 0


# --- caps ---------------------------------------------------------------


def test_list_tools_enforce_cap(nc):
    folders = [{"_id": f"d{i}", "name": f"ds {i}"} for i in range(150)]
    nc.list_datasets.return_value = folders
    result = loads(datasets.ni_datasets_list(limit=1000))
    assert result["returned"] == datasets.MAX_DATASETS == 100
    assert result["total"] == 150

    accessor = nc.dataset.return_value.annotations
    accessor.count.return_value = 5000
    accessor.list.return_value = [annotation(i) for i in range(200)]
    result = loads(annotations.ni_annotations_list(
        dataset_id="d", limit=10_000, offset=-5
    ))
    kwargs = accessor.list.call_args.kwargs
    assert kwargs["limit"] == annotations.MAX_LIST == 200
    assert kwargs["offset"] == 0
    assert result["total_matching"] == 5000
    assert result["has_more"] and result["next_offset"] == 200


def test_annotation_rows_are_small(nc):
    accessor = nc.dataset.return_value.annotations
    accessor.count.return_value = 1
    accessor.list.return_value = [annotation(1)]
    row, = loads(annotations.ni_annotations_list(dataset_id="d"))[
        "annotations"]
    assert row == {
        "id": "a1", "shape": "polygon", "tags": ["cell"], "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0}, "center": [1.0, 2.0],
        "vertices": 2,
    }


def test_composite_downsampled(nc):
    ds = nc.dataset.return_value
    ds.num_xy, ds.num_z, ds.num_time = 1, 1, 1
    ds.shape = (4000, 3000)
    ds.collections.layers = [{"visible": True}]
    ds.images.get_composite.return_value = np.full((8, 8, 3), 9, np.uint8)
    result = images.ni_image_get_composite(
        dataset_id="d", max_size=99_999, crop=(-10, 0, 5000, 100)
    )
    kwargs = ds.images.get_composite.call_args.kwargs
    assert kwargs["max_size"] == images.MAX_IMAGE_SIZE
    assert kwargs["crop"] == (0, 0, 3000, 100)
    assert isinstance(result, Image)
    # An all-black composite is still shown, with a note saying why it
    # may be black.
    ds.images.get_composite.return_value = np.zeros((8, 8, 3), np.uint8)
    image, note = images.ni_image_get_composite(dataset_id="d")
    assert isinstance(image, Image) and note == images.BLACK_NOTE
    assert _common.result_size([image, note]) == (
        _common.result_size(image) + len(note))


def test_channel_view_is_one_stretched_channel(nc):
    ds = nc.dataset.return_value
    ds.num_xy, ds.num_z, ds.num_time, ds.num_channels = 1, 3, 1, 2
    frame = np.arange(10_000, dtype=np.uint16).reshape(100, 100)
    ds.images.get.return_value = frame
    images.ni_image_get_channel(dataset_id="d", channel=1, z=2, max_size=5)
    kwargs = ds.images.get.call_args.kwargs
    assert kwargs["channel"] == 1 and kwargs["z"] == 2
    assert kwargs["max_size"] == 64
    stretched = images.stretch(frame)
    assert stretched.dtype == np.uint8
    assert stretched.min() == 0 and stretched.max() == 255
    with pytest.raises(ToolError, match="channel=2 is out of range"):
        images.ni_image_get_channel(dataset_id="d", channel=2)


def test_check_crop_clips_and_rejects_empty():
    assert images.check_crop((-5, 10, 120, 50), 100, 80) == (0, 10, 100, 50)
    for bad in ((50, 0, 40, 10), (0, 0, 10, 0), (200, 0, 300, 10)):
        with pytest.raises(ValueError, match="empty or outside"):
            images.check_crop(bad, 100, 80)


# --- annotations --------------------------------------------------------


def test_count_across_datasets_reports_each(nc):
    # Rows as the server returns them: a malformed id and an unreadable
    # one each fail only their own entry.
    nc.count_annotations.return_value = [
        {"datasetId": "aa", "count": 2},
        {"datasetId": "bad", "error": "not a valid id"},
        {"datasetId": "aaa", "count": 3},
    ]
    result = loads(annotations.ni_annotations_count(
        dataset_ids=["aa", "bad", "aaa", "aa"], shape="point"
    ))
    # One batch request, not one per dataset, without duplicates.
    nc.count_annotations.assert_called_once_with(
        ["aa", "bad", "aaa"], shape="point", tags=None
    )
    nc.dataset.assert_not_called()
    assert result["total"] == 5 and result["incomplete"] is True
    assert [c["dataset_id"] for c in result["counts"]] == ["aa", "bad", "aaa"]
    assert result["counts"][1]["error"] == "not a valid id"
    with pytest.raises(ToolError, match="between 1 and 50"):
        annotations.ni_annotations_count(
            dataset_ids=[f"d{i}" for i in range(51)])
    # The limit counts distinct ids.
    nc.count_annotations.return_value = [{"datasetId": "x", "count": 1}]
    assert loads(annotations.ni_annotations_count(
        dataset_ids=["x"] * 51))["total"] == 1


def test_count_keeps_an_overlong_id_to_its_own_entry(nc):
    """The server refuses a whole request with an id over its length cap;
    the tool keeps that a per-entry error and counts the rest."""
    nc.count_annotations.return_value = [{"datasetId": "aa", "count": 2}]
    long_id = "x" * 65
    result = loads(annotations.ni_annotations_count(
        dataset_ids=["aa", long_id]
    ))
    nc.count_annotations.assert_called_once_with(
        ["aa"], shape=None, tags=None)
    assert result["counts"] == [
        {"dataset_id": "aa", "count": 2},
        {"dataset_id": long_id, "error": "not a valid id"},
    ]
    assert result["total"] == 2 and result["incomplete"] is True


@pytest.mark.parametrize("mode, expected", [
    ("add", ["a", "b", "c"]),
    ("remove", ["a"]),
    ("replace", ["b", "c"]),
])
def test_retag_modes(mode, expected):
    assert annotations.retag(["a", "b"], ["b", "c", "c"], mode) == expected


def test_tag_by_query_updates_only_changed(nc):
    accessor = nc.dataset.return_value.annotations
    accessor.count.return_value = 2
    accessor.list.return_value = [
        annotation(1, tags=["cell"]), annotation(2, tags=["cell", "big"]),
    ]
    result = loads(annotations.ni_annotations_tag(
        dataset_id="d", tags=["big"], mode="add", match_tags=["cell"]
    ))
    assert result["matched"] == 2 and result["changed"] == 1
    accessor.update_many.assert_called_once_with(
        [("a1", {"tags": ["cell", "big"]})]
    )
    accessor.update_many.reset_mock()
    accessor.list.return_value = [annotation(3, tags=["big", "cell"])]
    accessor.count.return_value = 1
    result = loads(annotations.ni_annotations_tag(
        dataset_id="d", tags=["cell", "big"], mode="replace",
        match_tags=["cell"],
    ))
    assert result["changed"] == 0
    accessor.update_many.assert_not_called()


def test_tag_by_ids(nc):
    accessor = nc.dataset.return_value.annotations
    accessor.get_many.return_value = [annotation(1, tags=["cell", "x"])]
    result = loads(annotations.ni_annotations_tag(
        dataset_id="d", tags=["x"], mode="remove", annotation_ids=["a1"]
    ))
    accessor.get_many.assert_called_once_with(["a1"])
    accessor.count.assert_not_called()
    accessor.update_many.assert_called_once_with([("a1", {"tags": ["cell"]})])
    assert result["changed"] == 1


def test_tag_refuses_unbounded_or_ambiguous_targets(nc):
    accessor = nc.dataset.return_value.annotations
    with pytest.raises(ToolError, match="match_shape, match_tags"):
        annotations.ni_annotations_tag(dataset_id="d", tags=["x"],
                                       mode="add")
    with pytest.raises(ToolError, match="not both"):
        annotations.ni_annotations_tag(
            dataset_id="d", tags=["x"], mode="add", annotation_ids=["a"],
            match_shape="point",
        )
    with pytest.raises(ToolError, match="non-empty"):
        annotations.ni_annotations_tag(dataset_id="d", tags=[], mode="add",
                                       match_shape="point")
    accessor.count.return_value = annotations.MAX_TAG_ANNOTATIONS + 1
    with pytest.raises(ToolError, match="Narrow it"):
        annotations.ni_annotations_tag(dataset_id="d", tags=["x"],
                                       mode="add", match_shape="point")
    with pytest.raises(ToolError, match="At most"):
        annotations.ni_annotations_tag(
            dataset_id="d", tags=["x"], mode="add",
            annotation_ids=["a"] * (annotations.MAX_TAG_ANNOTATIONS + 1),
        )
    # An empty id list is "no target", never "every annotation".
    with pytest.raises(ToolError, match="match_shape, match_tags"):
        annotations.ni_annotations_tag(dataset_id="d", tags=["x"],
                                       mode="add", annotation_ids=[])
    accessor.update_many.assert_not_called()
    accessor.list.assert_not_called()
    accessor.get_many.assert_not_called()


# --- properties ---------------------------------------------------------


def _property(pid, name="Blob metrics"):
    return ni.Property(_id=pid, name=name, shape="polygon",
                       image="properties/blob_metrics:latest",
                       tags={"tags": ["nucleus"], "exclusive": False})


def _value_docs(nc, docs):
    nc.girder.get.return_value = docs


def test_properties_list_is_scoped_to_the_configuration(nc):
    ds = nc.dataset.return_value
    ds.collections.property_ids = ["p2", "p1"]
    ds.properties.list.return_value = [
        _property("p1"), _property("p2", "Intensity"), _property("other"),
    ]
    _value_docs(nc, [{"values": {
        "p1": {"Area": 1, "Centroid": {"x": 1, "y": 2}},
        "ghost": {"Area": 3},
    }}])
    nc.girder.post.return_value = {"p1": 0, "p2": 7}
    rows = loads(properties.ni_properties_list(dataset_id="d"))["properties"]
    assert [r["id"] for r in rows] == ["p2", "p1"]
    assert rows[1]["value_paths"] == [
        ["p1", "Area"], ["p1", "Centroid", "x"], ["p1", "Centroid", "y"],
    ]
    assert rows[0]["value_paths"] == [] and rows[0]["uncomputed"] == 7
    # Both ends of the value collection are sampled.
    sortdirs = [c.kwargs["parameters"]["sortdir"]
                for c in nc.girder.get.call_args_list]
    assert sortdirs == [1, -1]


def test_no_properties_means_no_value_sampling(nc):
    ds = nc.dataset.return_value
    ds.collections.property_ids = []
    ds.properties.list.return_value = [_property("elsewhere")]
    assert loads(properties.ni_properties_list(dataset_id="d")) == {
        "properties": []}
    with pytest.raises(ToolError, match="No measurements"):
        properties.ni_property_values_summary(dataset_id="d")
    nc.girder.get.assert_not_called()
    nc.girder.post.assert_not_called()


def test_values_summary_summarizes_discovered_paths(nc):
    ds = nc.dataset.return_value
    ds.collections.property_ids = ["p1"]
    ds.properties.list.return_value = [_property("p1")]
    _value_docs(nc, [{"values": {"p1": {"Area": 1, "Perimeter": 2}}}])
    ds.annotations.summary.return_value = ni.AnnotationSummary(
        total=10, tags={}, properties=[
            ni.PropertyStats(path=["p1", "Area"], count=10, mean=1.23456,
                             std=None, min=0.5, max=2),
        ],
    )
    result = loads(properties.ni_property_values_summary(
        dataset_id="d", tags=["nucleus"]
    ))
    kwargs = ds.annotations.summary.call_args.kwargs
    assert kwargs["property_paths"] == [["p1", "Area"], ["p1", "Perimeter"]]
    assert kwargs["tags"] == ["nucleus"]
    stat, = result["stats"]
    assert stat["property"] == "Blob metrics" and stat["path"] == "Area"
    assert stat["mean"] == 1.235


def test_values_summary_says_when_nothing_is_computed(nc):
    ds = nc.dataset.return_value
    ds.collections.property_ids = ["p1"]
    ds.properties.list.return_value = [_property("p1")]
    _value_docs(nc, [])
    with pytest.raises(ToolError, match="ni_property_compute"):
        properties.ni_property_values_summary(dataset_id="d")
    with pytest.raises(ToolError, match="ni_properties_list"):
        properties.ni_property_values_summary(dataset_id="d",
                                              property_id="nope")


def test_histogram_validates_the_path(nc):
    for bad in (["p1"], ["p1", "a.b"], ["p1", ""], ["p1", "$bad"]):
        with pytest.raises(ToolError, match="property_path"):
            properties.ni_property_histogram(dataset_id="d",
                                             property_path=bad)
    hist = nc.dataset.return_value.properties.histogram
    hist.return_value = [{"min": 1, "max": 2, "count": 3}]
    result = loads(properties.ni_property_histogram(
        dataset_id="d", property_path=["p1", "Area"], buckets=500
    ))
    hist.assert_called_once_with("p1.Area", buckets=properties.MAX_BUCKETS)
    assert result["total"] == 3


def test_property_compute_needs_a_configured_property(nc):
    ds = nc.dataset.return_value
    ds.collections.property_ids = ["p1"]
    with pytest.raises(ToolError, match="ni_properties_list"):
        properties.ni_property_compute(dataset_id="d", property_id="p9")
    ds.properties.compute.return_value = SimpleNamespace(
        id="j1", status_name="queued", title="Blob metrics"
    )
    assert loads(properties.ni_property_compute(
        dataset_id="d", property_id="p1"
    ))["job_id"] == "j1"


# --- workers ------------------------------------------------------------


SEG = "annotations/seg:latest"
WORKERS = {
    "annotations/seg:latest": {"isAnnotationWorker": "",
                               "interfaceName": "Seg"},
    "annotations/seg:test": {"isAnnotationWorker": ""},
    "properties/area:latest": {"isPropertyWorker": "",
                               "annotationShape": "polygon"},
    "both/seg-and-area:latest": {"isAnnotationWorker": "",
                                 "isPropertyWorker": "",
                                 "annotationShape": "polygon"},
    "nimbusimage/worker-base:latest": {"isUPennContrastWorkerBase": "True"},
}


def test_workers_list_keeps_real_workers(nc):
    nc.list_workers.return_value = WORKERS
    rows = loads(workers.ni_workers_list())["workers"]
    assert [(r["image"], r["roles"]) for r in rows] == [
        ("annotations/seg:latest", ["annotation"]),
        ("both/seg-and-area:latest", ["annotation", "property"]),
        ("properties/area:latest", ["property"]),
    ]
    assert rows[2]["shape"] == "polygon"
    rows = loads(workers.ni_workers_list(kind="annotation",
                                         include_test_images=True))["workers"]
    assert [r["image"] for r in rows] == [
        "annotations/seg:latest", "annotations/seg:test",
        "both/seg-and-area:latest",
    ]
    # A dual-role worker is a property worker too.
    rows = loads(workers.ni_workers_list(kind="property"))["workers"]
    assert [r["image"] for r in rows] == [
        "both/seg-and-area:latest", "properties/area:latest",
    ]


INTERFACE = {
    "Model": {"type": "select", "items": ["a", "b"], "default": "a",
              "displayOrder": 2},
    "Slot 1": {"type": "channelCheckboxes", "displayOrder": 1},
    "About": {"type": "notes", "value": "Segments cells.", "displayOrder": 0},
}


def test_worker_interface_registers_only_installed_workers(nc):
    nc.get_worker_interface.return_value = None
    nc.list_workers.return_value = WORKERS
    for image in ("evil/image:latest", "nimbusimage/worker-base:latest"):
        with pytest.raises(ToolError, match="No worker image"):
            run_tool(workers.ni_worker_interface, image=image)
    nc.girder.post.assert_not_called()


def test_worker_interface_shape(nc):
    nc.get_worker_interface.return_value = INTERFACE
    nc.dataset.return_value.channels = ["DAPI", "GFP"]
    nc.dataset.return_value.num_channels = 2
    result = loads(run_tool(
        workers.ni_worker_interface, image=SEG, dataset_id="d"
    ))
    assert result["notes"] == ["Segments cells."]
    assert [p["name"] for p in result["parameters"]] == ["Slot 1", "Model"]
    assert set(result["value_formats"]) == {"channelCheckboxes", "select"}
    assert result["channels"][1] == {"index": 1, "name": "GFP"}


def test_worker_run_fills_defaults_and_rejects_property_workers(nc):
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = INTERFACE
    ds = nc.dataset.return_value
    ds.channels, ds.num_channels = ["DAPI", "GFP"], 2
    ds.num_xy, ds.num_z, ds.num_time = 1, 5, 1
    ds.annotations.compute.return_value = SimpleNamespace(
        id="j1", status_name="queued", title="Seg"
    )
    result = loads(run_tool(
        workers.ni_worker_run, dataset_id="d", image=SEG,
        parameters={"Slot 1": ["gfp"]}, tags=["cell"], z=3,
    ))
    assert result["job_id"] == "j1"
    kwargs = ds.annotations.compute.call_args.kwargs
    assert kwargs["worker_interface"] == {
        "Model": "a", "Slot 1": {"0": False, "1": True}, "About": "",
    }
    assert kwargs["location"] == ni.Location(xy=0, z=3, time=0)
    assert kwargs["tags"] == ["cell"]
    # A worker labelled with both roles runs as an annotation worker.
    ds.annotations.compute.reset_mock()
    run_tool(workers.ni_worker_run, dataset_id="d",
             image="both/seg-and-area:latest")
    assert ds.annotations.compute.call_args.kwargs["image"] == \
        "both/seg-and-area:latest"
    with pytest.raises(ToolError, match="not an annotation worker"):
        run_tool(workers.ni_worker_run, dataset_id="d",
                 image="properties/area:latest")
    with pytest.raises(ToolError, match="Unknown worker parameters"):
        run_tool(workers.ni_worker_run, dataset_id="d", image=SEG,
                 parameters={"Nope": 1})


def test_worker_tools_count_unnamed_channels(nc):
    """large_image leaves `channels` empty for images without channel
    names (e.g. one frame); num_channels still counts them."""
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = {
        "Slot 1": {"type": "channelCheckboxes"}}
    ds = nc.dataset.return_value
    ds.channels, ds.num_channels = [], 1
    ds.num_xy, ds.num_z, ds.num_time = 1, 1, 1
    ds.annotations.compute.return_value = SimpleNamespace(
        id="j1", status_name="queued", title="Seg")
    run_tool(workers.ni_worker_run, dataset_id="d", image=SEG,
             parameters={"Slot 1": [0]})
    assert ds.annotations.compute.call_args.kwargs["worker_interface"] == {
        "Slot 1": {"0": True}}
    info = loads(run_tool(workers.ni_worker_interface, image=SEG,
                          dataset_id="d"))
    assert info["channels"] == [{"index": 0, "name": None}]


def test_worker_run_checks_the_location_before_submitting(nc):
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = INTERFACE
    ds = nc.dataset.return_value
    ds.channels, ds.num_channels = ["DAPI"], 1
    ds.num_xy, ds.num_z, ds.num_time = 1, 3, 1
    with pytest.raises(ToolError, match="z=3 is out of range"):
        run_tool(workers.ni_worker_run, dataset_id="d", image=SEG, z=3)
    ds.annotations.compute.assert_not_called()


class _Job:
    """Finishes after `polls` refreshes (never, for None)."""

    def __init__(self, polls, clock=None):
        self.id, self.title = "j1", "Seg"
        self.polls_left = polls
        self.refreshes = 0
        self.refreshed_at = []
        self.clock = clock or {"now": 0.0}
        self.log = "x" * 5000

    @property
    def finished(self):
        return self.polls_left is not None and self.refreshes > \
            self.polls_left

    succeeded = finished

    @property
    def status_name(self):
        return "success" if self.finished else "running"

    def refresh(self):
        self.refreshes += 1
        self.refreshed_at.append(self.clock["now"])


def test_job_wait_clamps_and_reports_still_running(nc, monkeypatch):
    # Patching time.monotonic also drives asyncio's clock; real timeouts
    # are tested in test_job_wait_stops_waiting_for_a_slow_refresh.
    clock = {"now": 0.0}
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        clock["now"] += seconds

    monkeypatch.setattr(workers.anyio, "sleep", fake_sleep)
    monkeypatch.setattr(workers.time, "monotonic", lambda: clock["now"])
    job = _Job(polls=None, clock=clock)
    nc.job.return_value = job
    result = loads(asyncio.run(workers.ni_job_wait(
        job_id="j1", timeout_seconds=10_000
    )))
    # Waits close to the cap, and no poll starts at or after it.
    limit = _common.settings().max_job_wait
    assert limit - workers.POLL_SECONDS <= sum(sleeps) < limit
    assert max(job.refreshed_at) < limit
    assert result["finished"] is False and result["status"] == "running"
    assert len(result["log_tail"]) == workers.LOG_TAIL

    clock["now"], sleeps[:] = 0.0, []
    nc.job.return_value = _Job(polls=2)
    result = loads(asyncio.run(workers.ni_job_wait(job_id="j1")))
    assert result["succeeded"] is True
    assert sleeps == [workers.POLL_SECONDS] * 2


def test_job_wait_stops_waiting_for_a_slow_refresh(nc):
    """A refresh that hangs (slow backend) must not hold the call past
    its cap; the call reports the state it last saw."""
    import time as real_time

    class SlowJob(_Job):
        def refresh(self):
            real_time.sleep(3)

    nc.job.return_value = SlowJob(polls=None)
    start = real_time.monotonic()
    result = loads(asyncio.run(workers.ni_job_wait(
        job_id="j1", timeout_seconds=1
    )))
    assert real_time.monotonic() - start < 2
    assert result["finished"] is False
    # The first lookup is inside the budget too.
    nc.job.side_effect = lambda job_id: real_time.sleep(3)
    start = real_time.monotonic()
    result = loads(asyncio.run(workers.ni_job_wait(
        job_id="j1", timeout_seconds=1
    )))
    assert real_time.monotonic() - start < 2
    assert result["status"] == "unknown" and result["finished"] is False


def test_job_wait_never_reports_a_torn_state(nc):
    """A refresh abandoned at the deadline finishes later and mutates the
    job; the result is the last complete snapshot, not a mix."""
    import time as real_time

    class LateJob(_Job):
        def refresh(self):
            # Status lands before the 1 s deadline, the log after it:
            # reading the live job at the deadline would mix the two.
            real_time.sleep(0.5)
            self.polls_left = -1
            real_time.sleep(1.0)
            self.log = "late log"

    nc.job.return_value = LateJob(polls=None)
    result = loads(asyncio.run(workers.ni_job_wait(
        job_id="j1", timeout_seconds=1
    )))
    # No refresh completed: the job as looked up, consistently.
    assert result["status"] == "running" and result["finished"] is False
    assert result["log_tail"] == "x" * workers.LOG_TAIL


def test_worker_interface_registration_respects_the_wait_cap(nc):
    import time as real_time
    _common.configure(make_settings(max_job_wait=1))
    nc.get_worker_interface.side_effect = lambda *a, **k: real_time.sleep(3)
    start = real_time.monotonic()
    with pytest.raises(ToolError, match="did not answer in time"):
        run_tool(workers.ni_worker_interface, image=SEG)
    assert real_time.monotonic() - start < 2


def test_worker_run_reads_the_dataset_off_the_event_loop(nc):
    import threading
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = INTERFACE
    ds = nc.dataset.return_value
    ds.channels, ds.num_channels = ["DAPI", "GFP"], 2
    ds.num_xy, ds.num_z, ds.num_time = 1, 1, 1
    seen = []
    type(ds.collections).scales = property(
        lambda _: seen.append(threading.current_thread()) or {})
    ds.annotations.compute.return_value = SimpleNamespace(
        id="j1", status_name="queued", title="Seg")
    run_tool(workers.ni_worker_run, dataset_id="d", image=SEG)
    # ds.collections.scales can fetch; it must not run on the loop.
    assert seen and threading.main_thread() not in seen


def test_tool_requests_time_out_once_without_retrying(monkeypatch):
    """The real client() against a server that accepts and never answers:
    the request must end at the read timeout, after ONE connection (no
    read retries re-running a slow server request), and surface as a
    clear tool error that does not name the internal host."""
    import socket
    import threading
    from types import SimpleNamespace as Token

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    accepted = []

    def accept():
        while True:
            try:
                accepted.append(listener.accept()[0])
            except OSError:
                return

    threading.Thread(target=accept, daemon=True).start()

    # If the timeout wiring regressed, the request would block forever:
    # answer nothing for 5 s, then drop the connections, so the test
    # fails instead of hanging.
    def drop_all():
        for connection in accepted:
            connection.close()
    threading.Timer(5, drop_all).start()
    port = listener.getsockname()[1]
    _common.configure(make_settings(
        api_url=f"http://127.0.0.1:{port}/api/v1"))
    monkeypatch.setattr(_common, "get_access_token", lambda: Token(
        claims={"girder_token": "t"}, subject="u"))
    monkeypatch.setattr(_common, "HTTP_TIMEOUT", (1, 0.3))
    try:
        with pytest.raises(ToolError, match="took too long") as raised:
            datasets.ni_dataset_info(dataset_id="d")
        assert "127.0.0.1" not in str(raised.value)
        assert len(accepted) == 1
    finally:
        _close_listener(listener)
        for connection in accepted:
            connection.close()


def test_concurrent_first_requests_register_an_interface_once(nc):
    """Two calls for an unregistered worker at once: the server starts a
    container per registration request, so only one may be sent."""
    import threading
    registered = threading.Event()
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.side_effect = (
        lambda *a, **k: INTERFACE if registered.is_set() else None)

    def register(*args, **kwargs):
        registered.set()
        return []  # no job to wait on

    nc.girder.post.side_effect = register

    async def both():
        return await asyncio.gather(
            workers.ni_worker_interface(image=SEG),
            workers.ni_worker_interface(image=SEG),
        )

    first, second = (loads(r) for r in asyncio.run(both()))
    assert nc.girder.post.call_count == 1
    assert first["parameters"] == second["parameters"]


def test_a_pending_registration_is_not_sent_again(nc):
    """The first caller gives up while the registration job still runs;
    a retry must wait for that job's result, not start another."""
    _common.configure(make_settings(max_job_wait=1))
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = None
    nc.girder.post.return_value = [{"_id": "j1", "status": 2}]
    nc.girder.get.return_value = {"_id": "j1", "status": 2}  # running

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError, match="still registering"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def _registering(nc, job_status=2):
    """A worker whose registration job has the given status."""
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.return_value = None
    nc.girder.post.return_value = [{"_id": "j1", "status": 2}]
    nc.girder.get.return_value = {"_id": "j1", "status": job_status}


def test_a_slow_registration_post_counts_as_pending(nc):
    """A POST that outlives the wait still reaches the server; the retry
    must not send another."""
    import time as real_time
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.post.side_effect = lambda *a, **k: real_time.sleep(1.5)

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def test_a_retry_joins_the_running_registration_and_gets_its_result(
        nc, monkeypatch):
    """The first caller stops waiting while the registration job runs; a
    retry joins the same registration (no second POST) and returns the
    interface once its job finishes."""
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)

    async def scenario():
        with pytest.raises(ToolError, match="still registering"):
            await workers.ni_worker_interface(image=SEG)
        # The job now finishes and registers the interface.
        nc.girder.get.return_value = {"_id": "j1", "status": 3}
        nc.get_worker_interface.return_value = INTERFACE
        _common.configure(make_settings(max_job_wait=10))
        return await workers.ni_worker_interface(image=SEG)

    monkeypatch.setattr(workers, "POLL_SECONDS", 0.05)
    assert loads(asyncio.run(scenario()))["parameters"]
    assert nc.girder.post.call_count == 1


def test_a_failed_registration_is_reported_and_retried(nc, monkeypatch):
    """A registration whose job fails is reported as failed to everyone
    waiting on it, and the next call starts a new one."""
    _common.configure(make_settings(max_job_wait=10))
    _registering(nc, job_status=4)  # the job errors
    monkeypatch.setattr(workers, "POLL_SECONDS", 0.05)

    async def scenario():
        for _ in range(2):
            with pytest.raises(ToolError, match="registration failed"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(scenario())
    assert nc.girder.post.call_count == 2


def _refused_connection():
    """A requests error as a refused connection really raises it."""
    import requests
    from urllib3.exceptions import MaxRetryError, NewConnectionError
    reason = NewConnectionError(None, "Connection refused")
    return requests.ConnectionError(MaxRetryError(None, "/x", reason))


def test_a_registration_that_never_reached_the_server_is_retried(nc):
    """Nothing was sent (connection refused): the next call registers."""
    _common.configure(make_settings(max_job_wait=10))
    _registering(nc)
    nc.girder.post.side_effect = _refused_connection()

    async def scenario():
        for _ in range(2):
            with pytest.raises(ToolError, match="Could not reach"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(scenario())
    assert nc.girder.post.call_count == 2


def test_a_registration_whose_answer_was_lost_stays_pending(nc):
    """The connection dropped after the request went out: it may have
    reached Girder, so a retry must not register again."""
    import requests
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.post.side_effect = requests.ConnectionError(
        "Connection aborted")

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError, match="still registering"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def test_a_proxy_timeout_on_registration_stays_pending(nc):
    """A 504 from the proxy: Girder may have the request; no second POST."""
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.post.side_effect = http_error(504)

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError, match="still registering"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def test_a_truncated_answer_is_a_clean_tool_error(nc):
    import requests
    nc.dataset.side_effect = requests.exceptions.ChunkedEncodingError(
        "http://internal-girder:8080 broke")
    with pytest.raises(ToolError, match="incomplete answer") as raised:
        datasets.ni_dataset_info(dataset_id="d")
    assert "internal-girder" not in str(raised.value)


def test_job_wait_reports_a_missing_job(nc):
    """A 4xx is an answer, not a blip (girder_client.HttpError is also a
    requests.RequestException, so the order of the handlers matters)."""
    job = _Job(polls=None)
    job.refresh = lambda: (_ for _ in ()).throw(http_error(404, "gone"))
    nc.job.return_value = job
    with pytest.raises(ToolError, match="Not found"):
        asyncio.run(workers.ni_job_wait(job_id="j1", timeout_seconds=1))


def test_worker_run_lists_the_workers_once(nc):
    nc.list_workers.return_value = WORKERS
    nc.get_worker_interface.side_effect = [None, None, INTERFACE]
    nc.girder.post.return_value = []
    ds = nc.dataset.return_value
    ds.channels, ds.num_channels = ["DAPI"], 1
    ds.num_xy, ds.num_z, ds.num_time = 1, 1, 1
    ds.annotations.compute.return_value = SimpleNamespace(
        id="j1", status_name="queued", title="Seg")
    run_tool(workers.ni_worker_run, dataset_id="d", image=SEG)
    # Listing workers is a slow Docker listing on the server.
    assert nc.list_workers.call_count == 1


def test_an_unreadable_job_keeps_the_registration_pending(nc):
    """A key without core.user_auth can POST but not read the job: the
    registration stays pending (watching for the interface) instead of
    ending, so a retry does not start another container."""
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.get.side_effect = http_error(401)

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError, match="still registering"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def test_a_connection_blip_while_following_the_job_keeps_it_pending(nc):
    import requests
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.get.side_effect = requests.ConnectionError("blip")

    async def twice():
        for _ in range(2):
            with pytest.raises(ToolError, match="still registering"):
                await workers.ni_worker_interface(image=SEG)

    asyncio.run(twice())
    assert nc.girder.post.call_count == 1


def test_an_outage_while_watching_for_the_interface_keeps_it_pending(
        nc, monkeypatch):
    """Girder stays unreachable after the job poll fails: the interface
    reads fail too, and the registration must still stay pending."""
    import requests
    _common.configure(make_settings(max_job_wait=1))
    _registering(nc)
    nc.girder.get.side_effect = requests.ConnectionError("down")
    reads = iter([None, None])  # before posting; then Girder is down

    def interface(*args, **kwargs):
        value = next(reads, "down")
        if value == "down":
            raise requests.ConnectionError("down")
        return value

    nc.get_worker_interface.side_effect = interface

    async def scenario():
        with pytest.raises(ToolError, match="still registering"):
            await workers.ni_worker_interface(image=SEG)
        # The task outlives the first caller; let it watch a while.
        await asyncio.sleep(0.3)
        task, _ = workers._registrations[asyncio.get_running_loop()][SEG]
        return task.done()

    monkeypatch.setattr(workers, "POLL_SECONDS", 0.05)
    assert asyncio.run(scenario()) is False  # still pending
    assert nc.girder.post.call_count == 1


def test_a_refusal_while_watching_ends_the_registration(nc, monkeypatch):
    """401/403 is permanent: the task ends and reports it, rather than
    retrying a refused key for five minutes."""
    _common.configure(make_settings(max_job_wait=10))
    _registering(nc)
    nc.girder.get.side_effect = http_error(403)  # job unreadable
    reads = iter([None, None])

    def interface(*args, **kwargs):
        value = next(reads, "refused")
        if value == "refused":
            raise http_error(403)
        return value

    nc.get_worker_interface.side_effect = interface
    monkeypatch.setattr(workers, "POLL_SECONDS", 0.05)
    with pytest.raises(ToolError, match="denied"):
        run_tool(workers.ni_worker_interface, image=SEG)


def test_job_wait_survives_a_girder_blip(nc):
    import requests
    job = _Job(polls=None)
    job.refresh = lambda: (_ for _ in ()).throw(
        requests.ConnectionError("blip"))
    nc.job.return_value = job
    result = loads(asyncio.run(workers.ni_job_wait(
        job_id="j1", timeout_seconds=1)))
    assert result["status"] == "running" and "stopped answering" in \
        result["note"]


def test_another_users_refusal_is_not_reported_as_yours(nc, monkeypatch):
    """B joins a registration A started; A's key is refused. B must not
    be told B's own key was refused."""
    import threading
    _common.configure(make_settings(max_job_wait=10))
    _registering(nc)
    import contextvars
    users = iter(["alice", "bob"])
    # Per task, like the real caller_id (the request's contextvar).
    current = contextvars.ContextVar("user", default=None)
    monkeypatch.setattr(workers, "caller_id", current.get)
    go = threading.Event()
    posting = threading.Event()

    def refused(*args, **kwargs):
        posting.set()
        go.wait(5)
        raise http_error(401)

    nc.girder.post.side_effect = refused

    async def call(user):
        current.set(user)
        return await workers.ni_worker_interface(image=SEG)

    async def both():
        alice = asyncio.create_task(call(next(users)))
        # Bob joins only once alice's registration is in flight.
        await asyncio.to_thread(posting.wait, 5)
        bob = asyncio.create_task(call(next(users)))
        await asyncio.sleep(0.2)
        go.set()
        return await asyncio.gather(alice, bob, return_exceptions=True)

    alice_error, bob_error = asyncio.run(both())
    assert "API key" in str(alice_error)  # about alice's own key
    assert "could not be completed" in str(bob_error)
    assert "API key" not in str(bob_error)
    assert nc.girder.post.call_count == 1


def test_finished_registrations_leave_the_registry(nc):
    nc.list_workers.return_value = WORKERS
    calls = iter([None, None, INTERFACE])
    nc.get_worker_interface.side_effect = lambda *a, **k: next(calls)
    nc.girder.post.return_value = []

    async def once():
        await workers.ni_worker_interface(image=SEG)
        await asyncio.sleep(0)  # let the done callback run
        return dict(workers._registrations.get(
            asyncio.get_running_loop(), {}))

    assert asyncio.run(once()) == {}
    assert nc.girder.post.call_count == 1  # a registration did run


def test_worker_interface_checks_the_dataset_before_registering(nc):
    nc.get_worker_interface.return_value = None
    nc.list_workers.return_value = WORKERS
    nc.dataset.return_value.num_channels = 1
    # Girder answers 400 for an id that matches no folder.
    type(nc.dataset.return_value).channels = property(
        lambda _: (_ for _ in ()).throw(http_error(400, "No such folder")))
    with pytest.raises(ToolError, match="No such folder"):
        run_tool(workers.ni_worker_interface, image=SEG, dataset_id="typo")
    nc.girder.post.assert_not_called()


def test_job_wait_scope_problem_is_explained(nc):
    nc.job.return_value.refresh.side_effect = PermissionError(
        "core.user_auth")
    with pytest.raises(ToolError, match="core.user_auth"):
        asyncio.run(workers.ni_job_wait(job_id="j1"))


# --- help ---------------------------------------------------------------


def test_help_topic(nc):
    assert "workflows" in loads(help.ni_help_topic())["topics"]
    nc.girder.get.return_value = {"topic": "workflows", "markdown": "# Hi"}
    assert loads(help.ni_help_topic(topic="workflows"))["markdown"] == "# Hi"
    nc.girder.get.side_effect = http_error(
        400, "Unknown help topic. Available: a, b"
    )
    with pytest.raises(ToolError, match="Available: a, b"):
        help.ni_help_topic(topic="nope")
