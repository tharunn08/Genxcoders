"""Authentication.

OTP codes are generated, emailed and verified by Supabase Auth. This service
never sees, stores or returns a code — there is no endpoint that can leak one.

Flow pairing matters and is easy to get wrong. Each send has exactly one
matching verify type:

    sign_up()                 -> verify_otp(type="signup")
    resend(type="signup")     -> verify_otp(type="signup")
    reset_password_email()    -> verify_otp(type="recovery")
    sign_in_with_otp()        -> verify_otp(type="magiclink")

Sending a recovery mail and verifying it as a magic link (or the reverse) fails
with "Token has expired or is invalid" even when the code is correct.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field

from ..core.db import utcnow_iso
from ..core.config import anon_client, get_settings, service_client
from ..core.security import CurrentUser, audit, current_user, require_super
from ..services.captcha import verify_captcha
from ..services.profiles import ensure_profile, public_user

router = APIRouter(prefix="/auth", tags=["auth"])

PASSWORD_HELP = ("Use at least 8 characters with a mix of upper and lower case, "
                 "a number and a symbol.")


def check_password_strength(password: str) -> None:
    checks = [
        len(password) >= 8,
        any(c.islower() for c in password),
        any(c.isupper() for c in password),
        any(c.isdigit() for c in password),
        any(not c.isalnum() for c in password),
    ]
    if sum(checks) < 4:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, PASSWORD_HELP)


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


# ---------------------------------------------------------------- schemas


class SignUpIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=1, max_length=120)
    captcha_token: str | None = None


class EmailIn(BaseModel):
    email: EmailStr
    captcha_token: str | None = None


class VerifyOtpIn(BaseModel):
    email: EmailStr
    token: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    purpose: str = Field(default="signup", pattern="^(signup|email|recovery|magiclink)$")


class SignInIn(BaseModel):
    email: EmailStr
    password: str
    captcha_token: str | None = None


class SessionIn(BaseModel):
    access_token: str
    refresh_token: str | None = None


class ResetPasswordIn(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


class UpdateProfileIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)


# ---------------------------------------------------------------- public config


@router.get("/config")
def auth_config():
    """Lets the frontend render the right controls without guessing.

    Only public values: the site key is designed to be embedded in a page.
    """
    settings = get_settings()
    return {
        "captcha_enabled": settings.captcha_enabled,
        "google_enabled": True,
        "oauth_redirect_url": settings.oauth_redirect_url,
        "environment": settings.environment,
    }


# ---------------------------------------------------------------- sign up


@router.post("/sign-up", status_code=201)
async def sign_up(payload: SignUpIn, request: Request):
    """Creates the account and triggers Supabase to email a six-digit code."""
    await verify_captcha(payload.captcha_token, client_ip(request))
    check_password_strength(payload.password)
    try:
        anon_client().auth.sign_up({
            "email": payload.email,
            "password": payload.password,
            "options": {
                "data": {"full_name": payload.full_name},
                # Point the confirmation-link email at the app's callback page
                # instead of the raw Site URL, so a user who clicks the link in
                # the email completes verification inside the app. In local
                # development this is http://localhost:5173/auth/callback; set
                # AUTH_REDIRECT_URL to the real domain in production.
                "email_redirect_to": get_settings().auth_redirect_url,
            },
        })
    except Exception as exc:
        message = str(exc)
        if "already registered" in message.lower() or "already been" in message.lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "An account already exists for this email.") from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST, message) from exc

    return {"message": f"We sent a six-digit code to {payload.email}. It expires in 10 minutes.",
            "purpose": "signup"}


@router.post("/resend-otp")
async def resend_otp(payload: EmailIn):
    try:
        anon_client().auth.resend({"type": "signup", "email": payload.email})
    except Exception as exc:
        text = str(exc).lower()
        if "rate" in text or "seconds" in text:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                                "Wait a moment before requesting another code.") from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"message": "A new code is on its way."}


# ---------------------------------------------------------------- verify


@router.post("/verify-otp")
def verify_otp(payload: VerifyOtpIn):
    """Exchanges a valid code for a session. Supabase enforces expiry and attempts."""
    try:
        result = anon_client().auth.verify_otp({
            "email": payload.email,
            "token": payload.token,
            "type": payload.purpose,
        })
    except Exception as exc:
        message = str(exc).lower()
        if "expired" in message:
            raise HTTPException(status.HTTP_410_GONE,
                                "That code has expired. Request a new one.") from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That code isn't valid. Check the digits and try again.") from exc

    if not result.session or not result.user:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Verification did not return a session.")

    profile, created = ensure_profile(
        result.user.id,
        result.user.email or payload.email,
        (result.user.user_metadata or {}).get("full_name"),
        email_verified=True,
    )

    return {
        "access_token": result.session.access_token,
        "refresh_token": result.session.refresh_token,
        "expires_at": result.session.expires_at,
        "user": public_user(profile),
        "profile_created": created,
    }


# ---------------------------------------------------------------- sign in


@router.post("/sign-in")
async def sign_in(payload: SignInIn, request: Request):
    await verify_captcha(payload.captcha_token, client_ip(request))
    try:
        result = anon_client().auth.sign_in_with_password(
            {"email": payload.email, "password": payload.password})
    except Exception as exc:
        message = str(exc).lower()
        if "not confirmed" in message or "confirm" in message:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "Verify your email before signing in.") from exc
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Email or password is incorrect.") from exc

    if not result.session or not result.user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect.")

    profile, created = ensure_profile(
        result.user.id,
        result.user.email or payload.email,
        (result.user.user_metadata or {}).get("full_name"),
        email_verified=result.user.email_confirmed_at is not None,
    )

    if not profile["is_active"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "This account has been deactivated. Contact an administrator.")

    service_client().table("profiles").update(
        {"last_login_at": utcnow_iso()}).eq("id", profile["id"]).execute()

    return {
        "access_token": result.session.access_token,
        "refresh_token": result.session.refresh_token,
        "expires_at": result.session.expires_at,
        "user": public_user(profile),
        "profile_created": created,
    }


@router.post("/session")
def exchange_session(payload: SessionIn):
    """Turns a Supabase session into an app session.

    Used by the Google OAuth callback: supabase-js completes the redirect in the
    browser, then hands the access token here so the profile, role and store
    assignments are resolved by the same code path as password sign-in.
    """
    try:
        result = anon_client().auth.get_user(payload.access_token)
    except Exception as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "That sign-in session isn't valid.") from exc

    if not result or not result.user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "That sign-in session isn't valid.")

    user = result.user
    metadata = user.user_metadata or {}
    profile, created = ensure_profile(
        user.id,
        user.email or "",
        metadata.get("full_name") or metadata.get("name"),
        email_verified=user.email_confirmed_at is not None,
    )

    if not profile["is_active"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "This account has been deactivated. Contact an administrator.")

    service_client().table("profiles").update(
        {"last_login_at": utcnow_iso()}).eq("id", profile["id"]).execute()

    return {"user": public_user(profile), "profile_created": created}


# ---------------------------------------------------------------- recovery


@router.post("/forgot-password")
async def forgot_password(payload: EmailIn, request: Request):
    """Sends a recovery code. Verified with purpose='recovery', not 'magiclink'.

    Returns an identical response whether or not the account exists, so this
    endpoint can't be used to discover which emails are registered.
    """
    await verify_captcha(payload.captcha_token, client_ip(request))
    try:
        anon_client().auth.reset_password_email(payload.email)
    except Exception:
        pass
    return {"message": f"If an account exists for {payload.email}, a reset code is on its way.",
            "purpose": "recovery"}


@router.post("/reset-password")
def reset_password(payload: ResetPasswordIn, user: CurrentUser = Depends(current_user)):
    """Called with the session returned by verify-otp using purpose='recovery'."""
    check_password_strength(payload.new_password)
    try:
        service_client().auth.admin.update_user_by_id(
            user.id, {"password": payload.new_password})
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Password could not be updated: {exc}") from exc

    audit(user, "password.reset", "profile", user.id)
    return {"message": "Password updated. Sign in with your new password."}


# ---------------------------------------------------------------- profile


@router.get("/me")
def me(user: CurrentUser = Depends(current_user)):
    from ..services.profiles import load_profile
    profile = load_profile(user.id)
    if not profile:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found.")
    return public_user(profile)


@router.patch("/me")
def update_me(payload: UpdateProfileIn, user: CurrentUser = Depends(current_user)):
    service_client().table("profiles").update(
        {"full_name": payload.full_name}).eq("id", user.id).execute()
    audit(user, "profile.update", "profile", user.id)
    return {"message": "Profile updated."}


@router.post("/change-password")
def change_password(payload: ResetPasswordIn, user: CurrentUser = Depends(current_user)):
    check_password_strength(payload.new_password)
    try:
        service_client().auth.admin.update_user_by_id(
            user.id, {"password": payload.new_password})
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    audit(user, "password.change", "profile", user.id)
    return {"message": "Password changed."}


# ---------------------------------------------------------------- admin


class CreateUserIn(BaseModel):
    email: EmailStr
    full_name: str
    role_id: int = Field(ge=1, le=4)
    store_ids: list[str] = []
    password: str = Field(min_length=8, max_length=128)
    is_active: bool = True


@router.post("/admin/users", status_code=201)
def create_user(payload: CreateUserIn, admin: CurrentUser = Depends(require_super)):
    """Create a user directly — no invitation email, no acceptance flow.

    The password is handed to Supabase Auth (``admin.create_user``), which
    hashes it server-side; this service never sees or stores a plain-text
    password. The account is confirmed immediately so the user can sign in
    with email + password right away.
    """
    check_password_strength(payload.password)
    svc = service_client()
    try:
        created = svc.auth.admin.create_user({
            "email": payload.email,
            "password": payload.password,
            "email_confirm": True,
            "user_metadata": {"full_name": payload.full_name,
                              "role_id": payload.role_id},
        })
    except Exception as exc:
        message = str(exc)
        if "already" in message.lower() and ("registered" in message.lower()
                                             or "exists" in message.lower()):
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"An account already exists for {payload.email}.") from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    user_id = created.user.id
    ensure_profile(user_id, payload.email, payload.full_name, email_verified=True)
    svc.table("profiles").update({
        "full_name": payload.full_name,
        "role_id": payload.role_id,
        "is_active": payload.is_active,
        "email_verified": True,
    }).eq("id", user_id).execute()

    if payload.store_ids:
        svc.table("user_store_assignments").upsert(
            [{"user_id": user_id, "store_id": s} for s in payload.store_ids]).execute()

    audit(admin, "user.create", "profile", user_id,
          {"email": payload.email, "role_id": payload.role_id})
    return {"id": user_id, "message": f"User {payload.full_name} created. They can sign in now."}
