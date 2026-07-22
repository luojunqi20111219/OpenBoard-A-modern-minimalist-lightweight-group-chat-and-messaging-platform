import time
from collections import deque
from threading import Lock

try:
    import bleach
except ImportError:
    bleach = None


def sanitize_plain_text(value: str, max_length: int) -> str:
    value = (value or "").strip()
    if bleach:
        value = bleach.clean(value, tags=[], strip=True).strip()
    else:
        value = value.replace("<", "").replace(">", "")
    return value[:max_length]


class LoginRateLimiter:
    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: int = 300,
        lock_seconds: int = 900,
        max_keys: int = 10000,
    ):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.lock_seconds = lock_seconds
        self.max_keys = max_keys
        self._failures = {}
        self._blocked_until = {}
        self._lock = Lock()

    def retry_after(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            blocked_until = self._blocked_until.get(key, 0)
            if blocked_until <= now:
                self._blocked_until.pop(key, None)
                return 0
            return max(1, int(blocked_until - now))

    def record_failure(self, key: str) -> int:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            if key not in self._failures:
                if len(self._failures) >= self.max_keys:
                    for old_key in list(self._failures)[:100]:
                        old_failures = self._failures.get(old_key)
                        if not old_failures or old_failures[-1] < cutoff:
                            self._failures.pop(old_key, None)
                while len(self._failures) >= self.max_keys:
                    self._failures.pop(next(iter(self._failures)))
                self._failures[key] = deque()
            failures = self._failures[key]
            while failures and failures[0] < cutoff:
                failures.popleft()
            failures.append(now)
            if len(failures) >= self.max_failures:
                if len(self._blocked_until) >= self.max_keys:
                    self._blocked_until.pop(next(iter(self._blocked_until)))
                self._blocked_until[key] = now + self.lock_seconds
                failures.clear()
                return self.lock_seconds
            return 0

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)
            self._blocked_until.pop(key, None)


def client_ip(request) -> str:
    peer = request.client.host if request.client else "unknown"
    if peer in {"127.0.0.1", "::1"}:
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            peer = forwarded.split(",", 1)[0].strip()
    return peer[:64]


login_rate_limiter = LoginRateLimiter()
login_ip_rate_limiter = LoginRateLimiter(max_failures=20)
