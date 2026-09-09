"""Profile provisioning.

The database trigger on auth.users creates a profile for every new signup, but a
profile can still be missing: users created before the trigger existed, users
made directly in the Supabase dashboard, or a signup that raced the trigger.

Previously that produced a successful Supabase login followed by a hard 403,
which reads to the user as "my password is right but the app is broken". This
module repairs the gap instead, and reports whether it had to.
"""
from __future__ import annotations

from typing import Any

from ..core.config import service_client

DEFAULT_ROLE_ID = 4  # store_manager — least privilege


def load_profile(user_id: str) -> dict[str, Any] | None:
    rows = (
        service_client()
        .table("profiles")
        .select("id,email,full_name,is_active,email_verified,role_id,roles(name)")
        .eq("id", user_id)
        .limit(1)
        .execute()
    ).data
    return rows[0] if rows else None


def ensure_profile(
    user_id: str,
    email: str,
    full_name: str | None = None,
    *,
    email_verified: bool = False,
) -> tuple[dict[str, Any], bool]:
    """Returns (profile, was_created). Never raises for a missing row."""
    existing = load_profile(user_id)
    if existing:
        # Backfill anything the trigger or an earlier import left blank.
        patch: dict[str, Any] = {}
        if not existing.get("full_name") and full_name:
            patch["full_name"] = full_name
        if email and existing.get("email") != email:
            patch["email"] = email
        if email_verified and not existing.get("email_verified"):
            patch["email_verified"] = True
        if existing.get("role_id") is None:
            patch["role_id"] = DEFAULT_ROLE_ID
        if patch:
            service_client().table("profiles").update(patch).eq("id", user_id).execute()
            existing = load_profile(user_id) or existing
        return existing, False

    service_client().table("profiles").upsert({
        "id": user_id,
        "email": email,
        "full_name": full_name or (email.split("@")[0] if email else "New user"),
        "role_id": DEFAULT_ROLE_ID,
        "email_verified": email_verified,
        "is_active": True,
    }).execute()

    created = load_profile(user_id)
    if created is None:
        # Fall back to an in-memory shape so the request can still complete.
        created = {
            "id": user_id, "email": email, "full_name": full_name,
            "is_active": True, "email_verified": email_verified,
            "role_id": DEFAULT_ROLE_ID, "roles": {"name": "store_manager"},
        }
    return created, True


def role_of(profile: dict[str, Any]) -> str:
    role = profile.get("roles")
    if isinstance(role, dict) and role.get("name"):
        return role["name"]
    return {1: "super_admin", 2: "admin", 3: "inventory_manager",
            4: "store_manager", 5: "warehouse"}.get(
                profile.get("role_id") or DEFAULT_ROLE_ID, "store_manager")


def stores_of(user_id: str) -> list[dict[str, Any]]:
    rows = (
        service_client()
        .table("user_store_assignments")
        .select("stores(id,code,name,location,address)")
        .eq("user_id", user_id)
        .execute()
    ).data
    return [r["stores"] for r in rows if r.get("stores")]


def public_user(profile: dict[str, Any]) -> dict[str, Any]:
    """The shape the frontend consumes. Never includes role_id or internals."""
    return {
        "id": profile["id"],
        "email": profile["email"],
        "full_name": profile.get("full_name"),
        "role": role_of(profile),
        "email_verified": bool(profile.get("email_verified")),
        "stores": stores_of(profile["id"]),
    }
