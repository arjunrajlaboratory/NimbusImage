"""ni_property_pairs, ni_image_line_scan, ni_projects_list and
ni_dataset_access with a mocked nimbusimage client."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from mcp.server.mcpserver.exceptions import ToolError

from nimbusimage.images import LineScanResult
from nimbusimage_mcp.tools import analysis


def loads(text: str):
    assert isinstance(text, str)
    return json.loads(text)


@pytest.fixture
def nc(monkeypatch):
    """The caller's client; set every value a test depends on (a
    MagicMock answers anything else with another MagicMock)."""
    fake = MagicMock(name="NimbusClient")
    monkeypatch.setattr(analysis, "client", lambda: fake)
    return fake


def histogram2d_answer(xs, ys, input_count=None, sample_size=None):
    """What upenn_annotation/analysis/histogram2d answers for these
    paired values (its helpers/analysis.py): bin edges over the pairs
    (one bin with edges 0.5 either side for a one-value axis), the
    counts, and a display sample rounded to 4 decimals."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)

    def edges(values):
        low, high = float(values.min()), float(values.max())
        if low == high:
            return [low - 0.5, high + 0.5]
        return np.linspace(low, high, 3).tolist()

    size = len(xs) if sample_size is None else min(sample_size, len(xs))
    return {
        "counts": [[0, 0], [0, 0]],
        "xEdges": edges(xs), "yEdges": edges(ys),
        "xCategories": None, "yCategories": None,
        "inputCount": len(xs) if input_count is None else input_count,
        "plottedCount": len(xs),
        "gateCount": None,
        "sample": {
            "x": np.round(xs[:size], 4).tolist(),
            "y": np.round(ys[:size], 4).tolist(),
            "total": len(xs), "color": None, "colorCategories": None,
        },
    }


# --- ni_property_pairs -------------------------------------------------------


def test_ranks_average_ties():
    assert analysis.ranks(np.array([10.0, 20, 20, 5, 20])).tolist() == [
        2, 4, 4, 1, 4,
    ]


def test_spearman_matches_the_textbook_value():
    # Monotonic but not linear: Spearman is exactly 1, Pearson is not.
    x = np.arange(1.0, 11)
    assert analysis.spearman(x, x ** 3) == pytest.approx(1.0)
    assert analysis.pearson(x, x ** 3) < 0.95
    # A known tied example: rho on the average ranks.
    x = np.array([1.0, 2, 2, 3])
    y = np.array([1.0, 3, 2, 4])
    expected = np.corrcoef([1, 2.5, 2.5, 4], [1, 3, 2, 4])[0, 1]
    assert analysis.spearman(x, y) == pytest.approx(expected)
    # A constant axis has no correlation.
    assert analysis.pearson(np.ones(4), y) is None


def test_pairs_use_one_server_aggregate(nc):
    rng = np.random.default_rng(1)
    xs = rng.normal(100, 10, 2_000)
    ys = 2 * xs + rng.normal(0, 5, 2_000)
    nc.girder.post.return_value = histogram2d_answer(xs, ys, 2_500)
    result = loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p1", "Area"],
        y_property=["p2", "Intensity", "mean"], tags=["cell", "cell"],
        shape="polygon", sample=50, exclusive=True,
    ))
    nc.girder.post.assert_called_once()
    path, = nc.girder.post.call_args.args
    body = nc.girder.post.call_args.kwargs["json"]
    assert path == "upenn_annotation/analysis/histogram2d"
    assert body["datasetId"] == "d"
    assert body["xAxis"] == {"type": "property", "path": ["p1", "Area"]}
    assert body["yAxis"] == {
        "type": "property", "path": ["p2", "Intensity", "mean"]}
    assert body["filters"] == {
        "shape": "polygon",
        "tags": {"values": ["cell"], "exclusive": True},
    }
    assert body["sample"] == {"size": analysis.MAX_CORRELATION_PAIRS}
    # No values are paged through.
    nc.girder.get.assert_not_called()

    assert result["annotations_matching"] == 2_500
    assert result["n_pairs"] == result["n_used"] == 2_000
    assert result["sampled"] is False
    rx, ry = np.round(xs, 4), np.round(ys, 4)
    assert result["pearson_r"] == pytest.approx(
        np.corrcoef(rx, ry)[0, 1], abs=1e-3)
    assert result["spearman_r"] == pytest.approx(
        np.corrcoef(analysis.ranks(rx), analysis.ranks(ry))[0, 1], abs=1e-3)
    assert result["x"]["min"] == pytest.approx(xs.min(), rel=1e-3)
    assert result["x"]["max"] == pytest.approx(xs.max(), rel=1e-3)
    assert result["y"]["median"] == pytest.approx(np.median(ys), rel=1e-3)
    assert len(result["sample"]) == 50
    # Each shown pair is a real pair, and the choice is repeatable.
    pairs = set(zip(rx.tolist(), ry.tolist()))
    for x, y in result["sample"]:
        assert any(abs(x - px) < 0.06 and abs(y - py) < 0.06
                   for px, py in pairs)
    again = loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p1", "Area"],
        y_property=["p2", "Intensity", "mean"], sample=50,
    ))
    assert again["sample"] == result["sample"]


def test_pairs_cap_the_shown_sample_and_say_when_sampled(nc):
    xs = np.arange(5_000, dtype=float)
    answer = histogram2d_answer(xs, xs, sample_size=3_000)
    answer["plottedCount"] = 400_000  # the server sampled the pairs
    nc.girder.post.return_value = answer
    result = loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p", "a"], y_property=["p", "b"],
        sample=10_000,
    ))
    assert len(result["sample"]) == analysis.MAX_PAIR_SAMPLE
    assert result["n_pairs"] == 400_000
    assert result["n_used"] == 3_000
    assert result["sampled"] is True
    # min/max come from the edges over every pair, not the sample.
    assert result["x"]["max"] == 4_999


def test_pairs_report_a_one_value_axis_exactly(nc):
    nc.girder.post.return_value = histogram2d_answer(
        [3.0, 3.0, 3.0], [1.0, 2.0, 4.0])
    result = loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p", "a"], y_property=["p", "b"]))
    assert result["x"] == {"min": 3.0, "max": 3.0, "median": 3.0}
    assert result["pearson_r"] is None and result["spearman_r"] is None
    assert result["y"]["min"] == 1.0 and result["y"]["max"] == 4.0


def test_pairs_note_values_too_small_for_the_server_rounding(nc):
    xs = np.linspace(0.001, 0.003, 50)
    nc.girder.post.return_value = histogram2d_answer(xs, xs * 1000)
    result = loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p", "a"], y_property=["p", "b"]))
    assert "x span less than 0.01" in result["note"]
    nc.girder.post.return_value = histogram2d_answer(xs * 1000, xs * 1000)
    assert "note" not in loads(analysis.ni_property_pairs(
        dataset_id="d", x_property=["p", "a"], y_property=["p", "b"]))


@pytest.mark.parametrize("path", [
    ["p"], [], "p.Area", ["p", "a.b"], ["p", "$x"], ["p", ""], ["p", 3],
])
def test_pairs_refuse_a_malformed_path(nc, path):
    with pytest.raises(ToolError, match="value path"):
        analysis.ni_property_pairs(
            dataset_id="d", x_property=path, y_property=["p", "b"])
    nc.girder.post.assert_not_called()


def test_pairs_say_when_nothing_is_paired(nc):
    nc.girder.post.return_value = {
        "plottedCount": 0, "inputCount": 12, "xEdges": [0, 1],
        "yEdges": [0, 1], "sample": {"x": [], "y": []},
    }
    with pytest.raises(ToolError, match="None of the 12"):
        analysis.ni_property_pairs(
            dataset_id="d", x_property=["p", "a"], y_property=["p", "b"])
    with pytest.raises(ToolError, match="exclusive=true needs tags"):
        analysis.ni_property_pairs(
            dataset_id="d", x_property=["p", "a"], y_property=["p", "b"],
            exclusive=True)


# --- ni_image_line_scan ------------------------------------------------------


def line_dataset(nc, pixel_um=None):
    ds = nc.dataset.return_value
    ds.num_xy, ds.num_z, ds.num_time, ds.num_channels = 1, 3, 1, 2
    ds.dtype = "uint16"
    ds.pixel_size = (
        SimpleNamespace(to=lambda unit: SimpleNamespace(value=pixel_um))
        if pixel_um else None
    )
    return ds


def scan_of(values, length):
    values = np.asarray(values, dtype=float)
    distances = np.linspace(0, length, len(values))
    points = np.column_stack([distances + 10, np.full(len(values), 20.0)])
    return LineScanResult(distances=distances, values=values, points=points)


def test_line_scan_profile_and_peak(nc):
    ds = line_dataset(nc, pixel_um=0.5)
    values = np.full(1_001, 100.0)
    values[[300, 700]] = 4_000.0  # two equal peaks
    ds.images.line_scan.return_value = scan_of(values, 1_000)
    result = loads(analysis.ni_image_line_scan(
        dataset_id="d", channel=1, start=(10, 20), end=(1010, 20), z=2,
        samples=10_000,
    ))
    kwargs = ds.images.line_scan.call_args.kwargs
    assert ds.images.line_scan.call_args.args[0] == [
        (10.0, 20.0), (1010.0, 20.0)]
    assert kwargs["channel"] == 1 and kwargs["z"] == 2
    # A long thin line is read at full resolution.
    assert kwargs["max_region_dim"] >= 1_000
    assert "note" not in result
    assert result["length_px"] == 1_000
    assert result["length_um"] == 500
    assert result["max"] == 4_000 and result["min"] == 100
    assert result["mean"] == pytest.approx(values.mean(), rel=1e-3)
    assert [p["distance_px"] for p in result["max_at"]] == [300, 700]
    assert result["max_at"][0]["x"] == 310
    assert len(result["profile"]) == analysis.MAX_LINE_SAMPLES
    assert result["profile"][0] == [0, 100]
    assert result["profile"][-1][0] == 1_000
    assert result["dtype"] == "uint16"


def test_line_scan_off_image_samples_are_null(nc):
    ds = line_dataset(nc)
    ds.images.line_scan.return_value = scan_of(
        [np.nan, np.nan, 5.0, 7.0, 6.0], 4)
    result = loads(analysis.ni_image_line_scan(
        dataset_id="d", channel=0, start=(0, 0), end=(4, 0), samples=5))
    assert result["profile"] == [[0, None], [1, None], [2, 5], [3, 7],
                                 [4, 6]]
    assert result["samples_off_image"] == 2
    assert result["length_um"] is None and result["pixel_size_um"] is None
    assert result["mean"] == 6
    ds.images.line_scan.return_value = scan_of([np.nan, np.nan], 4)
    with pytest.raises(ToolError, match="outside the image"):
        analysis.ni_image_line_scan(
            dataset_id="d", channel=0, start=(0, 0), end=(4, 0))


def test_line_scan_bounds_the_region_it_reads(nc):
    ds = line_dataset(nc)
    ds.images.line_scan.return_value = scan_of([1.0, 2.0], 1)
    result = loads(analysis.ni_image_line_scan(
        dataset_id="d", channel=0, start=(0, 0), end=(10_000, 10_000)))
    dim = ds.images.line_scan.call_args.kwargs["max_region_dim"]
    assert dim * dim <= analysis.MAX_LINE_REGION_PIXELS * 1.01
    assert "downsampled" in result["note"]


@pytest.mark.parametrize("arguments, fragment", [
    ({"channel": 2}, "channel=2"),
    ({"channel": 0, "z": 3}, "z=3"),
    ({"channel": 0, "start": (1, 2, 3)}, r"\(x, y\)"),
])
def test_line_scan_checks_its_input_before_reading(nc, arguments,
                                                   fragment):
    ds = line_dataset(nc)
    with pytest.raises(ToolError, match=fragment):
        analysis.ni_image_line_scan(**{
            "dataset_id": "d", "start": (0, 0), "end": (5, 5), **arguments,
        })
    ds.images.line_scan.assert_not_called()


# --- ni_projects_list --------------------------------------------------------


def test_projects_list(nc):
    nc.list_projects.return_value = [
        {"_id": "pr1", "name": "Paper", "description": "word " * 100,
         "meta": {"status": "exported",
                  "datasets": [{"datasetId": "d1"}, {"datasetId": "d2"}],
                  "collections": [{"collectionId": "c1"}]}},
        {"_id": "pr2", "name": "New"},
        {"_id": "pr3", "name": "Third", "meta": {}},
    ]
    result = loads(analysis.ni_projects_list(limit=2))
    assert result["total"] == 3 and result["returned"] == 2
    first, second = result["projects"]
    assert first["dataset_count"] == 2
    assert first["configuration_count"] == 1
    assert first["status"] == "exported"
    assert len(first["description"]) <= analysis.MAX_DESCRIPTION
    assert first["description"].endswith("…")
    assert second == {"id": "pr2", "name": "New", "description": "",
                      "dataset_count": 0, "configuration_count": 0,
                      "status": "draft"}


# --- ni_dataset_access -------------------------------------------------------


def test_dataset_access_names_people_without_emails(nc):
    nc.dataset.return_value.sharing.get_access.return_value = {
        "datasetId": "d", "public": True, "currentUserLevel": 2,
        "users": [
            {"id": "u1", "login": "ann", "name": "Ann A",
             "email": "ann@example.org", "level": 2},
            {"id": "u2", "login": "bob", "name": "Bob B",
             "email": "bob@example.org", "level": 0},
        ],
        "groups": [{"id": "g1", "name": "Lab", "level": 1}],
        "configurations": [
            {"id": "c1", "name": "Config", "public": False,
             "currentUserLevel": 2},
        ],
        "writableViewIds": ["v1"],
    }
    result = loads(analysis.ni_dataset_access(dataset_id="d"))
    assert "@" not in json.dumps(result)
    assert result == {
        "dataset_id": "d", "public": True, "your_level": "admin",
        "users": [{"login": "ann", "name": "Ann A", "level": "admin"},
                  {"login": "bob", "name": "Bob B", "level": "read"}],
        "groups": [{"id": "g1", "name": "Lab", "level": "write"}],
        "configurations": [{"id": "c1", "name": "Config",
                            "public": False}],
    }


def test_every_analysis_tool_is_read_only():
    assert [fn.__name__ for fn, _ in analysis.TOOLS] == [
        "ni_property_pairs", "ni_image_line_scan", "ni_projects_list",
        "ni_dataset_access",
    ]
    for _, hints in analysis.TOOLS:
        assert hints.read_only_hint is True
