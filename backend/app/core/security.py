"""Authentication, role guards and audit.

## Why this file changed

The behaviour is identical — same Supabase tokens, same roles, same guards, same
row-level security. What changed is the cost of getting there.

Every authenticated request previously performed **three blocking network round
trips before the endpoint body ran**:

1. ``service_client().auth.get_user(token)`` — an HTTPS call to Supabase Auth
2. ``ensure_profile`` — a select on ``profiles`` (sometimes an update plus a
   second select)
3. a select on ``user_store_assignments``

and it did them from an ``async def`` dependency. supabase-py is synchronous, so
those calls blocked the event loop rather than yielding it: concurrent requests
queued behind each other instead of overlapping. A dashboard that fires four
requests paid roughly twelve serialised round trips before any real work began.

Three changes fix that without altering the security model:

* **Local verification first.** A Supabase access token is a signed JWT. When it
  is HS256-signed we verify it against ``SUPABASE_JWT_SECRET`` — the setting was
  already in the config and unused — which is a signature check, not a network
  call. Asymmetric tokens (ES256/RS256), which cannot be verified with the
  shared secret, fall back to the Auth API exactly as before. Either path
  produces the same claims, and an invalid or expired token is still rejected.
* **A short-lived identity cache.** The resolved profile and store list are
  cached per token for 60 seconds, bounded in size, and never past the token's
  own expiry. A role change takes at most a minute to apply, and the endpoints
  that change roles clear the entry immediately.
* **A synchronous dependency.** ``def`` rather than ``async def`` makes Starlette
  run it in a worker thread, so the blocking client no longer stalls the loop.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import get_settings, service_client, user_client

bearer = HTTPBearer(auto_error=False)

ROLE_RANK = {
    "store_manager": 1,
    # The warehouse team sits alongside a store manager rather than above one:
    # it is not scoped to a single store, but it cannot touch the catalogue,
    # settings or users either. Its permissions are granted explicitly through
    # require_warehouse rather than by rank.
    "warehouse": 1,
    "inventory_manager": 2,
    "admin": 3,
    "super_admin": 4,
}

# How long a resolved identity may be reused. Short enough that a role or
# deactivation change lands promptly, long enough to collapse the burst of
# requests a single screen makes.
IDENTITY_TTL_SECONDS = 60
IDENTITY_CACHE_MAX = 512


@dataclass
class CurrentUser:
    id: str
    email: str
    role: str
    full_name: str | None
    is_active: bool
    email_verified: bool
    token: str
    store_ids: list[str] = field(default_factory=list)

    @property
    def is_admin(self) -> bool:
        return self.role in ("super_admin", "admin")

    @property
    def is_super(self) -> bool:
        return self.role == "super_admin"

    @property
    def is_staff(self) -> bool:
        return self.role in (
            "super_admin",
            "admin",
            "inventory_manager",
        )

    @property
    def is_warehouse(self) -> bool:
        """Can move orders through pick / pack / ship.

        Admins keep the capability so a single-operator deployment does not
        need a second account just to ship an order.
        """
        return self.role in ("warehouse", "super_admin", "admin", "inventory_manager")

    def can_access_store(self, store_id: str | None) -> bool:
        if store_id is None:
            return True
        if self.role != "store_manager":
            return True
        return store_id in self.store_ids

    def db(self):
        """RLS-scoped client for this user."""
        return user_client(self.token)


# ---------------------------------------------------------------- token verify


def _verify_local(token: str) -> dict[str, Any] | None:
    """Verify an HS256 Supabase token against the project JWT secret.

    Returns None when the token isn't HS256 or the secret isn't usable, so the
    caller falls back to the Auth API. None means "can't decide here" — a token
    that *is* checkable and has expired raises rather than falling through.
    """
    secret = (get_settings().supabase_jwt_secret or "").strip()
    if not secret:
        return None

    try:
        from jose import jwt as jose_jwt
        from jose.exceptions import ExpiredSignatureError, JWTError
    except Exception:  # pragma: no cover - python-jose is in requirements.txt
        return None

    try:
        header = jose_jwt.get_unverified_header(token)
    except Exception:
        return None

    if (header or {}).get("alg") != "HS256":
        # Asymmetric signing keys can't be checked with the shared secret.
        return None

    try:
        claims = jose_jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            # Supabase sets aud="authenticated"; verifying it adds nothing here
            # and breaks projects that customise it.
            options={"verify_aud": False},
        )
    except ExpiredSignatureError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Your session expired. Sign in again."
        ) from exc
    except JWTError:
        # Wrong secret, or a token from another project. Let the Auth API decide
        # rather than locking a correctly-configured user out.
        return None

    if not claims.get("sub"):
        return None

    metadata = claims.get("user_metadata") or {}
    return {
        "sub": str(claims["sub"]),
        "email": claims.get("email") or metadata.get("email") or "",
        "full_name": metadata.get("full_name") or metadata.get("name"),
        "email_verified": bool(
            claims.get("email_confirmed_at") or metadata.get("email_verified")
        ),
        "exp": claims.get("exp"),
    }


def _verify_remote(token: str) -> dict[str, Any]:
    """Validate through Supabase Auth. Supports asymmetric signing (ES256 etc.)."""
    try:
        response = service_client().auth.get_user(token)
        auth_user = response.user

        if auth_user is None or not getattr(auth_user, "id", None):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid or expired token.",
            )

        metadata = getattr(auth_user, "user_metadata", None) or {}

        return {
            "sub": str(auth_user.id),
            "email": getattr(auth_user, "email", None) or "",
            "full_name": metadata.get("full_name"),
            "email_verified": bool(getattr(auth_user, "email_confirmed_at", None)),
            "exp": None,
        }

    except HTTPException:
        raise

    except Exception as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid or expired token.",
        ) from exc


def _verify_token(token: str) -> dict[str, Any]:
    local = _verify_local(token)
    if local is not None:
        return local
    return _verify_remote(token)


# ---------------------------------------------------------------- identity cache

_cache: dict[str, tuple[float, "CurrentUser"]] = {}
_cache_lock = threading.Lock()


def _cache_get(token: str) -> CurrentUser | None:
    now = time.time()
    with _cache_lock:
        entry = _cache.get(token)
        if not entry:
            return None
        expires_at, user = entry
        if expires_at <= now:
            _cache.pop(token, None)
            return None
        return user


def _cache_put(token: str, user: CurrentUser, token_exp: Any = None) -> None:
    expires_at = time.time() + IDENTITY_TTL_SECONDS
    if token_exp:
        try:
            expires_at = min(expires_at, float(token_exp))
        except (TypeError, ValueError):
            pass
    with _cache_lock:
        if len(_cache) >= IDENTITY_CACHE_MAX:
            now = time.time()
            for key in [k for k, (exp, _) in _cache.items() if exp <= now]:
                _cache.pop(key, None)
            if len(_cache) >= IDENTITY_CACHE_MAX:
                oldest = min(_cache, key=lambda k: _cache[k][0])
                _cache.pop(oldest, None)
        _cache[token] = (expires_at, user)


def invalidate_identity(user_id: str | None = None) -> None:
    """Drop cached identities after a role, store-assignment or activation change."""
    with _cache_lock:
        if user_id is None:
            _cache.clear()
            return
        for key in [k for k, (_, u) in _cache.items() if u.id == user_id]:
            _cache.pop(key, None)


# ---------------------------------------------------------------- dependency


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> CurrentUser:
    """Resolve the signed-in user.

    Deliberately ``def`` rather than ``async def``: everything underneath is
    blocking I/O, so FastAPI should run it in a worker thread instead of on the
    event loop.
    """
    if creds is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Sign in to continue.",
        )

    token = creds.credentials

    cached = _cache_get(token)
    if cached is not None:
        return cached

    claims = _verify_token(token)

    user_id = claims.get("sub")

    if not user_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Token is missing a subject.",
        )

    from ..services.profiles import ensure_profile, role_of

    svc = service_client()

    row, _ = ensure_profile(
        user_id,
        claims.get("email") or "",
        claims.get("full_name"),
        email_verified=bool(claims.get("email_verified")),
    )

    if not row["is_active"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This account has been deactivated. Contact an administrator.",
        )

    role = role_of(row)

    # Only store managers are scoped by assignment, so only they need the extra
    # query — everyone else sees all stores regardless of what it returns.
    store_ids: list[str] = []
    if role == "store_manager":
        stores = (
            svc.table("user_store_assignments")
            .select("store_id")
            .eq("user_id", user_id)
            .execute()
        ).data
        store_ids = [s["store_id"] for s in stores]

    user = CurrentUser(
        id=row["id"],
        email=row["email"],
        role=role,
        full_name=row.get("full_name"),
        is_active=row["is_active"],
        email_verified=row["email_verified"],
        token=token,
        store_ids=store_ids,
    )

    _cache_put(token, user, claims.get("exp"))
    return user


def require_roles(*roles: str):
    allowed = set(roles)

    def guard(
        user: CurrentUser = Depends(current_user),
    ) -> CurrentUser:

        if user.role not in allowed:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"This action needs one of: {', '.join(sorted(allowed))}.",
            )

        return user

    return guard


def require_min_role(role: str):
    floor = ROLE_RANK[role]

    def guard(
        user: CurrentUser = Depends(current_user),
    ) -> CurrentUser:

        if ROLE_RANK.get(user.role, 0) < floor:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "You don't have access to this.",
            )

        return user

    return guard


require_admin = require_roles("super_admin", "admin")

require_staff = require_roles(
    "super_admin",
    "admin",
    "inventory_manager",
)

require_super = require_roles("super_admin")

require_warehouse = require_roles(
    "warehouse",
    "super_admin",
    "admin",
    "inventory_manager",
)


def scope_stores(
    user: CurrentUser,
    requested: str | None,
) -> list[str] | None:

    """Resolve which stores a query may touch. None means 'all stores'."""

    if user.role != "store_manager":
        return [requested] if requested else None

    if requested:
        if requested not in user.store_ids:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "You aren't assigned to that store.",
            )

        return [requested]

    return user.store_ids


def audit(
    user: CurrentUser,
    action: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    detail: dict | None = None,
) -> None:

    try:
        service_client().table("audit_logs").insert({
            "user_id": user.id,
            "user_email": user.email,
            "action": action,
            "entity_type": entity_type,
            "entity_id": str(entity_id) if entity_id else None,
            "detail": detail,
        }).execute()

    except Exception:
        # Auditing must never break the request.
        pass
