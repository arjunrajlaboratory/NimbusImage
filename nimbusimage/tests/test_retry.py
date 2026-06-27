"""Tests for NIM-006: transient-5xx retry-with-backoff in create_client.

The client mounts a urllib3 Retry adapter so transient 502/503/504
responses are retried with backoff instead of surfacing to the caller,
removing the need for hand-rolled retry loops.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import pytest
from urllib3.util.retry import Retry

from nimbusimage._girder import create_client


class _FlakyHandler(BaseHTTPRequestHandler):
    """Returns a configured sequence of status codes, counting hits.

    Note: the attribute is ``status_codes`` (not ``responses``) because
    ``BaseHTTPRequestHandler.responses`` is the built-in status->message
    map used by ``send_response``.
    """

    status_codes: list[int] = []
    hits = 0

    def _serve(self):
        cls = type(self)
        idx = cls.hits
        cls.hits += 1
        status = cls.status_codes[idx] if idx < len(cls.status_codes) \
            else cls.status_codes[-1]
        body = json.dumps({"ok": True}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _serve
    do_POST = _serve

    def log_message(self, *args):  # silence stderr noise
        pass


@pytest.fixture
def flaky_server():
    """A throwaway HTTP server with a per-test handler subclass."""

    class Handler(_FlakyHandler):
        status_codes: list[int] = []
        hits = 0

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield Handler, f"http://127.0.0.1:{port}/api/v1"
    finally:
        server.shutdown()
        server.server_close()


# Avoid real backoff sleeps; the retry policy is exercised either way.
def _no_sleep(self, response=None):
    return None


class TestRetryConfiguration:
    def test_retry_adapter_mounted_with_5xx_forcelist(self):
        gc = create_client(api_url="https://example.test/api/v1", token="x")
        retry = gc._session.get_adapter("https://example.test/").max_retries
        assert isinstance(retry, Retry)
        assert {502, 503, 504}.issubset(set(retry.status_forcelist))
        assert retry.total and retry.total > 0
        assert retry.backoff_factor and retry.backoff_factor > 0
        assert retry.respect_retry_after_header is True

    def test_retry_adapter_on_both_schemes(self):
        gc = create_client(api_url="http://localhost:8080/api/v1", token="x")
        http_retry = gc._session.get_adapter("http://localhost/").max_retries
        https_retry = gc._session.get_adapter("https://localhost/").max_retries
        assert http_retry.total and http_retry.total > 0
        assert https_retry.total and https_retry.total > 0

    def test_post_not_retried_by_default(self):
        """Retrying POST could duplicate job submissions (NIM-007), so
        only idempotent methods are retried."""
        gc = create_client(api_url="https://example.test/api/v1", token="x")
        retry = gc._session.get_adapter("https://example.test/").max_retries
        assert "POST" not in retry.allowed_methods
        assert "GET" in retry.allowed_methods


class TestRetryBehavior:
    def test_retries_503_then_succeeds(self, flaky_server):
        Handler, api_url = flaky_server
        Handler.status_codes = [503, 503, 200]
        gc = create_client(api_url=api_url, token="x")

        with patch.object(Retry, "sleep", _no_sleep):
            result = gc.get("anything")

        assert result == {"ok": True}
        assert Handler.hits == 3

    def test_no_retry_on_4xx(self, flaky_server):
        from girder_client import HttpError

        Handler, api_url = flaky_server
        Handler.status_codes = [404]
        gc = create_client(api_url=api_url, token="x")

        with patch.object(Retry, "sleep", _no_sleep):
            with pytest.raises(HttpError):
                gc.get("anything")

        assert Handler.hits == 1
