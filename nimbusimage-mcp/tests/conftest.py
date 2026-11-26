"""Shared fixtures: a fake nimbusimage client for tool tests, and a real
HTTP server (uvicorn in a thread) for auth tests.

Run from nimbusimage-mcp/ (not the repo root, whose nimbusimage/ folder
would shadow the installed package):
    .venv/bin/python -m pytest -m "not integration"
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

import girder_client
import pytest
import requests
import uvicorn

from nimbusimage_mcp import _common
from nimbusimage_mcp.config import Settings
from nimbusimage_mcp.server import build_app
from nimbusimage_mcp.tools import (
    annotations,
    datasets,
    help,
    images,
    properties,
    workers,
)

TOOL_MODULES = [annotations, datasets, help, images, properties, workers]


def make_settings(**overrides) -> Settings:
    values = dict(
        api_url="http://girder.test/api/v1",
        public_url="http://127.0.0.1:8000/mcp",
        issuer_url="http://girder.test",
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture(autouse=True)
def configured():
    # Settings are process-global (one server per process in real use);
    # each test sets its own and puts the previous ones back.
    previous = _common._settings
    _common.configure(make_settings())
    yield
    _common.configure(previous)


@pytest.fixture
def nc(monkeypatch):
    """A MagicMock standing in for the caller's nimbusimage client.

    MagicMock returns MagicMocks for anything not set, which silently
    satisfies code under test; set every value a test depends on.
    """
    fake = MagicMock(name="NimbusClient")
    for module in TOOL_MODULES:
        monkeypatch.setattr(module, "client", lambda: fake)
    return fake


@contextmanager
def serve(app):
    """Run an ASGI app on a free localhost port; yield its base URL."""
    config = uvicorn.Config(
        app, host="127.0.0.1", port=0, log_level="warning", lifespan="on"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("test server did not start")
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


# --- The local compose stack, for tests marked integration -------------

REPO = Path(__file__).resolve().parents[2]


class LiveStack:
    """Real Girder plus this server in front of it.

    Users: the site admin from tmp/login_credentials.txt (line 1 login,
    line 2 password) and a throwaway non-admin user created for the run
    and deleted after it. Each gets a full-access API key for the run.
    """

    def __init__(self, api_url: str, login: str, password: str):
        self.api_url = api_url
        self.admin = girder_client.GirderClient(apiUrl=api_url)
        self.admin.authenticate(login, password)
        self._key_ids: list[tuple[girder_client.GirderClient, str]] = []
        self.admin_key, _ = self._make_key(self.admin)
        suffix = uuid.uuid4().hex[:10]
        user_password = uuid.uuid4().hex
        self.user = self.admin.post("user", parameters={
            "login": f"mcptest{suffix}", "email": f"mcptest{suffix}@x.test",
            "firstName": "MCP", "lastName": "Test",
            "password": user_password,
        })
        self.user_id = self.user["_id"]
        self.user_gc = girder_client.GirderClient(apiUrl=api_url)
        self.user_gc.authenticate(f"mcptest{suffix}", user_password)
        self.user_key, _ = self._make_key(self.user_gc)
        self.url: str | None = None
        self.settings: Settings | None = None

    def _make_key(self, gc) -> tuple[str, str]:
        doc = gc.post("api_key", parameters={
            "name": f"mcp-test-{uuid.uuid4().hex[:6]}", "active": "true",
        })
        self._key_ids.append((gc, doc["_id"]))
        return doc["key"], doc["_id"]

    def new_api_key(self) -> tuple[str, str]:
        return self._make_key(self.user_gc)

    def delete_api_key(self, key_id: str) -> None:
        self.user_gc.delete(f"api_key/{key_id}")

    def token_count(self, user_id: str) -> int:
        container = os.environ.get(
            "NI_TEST_MONGO_CONTAINER", "nimbusimage-mongodb-1"
        )
        out = subprocess.run(
            ["docker", "exec", container, "mongosh", "girder", "--quiet",
             "--eval",
             f'db.token.countDocuments({{userId: ObjectId("{user_id}")}})'],
            check=True, capture_output=True, text=True,
        )
        return int(out.stdout.strip())

    def close(self) -> None:
        for gc, key_id in self._key_ids:
            try:
                gc.delete(f"api_key/{key_id}")
            except girder_client.HttpError:
                pass  # already deleted by a test
        self.admin.delete(f"user/{self.user_id}")


@pytest.fixture(scope="session")
def live_stack():
    api_url = os.environ.get("NI_TEST_API_URL", "http://localhost:8080/api/v1")
    credentials = REPO / "tmp" / "login_credentials.txt"
    if not credentials.exists():
        pytest.skip(f"no admin credentials at {credentials}")
    login, password = credentials.read_text().splitlines()[:2]
    try:
        stack = LiveStack(api_url, login.strip(), password.strip())
    except requests.ConnectionError:
        pytest.skip(f"no Girder at {api_url}")
    stack.settings = make_settings(api_url=api_url)
    try:
        with serve(build_app(stack.settings)) as url:
            stack.url = url
            yield stack
    finally:
        stack.close()


@pytest.fixture
def live(live_stack):
    # Runs after the autouse fixture, so the live server's tools reach
    # the real Girder for this test.
    _common.configure(live_stack.settings)
    return live_stack
