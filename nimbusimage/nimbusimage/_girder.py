"""Internal wrapper around girder_client.GirderClient.

This module is an implementation detail. Users should never import from it.
All HTTP communication goes through this wrapper so that endpoint paths
and error handling are centralized.
"""

from __future__ import annotations

import os

import girder_client


def create_client(
    api_url: str | None = None,
    token: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> girder_client.GirderClient:
    """Create and authenticate a GirderClient.

    Connection modes (tried in order):
    1. Explicit token
    2. Username + password
    3. Environment variables NI_API_URL and NI_TOKEN

    Args:
        api_url: Girder API URL (e.g., 'http://localhost:8080/api/v1').
        token: Pre-existing authentication token.
        username: Username for interactive auth.
        password: Password for interactive auth.

    Returns:
        Authenticated GirderClient instance.

    Raises:
        ValueError: If no valid authentication method is provided.
    """
    if api_url is None:
        api_url = os.environ.get("NI_API_URL")
    if api_url is None:
        raise ValueError(
            "api_url must be provided or set NI_API_URL environment variable"
        )

    gc = girder_client.GirderClient(apiUrl=api_url)

    if token is not None:
        gc.setToken(token)
    elif username is not None or password is not None:
        if username is None or password is None:
            raise ValueError("Both username and password must be provided")
        gc.authenticate(username=username, password=password)
    else:
        env_token = os.environ.get("NI_TOKEN")
        if env_token is not None:
            gc.setToken(env_token)
        else:
            raise ValueError(
                "Provide token=, username=/password=, or set NI_TOKEN "
                "environment variable"
            )

    return gc
