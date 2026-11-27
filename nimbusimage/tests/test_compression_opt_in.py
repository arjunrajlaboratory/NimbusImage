"""ni.connect() asks Girder to compress responses with ?compress=zstd;
create_client() alone (workers' WorkerContext) does not, and neither does
connect(compress=False) (the MCP server). Girder compresses only requests
that carry the parameter."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

import nimbusimage as ni
from nimbusimage._girder import create_client


@pytest.fixture
def recording_server():
    """HTTP server that records each request's query parameters."""

    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(parse_qs(urlsplit(self.path).query))
            body = json.dumps({"_id": "u", "login": "x"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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


def test_connect_opts_in_and_keeps_request_params(recording_server):
    seen, api_url = recording_server
    client = ni.connect(api_url, anonymous=True)

    client.girder.get("upenn_annotation", parameters={"datasetId": "d1"})

    assert seen[-1] == {"datasetId": ["d1"], "compress": ["zstd"]}


@pytest.mark.parametrize(
    "make_client",
    [
        lambda url: ni.connect(url, anonymous=True, compress=False).girder,
        lambda url: create_client(url, anonymous=True),
    ],
    ids=["connect(compress=False)", "create_client"],
)
def test_clients_next_to_girder_do_not_opt_in(recording_server, make_client):
    seen, api_url = recording_server

    make_client(api_url).get(
        "upenn_annotation", parameters={"datasetId": "d1"}
    )

    assert seen[-1] == {"datasetId": ["d1"]}
