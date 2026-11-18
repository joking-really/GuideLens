"""Per-user and per-IP rate limiting (20 req/min default) with in-memory + Redis backends."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Protocol

from fastapi import Request
from fastapi.responses import JSONResponse


class RateLimitExceededError(Exception):
    """Raised when a per-user or per-IP rate limit or monthly quota is exceeded."""

    def __init__(self, error: str, message: str, retry_after: int = 60) -> None:
        super().__init__(message)
        self.error = error
        self.message = message
        self.retry_after = max(1, int(retry_after))


class RateLimiterBackend(Protocol):
    """Pluggable rate limiter interface."""

    def check_and_record(self, key: str, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        ...

    def reset(self) -> None:
        """Clear all rate limit buckets (used in tests)."""
        ...


class InMemoryRateLimiter:
    """Thread-safe sliding-window in-memory rate limiter."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    def check_and_record(self, key: str, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
        now = float(self._clock())
        cutoff = now - float(window_seconds)

        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket

            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= limit:
                oldest = bucket[0]
                retry_after = max(1, int(math.ceil((oldest + window_seconds) - now)))
                return False, retry_after

            bucket.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


class RedisRateLimiter:
    """Fixed-window atomic Redis rate limiter (optional pluggable backend)."""

    def __init__(self, redis_url: str) -> None:
        import redis  # Optional dependency

        self._client = redis.Redis.from_url(redis_url, decode_responses=True)

    def check_and_record(self, key: str, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
        now = int(time.time())
        bucket_id = now // window_seconds
        redis_key = f"guidelens:rl:{key}:{bucket_id}"

        pipe = self._client.pipeline()
        pipe.incr(redis_key)
        pipe.expire(redis_key, window_seconds + 5)
        count_raw, _ = pipe.execute()
        count = int(count_raw)

        if count > limit:
            retry_after = max(1, window_seconds - (now % window_seconds))
            return False, retry_after
        return True, 0

    def reset(self) -> None:
        for key in self._client.scan_iter("guidelens:rl:*"):
            self._client.delete(key)


def create_rate_limiter(redis_url: str = "") -> RateLimiterBackend:
    """Create a RedisRateLimiter if redis_url is provided, else InMemoryRateLimiter."""
    if redis_url.strip():
        return RedisRateLimiter(redis_url.strip())
    return InMemoryRateLimiter()


def extract_client_ip(request: Request) -> str:
    """Extract client IP from X-Forwarded-For (first hop) or request.client."""
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        first_ip = forwarded_for.split(",")[0].strip()
        if first_ip:
            return first_ip
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def build_429_response(exc: RateLimitExceededError) -> JSONResponse:
    """Build standard 429 JSON response with {error, retry_after} per decisions.md §6."""
    return JSONResponse(
        status_code=429,
        headers={"Retry-After": str(exc.retry_after)},
        content={
            "error": exc.error,
            "detail": exc.message,
            "retry_after": exc.retry_after,
        },
    )
