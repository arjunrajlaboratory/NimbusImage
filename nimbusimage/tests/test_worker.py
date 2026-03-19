"""Tests for WorkerContext."""

import json
from unittest.mock import MagicMock, patch

from nimbusimage.worker import WorkerContext


def _make_params(**overrides):
    """Create a typical worker params dict."""
    params = {
        "configurationId": "cfg_001",
        "datasetId": "ds_001",
        "tile": {"XY": 0, "Z": 0, "Time": 0},
        "channel": 1,
        "assignment": {"XY": 0, "Z": 0, "Time": 0},
        "tags": ["nucleus", "cell"],
        "workerInterface": {"Channel": 0, "Diameter": 10},
        "scales": {"pixelSize": {"unit": "mm", "value": 0.000219}},
        "connectTo": {"tags": ["cell"], "channel": 0},
    }
    params.update(overrides)
    return params


class TestWorkerContextParsing:
    def test_basic_attributes(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_gc = MagicMock()
            mock_create.return_value = mock_gc

            ctx = WorkerContext(
                dataset_id="ds_001",
                api_url="http://localhost:8080/api/v1",
                token="tok",
                params=_make_params(),
            )

            assert ctx.channel == 1
            assert ctx.interface == {"Channel": 0, "Diameter": 10}
            assert ctx.scales["pixelSize"]["value"] == 0.000219

    def test_tags_normalized_from_list(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(tags=["a", "b"]),
            )
            assert ctx.tags == ["a", "b"]
            assert ctx.exclusive_tags is False

    def test_tags_normalized_from_dict(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    tags={"tags": ["x", "y"], "exclusive": True}
                ),
            )
            assert ctx.tags == ["x", "y"]
            assert ctx.exclusive_tags is True

    def test_tile_location(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(tile={"XY": 1, "Z": 2, "Time": 3}),
            )
            assert ctx.tile.xy == 1
            assert ctx.tile.z == 2
            assert ctx.tile.time == 3

    def test_connect_to(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            assert ctx.connect_to == {"tags": ["cell"], "channel": 0}

    def test_connect_to_none_when_absent(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            params = _make_params()
            del params["connectTo"]
            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=params,
            )
            assert ctx.connect_to is None


class TestWorkerContextMessaging:
    def test_progress(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.progress(0.5, "Processing", "Frame 50/100")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["progress"] == 0.5
            assert msg["title"] == "Processing"

    def test_warning(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.warning("No objects found")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["warning"] == "No objects found"

    def test_error(self, capsys):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(),
            )
            ctx.error("Model failed")

            captured = capsys.readouterr()
            msg = json.loads(captured.out.strip())
            assert msg["error"] == "Model failed"


class TestWorkerContextBatchLocations:
    def test_single_location(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    assignment={"XY": 0, "Z": 0, "Time": 0}
                ),
            )
            locs = list(ctx.batch_locations())
            assert len(locs) == 1
            assert locs[0].xy == 0

    def test_range_assignment(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_create.return_value = MagicMock()

            ctx = WorkerContext(
                dataset_id="ds_001", api_url="url", token="tok",
                params=_make_params(
                    assignment={"XY": "0-2", "Z": 0, "Time": 0}
                ),
            )
            locs = list(ctx.batch_locations())
            assert len(locs) == 3
            assert [loc.xy for loc in locs] == [0, 1, 2]


class TestWorkerContextSetInterface:
    def test_set_interface(self):
        with patch("nimbusimage.worker.create_client") as mock_create:
            mock_gc = MagicMock()
            mock_create.return_value = mock_gc

            ctx = WorkerContext(api_url="url", token="tok", params={})
            ctx.set_interface("myimage:latest", {
                "Channel": {"type": "channel", "required": True},
            })
            mock_gc.post.assert_called_once()
