"""The client identifies itself with a nimbusimage-python/<version> UA.

The production load balancer rate-limits worker-compute submissions from
this User-Agent only (AWSDeploy doc/Worker_Rate_Limiting.md), so every
request, including the API-key token exchange, must carry it.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from nimbusimage._girder import USER_AGENT, create_client


@pytest.fixture
def recording_server():
    """HTTP server that records each request's (method, path, User-Agent)."""

    seen = []

    class Handler(BaseHTTPRequestHandler):
        def _serve(self):
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            seen.append(
                (self.command, self.path, self.headers.get("User-Agent"))
            )
            # Shape of POST /api_key/token, so authenticate() succeeds.
            body = json.dumps(
                {"authToken": {"token": "t" * 64}, "user": {"_id": "u"}}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = _serve

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield seen, f"http://127.0.0.1:{server.server_address[1]}/api/v1"
    finally:
        server.shutdown()
        server.server_close()


def test_user_agent_format():
    assert USER_AGENT.startswith("nimbusimage-python/")
    assert len(USER_AGENT) > len("nimbusimage-python/")


def test_requests_carry_user_agent(recording_server):
    seen, url = recording_server
    gc = create_client(api_url=url, token="x")
    gc.post("upenn_annotation/compute?datasetId=d", json={"image": "i"})
    assert seen == [
        ("POST", "/api/v1/upenn_annotation/compute?datasetId=d", USER_AGENT)
    ]


def test_api_key_token_exchange_carries_user_agent(recording_server):
    seen, url = recording_server
    create_client(api_url=url, api_key="k")
    assert seen, "authenticate() made no request"
    assert all(ua == USER_AGENT for _, _, ua in seen)
