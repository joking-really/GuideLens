"""Stripe Checkout, Customer Portal, and Webhook verification/handling service."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Any

import stripe
from fastapi import HTTPException, status

from app.config import Settings
from app.schemas import (
    CheckoutRequest,
    CheckoutResponse,
    PortalRequest,
    PortalResponse,
    SubscriptionStatus,
    SubscriptionTier,
)
from app.supabase_client import SupabaseStore, UserProfile


def _format_period_end(timestamp_val: Any) -> str | None:
    if timestamp_val is None:
        return None
    if isinstance(timestamp_val, str):
        return timestamp_val
    try:
        ts = int(timestamp_val)
        return datetime.fromtimestamp(ts, tz=UTC).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def map_stripe_status(raw_status: str | None) -> SubscriptionStatus:
    """Map Stripe subscription status to GuideLens profile subscription_status."""
    if raw_status in ("active", "trialing"):
        return "active"
    if raw_status in ("past_due", "unpaid"):
        return "past_due"
    if raw_status == "canceled":
        return "canceled"
    return "inactive"


class StripeService:
    """Handles Stripe Checkout, Billing Portal, and signed Webhook events."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def _is_live_stripe_configured(self) -> bool:
        key = self.settings.stripe_secret_key.strip()
        return bool(key and key != "sk_test_your_stripe_secret_key" and not key.startswith("mock"))

    def resolve_price_and_tier(self, req: CheckoutRequest) -> tuple[str, SubscriptionTier]:
        """Resolve Stripe price ID ($19/mo or $190/yr) and corresponding tier name."""
        if req.price_id:
            if req.price_id == self.settings.stripe_price_annual:
                return req.price_id, "pro_annual"
            return req.price_id, "pro_monthly"

        if req.plan in ("annual", "pro_annual"):
            return self.settings.stripe_price_annual, "pro_annual"
        return self.settings.stripe_price_monthly, "pro_monthly"

    async def create_checkout_session(
        self,
        profile: UserProfile,
        req: CheckoutRequest,
    ) -> CheckoutResponse:
        price_id, tier = self.resolve_price_and_tier(req)
        success_url = req.success_url or self.settings.billing_success_url
        cancel_url = req.cancel_url or self.settings.billing_cancel_url

        if not self._is_live_stripe_configured:
            mock_session_id = f"cs_test_mock_{profile.id[:8]}_{tier}"
            return CheckoutResponse(
                url=f"https://checkout.stripe.com/pay/{mock_session_id}?price={price_id}",
                session_id=mock_session_id,
            )

        stripe.api_key = self.settings.stripe_secret_key
        params: dict[str, Any] = {
            "mode": "subscription",
            "line_items": [{"price": price_id, "quantity": 1}],
            "success_url": success_url,
            "cancel_url": cancel_url,
            "client_reference_id": profile.id,
            "metadata": {
                "user_id": profile.id,
                "tier": tier,
                "price_id": price_id,
            },
        }
        if profile.stripe_customer_id:
            params["customer"] = profile.stripe_customer_id
        elif profile.email:
            params["customer_email"] = profile.email

        session = stripe.checkout.Session.create(**params)
        return CheckoutResponse(
            url=str(session["url"] if isinstance(session, dict) else session.url),
            session_id=str(session["id"] if isinstance(session, dict) else session.id),
        )

    async def create_portal_session(
        self,
        profile: UserProfile,
        req: PortalRequest,
    ) -> PortalResponse:
        if not profile.stripe_customer_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "no_billing_customer",
                    "message": "No Stripe customer is linked to this profile.",
                },
            )

        return_url = req.return_url or self.settings.billing_portal_return_url

        if not self._is_live_stripe_configured:
            return PortalResponse(
                url=f"https://billing.stripe.com/p/session/mock_{profile.stripe_customer_id}"
            )

        stripe.api_key = self.settings.stripe_secret_key
        portal = stripe.billing_portal.Session.create(
            customer=profile.stripe_customer_id,
            return_url=return_url,
        )
        return PortalResponse(url=str(portal["url"] if isinstance(portal, dict) else portal.url))

    def verify_webhook_event(self, payload: bytes, sig_header: str | None) -> dict[str, Any]:
        """Verify Stripe-Signature header and return parsed event dict."""
        if not sig_header or not sig_header.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "missing_signature",
                    "message": "Missing Stripe-Signature header.",
                },
            )

        webhook_secret = (
            self.settings.stripe_webhook_secret.strip() or "whsec_dev_mock_webhook_secret"
        )

        try:
            event = stripe.Webhook.construct_event(
                payload=payload,
                sig_header=sig_header,
                secret=webhook_secret,
            )
            if isinstance(event, dict):
                return event
            if hasattr(event, "to_dict_recursive"):
                return event.to_dict_recursive()
            if hasattr(event, "to_dict"):
                return event.to_dict()
            return dict(event)
        except stripe.error.SignatureVerificationError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "invalid_signature",
                    "message": f"Invalid Stripe webhook signature: {exc}",
                },
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "invalid_payload",
                    "message": f"Invalid Stripe webhook payload: {exc}",
                },
            ) from exc

    def _infer_tier_from_object(self, obj: dict[str, Any]) -> SubscriptionTier:
        metadata = obj.get("metadata") or {}
        meta_tier = metadata.get("tier")
        if meta_tier in ("pro_monthly", "pro_annual"):
            return meta_tier

        meta_price = metadata.get("price_id")
        if meta_price == self.settings.stripe_price_annual:
            return "pro_annual"
        if meta_price == self.settings.stripe_price_monthly:
            return "pro_monthly"

        items = (obj.get("items") or {}).get("data") or []
        if items and isinstance(items, list):
            first_item = items[0] if isinstance(items[0], dict) else {}
            price = first_item.get("price") or first_item.get("plan") or {}
            price_id = price.get("id") if isinstance(price, dict) else None
            if price_id == self.settings.stripe_price_annual:
                return "pro_annual"
            if price_id == self.settings.stripe_price_monthly:
                return "pro_monthly"
            interval = (
                (price.get("recurring") or {}).get("interval") if isinstance(price, dict) else None
            )
            if interval == "year":
                return "pro_annual"

        return "pro_monthly"

    async def handle_webhook_event(
        self,
        event: dict[str, Any],
        store: SupabaseStore,
    ) -> dict[str, Any]:
        """Process verified Stripe webhook event and update Supabase profiles."""
        event_type = str(event.get("type") or "")
        data_obj = (event.get("data") or {}).get("object") or {}

        if event_type == "checkout.session.completed":
            metadata = data_obj.get("metadata") or {}
            user_id = data_obj.get("client_reference_id") or metadata.get("user_id")
            customer_id = data_obj.get("customer")
            tier = self._infer_tier_from_object(data_obj)
            period_end = _format_period_end(data_obj.get("current_period_end"))

            await store.update_subscription(
                user_id=str(user_id) if user_id else None,
                stripe_customer_id=str(customer_id) if customer_id else None,
                tier=tier,
                status="active",
                current_period_end=period_end,
            )

        elif event_type == "customer.subscription.updated":
            metadata = data_obj.get("metadata") or {}
            user_id = metadata.get("user_id")
            customer_id = data_obj.get("customer")
            raw_status = str(data_obj.get("status") or "active")
            mapped_status = map_stripe_status(raw_status)
            tier = self._infer_tier_from_object(data_obj)
            period_end = _format_period_end(data_obj.get("current_period_end"))

            await store.update_subscription(
                user_id=str(user_id) if user_id else None,
                stripe_customer_id=str(customer_id) if customer_id else None,
                tier=tier,
                status=mapped_status,
                current_period_end=period_end,
            )

        elif event_type == "customer.subscription.deleted":
            metadata = data_obj.get("metadata") or {}
            user_id = metadata.get("user_id")
            customer_id = data_obj.get("customer")
            period_end = _format_period_end(data_obj.get("current_period_end"))

            await store.update_subscription(
                user_id=str(user_id) if user_id else None,
                stripe_customer_id=str(customer_id) if customer_id else None,
                tier="free",
                status="canceled",
                current_period_end=period_end,
            )

        return {"received": True, "event_type": event_type}


def generate_stripe_signature(
    payload: bytes | str,
    secret: str,
    timestamp: int | None = None,
) -> str:
    """Helper to generate a valid Stripe-Signature header (`t=...,v1=...`) for tests."""
    ts = timestamp if timestamp is not None else int(time.time())
    body_str = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    signed_payload = f"{ts}.{body_str}".encode()
    digest = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def encode_webhook_event(event_dict: dict[str, Any]) -> bytes:
    return json.dumps(event_dict).encode("utf-8")
