"""Tests for Job tracking."""

from unittest.mock import MagicMock, patch

import pytest

from nimbusimage.jobs import (
    Job,
    STATUS_INACTIVE,
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_SUCCESS,
    STATUS_ERROR,
    STATUS_CANCELLED,
)


class TestJobProperties:
    def test_id(self):
        gc = MagicMock()
        job = Job(gc, {"_id": "job_001", "status": 2, "title": "Test"})
        assert job.id == "job_001"

    def test_status(self):
        gc = MagicMock()
        job = Job(gc, {"_id": "j1", "status": STATUS_RUNNING})
        assert job.status == STATUS_RUNNING
        assert job.status_name == "running"
        assert not job.finished
        assert not job.succeeded

    def test_finished_success(self):
        gc = MagicMock()
        job = Job(gc, {"_id": "j1", "status": STATUS_SUCCESS})
        assert job.finished
        assert job.succeeded

    def test_finished_error(self):
        gc = MagicMock()
        job = Job(gc, {"_id": "j1", "status": STATUS_ERROR})
        assert job.finished
        assert not job.succeeded

    def test_finished_cancelled(self):
        gc = MagicMock()
        job = Job(gc, {"_id": "j1", "status": STATUS_CANCELLED})
        assert job.finished
        assert not job.succeeded


class TestJobRefresh:
    def test_refresh_updates_status(self):
        gc = MagicMock()
        gc.get.side_effect = [
            {"_id": "j1", "status": STATUS_SUCCESS, "title": "Done"},
            [],  # log response
        ]
        job = Job(gc, {"_id": "j1", "status": STATUS_RUNNING})
        job.refresh()
        assert job.status == STATUS_SUCCESS

    def test_refresh_fetches_log(self):
        gc = MagicMock()
        gc.get.side_effect = [
            {"_id": "j1", "status": STATUS_SUCCESS},
            ["line 1", "line 2"],
        ]
        job = Job(gc, {"_id": "j1", "status": STATUS_RUNNING})
        job.refresh()
        assert "line 1" in job.log
        assert "line 2" in job.log


class TestJobWait:
    def test_wait_returns_true_on_success(self):
        gc = MagicMock()
        gc.get.side_effect = [
            {"_id": "j1", "status": STATUS_SUCCESS},
            [],
        ]
        job = Job(gc, {"_id": "j1", "status": STATUS_SUCCESS})
        assert job.wait(verbose=False) is True

    def test_wait_returns_false_on_error(self):
        gc = MagicMock()
        gc.get.side_effect = [
            {"_id": "j1", "status": STATUS_ERROR},
            [],
        ]
        job = Job(gc, {"_id": "j1", "status": STATUS_ERROR})
        assert job.wait(verbose=False) is False

    @patch("nimbusimage.jobs.time.sleep")
    def test_wait_polls_until_done(self, mock_sleep):
        gc = MagicMock()
        gc.get.side_effect = [
            # First poll: running
            {"_id": "j1", "status": STATUS_RUNNING},
            [],
            # Second poll: success
            {"_id": "j1", "status": STATUS_SUCCESS},
            [],
        ]
        job = Job(gc, {"_id": "j1", "status": STATUS_RUNNING})
        result = job.wait(poll_interval=1.0, verbose=False)
        assert result is True
        mock_sleep.assert_called_once_with(1.0)

    @patch("nimbusimage.jobs.time.sleep")
    @patch("nimbusimage.jobs.time.monotonic")
    def test_wait_timeout(self, mock_monotonic, mock_sleep):
        gc = MagicMock()
        gc.get.side_effect = [
            {"_id": "j1", "status": STATUS_RUNNING},
            [],
        ] * 10  # keep returning running
        mock_monotonic.side_effect = [0.0, 0.0, 11.0]  # start, check, timeout

        job = Job(gc, {"_id": "j1", "status": STATUS_RUNNING})
        with pytest.raises(TimeoutError, match="did not finish"):
            job.wait(timeout=10.0, verbose=False)


class TestAnnotationCompute:
    def test_compute_returns_job(self, mock_gc):
        mock_gc.post.return_value = [
            {"_id": "job_123", "status": 1, "title": "worker"}
        ]

        from nimbusimage.annotations import AnnotationAccessor
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        job = accessor.compute(
            image="myworker:latest",
            channel=0,
            tags=["nucleus"],
        )
        assert isinstance(job, Job)
        assert job.id == "job_123"

        # Verify the POST body
        call_args = mock_gc.post.call_args
        assert "compute" in call_args[0][0]
        body = call_args[1]["json"]
        assert body["image"] == "myworker:latest"
        assert body["channel"] == 0
        assert body["tags"] == ["nucleus"]
        assert body["datasetId"] == "ds_001"

    def test_compute_with_connect_to(self, mock_gc):
        mock_gc.post.return_value = [
            {"_id": "job_123", "status": 1}
        ]

        from nimbusimage.annotations import AnnotationAccessor
        accessor = AnnotationAccessor(mock_gc, "ds_001")

        job = accessor.compute(
            image="myworker:latest",
            connect_to={"tags": ["cell"], "channel": 0},
        )
        body = mock_gc.post.call_args[1]["json"]
        assert body["connectTo"] == {"tags": ["cell"], "channel": 0}


class TestPropertyCompute:
    def test_compute_returns_job(self, mock_gc):
        mock_gc.post.return_value = [
            {"_id": "job_456", "status": 1, "title": "prop_worker"}
        ]

        from nimbusimage.properties import PropertyAccessor
        from nimbusimage.models import Property
        accessor = PropertyAccessor(mock_gc, "ds_001")

        prop = Property(
            id="prop_001",
            name="Area",
            shape="polygon",
            image="properties/area:latest",
            tags={"exclusive": False, "tags": ["nucleus"]},
            worker_interface={"Channel": 0},
        )

        job = accessor.compute(prop)
        assert isinstance(job, Job)
        assert job.id == "job_456"

        call_url = mock_gc.post.call_args[0][0]
        assert "prop_001" in call_url
        assert "ds_001" in call_url

    def test_compute_with_overrides(self, mock_gc):
        mock_gc.post.return_value = [
            {"_id": "job_456", "status": 1}
        ]

        from nimbusimage.properties import PropertyAccessor
        from nimbusimage.models import Property
        accessor = PropertyAccessor(mock_gc, "ds_001")

        prop = Property(
            id="prop_001", name="Area", shape="polygon",
            image="properties/area:latest",
            tags={"exclusive": False, "tags": []},
            worker_interface={"Channel": 0},
        )

        job = accessor.compute(
            prop,
            worker_interface={"Channel": 1},
            scales={"pixelSize": {"unit": "mm", "value": 0.000219}},
        )
        body = mock_gc.post.call_args[1]["json"]
        assert body["workerInterface"] == {"Channel": 1}
        assert body["scales"]["pixelSize"]["value"] == 0.000219


class TestClientWorkers:
    def test_list_workers(self, mock_gc):
        mock_gc.get.return_value = {
            "myworker:latest": {
                "isUPennContrastWorker": "true",
                "isAnnotationWorker": "true",
            }
        }

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc

        workers = client.list_workers()
        assert "myworker:latest" in workers
        mock_gc.get.assert_called_with("/worker_interface/available")

    def test_get_worker_interface_cached(self, mock_gc):
        mock_gc.get.return_value = {
            "interface": {"Channel": {"type": "channel"}}
        }

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc

        iface = client.get_worker_interface(
            "myworker:latest", request_if_missing=False
        )
        assert iface == {"Channel": {"type": "channel"}}

    def test_get_worker_interface_missing_no_request(self, mock_gc):
        mock_gc.get.return_value = {}

        from nimbusimage.client import NimbusClient
        client = NimbusClient.__new__(NimbusClient)
        client._gc = mock_gc

        iface = client.get_worker_interface(
            "myworker:latest", request_if_missing=False
        )
        assert iface is None
