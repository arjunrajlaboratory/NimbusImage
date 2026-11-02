import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


class FakeGirder:
    """Routes for a throwaway HTTP server, plus a record of what it got.

    ``routes`` maps "METHOD /path" (no query string) to a list of
    (status, body bytes) responses served in order; the last one repeats.
    """

    def __init__(self):
        self.routes = {}
        self.requests = []

    def route(self, method, path, *responses):
        self.routes[f"{method} {path}"] = [
            (status, body if isinstance(body, bytes) else
             json.dumps(body).encode())
            for status, body in responses
        ]


@pytest.fixture
def fakeGirder():
    fake = FakeGirder()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"  # keep-alive, like Girder

        def _serve(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            # The client's PATHS start with "/", so URLs carry "v1//...",
            # which Girder tolerates.
            path = self.path.split("?")[0].replace("//", "/")
            fake.requests.append({
                "method": self.command,
                "path": path,
                "query": self.path.partition("?")[2],
                "headers": dict(self.headers),
                "body": body,
                "client": self.client_address,
            })
            responses = fake.routes.get(f"{self.command} {path}")
            if responses is None:
                status, payload = 404, b'{"message": "no route"}'
            else:
                status, payload = (
                    responses.pop(0) if len(responses) > 1 else responses[0]
                )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = do_DELETE = _serve

        def log_message(self, *args):
            pass

    # Threaded: pooled keep-alive connections stay open between requests.
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01},
        daemon=True,
    )
    thread.start()
    fake.apiUrl = f"http://127.0.0.1:{server.server_address[1]}/api/v1"
    yield fake
    server.shutdown()
    server.server_close()
