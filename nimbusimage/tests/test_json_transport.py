"""Tests for the orjson request/response path in _girder.py.

requests' json= / .json() (stdlib json) is the reference: anything it
accepted must still be accepted with the same JSON values, and NaN/Infinity
must still be rejected before sending.
"""

import dataclasses
import datetime
import json
import math
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
import requests

import nimbusimage._girder as g


def _stdlib_body(value):
    return json.dumps(value, allow_nan=False).encode("utf-8")


def _Response(content):
    """A real requests.Response, so the reference is master's .json()."""
    response = requests.Response()
    response._content = content
    response.status_code = 200
    return response


@pytest.fixture
def annotations():
    rng = random.Random(0)
    return [
        {
            "_id": f"{i:024x}",
            "tags": ["cell"],
            "shape": "polygon",
            "channel": 0,
            "location": {"XY": 0, "Z": 0, "Time": 0},
            "datasetId": "6a18de9586eb377626a51daf",
            "coordinates": [
                {"x": rng.uniform(0, 4e4), "y": rng.uniform(0, 4e4), "z": 0}
                for _ in range(25)
            ],
            "name": None,
            "label": "細胞 é",
        }
        for i in range(300)
    ]


class TestDumpsJson:
    def test_matches_stdlib(self, annotations):
        assert (
            json.loads(g.dumps_json(annotations))
            == json.loads(_stdlib_body(annotations))
        )

    def test_numpy_values(self):
        payload = {
            "f64": np.float64(1.25), "f32": np.float32(0.5),
            "i64": np.int64(2**40), "array": np.array([1.5, 2.5]),
        }
        assert json.loads(g.dumps_json(payload)) == {
            "f64": 1.25, "f32": 0.5, "i64": 2**40, "array": [1.5, 2.5],
        }

    @pytest.mark.parametrize("bad", [
        float("nan"), float("inf"), np.float32("nan"),
        np.array([0.0, -np.inf]),
    ])
    def test_non_finite_raises(self, bad):
        with pytest.raises(ValueError, match="not JSON compliant"):
            g.dumps_json({"values": [{"x": bad}]})

    @pytest.mark.parametrize("payload", [
        {0: 1.5}, {"big": 2**70},
    ])
    def test_orjson_rejects_fall_back_to_stdlib(self, payload):
        assert g.dumps_json(payload) == _stdlib_body(payload)

    @pytest.mark.parametrize("payload", [
        {"when": datetime.datetime(2026, 1, 1)},
        {"point": dataclasses.make_dataclass("P", ["x"])(float("nan"))},
    ])
    def test_stdlib_rejections_still_raise(self, payload):
        with pytest.raises(TypeError):
            g.dumps_json(payload)

    def test_without_orjson(self, annotations, monkeypatch):
        monkeypatch.setattr(g, "orjson", None)
        assert g.dumps_json(annotations) == _stdlib_body(annotations)
        with pytest.raises(ValueError, match="not JSON compliant"):
            g.dumps_json([float("nan")])


class TestLoadsJson:
    def test_matches_stdlib(self, annotations):
        body = _stdlib_body(annotations)
        assert g.loads_json(_Response(body)) == _Response(body).json()

    @pytest.mark.parametrize("body", [
        b'\xef\xbb\xbf{"a": 1}',  # UTF-8 BOM: orjson refuses it
        '{"tag": "\u7d30\u80de"}'.encode("utf-16"),
    ])
    def test_encodings_match_requests(self, body):
        assert g.loads_json(_Response(body)) == _Response(body).json()

    def test_nan_tokens_fall_back_to_stdlib(self):
        assert math.isnan(g.loads_json(_Response(b"[NaN]"))[0])

    def test_truncated_body_raises_requests_json_error(self):
        response = requests.Response()
        response._content = b'[{"_id": "abc"'
        with pytest.raises(requests.exceptions.JSONDecodeError):
            g.loads_json(response)


@pytest.fixture
def echo_server():
    """Replies with the request's JSON body; records headers and body."""
    seen = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _serve(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"null"
            seen.append({"headers": dict(self.headers), "body": body,
                         "client": self.client_address})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_DELETE = _serve

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01},
        daemon=True,
    )
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/api/v1", seen
    server.shutdown()
    server.server_close()


class TestCreateClientOverHttp:
    def test_json_round_trip(self, echo_server, annotations):
        url, seen = echo_server
        gc = g.create_client(api_url=url, token="tok")
        assert isinstance(gc, g.FastJsonGirderClient)

        assert gc.post("upenn_annotation/multiple", json=annotations) == (
            json.loads(_stdlib_body(annotations))
        )
        headers = seen[-1]["headers"]
        assert headers["Content-Type"] == "application/json"
        assert headers["Girder-Token"] == "tok"
        assert headers["User-Agent"] == g.USER_AGENT

    def test_delete_with_json_body(self, echo_server):
        url, seen = echo_server
        gc = g.create_client(api_url=url, token="tok")
        ids = ["a" * 24, "b" * 24]
        assert gc.sendRestRequest(
            "DELETE", "upenn_annotation/multiple", json=ids
        ) == ids
        assert json.loads(seen[-1]["body"]) == ids

    def test_nan_is_not_sent(self, echo_server):
        url, seen = echo_server
        gc = g.create_client(api_url=url, token="tok")
        with pytest.raises(ValueError, match="not JSON compliant"):
            gc.post("annotation_property_values/multiple",
                    json=[{"values": {"p": float("nan")}}])
        assert seen == []

    def test_explicit_data_is_sent_unchanged(self, echo_server):
        # requests ignores json= when data= is given; so does the client.
        url, seen = echo_server
        gc = g.create_client(api_url=url, token="tok")
        gc.sendRestRequest(
            "POST", "export/csv", data=b'{"a": 1}', json={"b": 2},
            headers={"Content-Type": "text/plain"}, jsonResp=False,
        )
        assert seen[-1]["body"] == b'{"a": 1}'
        assert seen[-1]["headers"]["Content-Type"] == "text/plain"
