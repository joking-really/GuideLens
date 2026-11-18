"""Comprehensive pytest suite for GuideLens Cloud Proxy (decisions.md §1, §3, §6)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth import JWTVerifier
from app.config import Settings
from app.groq_service import GroqHttpClient, GroqTimeoutError
from app.main import create_app
from app.rate_limit import InMemoryRateLimiter
from app.schemas import GuideRequest, Step, StepPlan, repair_step_plan
from app.stripe_service import encode_webhook_event, generate_stripe_signature
from app.supabase_client import (
    InMemorySupabaseStore,
    SupabaseRestStore,
    UserProfile,
    current_billing_month,
)
from tests.conftest import (
    TEST_JWT_SECRET,
    TEST_PRICE_ANNUAL,
    TEST_PRICE_MONTHLY,
    TEST_WEBHOOK_SECRET,
    make_jwt,
)

SAMPLE_IMAGE_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

SAMPLE_GUIDE_BODY: dict[str, Any] = {
    "image_base64": SAMPLE_IMAGE_B64,
    "query": "How do I select an object in Photoshop?",
    "active_app_title": "Adobe Photoshop 2026",
    "screen_resolution": "1920x1080",
    "conversation_history": [],
}


# ============================================================================
# 1. JWT Authentication & Rejection Tests (HS256 + JWKS RS256)
# ============================================================================
def test_guide_rejects_missing_jwt(client: TestClient) -> None:
    resp = client.post("/api/v1/guide", json=SAMPLE_GUIDE_BODY)
    assert resp.status_code == 401


def test_guide_rejects_malformed_jwt(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": "Bearer not-a-valid-jwt"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 401


def test_guide_rejects_wrong_secret_jwt(client: TestClient) -> None:
    bad_token = make_jwt(secret="wrong-secret-that-does-not-match-server-secret")
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {bad_token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 401


def test_guide_rejects_expired_jwt(client: TestClient) -> None:
    expired_token = make_jwt(exp_offset=-120)
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {expired_token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 401
    assert "expired" in resp.text.lower()


def test_guide_rejects_jwt_without_sub(client: TestClient) -> None:
    token_no_sub = jwt.encode(
        {"email": "pro@guidelens.app", "role": "authenticated"},
        TEST_JWT_SECRET,
        algorithm="HS256",
    )
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {token_no_sub}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 401


def test_jwks_rs256_verification(test_settings: Settings) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()

    jwks_url = "https://example.supabase.co/auth/v1/.well-known/jwks.json"
    settings_with_jwks = test_settings.model_copy(update={"supabase_jwks_url": jwks_url})
    verifier = JWTVerifier(settings_with_jwks)
    fake_signing_key = MagicMock()
    fake_signing_key.key = public_key
    assert verifier._jwks_client is not None
    verifier._jwks_client.get_signing_key_from_jwt = MagicMock(return_value=fake_signing_key)

    rs256_token = jwt.encode(
        {"sub": "user-rs256", "email": "rs256@guidelens.app", "role": "authenticated"},
        private_key,
        algorithm="RS256",
    )
    verified = verifier.verify_token(rs256_token)
    assert verified.user_id == "user-rs256"
    assert verified.email == "rs256@guidelens.app"


# ============================================================================
# 2. Pro Subscription Enforcement Tests (402 Payment Required)
# ============================================================================
def test_guide_returns_402_for_free_user(client: TestClient) -> None:
    free_token = make_jwt(
        user_id="22222222-2222-2222-2222-222222222222",
        email="free@guidelens.app",
    )
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {free_token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 402
    body = resp.json()
    assert body["error"] == "pro_subscription_required"
    assert body["tier"] == "free"


@pytest.mark.parametrize("inactive_status", ["past_due", "canceled", "inactive"])
def test_guide_returns_402_when_pro_subscription_not_active(
    client: TestClient,
    supabase_store: InMemorySupabaseStore,
    inactive_status: str,
) -> None:
    user_id = f"user-{inactive_status}"
    supabase_store.seed_profile(
        UserProfile(
            id=user_id,
            email=f"{inactive_status}@guidelens.app",
            subscription_tier="pro_monthly",
            subscription_status=inactive_status,  # type: ignore[arg-type]
        )
    )
    token = make_jwt(user_id=user_id, email=f"{inactive_status}@guidelens.app")
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 402


def test_guide_succeeds_for_pro_monthly_and_pro_annual(
    client: TestClient,
    supabase_store: InMemorySupabaseStore,
) -> None:
    # pro_monthly user (seeded in fixture)
    pro_token = make_jwt()
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {pro_token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 200
    plan = StepPlan.model_validate(resp.json())
    assert plan.total_steps == len(plan.steps)
    assert len(plan.steps[0].instruction_line) <= 140

    # pro_annual user
    annual_id = "33333333-3333-3333-3333-333333333333"
    supabase_store.seed_profile(
        UserProfile(
            id=annual_id,
            email="annual@guidelens.app",
            subscription_tier="pro_annual",
            subscription_status="active",
        )
    )
    annual_token = make_jwt(user_id=annual_id, email="annual@guidelens.app")
    resp_annual = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {annual_token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp_annual.status_code == 200


# ============================================================================
# 3. Monthly Quota (1,500/mo) and Rate Limit (20 req/min user + IP) -> 429
# ============================================================================
def test_guide_enforces_1500_monthly_quota(
    client: TestClient,
    supabase_store: InMemorySupabaseStore,
) -> None:
    user_id = "11111111-1111-1111-1111-111111111111"
    supabase_store.seed_profile(
        UserProfile(
            id=user_id,
            email="pro@guidelens.app",
            subscription_tier="pro_monthly",
            subscription_status="active",
        ),
        monthly_usage=1500,
    )
    token = make_jwt(user_id=user_id)
    resp = client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 429
    body = resp.json()
    assert body["error"] == "monthly_quota_exceeded"
    assert isinstance(body["retry_after"], int)
    assert body["retry_after"] > 0
    assert "Retry-After" in resp.headers


def test_guide_enforces_20_req_per_min_per_user(
    client: TestClient,
) -> None:
    token = make_jwt()
    for i in range(20):
        resp = client.post(
            "/api/v1/guide",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Forwarded-For": f"10.0.0.{i + 1}",
            },
            json=SAMPLE_GUIDE_BODY,
        )
        assert resp.status_code == 200

    # 21st request within the same minute for the same user (even from a new IP) -> 429
    resp_21 = client.post(
        "/api/v1/guide",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Forwarded-For": "10.0.0.250",
        },
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp_21.status_code == 429
    body = resp_21.json()
    assert body["error"] == "rate_limit_exceeded"
    assert body["retry_after"] >= 1


def test_guide_enforces_20_req_per_min_per_ip(
    client: TestClient,
    supabase_store: InMemorySupabaseStore,
) -> None:
    shared_ip = "203.0.113.42"
    for i in range(20):
        uid = f"user-ip-test-{i}"
        supabase_store.seed_profile(
            UserProfile(
                id=uid,
                email=f"{uid}@guidelens.app",
                subscription_tier="pro_monthly",
                subscription_status="active",
            )
        )
        tok = make_jwt(user_id=uid, email=f"{uid}@guidelens.app")
        resp = client.post(
            "/api/v1/guide",
            headers={
                "Authorization": f"Bearer {tok}",
                "X-Forwarded-For": shared_ip,
            },
            json=SAMPLE_GUIDE_BODY,
        )
        assert resp.status_code == 200

    # 21st request from the same IP -> 429
    uid_21 = "user-ip-test-21"
    supabase_store.seed_profile(
        UserProfile(
            id=uid_21,
            email="u21@guidelens.app",
            subscription_tier="pro_monthly",
            subscription_status="active",
        )
    )
    tok_21 = make_jwt(user_id=uid_21, email="u21@guidelens.app")
    resp_21 = client.post(
        "/api/v1/guide",
        headers={
            "Authorization": f"Bearer {tok_21}",
            "X-Forwarded-For": shared_ip,
        },
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp_21.status_code == 429
    assert resp_21.json()["error"] == "rate_limit_exceeded"


# ============================================================================
# 4. Groq Timeout (504), Vision/Reasoning Client, & Privacy (No Image Logging)
# ============================================================================
def test_guide_returns_504_on_groq_timeout(
    test_settings: Settings,
    supabase_store: InMemorySupabaseStore,
    rate_limiter: InMemoryRateLimiter,
) -> None:
    class TimeoutGroqProvider:
        async def generate_step_plan(self, request: GuideRequest) -> StepPlan:
            raise GroqTimeoutError("Groq vision model timed out after 15.0s")

    app = create_app(
        settings=test_settings,
        supabase_store=supabase_store,
        rate_limiter=rate_limiter,
        groq_provider=TimeoutGroqProvider(),
    )
    local_client = TestClient(app)
    token = make_jwt()
    resp = local_client.post(
        "/api/v1/guide",
        headers={"Authorization": f"Bearer {token}"},
        json=SAMPLE_GUIDE_BODY,
    )
    assert resp.status_code == 504
    assert resp.json()["error"] == "groq_timeout"


@pytest.mark.asyncio
async def test_groq_http_client_vision_and_repair(test_settings: Settings) -> None:
    long_line = (
        "Click the Object Selection Tool in the far left toolbar panel and hold down the mouse "
        "button to reveal the nested selection tools in Adobe Photoshop 2026 right now."
    )
    assert len(long_line) > 140

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        assert body["model"] == test_settings.groq_vision_model
        assert body["response_format"] == {"type": "json_object"}
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "mode": "guide",
                                    "total_steps": 99,  # wrong count, should be repaired to 1
                                    "steps": [
                                        {
                                            "step_number": 1,
                                            "instruction_line": long_line,
                                            "target_name": "Object Selection Tool",
                                            "control_type": "Button",
                                            "bbox": [45, 210, 32, 32],
                                            "confidence": 94,  # 0-100 scale, repaired to 0.94
                                            "shortcut": "W",
                                        }
                                    ],
                                }
                            )
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as async_client:
        groq_client = GroqHttpClient(test_settings, http_client=async_client)
        plan = await groq_client.generate_step_plan(GuideRequest.model_validate(SAMPLE_GUIDE_BODY))

    assert plan.mode == "guide"
    assert plan.total_steps == 1
    assert len(plan.steps) == 1
    assert len(plan.steps[0].instruction_line) <= 140
    assert plan.steps[0].confidence == pytest.approx(0.94)
    assert plan.steps[0].bbox == [45.0, 210.0, 32.0, 32.0]


def test_image_base64_never_exposed_in_repr() -> None:
    secret_marker = "SUPER_SENSITIVE_SCREENSHOT_BASE64_PAYLOAD"
    req = GuideRequest(
        image_base64=secret_marker,
        query="Where is save?",
        active_app_title="Notepad.exe",
    )
    assert secret_marker not in repr(req)
    assert secret_marker not in str(req)


# ============================================================================
# 5. StepPlan Validation & Repair Unit Tests
# ============================================================================
def test_step_plan_strict_validation_rejects_invalid_fields() -> None:
    # instruction_line > 140 chars rejected by strict Step model
    with pytest.raises(ValidationError):
        Step(
            step_number=1,
            instruction_line="A" * 141,
            confidence=0.9,
        )

    # bbox outside 0..1000 rejected by strict Step model
    with pytest.raises(ValidationError):
        Step(
            step_number=1,
            instruction_line="Click File.",
            bbox=[10.0, 20.0, 1200.0, 40.0],
            confidence=0.9,
        )

    # mismatched total_steps rejected by strict StepPlan model
    with pytest.raises(ValidationError):
        StepPlan(
            mode="guide",
            total_steps=2,
            steps=[
                Step(
                    step_number=1,
                    instruction_line="Click File.",
                    confidence=0.9,
                )
            ],
        )


def test_repair_step_plan_handles_fenced_json_and_low_confidence() -> None:
    fenced = """```json
    {
      "mode": "unknown_mode",
      "steps": [
        {
          "instruction_line": "Line one\\nwith newline and extra spaces",
          "bbox": [500, 500, 100, 50],
          "confidence": 0.35
        }
      ]
    }
    ```"""
    plan = repair_step_plan(fenced)
    assert plan.mode == "guide"
    assert plan.total_steps == 1
    assert "\n" not in plan.steps[0].instruction_line
    # Low confidence (<0.5) drops bbox to None per decisions.md §1
    assert plan.steps[0].bbox is None


# ============================================================================
# 6. Stripe Checkout, Portal, Webhooks (Stripe-Signature) & /api/v1/me Tests
# ============================================================================
def test_billing_checkout_monthly_and_annual(client: TestClient) -> None:
    token = make_jwt()

    resp_monthly = client.post(
        "/billing/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={"plan": "monthly"},
    )
    assert resp_monthly.status_code == 200
    assert TEST_PRICE_MONTHLY in resp_monthly.json()["url"]

    resp_annual = client.post(
        "/api/v1/billing/checkout",
        headers={"Authorization": f"Bearer {token}"},
        json={"plan": "annual"},
    )
    assert resp_annual.status_code == 200
    assert TEST_PRICE_ANNUAL in resp_annual.json()["url"]


def test_billing_portal_requires_customer_id(client: TestClient) -> None:
    # Pro user has stripe_customer_id="cus_pro_111"
    pro_token = make_jwt()
    resp_ok = client.post(
        "/billing/portal",
        headers={"Authorization": f"Bearer {pro_token}"},
        json={},
    )
    assert resp_ok.status_code == 200
    assert "cus_pro_111" in resp_ok.json()["url"]

    # Free user has no stripe_customer_id -> 400
    free_token = make_jwt(
        user_id="22222222-2222-2222-2222-222222222222",
        email="free@guidelens.app",
    )
    resp_err = client.post(
        "/api/v1/billing/portal",
        headers={"Authorization": f"Bearer {free_token}"},
        json={},
    )
    assert resp_err.status_code == 400


def test_stripe_webhook_rejects_missing_or_invalid_signature(client: TestClient) -> None:
    payload = encode_webhook_event({"id": "evt_1", "type": "checkout.session.completed"})

    resp_missing = client.post("/webhooks/stripe", content=payload)
    assert resp_missing.status_code == 400

    bad_sig = generate_stripe_signature(payload, secret="whsec_wrong_secret")
    resp_bad = client.post(
        "/webhooks/stripe",
        content=payload,
        headers={"Stripe-Signature": bad_sig},
    )
    assert resp_bad.status_code == 400


def test_stripe_webhook_lifecycle_updates_profiles_and_me(
    client: TestClient,
) -> None:
    free_user_id = "22222222-2222-2222-2222-222222222222"
    free_token = make_jwt(user_id=free_user_id, email="free@guidelens.app")

    # 1. Initially free
    me_before = client.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {free_token}"},
    )
    assert me_before.status_code == 200
    assert me_before.json()["tier"] == "free"
    assert me_before.json()["status"] == "inactive"

    # 2. checkout.session.completed upgrades user to pro_annual + active
    checkout_event = encode_webhook_event(
        {
            "id": "evt_checkout_1",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_123",
                    "client_reference_id": free_user_id,
                    "customer": "cus_upgraded_222",
                    "metadata": {
                        "user_id": free_user_id,
                        "tier": "pro_annual",
                        "price_id": TEST_PRICE_ANNUAL,
                    },
                    "current_period_end": 1829000000,
                }
            },
        }
    )
    sig_1 = generate_stripe_signature(checkout_event, TEST_WEBHOOK_SECRET)
    resp_1 = client.post(
        "/webhooks/stripe",
        content=checkout_event,
        headers={"Stripe-Signature": sig_1},
    )
    assert resp_1.status_code == 200

    me_upgraded = client.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {free_token}"},
    )
    assert me_upgraded.status_code == 200
    assert me_upgraded.json()["tier"] == "pro_annual"
    assert me_upgraded.json()["status"] == "active"
    assert me_upgraded.json()["limit"] == 1500

    # 3. customer.subscription.updated changes status to past_due
    updated_event = encode_webhook_event(
        {
            "id": "evt_sub_updated_2",
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_222",
                    "customer": "cus_upgraded_222",
                    "status": "past_due",
                    "items": {"data": [{"price": {"id": TEST_PRICE_MONTHLY}}]},
                }
            },
        }
    )
    sig_2 = generate_stripe_signature(updated_event, TEST_WEBHOOK_SECRET)
    resp_2 = client.post(
        "/api/v1/webhooks/stripe",
        content=updated_event,
        headers={"Stripe-Signature": sig_2},
    )
    assert resp_2.status_code == 200

    me_past_due = client.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {free_token}"},
    )
    assert me_past_due.json()["tier"] == "pro_monthly"
    assert me_past_due.json()["status"] == "past_due"

    # 4. customer.subscription.deleted resets user to free + canceled
    deleted_event = encode_webhook_event(
        {
            "id": "evt_sub_deleted_3",
            "type": "customer.subscription.deleted",
            "data": {
                "object": {
                    "id": "sub_222",
                    "customer": "cus_upgraded_222",
                    "status": "canceled",
                }
            },
        }
    )
    sig_3 = generate_stripe_signature(deleted_event, TEST_WEBHOOK_SECRET)
    resp_3 = client.post(
        "/webhooks/stripe",
        content=deleted_event,
        headers={"Stripe-Signature": sig_3},
    )
    assert resp_3.status_code == 200

    me_deleted = client.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {free_token}"},
    )
    assert me_deleted.json()["tier"] == "free"
    assert me_deleted.json()["status"] == "canceled"


# ============================================================================
# 7. Supabase PostgREST RPC & SQL Migration Verification
# ============================================================================
@pytest.mark.asyncio
async def test_supabase_rest_store_calls_atomic_increment_usage_rpc() -> None:
    captured_calls: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8")) if request.content else None
        captured_calls.append((request.method, request.url.path, body))
        return httpx.Response(200, json=42)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        rest_store = SupabaseRestStore(
            "https://example.supabase.co",
            "service-role-secret",
            http_client=http_client,
        )
        new_count = await rest_store.increment_usage(
            "11111111-1111-1111-1111-111111111111",
            current_billing_month(),
        )

    assert new_count == 42
    assert len(captured_calls) == 1
    method, path, body = captured_calls[0]
    assert method == "POST"
    assert path == "/rest/v1/rpc/increment_usage"
    assert body["user_id"] == "11111111-1111-1111-1111-111111111111"


def test_supabase_migration_sql_contains_schema_rls_trigger_and_atomic_increment() -> None:
    migration_file = (
        Path(__file__).resolve().parent.parent
        / "supabase"
        / "migrations"
        / "20261118000000_init_cloud_schema.sql"
    )
    assert migration_file.is_file()
    sql = migration_file.read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS public.profiles" in sql
    assert "CREATE TABLE IF NOT EXISTS public.usage_logs" in sql
    assert "ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY" in sql
    assert "ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY" in sql
    assert "CREATE TRIGGER on_auth_user_created" in sql
    assert "CREATE OR REPLACE FUNCTION public.increment_usage(user_id uuid, month text)" in sql
    assert "ON CONFLICT (user_id, billing_month)" in sql
    assert "DO UPDATE SET" in sql
    assert "RETURNING" in sql


# ============================================================================
# 8. Health, Settings .env Loading, Reasoning Repair & Timeout Tests
# ============================================================================
def test_health_endpoints(client: TestClient) -> None:
    for path in ("/health", "/api/v1/health"):
        resp = client.get(path)
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


def test_settings_from_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "GROQ_API_KEY",
        "GROQ_VISION_MODEL",
        "MONTHLY_QUOTA_LIMIT",
        "RATE_LIMIT_PER_MINUTE",
    ):
        monkeypatch.delenv(key, raising=False)

    env_file = tmp_path / ".env"
    env_file.write_text(
        'GROQ_API_KEY="gsk_from_dotenv"\n'
        "GROQ_VISION_MODEL=custom-vision-model\n"
        "MONTHLY_QUOTA_LIMIT=2000\n"
        "RATE_LIMIT_PER_MINUTE=30\n",
        encoding="utf-8",
    )
    loaded = Settings.from_env(env_file=env_file)
    assert loaded.groq_api_key == "gsk_from_dotenv"
    assert loaded.groq_vision_model == "custom-vision-model"
    assert loaded.monthly_quota_limit == 2000
    assert loaded.rate_limit_per_minute == 30


@pytest.mark.asyncio
async def test_groq_http_client_repairs_via_reasoning_model_and_maps_timeouts(
    test_settings: Settings,
) -> None:
    models_called: list[str] = []

    def repair_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        models_called.append(body["model"])
        if len(models_called) == 1:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "NOT VALID JSON"}}]},
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "mode": "terminal",
                                    "total_steps": 1,
                                    "steps": [
                                        {
                                            "step_number": 1,
                                            "instruction_line": "Run pytest.",
                                            "confidence": 0.95,
                                            "terminal_command": "pytest -q",
                                            "explanation": "Runs the test suite.",
                                        }
                                    ],
                                }
                            )
                        }
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(repair_handler)) as async_client:
        groq_client = GroqHttpClient(test_settings, http_client=async_client)
        plan = await groq_client.generate_step_plan(GuideRequest.model_validate(SAMPLE_GUIDE_BODY))

    assert models_called == [
        test_settings.groq_vision_model,
        test_settings.groq_reasoning_model,
    ]
    assert plan.mode == "terminal"
    assert plan.steps[0].terminal_command == "pytest -q"

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler)) as timeout_client:
        groq_timeout = GroqHttpClient(test_settings, http_client=timeout_client)
        with pytest.raises(GroqTimeoutError):
            await groq_timeout.generate_step_plan(GuideRequest.model_validate(SAMPLE_GUIDE_BODY))
