"""Job tracking for worker computations."""

from __future__ import annotations

import sys
import time

import girder_client

# GET job/{id} is @access.public with no declared scope, so Girder
# authenticates the caller only if the key carries core.user_auth. That scope
# is what "Allow all actions on behalf of my user" grants; it is not one of
# the checkboxes in Girder's API key dialog, so a custom-scoped key (e.g.
# core.data.read/write) can submit jobs but never poll them, and gets a 401
# whose raw message misattributes the cause (NIM-005).
_JOB_SCOPE_HINT = (
    "Could not read job status (HTTP 401). Your API key is most likely a "
    "custom-scoped key (e.g. only 'Read data'/'Write data'), which can "
    "submit jobs but cannot poll their status. The job itself is not "
    "affected and may still be running. To watch jobs, use a full-access "
    "key ('Allow all actions on behalf of my user'). Meanwhile you can "
    "confirm the job ran by checking for its output annotations or "
    "property values. See the nimbusimage README (Authentication)."
)

# Girder job status codes
STATUS_INACTIVE = 0
STATUS_QUEUED = 1
STATUS_RUNNING = 2
STATUS_SUCCESS = 3
STATUS_ERROR = 4
STATUS_CANCELLED = 5

_STATUS_NAMES = {
    STATUS_INACTIVE: "inactive",
    STATUS_QUEUED: "queued",
    STATUS_RUNNING: "running",
    STATUS_SUCCESS: "success",
    STATUS_ERROR: "error",
    STATUS_CANCELLED: "cancelled",
}

_TERMINAL = {STATUS_SUCCESS, STATUS_ERROR, STATUS_CANCELLED}


class Job:
    """A running or completed worker job.

    Tracks a Girder Worker job by polling its status. Use ``wait()``
    to block until the job finishes, optionally printing progress.
    """

    def __init__(self, gc: girder_client.GirderClient, job_data: dict):
        self._gc = gc
        self._id = job_data["_id"]
        self._data = job_data
        self._log: str = ""

    @property
    def id(self) -> str:
        """The Girder job ID."""
        return self._id

    @property
    def status(self) -> int:
        """Current status code. Call refresh() to update."""
        return self._data.get("status", STATUS_INACTIVE)

    @property
    def status_name(self) -> str:
        """Human-readable status name."""
        return _STATUS_NAMES.get(self.status, f"unknown({self.status})")

    @property
    def title(self) -> str:
        return self._data.get("title", "")

    @property
    def log(self) -> str:
        """Full job log text."""
        return self._log

    @property
    def finished(self) -> bool:
        return self.status in _TERMINAL

    @property
    def succeeded(self) -> bool:
        return self.status == STATUS_SUCCESS

    def refresh(self) -> None:
        """Fetch the latest job status and log from the server.

        Raises:
            PermissionError: If the job-status request returns 401, which
                almost always means a custom-scoped API key rather than a
                full-access one (NIM-005). The job itself is unaffected.
        """
        try:
            self._data = self._gc.get(f"job/{self._id}")
        except girder_client.HttpError as exc:
            if getattr(exc, "status", None) == 401:
                raise PermissionError(_JOB_SCOPE_HINT) from exc
            raise
        # The log comes back inside the job document; girder_jobs has no
        # separate job/{id}/log route.
        log = self._data.get("log") or []
        self._log = "".join(log) if isinstance(log, list) else str(log)

    def wait(
        self,
        poll_interval: float = 2.0,
        timeout: float | None = None,
        verbose: bool = True,
    ) -> bool:
        """Block until the job finishes.

        Args:
            poll_interval: Seconds between status polls.
            timeout: Max seconds to wait. None = no limit.
            verbose: If True, print status updates to stderr.

        Returns:
            True if the job succeeded, False otherwise.

        Raises:
            TimeoutError: If timeout is reached before the job finishes.
            PermissionError: If polling returns 401, usually because the
                API key is custom-scoped rather than full-access (NIM-005).
                Raised via :meth:`refresh`.
        """
        start = time.monotonic()
        last_log_len = 0

        while True:
            self.refresh()

            if verbose:
                # Print any new log lines
                if len(self._log) > last_log_len:
                    new_text = self._log[last_log_len:]
                    print(new_text, end="", file=sys.stderr, flush=True)
                    last_log_len = len(self._log)

            if self.finished:
                if verbose:
                    print(
                        f"\nJob {self.status_name}: {self.title}",
                        file=sys.stderr,
                        flush=True,
                    )
                return self.succeeded

            if timeout is not None:
                elapsed = time.monotonic() - start
                if elapsed >= timeout:
                    raise TimeoutError(
                        f"Job {self._id} did not finish within "
                        f"{timeout}s (status: {self.status_name})"
                    )

            time.sleep(poll_interval)
