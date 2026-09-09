"""Cloudflare Turnstile verification.

The secret key never leaves the backend. When no secret is configured the
verifier reports `enabled: False` so the frontend can hide the widget — it does
not silently pass tokens through while pretending verification happened.
"""
from __future__ import annotations

import httpx
from fastapi import HTTPException, status

from ..core.config import get_settings

VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


async def verify_captcha(token: str | None, remote_ip: str | None = None) -> None:
    settings = get_settings()
    if not settings.captcha_enabled:
        return  # Not configured. Documented in SETUP; no false sense of safety.

    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Complete the verification challenge and try again.")

    payload = {"secret": settings.turnstile_secret_key, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            result = (await client.post(VERIFY_URL, data=payload)).json()
    except Exception as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "Verification service is unreachable. Try again shortly.") from exc

    if not result.get("success"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Verification failed. Refresh the page and try again.")
