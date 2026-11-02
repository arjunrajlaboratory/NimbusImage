"""Tests for the orjson transport and pooled session in transport.py.

The stdlib path (requests' json= and .json()) is the reference: anything it
accepted must still be accepted and produce the same JSON values, and
anything it rejected before sending (NaN/Infinity) must still be rejected.
"""

import dataclasses
import datetime
import enum
import json
import math
import random
from pathlib import Path
from unittest.mock import patch

import girder_client
import numpy as np
import pytest
import requests
from urllib3.util.retry import Retry

import annotation_client.transport as transport
from annotation_client.annotations import UPennContrastAnnotationClient
from annotation_client.tiles import UPennContrastDataset
from annotation_client.workers import UPennContrastWorkerPreviewClient

DATASET_ID = "6a18de9586eb377626a51daf"


class Measurement(enum.Enum):
    # orjson encodes a plain Enum by its value; stdlib raised TypeError.
    MISSING = float("nan")
    UNBOUNDED = {"limit": float("inf")}
    AREA = 2.5


def polygon(index, rng):
    """An annotation shaped like a segmentation worker's output."""
    return {
        "_id": f"{index:024x}",
        "tags": ["cell", "xenium"],
        "shape": "polygon",
        "channel": 0,
        "location": {"XY": 0, "Z": 0, "Time": 0},
        "datasetId": DATASET_ID,
        "coordinates": [
            {"x": rng.uniform(0, 4e4), "y": rng.uniform(0, 4e4), "z": 0}
            for _ in range(25)
        ],
        "name": None,
    }


def propertyValue(index, rng):
    return {
        "datasetId": DATASET_ID,
        "annotationId": f"{index:024x}",
        "values": {"blobMetrics": {
            "Area": rng.uniform(10, 500),
            "Perimeter": rng.uniform(5, 100),
            "Count": rng.randint(0, 2**40),
            "Label": "é ü 細胞",
        }},
    }


@pytest.fixture
def realShaped():
    rng = random.Random(0)
    return {
        "annotations": [polygon(i, rng) for i in range(500)],
        "propertyValues": [propertyValue(i, rng) for i in range(500)],
    }


def stdlibBody(value):
    """What requests' json= sends."""
    return json.dumps(value, allow_nan=False).encode("utf-8")


def FakeResponse(content):
    """A real requests.Response, so the reference is master's .json()."""
    response = requests.Response()
    response._content = content
    response.status_code = 200
    return response


class TestDumpsJson:
    def test_matches_stdlib_on_real_shaped_payloads(self, realShaped):
        for payload in realShaped.values():
            assert (
                json.loads(transport.dumpsJson(payload))
                == json.loads(stdlibBody(payload))
            )

    def test_uses_orjson(self, realShaped):
        payload = realShaped["annotations"]
        assert transport.dumpsJson(payload) == transport.orjson.dumps(
            payload, option=transport.orjson.OPT_SERIALIZE_NUMPY
        )

    def test_numpy_scalars_and_arrays_serialize_as_their_values(self):
        payload = {
            "f64": np.float64(1.25),
            "f32": np.float32(0.5),
            "i64": np.int64(2**40),
            "u8": np.uint8(7),
            "flag": np.bool_(True),
            "array": np.array([[1.5, 2.0], [3.0, 4.5]]),
            "ints": np.arange(3, dtype=np.int32),
        }
        assert json.loads(transport.dumpsJson(payload)) == {
            "f64": 1.25,
            "f32": 0.5,
            "i64": 2**40,
            "u8": 7,
            "flag": True,
            "array": [[1.5, 2.0], [3.0, 4.5]],
            "ints": [0, 1, 2],
        }

    def test_np_float64_matches_stdlib(self):
        # np.float64 subclasses float, so stdlib accepted it before.
        payload = [{"Area": np.float64(3.75)}]
        assert transport.dumpsJson(payload) == transport.orjson.dumps(
            [{"Area": 3.75}]
        )
        assert json.loads(stdlibBody(payload)) == [{"Area": 3.75}]

    @pytest.mark.parametrize("bad", [
        float("nan"),
        float("inf"),
        -float("inf"),
        np.float64("nan"),
        np.float32("inf"),
        np.array([1.0, np.nan]),
        Measurement.MISSING,
        Measurement.UNBOUNDED,
    ])
    def test_non_finite_values_raise_before_sending(self, bad):
        payload = [{"values": {"prop": {"nested": [1.0, bad]}}}]
        with pytest.raises(ValueError, match="not JSON compliant"):
            transport.dumpsJson(payload)

    def test_stdlib_rejected_nan_the_same_way(self):
        with pytest.raises(ValueError, match="not JSON compliant"):
            stdlibBody([float("nan")])

    def test_nulls_without_non_finite_values_are_sent(self, realShaped):
        # Every polygon has "name": None, so the body contains null and the
        # non-finite walk runs; it must find nothing and let it through.
        payload = realShaped["annotations"] + [{"name": "null", "v": None}]
        body = transport.dumpsJson(payload)
        assert b"null" in body
        assert json.loads(body) == json.loads(stdlibBody(payload))

    def test_finite_enum_values_are_sent(self):
        payload = {"m": Measurement.AREA, "missing": None}
        assert json.loads(transport.dumpsJson(payload)) == {
            "m": 2.5, "missing": None,
        }

    def test_finite_integer_arrays_with_nulls_are_sent(self):
        payload = {"ids": np.arange(4), "missing": None}
        assert json.loads(transport.dumpsJson(payload)) == {
            "ids": [0, 1, 2, 3], "missing": None,
        }

    @pytest.mark.parametrize("payload", [
        {0: 1.5, 1: 2.5},  # non-str keys: orjson raises, stdlib converts
        {"big": 2**70},  # past 64 bits
        {"nested": {True: None, None: 1}},
    ])
    def test_values_orjson_rejects_fall_back_to_stdlib(self, payload):
        assert transport.dumpsJson(payload) == stdlibBody(payload)

    @pytest.mark.parametrize("payload", [
        {"when": {1, 2}},
        {"when": datetime.datetime(2026, 1, 1)},
        # orjson would encode a dataclass, and a NaN in it as null.
        {"point": dataclasses.make_dataclass("P", ["x"])(float("nan"))},
    ])
    def test_values_stdlib_rejects_still_raise_type_error(self, payload):
        with pytest.raises(TypeError):
            stdlibBody(payload)
        with pytest.raises(TypeError):
            transport.dumpsJson(payload)

    def test_fallback_still_rejects_nan(self):
        with pytest.raises(ValueError, match="not JSON compliant"):
            transport.dumpsJson({0: float("nan")})

    def test_without_orjson(self, realShaped, monkeypatch):
        monkeypatch.setattr(transport, "orjson", None)
        payload = realShaped["annotations"]
        assert transport.dumpsJson(payload) == stdlibBody(payload)
        with pytest.raises(ValueError, match="not JSON compliant"):
            transport.dumpsJson([float("nan")])


class TestLoadsJson:
    def test_matches_stdlib_on_real_shaped_responses(self, realShaped):
        for payload in realShaped.values():
            body = stdlibBody(payload)
            assert (
                transport.loadsJson(FakeResponse(body))
                == FakeResponse(body).json()
            )

    @pytest.mark.parametrize("body", [
        b'\xef\xbb\xbf{"a": 1}',  # UTF-8 BOM: orjson refuses it
        '{"tag": "\u7d30\u80de"}'.encode("utf-16"),
        '{"tag": "\u7d30\u80de"}'.encode("utf-8"),
    ])
    def test_encodings_match_requests(self, body):
        assert (
            transport.loadsJson(FakeResponse(body))
            == FakeResponse(body).json()
        )

    def test_nan_tokens_fall_back_to_stdlib(self):
        value = transport.loadsJson(FakeResponse(b'{"a": NaN, "b": 1}'))
        assert math.isnan(value["a"]) and value["b"] == 1

    def test_ints_past_64_bits_decode_as_floats(self):
        # The one known difference from stdlib (documented in transport.py).
        # Girder can't send these: MongoDB stores at most 64-bit integers.
        body = b"[18446744073709551615, 18446744073709551616]"
        assert transport.loadsJson(FakeResponse(body)) == [
            18446744073709551615, 1.8446744073709552e19,
        ]

    def test_truncated_body_raises_requests_json_error(self):
        response = requests.Response()
        response._content = b'[{"_id": "abc", "coordinates": [{"x": 1'
        with pytest.raises(requests.exceptions.JSONDecodeError):
            transport.loadsJson(response)

    def test_without_orjson(self, realShaped, monkeypatch):
        monkeypatch.setattr(transport, "orjson", None)
        body = stdlibBody(realShaped["propertyValues"])
        assert transport.loadsJson(FakeResponse(body)) == json.loads(body)


def _noSleep(self, response=None):
    return None


class TestClientOverHttp:
    def test_bulk_create_sends_orjson_body_and_parses_reply(
        self, fakeGirder, realShaped
    ):
        annotations = realShaped["annotations"]
        created = [dict(a, _id=f"{i:024x}") for i, a in enumerate(annotations)]
        fakeGirder.route("POST", "/api/v1/upenn_annotation/multiple",
                         (200, created))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")

        assert client.createMultipleAnnotations(annotations) == created

        request = fakeGirder.requests[-1]
        assert request["headers"]["Content-Type"] == "application/json"
        assert request["headers"]["Girder-Token"] == "tok"
        assert json.loads(request["body"]) == annotations

    def test_numpy_property_values_upload(self, fakeGirder):
        fakeGirder.route(
            "POST", "/api/v1/annotation_property_values/multiple", (200, [])
        )
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        entries = [{
            "datasetId": DATASET_ID,
            "annotationId": "a" * 24,
            "values": {"prop": {"Area": np.float32(2.5), "N": np.int64(3)}},
        }]

        assert client.addMultipleAnnotationPropertyValues(entries) is None

        assert json.loads(fakeGirder.requests[-1]["body"]) == [{
            "datasetId": DATASET_ID,
            "annotationId": "a" * 24,
            "values": {"prop": {"Area": 2.5, "N": 3}},
        }]

    def test_nan_upload_raises_without_sending(self, fakeGirder):
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        entries = [{
            "datasetId": DATASET_ID,
            "annotationId": "a" * 24,
            "values": {"prop": float("nan")},
        }]
        with pytest.raises(ValueError, match="not JSON compliant"):
            client.addMultipleAnnotationPropertyValues(entries)
        assert fakeGirder.requests == []

    def test_reads_parse_like_stdlib(self, fakeGirder, realShaped):
        annotations = realShaped["annotations"]
        fakeGirder.route("GET", "/api/v1/upenn_annotation",
                         (200, stdlibBody(annotations)))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")

        assert client.getAnnotationsByDatasetId(
            DATASET_ID, limit=0
        ) == json.loads(stdlibBody(annotations))
        assert client.getAnnotationsByDatasetId(DATASET_ID) == annotations
        assert "datasetId=" + DATASET_ID in fakeGirder.requests[-1]["query"]

    def test_delete_with_json_body(self, fakeGirder):
        fakeGirder.route("DELETE", "/api/v1/upenn_annotation/multiple",
                         (200, b"null"))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")

        assert client.deleteMultipleAnnotations(["a" * 24]) is None
        request = fakeGirder.requests[-1]
        assert json.loads(request["body"]) == ["a" * 24]
        assert request["headers"]["Content-Type"] == "application/json"

    def test_http_errors_still_raise_girder_http_error(self, fakeGirder):
        fakeGirder.route("GET", "/api/v1/upenn_annotation/" + "a" * 24,
                         (400, {"message": "bad"}))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        with pytest.raises(girder_client.HttpError) as info:
            client.getAnnotationById("a" * 24)
        assert info.value.status == 400

    def test_connections_are_reused(self, fakeGirder):
        fakeGirder.route("GET", "/api/v1/upenn_annotation/count",
                         (200, {"count": 1}))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        for _ in range(3):
            client.countAnnotationsByDatasetId(DATASET_ID)
        ports = {request["client"] for request in fakeGirder.requests}
        assert len(ports) == 1

    def test_posts_use_fresh_connections(self, fakeGirder):
        # A pooled connection closed by the server mid-send fails a POST
        # with no retry, so POSTs don't reuse one; GETs still do.
        fakeGirder.route("GET", "/api/v1/upenn_annotation/count",
                         (200, {"count": 1}))
        fakeGirder.route("POST", "/api/v1/upenn_annotation/multiple",
                         (200, []))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        client.countAnnotationsByDatasetId(DATASET_ID)
        client.createMultipleAnnotations([{"shape": "point"}])
        client.countAnnotationsByDatasetId(DATASET_ID)
        client.countAnnotationsByDatasetId(DATASET_ID)
        client.createMultipleAnnotations([{"shape": "point"}])
        ports = [request["client"] for request in fakeGirder.requests]
        assert ports[1] != ports[0]
        assert ports[2] == ports[3]
        assert ports[4] not in ports[:4]

    def test_cookies_are_not_kept(self, fakeGirder):
        # The load balancer's sticky cookie must not pin a worker to one
        # backend; module-level requests.* never sent it back either.
        fakeGirder.route("GET", "/api/v1/upenn_annotation/count", (
            200, {"count": 1}, {"Set-Cookie": "SERVER=girder1; path=/"},
        ))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        client.countAnnotationsByDatasetId(DATASET_ID)
        client.countAnnotationsByDatasetId(DATASET_ID)
        assert "Cookie" not in fakeGirder.requests[-1]["headers"]
        assert len(client.client._session.cookies) == 0

    def test_gateway_timeouts_are_not_retried(self, fakeGirder):
        # A 504 comes after the server timeout; retrying reruns slow work.
        fakeGirder.route("GET", "/api/v1/upenn_annotation",
                         (504, {"message": "timeout"}), (200, []))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        with patch.object(Retry, "sleep", _noSleep):
            with pytest.raises(girder_client.HttpError) as info:
                client.getAnnotationsByDatasetId(DATASET_ID, limit=0)
        assert info.value.status == 504
        assert len(fakeGirder.requests) == 1

    def test_get_retries_transient_5xx(self, fakeGirder):
        fakeGirder.route("GET", "/api/v1/upenn_annotation/count",
                         (503, {"message": "busy"}), (200, {"count": 7}))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        with patch.object(Retry, "sleep", _noSleep):
            assert client.countAnnotationsByDatasetId(DATASET_ID) == {
                "count": 7
            }
        assert len(fakeGirder.requests) == 2

    def test_post_is_not_retried(self, fakeGirder):
        fakeGirder.route("POST", "/api/v1/upenn_annotation/multiple",
                         (503, {"message": "busy"}), (200, []))
        client = UPennContrastAnnotationClient(fakeGirder.apiUrl, "tok")
        with patch.object(Retry, "sleep", _noSleep):
            with pytest.raises(girder_client.HttpError) as info:
                client.createMultipleAnnotations([{"shape": "point"}])
        assert info.value.status == 503
        assert len(fakeGirder.requests) == 1


def test_packaging_requires_an_orjson_with_the_options_used():
    # An older orjson already in a worker env satisfies a bare "orjson"
    # requirement, and one before 3.3 fails this package's import.
    root = Path(transport.__file__).parent.parent
    assert "orjson>=3.10" in (root / "requirements.txt").read_text()
    assert '"orjson>=3.10"' in (root / "setup.py").read_text()


class TestEveryClientUsesTheTransport:
    def test_annotation_and_preview_clients(self):
        for cls in (UPennContrastAnnotationClient,
                    UPennContrastWorkerPreviewClient):
            client = cls("http://127.0.0.1:1/api/v1", "tok")
            assert isinstance(client.client, transport.FastJsonGirderClient)
            assert isinstance(client.client._session, requests.Session)
            assert client.client.token == "tok"

    def test_dataset_client(self, fakeGirder):
        folderId, itemId = "f" * 24, "i" * 24
        fakeGirder.route("GET", f"/api/v1/folder/{folderId}",
                         (200, {"_id": folderId, "meta": {}}))
        fakeGirder.route("GET", "/api/v1/item", (200, [
            {"_id": itemId, "folderId": folderId, "largeImage": {}},
        ]))
        fakeGirder.route("GET", f"/api/v1/item/{itemId}/tiles",
                         (200, {"frames": [{"Frame": 0, "IndexC": 0}]}))
        fakeGirder.route("GET", f"/api/v1/item/{itemId}/tiles/"
                         "internal_metadata", (200, {}))

        dataset = UPennContrastDataset(fakeGirder.apiUrl, "tok", folderId)

        assert isinstance(dataset.client, transport.FastJsonGirderClient)
        assert dataset.datasetId == itemId
        assert dataset.coordinatesToFrameIndex(0) == 0
        assert len({r["client"] for r in fakeGirder.requests}) == 1
