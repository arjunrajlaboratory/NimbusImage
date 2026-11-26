"""Plain-HTTP MCP calls, so tests go through the auth middleware (the
SDK's in-memory client skips it)."""

from __future__ import annotations

import json

import httpx

HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def rpc(base_url: str, method: str, params: dict | None = None,
        key: str | None = None, headers: dict | None = None
        ) -> httpx.Response:
    all_headers = dict(HEADERS)
    if key is not None:
        all_headers["Authorization"] = f"Bearer {key}"
    all_headers.update(headers or {})
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return httpx.post(
        f"{base_url}/mcp", headers=all_headers, json=body, timeout=120
    )


def call_tool(base_url: str, key: str, name: str, arguments: dict):
    """A tool's decoded JSON result; raises AssertionError on a tool
    error."""
    response = rpc(base_url, "tools/call",
                   {"name": name, "arguments": arguments}, key=key)
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    text = result["content"][0].get("text", "")
    assert not result.get("isError"), text
    return json.loads(text)
