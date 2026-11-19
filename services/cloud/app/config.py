"""Environment configuration for GuideLens Cloud Proxy."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


def _load_dotenv_file(dotenv_path: Path) -> dict[str, str]:
    """Minimal .env loader that reads key=value pairs without mutating os.environ."""
    values: dict[str, str] = {}
    if not dotenv_path.is_file():
        return values
    try:
        for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            values[key] = val
    except OSError:
        pass
    return values


class Settings(BaseModel):
    """Typed application settings loaded from environment variables or .env file."""

    model_config = ConfigDict(extra="ignore")

    # Groq API
    groq_api_key: str = Field(default="")
    groq_base_url: str = Field(default="https://api.groq.com/openai/v1")
    groq_vision_model: str = Field(default="meta-llama/llama-4-scout-17b-16e-instruct")
    groq_reasoning_model: str = Field(default="llama-3.3-70b-versatile")
    groq_timeout_seconds: float = Field(default=15.0)

    # Supabase
    supabase_url: str = Field(default="")
    supabase_service_role_key: str = Field(default="")
    supabase_jwt_secret: str = Field(default="")
    supabase_jwks_url: str = Field(default="")
    supabase_jwt_audience: str = Field(default="authenticated")

    # Stripe
    stripe_secret_key: str = Field(default="")
    stripe_webhook_secret: str = Field(default="")
    stripe_price_monthly: str = Field(default="price_pro_monthly_19_usd")
    stripe_price_annual: str = Field(default="price_pro_annual_190_usd")

    # Billing Redirects
    billing_success_url: str = Field(default="https://guidelens.app/billing/success")
    billing_cancel_url: str = Field(default="https://guidelens.app/billing/cancel")
    billing_portal_return_url: str = Field(default="https://guidelens.app/settings")

    # Quotas & Rate Limits
    monthly_quota_limit: int = Field(default=1500)
    rate_limit_per_minute: int = Field(default=20)
    redis_url: str = Field(default="")

    # CORS
    allowed_origins: str = Field(
        default="http://localhost:1420,tauri://localhost,https://tauri.localhost"
    )

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @classmethod
    def from_env(cls, env_file: Path | None = None) -> Settings:
        if env_file is None:
            env_file = Path(__file__).resolve().parent.parent / ".env"
        file_vals = _load_dotenv_file(env_file)
        data: dict[str, object] = {}
        for field_name in cls.model_fields:
            env_key = field_name.upper()
            if env_key in os.environ:
                data[field_name] = os.environ[env_key]
            elif env_key in file_vals:
                data[field_name] = file_vals[env_key]
        return cls.model_validate(data)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return cached Settings instance."""
    return Settings.from_env()
