"""Public exception types for the NimbusImage API."""

from __future__ import annotations


class NimbusError(Exception):
    """Base class for nimbusimage-specific errors."""


class WorkerRateLimitError(NimbusError):
    """Raised when the server rejects a worker request for rate limiting.

    NimbusImage runs GPU workers that are started on demand and take
    several minutes to spin up. To keep the job queue from being flooded,
    the deployment rate-limits worker-compute submissions (e.g.
    ``ds.annotations.compute()`` / ``ds.properties.compute()``) on a
    per-user basis. When the limit is hit the server responds with HTTP
    429 and this exception is raised.

    The :attr:`retry_after` attribute holds the number of seconds the
    server asked the client to wait before retrying (parsed from the
    ``Retry-After`` response header), or ``None`` if it was not provided.

    Worker jobs already process whole assignment ranges in one call, so
    prefer submitting a single job over a wide range rather than looping
    over many small ``compute()`` calls. If you do need to retry, back off
    for at least :attr:`retry_after` seconds.
    """

    def __init__(
        self,
        retry_after: int | None = None,
        message: str | None = None,
    ):
        self.retry_after = retry_after
        if message is None:
            wait = (
                f"Retry after {retry_after} seconds."
                if retry_after is not None
                else "Retry after a short wait."
            )
            message = (
                "Worker request rate limited by the server. GPU workers "
                "take several minutes to start, so worker jobs are "
                "throttled per user. Submit fewer, larger jobs (batch "
                f"assignments into a single compute call). {wait}"
            )
        super().__init__(message)
