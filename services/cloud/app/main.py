"""FastAPI application entrypoint for GuideLens Cloud Proxy (decisions.md §6)."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, FastAPI, Header, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.auth import AuthenticatedUser, JWTVerifier, get_current_user
from app.config import Settings, get_settings
from app.groq_service import (
    GroqProvider,
    GroqTimeoutError,
    GroqUpstreamError,
    create_groq_provider,
)
from app.rate_limit import (
    RateLimiterBackend,
    RateLimitExceededError,
    build_429_response,
    create_rate_limiter,
    extract_client_ip,
)
from app.schemas import (
    CheckoutRequest,
    CheckoutResponse,
    GuideRequest,
    MeResponse,
    PortalRequest,
    PortalResponse,
    StepPlan,
)
from app.stripe_service import StripeService
from app.supabase_client import (
    SupabaseStore,
    create_supabase_store,
    current_billing_month,
    seconds_until_next_month,
)


def get_store(request: Request) -> SupabaseStore:
    return request.app.state.supabase_store


def get_rate_limiter(request: Request) -> RateLimiterBackend:
    return request.app.state.rate_limiter


def get_groq_provider(request: Request) -> GroqProvider:
    return request.app.state.groq_provider


def get_stripe_service(request: Request) -> StripeService:
    return request.app.state.stripe_service


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


api_router = APIRouter()
billing_router = APIRouter()


@api_router.post("/api/v1/guide", response_model=StepPlan)
async def guide_endpoint(
    payload: GuideRequest,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    store: SupabaseStore = Depends(get_store),
    limiter: RateLimiterBackend = Depends(get_rate_limiter),
    groq: GroqProvider = Depends(get_groq_provider),
    settings: Settings = Depends(get_app_settings),
) -> StepPlan | JSONResponse:
    """Proxy screenshot + query to Groq API for Pro subscribers within rate & monthly quotas."""
    # 1. Per-IP and per-user rate limit (default 20 req/min each)
    client_ip = extract_client_ip(request)
    ip_ok, ip_retry = limiter.check_and_record(
        f"ip:{client_ip}",
        limit=settings.rate_limit_per_minute,
        window_seconds=60,
    )
    if not ip_ok:
        return build_429_response(
            RateLimitExceededError(
                error="rate_limit_exceeded",
                message=f"Per-IP rate limit of {settings.rate_limit_per_minute} req/min exceeded.",
                retry_after=ip_retry,
            )
        )

    user_ok, user_retry = limiter.check_and_record(
        f"user:{user.user_id}",
        limit=settings.rate_limit_per_minute,
        window_seconds=60,
    )
    if not user_ok:
        return build_429_response(
            RateLimitExceededError(
                error="rate_limit_exceeded",
                message=(
                    f"Per-user rate limit of {settings.rate_limit_per_minute} req/min exceeded."
                ),
                retry_after=user_retry,
            )
        )

    # 2. Verify active Pro subscription (pro_monthly or pro_annual + active)
    profile = await store.get_profile(user.user_id, email=user.email)
    if not profile.is_pro_active:
        return JSONResponse(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            content={
                "error": "pro_subscription_required",
                "detail": "An active GuideLens Pro subscription is required for Groq Cloud mode.",
                "tier": profile.subscription_tier,
                "status": profile.subscription_status,
            },
        )

    # 3. Check monthly fair-use quota (default 1,500 requests/month)
    month = current_billing_month()
    current_usage = await store.get_monthly_usage(user.user_id, month)
    if current_usage >= settings.monthly_quota_limit:
        return build_429_response(
            RateLimitExceededError(
                error="monthly_quota_exceeded",
                message=(
                    f"Monthly quota of {settings.monthly_quota_limit} Groq requests reached "
                    f"for {month}."
                ),
                retry_after=seconds_until_next_month(),
            )
        )

    # 4. Call Groq API (image held strictly in memory, never logged or stored)
    try:
        step_plan = await groq.generate_step_plan(payload)
    except GroqTimeoutError as exc:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={
                "error": "groq_timeout",
                "detail": str(exc) or "Groq API timed out.",
            },
        )
    except GroqUpstreamError as exc:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "error": "groq_upstream_error",
                "detail": str(exc),
            },
        )

    # 5. Atomically increment monthly usage counter
    new_usage = await store.increment_usage(user.user_id, month)
    if new_usage > settings.monthly_quota_limit:
        return build_429_response(
            RateLimitExceededError(
                error="monthly_quota_exceeded",
                message=(
                    f"Monthly quota of {settings.monthly_quota_limit} Groq requests reached "
                    f"for {month}."
                ),
                retry_after=seconds_until_next_month(),
            )
        )

    return step_plan


@api_router.get("/api/v1/me", response_model=MeResponse)
async def me_endpoint(
    user: AuthenticatedUser = Depends(get_current_user),
    store: SupabaseStore = Depends(get_store),
    settings: Settings = Depends(get_app_settings),
) -> MeResponse:
    """Return current user's subscription tier, status, monthly Groq usage, and limit."""
    profile = await store.get_profile(user.user_id, email=user.email)
    month = current_billing_month()
    usage = await store.get_monthly_usage(user.user_id, month)
    return MeResponse(
        id=profile.id,
        email=profile.email or user.email,
        tier=profile.subscription_tier,
        subscription_tier=profile.subscription_tier,
        status=profile.subscription_status,
        subscription_status=profile.subscription_status,
        usage=usage,
        limit=settings.monthly_quota_limit,
        billing_month=month,
        current_period_end=profile.current_period_end,
    )


@billing_router.post("/billing/checkout", response_model=CheckoutResponse)
async def billing_checkout_endpoint(
    payload: CheckoutRequest = Body(default_factory=CheckoutRequest),
    user: AuthenticatedUser = Depends(get_current_user),
    store: SupabaseStore = Depends(get_store),
    stripe_service: StripeService = Depends(get_stripe_service),
) -> CheckoutResponse:
    """Create a Stripe Checkout Session for $19/mo (monthly) or $190/yr (annual) Pro."""
    profile = await store.get_profile(user.user_id, email=user.email)
    return await stripe_service.create_checkout_session(profile, payload)


@billing_router.post("/billing/portal", response_model=PortalResponse)
async def billing_portal_endpoint(
    payload: PortalRequest = Body(default_factory=PortalRequest),
    user: AuthenticatedUser = Depends(get_current_user),
    store: SupabaseStore = Depends(get_store),
    stripe_service: StripeService = Depends(get_stripe_service),
) -> PortalResponse:
    """Create a Stripe Customer Portal session for managing an existing subscription."""
    profile = await store.get_profile(user.user_id, email=user.email)
    return await stripe_service.create_portal_session(profile, payload)


@billing_router.post("/webhooks/stripe")
async def stripe_webhook_endpoint(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    store: SupabaseStore = Depends(get_store),
    stripe_service: StripeService = Depends(get_stripe_service),
) -> dict[str, object]:
    """Verify Stripe-Signature and sync subscription events to Supabase profiles."""
    raw_body = await request.body()
    event = stripe_service.verify_webhook_event(raw_body, stripe_signature)
    return await stripe_service.handle_webhook_event(event, store)


def create_app(
    settings: Settings | None = None,
    *,
    supabase_store: SupabaseStore | None = None,
    rate_limiter: RateLimiterBackend | None = None,
    groq_provider: GroqProvider | None = None,
    stripe_service: StripeService | None = None,
    jwt_verifier: JWTVerifier | None = None,
) -> FastAPI:
    """Create and configure the GuideLens Cloud FastAPI application."""
    cfg = settings or get_settings()

    application = FastAPI(
        title="GuideLens Cloud Proxy",
        version=__version__,
        description="Stateless FastAPI proxy for GuideLens Pro (Groq API, Supabase Auth, Stripe).",
    )

    application.state.settings = cfg
    application.state.supabase_store = supabase_store or create_supabase_store(cfg)
    application.state.rate_limiter = rate_limiter or create_rate_limiter(cfg.redis_url)
    application.state.groq_provider = groq_provider or create_groq_provider(cfg)
    application.state.stripe_service = stripe_service or StripeService(cfg)
    application.state.jwt_verifier = jwt_verifier or JWTVerifier(cfg)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Stripe-Signature"],
    )

    @application.get("/health")
    @application.get("/api/v1/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "service": "guidelens-cloud", "version": __version__}

    # Include core /api/v1/guide and /api/v1/me routes
    application.include_router(api_router)
    # Mount billing & webhook routes at BOTH /billing/... + /webhooks/stripe
    # AND /api/v1/billing/... + /api/v1/webhooks/stripe so all callers match seamlessly
    application.include_router(billing_router)
    application.include_router(billing_router, prefix="/api/v1")

    return application


app = create_app()
