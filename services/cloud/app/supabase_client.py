"""Supabase profile & usage store (PostgREST + RPC increment_usage, with mock fallback)."""

from __future__ import annotations

import threading
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx

from app.config import Settings
from app.schemas import SubscriptionStatus, SubscriptionTier


def current_billing_month(now: datetime | None = None) -> str:
    """Return current UTC billing month formatted as 'YYYY-MM'."""
    dt = now or datetime.now(UTC)
    return dt.strftime("%Y-%m")


def seconds_until_next_month(now: datetime | None = None) -> int:
    """Return seconds remaining until the start of the next UTC month."""
    dt = now or datetime.now(UTC)
    if dt.month == 12:
        next_month = datetime(dt.year + 1, 1, 1, tzinfo=UTC)
    else:
        next_month = datetime(dt.year, dt.month + 1, 1, tzinfo=UTC)
    return max(60, int((next_month - dt).total_seconds()))


@dataclass
class UserProfile:
    """Represents a row in public.profiles (database.md §3)."""

    id: str
    email: str
    stripe_customer_id: str | None = None
    subscription_tier: SubscriptionTier = "free"
    subscription_status: SubscriptionStatus = "inactive"
    current_period_end: str | None = None

    @property
    def is_pro_active(self) -> bool:
        """Check whether user has an active Pro subscription (pro_monthly or pro_annual)."""
        return (
            self.subscription_tier in ("pro_monthly", "pro_annual")
            and self.subscription_status == "active"
        )


class SupabaseStore(Protocol):
    """Interface for profile and usage persistence."""

    async def get_profile(self, user_id: str, email: str = "") -> UserProfile: ...

    async def get_profile_by_customer(self, stripe_customer_id: str) -> UserProfile | None: ...

    async def upsert_profile(self, profile: UserProfile) -> UserProfile: ...

    async def update_subscription(
        self,
        *,
        user_id: str | None = None,
        stripe_customer_id: str | None = None,
        tier: SubscriptionTier,
        status: SubscriptionStatus,
        current_period_end: str | None = None,
    ) -> UserProfile | None: ...

    async def get_monthly_usage(self, user_id: str, billing_month: str) -> int: ...

    async def increment_usage(self, user_id: str, billing_month: str) -> int: ...


class InMemorySupabaseStore:
    """Thread-safe in-memory store used when Supabase credentials are not configured or in tests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._profiles: dict[str, UserProfile] = {}
        self._usage: dict[tuple[str, str], int] = {}

    def seed_profile(self, profile: UserProfile, monthly_usage: int | None = None) -> None:
        with self._lock:
            self._profiles[profile.id] = profile
            if monthly_usage is not None:
                self._usage[(profile.id, current_billing_month())] = monthly_usage

    async def get_profile(self, user_id: str, email: str = "") -> UserProfile:
        with self._lock:
            existing = self._profiles.get(user_id)
            if existing is not None:
                if email and not existing.email:
                    existing = replace(existing, email=email)
                    self._profiles[user_id] = existing
                return existing
            created = UserProfile(
                id=user_id,
                email=email or f"{user_id}@users.guidelens.local",
                subscription_tier="free",
                subscription_status="inactive",
            )
            self._profiles[user_id] = created
            return created

    async def get_profile_by_customer(self, stripe_customer_id: str) -> UserProfile | None:
        with self._lock:
            for profile in self._profiles.values():
                if profile.stripe_customer_id == stripe_customer_id:
                    return profile
            return None

    async def upsert_profile(self, profile: UserProfile) -> UserProfile:
        with self._lock:
            self._profiles[profile.id] = profile
            return profile

    async def update_subscription(
        self,
        *,
        user_id: str | None = None,
        stripe_customer_id: str | None = None,
        tier: SubscriptionTier,
        status: SubscriptionStatus,
        current_period_end: str | None = None,
    ) -> UserProfile | None:
        with self._lock:
            target: UserProfile | None = None
            if user_id and user_id in self._profiles:
                target = self._profiles[user_id]
            elif stripe_customer_id:
                for p in self._profiles.values():
                    if p.stripe_customer_id == stripe_customer_id:
                        target = p
                        break
            if target is None and user_id:
                target = UserProfile(
                    id=user_id,
                    email=f"{user_id}@users.guidelens.local",
                )
            if target is None:
                return None

            updated = replace(
                target,
                stripe_customer_id=stripe_customer_id or target.stripe_customer_id,
                subscription_tier=tier,
                subscription_status=status,
                current_period_end=(
                    current_period_end
                    if current_period_end is not None
                    else target.current_period_end
                ),
            )
            self._profiles[updated.id] = updated
            return updated

    async def get_monthly_usage(self, user_id: str, billing_month: str) -> int:
        with self._lock:
            return int(self._usage.get((user_id, billing_month), 0))

    async def increment_usage(self, user_id: str, billing_month: str) -> int:
        with self._lock:
            key = (user_id, billing_month)
            new_val = int(self._usage.get(key, 0)) + 1
            self._usage[key] = new_val
            return new_val


class SupabaseRestStore:
    """Supabase PostgREST + RPC client using service_role key."""

    def __init__(
        self,
        supabase_url: str,
        service_role_key: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = supabase_url.rstrip("/")
        self.service_role_key = service_role_key
        self._client = http_client

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _row_to_profile(self, row: dict[str, Any]) -> UserProfile:
        tier_raw = row.get("subscription_tier", "free")
        tier: SubscriptionTier = (
            tier_raw if tier_raw in ("free", "pro_monthly", "pro_annual") else "free"
        )
        status_raw = row.get("subscription_status", "inactive")
        sub_status: SubscriptionStatus = (
            status_raw
            if status_raw in ("active", "past_due", "canceled", "inactive")
            else "inactive"
        )
        return UserProfile(
            id=str(row["id"]),
            email=str(row.get("email") or ""),
            stripe_customer_id=row.get("stripe_customer_id"),
            subscription_tier=tier,
            subscription_status=sub_status,
            current_period_end=row.get("current_period_end"),
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: Any = None,
        prefer: str | None = None,
    ) -> httpx.Response:
        url = f"{self.base_url}{path}"
        headers = self._headers(prefer=prefer)
        if self._client is not None:
            resp = await self._client.request(
                method, url, params=params, json=json_body, headers=headers
            )
            resp.raise_for_status()
            return resp
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request(method, url, params=params, json=json_body, headers=headers)
            resp.raise_for_status()
            return resp

    async def get_profile(self, user_id: str, email: str = "") -> UserProfile:
        resp = await self._request(
            "GET",
            "/rest/v1/profiles",
            params={"id": f"eq.{user_id}", "select": "*"},
        )
        rows = resp.json()
        if isinstance(rows, list) and rows:
            return self._row_to_profile(rows[0])

        default_profile = UserProfile(
            id=user_id,
            email=email or f"{user_id}@users.guidelens.local",
            subscription_tier="free",
            subscription_status="inactive",
        )
        return await self.upsert_profile(default_profile)

    async def get_profile_by_customer(self, stripe_customer_id: str) -> UserProfile | None:
        resp = await self._request(
            "GET",
            "/rest/v1/profiles",
            params={"stripe_customer_id": f"eq.{stripe_customer_id}", "select": "*"},
        )
        rows = resp.json()
        if isinstance(rows, list) and rows:
            return self._row_to_profile(rows[0])
        return None

    async def upsert_profile(self, profile: UserProfile) -> UserProfile:
        payload = {
            "id": profile.id,
            "email": profile.email,
            "stripe_customer_id": profile.stripe_customer_id,
            "subscription_tier": profile.subscription_tier,
            "subscription_status": profile.subscription_status,
            "current_period_end": profile.current_period_end,
        }
        resp = await self._request(
            "POST",
            "/rest/v1/profiles",
            params={"on_conflict": "id"},
            json_body=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )
        rows = resp.json()
        if isinstance(rows, list) and rows:
            return self._row_to_profile(rows[0])
        return profile

    async def update_subscription(
        self,
        *,
        user_id: str | None = None,
        stripe_customer_id: str | None = None,
        tier: SubscriptionTier,
        status: SubscriptionStatus,
        current_period_end: str | None = None,
    ) -> UserProfile | None:
        patch_body: dict[str, Any] = {
            "subscription_tier": tier,
            "subscription_status": status,
        }
        if stripe_customer_id:
            patch_body["stripe_customer_id"] = stripe_customer_id
        if current_period_end is not None:
            patch_body["current_period_end"] = current_period_end

        if user_id:
            resp = await self._request(
                "PATCH",
                "/rest/v1/profiles",
                params={"id": f"eq.{user_id}"},
                json_body=patch_body,
                prefer="return=representation",
            )
            rows = resp.json()
            if isinstance(rows, list) and rows:
                return self._row_to_profile(rows[0])

        if stripe_customer_id:
            resp = await self._request(
                "PATCH",
                "/rest/v1/profiles",
                params={"stripe_customer_id": f"eq.{stripe_customer_id}"},
                json_body=patch_body,
                prefer="return=representation",
            )
            rows = resp.json()
            if isinstance(rows, list) and rows:
                return self._row_to_profile(rows[0])

        return None

    async def get_monthly_usage(self, user_id: str, billing_month: str) -> int:
        resp = await self._request(
            "GET",
            "/rest/v1/usage_logs",
            params={
                "user_id": f"eq.{user_id}",
                "billing_month": f"eq.{billing_month}",
                "select": "groq_requests_count",
            },
        )
        rows = resp.json()
        if isinstance(rows, list) and rows:
            return int(rows[0].get("groq_requests_count") or 0)
        return 0

    async def increment_usage(self, user_id: str, billing_month: str) -> int:
        resp = await self._request(
            "POST",
            "/rest/v1/rpc/increment_usage",
            json_body={"user_id": user_id, "month": billing_month},
        )
        data = resp.json()
        if isinstance(data, int):
            return data
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                return int(first.get("increment_usage") or first.get("groq_requests_count") or 1)
            return int(first)
        if isinstance(data, dict):
            return int(data.get("increment_usage") or data.get("groq_requests_count") or 1)
        return 1


def create_supabase_store(settings: Settings) -> SupabaseStore:
    """Create a SupabaseRestStore if real credentials are configured, else InMemorySupabaseStore."""
    url = settings.supabase_url.strip()
    key = settings.supabase_service_role_key.strip()
    if url and key and "your-project-ref" not in url and not key.endswith("your-service-role-key"):
        return SupabaseRestStore(url, key)
    return InMemorySupabaseStore()
