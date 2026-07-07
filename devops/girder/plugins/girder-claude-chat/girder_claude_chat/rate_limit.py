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

    def check(self, key, now=None):
        """Record a request for `key`; return True if it is allowed.

        Returns False (without recording) when the caller already made
        max_requests requests within the trailing window.
        """
        if now is None:
            now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            times = self._request_times[key]
            while times and times[0] < cutoff:
                times.popleft()
            if len(times) >= self.max_requests:
                return False
            times.append(now)
            return True
