"""Job tracking for worker computations."""

from __future__ import annotations

import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import girder_client

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
        """Fetch latest job status and log from the server."""
        self._data = self._gc.get(f"job/{self._id}")
        try:
            log_resp = self._gc.get(f"job/{self._id}/log")
            if isinstance(log_resp, list):
                self._log = "\n".join(str(entry) for entry in log_resp)
            elif isinstance(log_resp, dict):
                self._log = log_resp.get("log", "")
            else:
                self._log = str(log_resp)
        except Exception:
            pass

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
