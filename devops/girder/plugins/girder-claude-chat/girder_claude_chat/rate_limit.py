import time
from collections import defaultdict, deque
from threading import Lock


class SlidingWindowRateLimiter:
    """Per-key sliding-window request rate limiter.

    Kept in memory: if Girder runs multiple worker processes each keeps
    its own window, so the effective cap is max_requests times the
    process count. Adequate as a backstop; a shared store (Redis/Mongo)
    would be needed for a hard global cap. Stdlib-only so it can be unit
    tested without a Girder environment.
    """

    def __init__(self, max_requests, window_seconds):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        # key -> deque of recent request timestamps (monotonic)
        self._request_times = defaultdict(deque)
        self._lock = Lock()
        # Timestamp of the last full sweep of expired keys, so the map stays
        # proportional to recently-active keys instead of every key ever seen.
        self._last_sweep = None

    def _sweep_expired(self, cutoff):
        """Drop keys whose most recent request predates the window.

        Without this the map grows without bound: a key whose deque never gets
        touched again keeps its stale timestamps forever. Called at most once
        per window from check(), so it stays O(keys) amortized.
        """
        stale = [
            key
            for key, times in self._request_times.items()
            if not times or times[-1] < cutoff
        ]
        for key in stale:
            del self._request_times[key]

    def check(self, key, now=None):
        """Record a request for `key`; return True if it is allowed.

        Returns False (without recording) when the caller already made
        max_requests requests within the trailing window.
        """
        if now is None:
            now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            if (
                self._last_sweep is None
                or now - self._last_sweep >= self.window_seconds
            ):
                self._sweep_expired(cutoff)
                self._last_sweep = now
            times = self._request_times[key]
            while times and times[0] < cutoff:
                times.popleft()
            if len(times) >= self.max_requests:
                return False
            times.append(now)
            return True
