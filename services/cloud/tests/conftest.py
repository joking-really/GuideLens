"""Shared pytest fixtures for GuideLens Cloud Proxy tests."""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.groq_service import MockGroqClient
from app.main import create_app
from app.rate_limit import InMemoryRateLimiter
from app.supabase_client import InMemorySupabaseStore, UserProfile

TEST_JWT_SECRET = "test-supabase-jwt-secret-with-at-least-32-bytes"
TEST_WEBHOOK_SECRET = "whsec_test_stripe_webhook_secret_12345"
TEST_PRICE_MONTHLY = "price_test_pro_monthly_19"
TEST_PRICE_ANNUAL = "price_test_pro_annual_190"


def make_jwt(
    user_id: str = "11111111-1111-1111-1111-111111111111",
    email: str = "pro@guidelens.app",
    secret: str = TEST_JWT_SECRET,
    exp_offset: int = 3600,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": user_id,
        "email": email,
        "role": "authenticated",
        "aud": "authenticated",
        "iat": now,
        "exp": now + exp_offset,
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest.fixture()
def test_settings() -> Settings:
    return Settings(
        groq_api_key="mock_groq_key",
        groq_vision_model="meta-llama/llama-4-scout-17b-16e-instruct",
        groq_reasoning_model="llama-3.3-70b-versatile",
        groq_timeout_seconds=5.0,
        supabase_url="",
        supabase_service_role_key="",
        supabase_jwt_secret=TEST_JWT_SECRET,
        stripe_secret_key="mock_stripe_key",
        stripe_webhook_secret=TEST_WEBHOOK_SECRET,
        stripe_price_monthly=TEST_PRICE_MONTHLY,
        stripe_price_annual=TEST_PRICE_ANNUAL,
        monthly_quota_limit=1500,
        rate_limit_per_minute=20,
    )


@pytest.fixture()
def supabase_store() -> InMemorySupabaseStore:
    store = InMemorySupabaseStore()
    store.seed_profile(
        UserProfile(
            id="11111111-1111-1111-1111-111111111111",
            email="pro@guidelens.app",
            stripe_customer_id="cus_pro_111",
            subscription_tier="pro_monthly",
            subscription_status="active",
            current_period_end="2026-12-18T00:00:00+00:00",
        ),
        monthly_usage=0,
    )
    store.seed_profile(
        UserProfile(
            id="22222222-2222-2222-2222-222222222222",
            email="free@guidelens.app",
            stripe_customer_id=None,
            subscription_tier="free",
            subscription_status="inactive",
        ),
        monthly_usage=0,
    )
    return store


@pytest.fixture()
def rate_limiter() -> InMemoryRateLimiter:
    return InMemoryRateLimiter()


@pytest.fixture()
def client(
    test_settings: Settings,
    supabase_store: InMemorySupabaseStore,
    rate_limiter: InMemoryRateLimiter,
) -> TestClient:
    app = create_app(
        settings=test_settings,
        supabase_store=supabase_store,
        rate_limiter=rate_limiter,
        groq_provider=MockGroqClient(test_settings),
    )
    return TestClient(app)
