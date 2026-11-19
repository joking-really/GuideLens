"""Supabase JWT verification (HS256 secret or JWKS RS256/ES256, configurable)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthenticatedUser:
    """Verified user identity extracted from a Supabase JWT access token."""

    user_id: str
    email: str
    role: str
    raw_claims: dict[str, Any]


class JWTVerifier:
    """Verifies Supabase JWTs using either JWKS (RS256/ES256) or HS256 shared secret."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._jwks_client: jwt.PyJWKClient | None = None
        if settings.supabase_jwks_url:
            self._jwks_client = jwt.PyJWKClient(settings.supabase_jwks_url)

    def verify_token(self, token: str) -> AuthenticatedUser:
        if not token or not token.strip():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "missing_token", "message": "Authorization token is required."},
            )

        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "invalid_token", "message": f"Malformed JWT header: {exc}"},
            ) from exc

        alg = header.get("alg")
        decode_kwargs: dict[str, Any] = {}
        audience = self.settings.supabase_jwt_audience.strip()
        if audience:
            decode_kwargs["audience"] = audience
        else:
            decode_kwargs["options"] = {"verify_aud": False}

        try:
            if self._jwks_client is not None:
                # When JWKS is configured, enforce asymmetric algorithms only to prevent
                # HS256 algorithm-confusion / JWKS bypass attacks.
                if alg not in ("RS256", "ES256"):
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail={
                            "error": "unsupported_jwt_algorithm",
                            "message": f"JWKS mode rejects JWT algorithm: {alg}",
                        },
                    )
                signing_key = self._jwks_client.get_signing_key_from_jwt(token).key
                claims = jwt.decode(
                    token,
                    signing_key,
                    algorithms=["RS256", "ES256"],
                    **decode_kwargs,
                )
            elif alg == "HS256":
                jwt_secret = self.settings.supabase_jwt_secret.strip()
                if not jwt_secret or jwt_secret == "your-supabase-jwt-secret-min-32-chars":
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail={
                            "error": "jwt_secret_not_configured",
                            "message": "SUPABASE_JWT_SECRET is not configured.",
                        },
                    )
                claims = jwt.decode(
                    token,
                    jwt_secret,
                    algorithms=["HS256"],
                    **decode_kwargs,
                )
            else:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail={
                        "error": "unsupported_jwt_algorithm",
                        "message": f"Unsupported or unconfigured JWT algorithm: {alg}",
                    },
                )
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "token_expired", "message": "Access token has expired."},
            ) from exc
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "invalid_token", "message": f"Invalid JWT: {exc}"},
            ) from exc

        user_id = str(claims.get("sub") or "").strip()
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "invalid_token", "message": "JWT is missing 'sub' claim."},
            )

        email = str(claims.get("email") or "")
        role = str(claims.get("role") or "authenticated")
        return AuthenticatedUser(
            user_id=user_id,
            email=email,
            role=role,
            raw_claims=claims,
        )


def get_jwt_verifier(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> JWTVerifier:
    verifier = getattr(request.app.state, "jwt_verifier", None)
    if verifier is None:
        verifier = JWTVerifier(settings)
    return verifier


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    verifier: JWTVerifier = Depends(get_jwt_verifier),
) -> AuthenticatedUser:
    """FastAPI dependency returning the authenticated Supabase user or raising 401."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "missing_authorization",
                "message": "Missing Bearer token in Authorization header.",
            },
        )
    return verifier.verify_token(credentials.credentials)
