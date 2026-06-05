"""Tests for worker-request rate limit handling (HTTP 429)."""

from unittest.mock import MagicMock

import girder_client
import pytest

from nimbusimage._girder import _parse_retry_after, submit_worker_job
from nimbusimage.annotations import AnnotationAccessor
from nimbusimage.exceptions import WorkerRateLimitError


def _http_error(status, retry_after=None):
    response = MagicMock()
    response.headers = {} if retry_after is None else {
        "Retry-After": str(retry_after)
    }
    return girder_client.HttpError(
        status=status, text="", url="u", method="POST", response=response
    )


class TestParseRetryAfter:
    def test_parses_integer_seconds(self):
        resp = MagicMock()
        resp.headers = {"Retry-After": "300"}
        assert _parse_retry_after(resp) == 300

    def test_missing_header_returns_none(self):
        resp = MagicMock()
        resp.headers = {}
        assert _parse_retry_after(resp) is None

    def test_non_integer_header_returns_none(self):
        # HTTP-date form of Retry-After is not parsed; we just skip it.
        resp = MagicMock()
        resp.headers = {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}
        assert _parse_retry_after(resp) is None


class TestSubmitWorkerJob:
    def test_returns_job_dict_on_success(self, mock_gc):
        mock_gc.post.return_value = {"_id": "job_1"}
        assert submit_worker_job(mock_gc, "/x/compute", {}) == {"_id": "job_1"}

    def test_unwraps_single_element_list(self, mock_gc):
        mock_gc.post.return_value = [{"_id": "job_1"}]
        assert submit_worker_job(mock_gc, "/x/compute", {}) == {"_id": "job_1"}

    def test_429_raises_rate_limit_error_with_retry_after(self, mock_gc):
        mock_gc.post.side_effect = _http_error(429, retry_after=300)
        with pytest.raises(WorkerRateLimitError) as excinfo:
            submit_worker_job(mock_gc, "/x/compute", {})
        assert excinfo.value.retry_after == 300

    def test_429_without_retry_after_header(self, mock_gc):
        mock_gc.post.side_effect = _http_error(429)
        with pytest.raises(WorkerRateLimitError) as excinfo:
            submit_worker_job(mock_gc, "/x/compute", {})
        assert excinfo.value.retry_after is None

    def test_other_http_errors_propagate(self, mock_gc):
        mock_gc.post.side_effect = _http_error(500)
        with pytest.raises(girder_client.HttpError):
            submit_worker_job(mock_gc, "/x/compute", {})


class TestComputeRateLimit:
    def test_annotation_compute_translates_429(self, mock_gc):
        mock_gc.post.side_effect = _http_error(429, retry_after=300)
        accessor = AnnotationAccessor(mock_gc, "ds_001")
        with pytest.raises(WorkerRateLimitError):
            accessor.compute(image="annotations/random_squares:latest")
