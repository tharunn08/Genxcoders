"""Site administration: dynamic branding, the media library and announcements.

Everything here is additive — two new tables (site_media, announcements) and a
set of branding.* keys inside the existing system_settings table, all created by
supabase/migrations/0004_site_admin.sql. The reads are safe on a project that
has not run the migration: they return defaults instead of failing, so a stale
backend cannot break the login page or the layout.

Writes are super admin only, enforced here with ``require_super`` and again in
row-level security. Every write goes through the existing audit helper.
"""
from __future__ import annotations

import time

from fastapi import (APIRouter, Body, Depends, File, HTTPException, Query,
                     UploadFile, status)
from pydantic import BaseModel

from ..core.config import get_settings, service_client
from ..core.db import db_error, utcnow_iso
from ..core.security import CurrentUser, audit, current_user, require_super

router = APIRouter(prefix="/site", tags=["site"])

BRANDING_PREFIX = "branding."

# Keys a super admin may publish. Everything else in system_settings stays out
# of the branding form, so an accidental PUT can't touch a computation threshold.
BRANDING_FIELDS = {
    "platform_name", "short_name", "website_title", "website_subtitle",
    "company_name", "support_email", "footer_text", "logo_url", "logo_light_url",
    "logo_dark_url", "favicon_url", "login_logo_url", "dashboard_logo_url",
    "login_welcome_title", "login_welcome_subtitle", "login_background_url",
    "login_announcement", "dashboard_welcome_title", "dashboard_welcome_message",
    "dashboard_banner_url", "announcement_banner",
}

DEFAULTS: dict[str, str | None] = {
    "platform_name": "RetailMind AI",
    "short_name": "RetailMind",
    "website_title": "RetailMind AI — Predict smarter. Stock smarter. Sell better.",
    "website_subtitle": "AI-powered retail intelligence and smart inventory platform",
    "company_name": "RetailMind",
    "support_email": None,
    "footer_text": "RetailMind AI",
    "logo_url": None,
    "logo_light_url": None,
    "logo_dark_url": None,
    "favicon_url": None,
    "login_logo_url": None,
    "dashboard_logo_url": None,
    "login_welcome_title": "Welcome to RetailMind AI",
    "login_welcome_subtitle": "Inventory intelligence for smarter retail decisions.",
    "login_background_url": None,
    "login_announcement": None,
    "dashboard_welcome_title": None,
    "dashboard_welcome_message": None,
    "dashboard_banner_url": None,
    "announcement_banner": None,
}


def _load_branding_rows() -> dict[str, str | None]:
    """branding.* settings as {short_key: value}, defaults applied."""
    svc = service_client()
    try:
        rows = (svc.table("system_settings")
                .select("key,value")
                .ilike("key", BRANDING_PREFIX + "%")
                .execute()).data
    except Exception:
        return dict(DEFAULTS)  # migration not run — fall back to the defaults

    out = dict(DEFAULTS)
    for row in rows:
        key = row["key"][len(BRANDING_PREFIX):]
        value = row.get("value")
        if key in out:
            # Stored as jsonb: strings arrive as str, null as None.
            out[key] = value if value is None or isinstance(value, str) else str(value)
    return out


# ---------------------------------------------------------------- branding


@router.get("/branding")
def get_branding():
    """Public branding — this is the content of the login page itself, so it
    deliberately does not require a session."""
    return _load_branding_rows()


class BrandingIn(BaseModel):
    values: dict


@router.put("/branding")
def update_branding(payload: BrandingIn, user: CurrentUser = Depends(require_super)):
    """Publish branding changes. Only whitelisted keys are written."""
    allowed = {k: v for k, v in payload.values.items()
               if k in BRANDING_FIELDS and isinstance(v, (str, type(None)))}
    if not allowed:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")

    svc = service_client()
    now = utcnow_iso()
    try:
        svc.table("system_settings").upsert([
            {"key": BRANDING_PREFIX + k, "value": v,
             "updated_by": user.id, "updated_at": now}
            for k, v in allowed.items()
        ], on_conflict="key").execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't save the branding changes") from exc

    audit(user, "site.branding.update", "system_setting", None, {"keys": list(allowed)})
    return {"message": "Branding published.", "branding": _load_branding_rows()}


# ---------------------------------------------------------------- announcements


class AnnouncementIn(BaseModel):
    title: str
    message: str
    image_url: str | None = None
    priority: str = "medium"
    target_roles: list[str] | None = None   # None = everyone
    start_at: str | None = None
    end_at: str | None = None
    is_published: bool = True


@router.get("/announcements")
def list_announcements(user: CurrentUser = Depends(current_user)):
    """Super admins see everything; other roles only published, live,
    role-targeted announcements."""
    svc = service_client()
    rows = (svc.table("announcements").select("*")
            .order("created_at", desc=True).limit(200).execute()).data
    if not rows:
        return {"items": []}

    if not user.is_super:
        now = utcnow_iso()
        visible = []
        for row in rows:
            if not row.get("is_published"):
                continue
            if row.get("start_at") and row["start_at"] > now:
                continue
            if row.get("end_at") and row["end_at"] < now:
                continue
            targets = row.get("target_roles")
            if targets and user.role not in targets:
                continue
            visible.append(row)
        return {"items": visible}

    return {"items": rows}


@router.post("/announcements", status_code=201)
def create_announcement(payload: AnnouncementIn,
                        user: CurrentUser = Depends(require_super)):
    title = payload.title.strip()
    message = payload.message.strip()
    if not title or not message:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Title and message are both required.")
    if payload.priority not in ("low", "medium", "high", "critical"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown priority.")

    svc = service_client()
    try:
        row = svc.table("announcements").insert({
            "title": title, "message": message,
            "image_url": payload.image_url, "priority": payload.priority,
            "target_roles": payload.target_roles or None,
            "start_at": payload.start_at or None, "end_at": payload.end_at or None,
            "is_published": payload.is_published, "created_by": user.id,
        }).execute().data[0]
    except Exception as exc:
        raise db_error(exc, "Couldn't create that announcement") from exc

    audit(user, "announcement.create", "announcement", row["id"], {"title": title})
    return row


class AnnouncementPatch(BaseModel):
    title: str | None = None
    message: str | None = None
    image_url: str | None = None
    priority: str | None = None
    target_roles: list[str] | None = None
    start_at: str | None = None
    end_at: str | None = None
    is_published: bool | None = None


@router.patch("/announcements/{announcement_id}")
def update_announcement(announcement_id: str, payload: AnnouncementPatch,
                        user: CurrentUser = Depends(require_super)):
    # exclude_unset keeps explicit nulls (clear an image) and empty lists
    # (announcement targets everyone again) while skipping untouched fields.
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")
    if data.get("priority") not in (None, "low", "medium", "high", "critical"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown priority.")

    svc = service_client()
    try:
        rows = svc.table("announcements").update(data).eq("id", announcement_id).execute().data
    except Exception as exc:
        raise db_error(exc, "Couldn't update that announcement") from exc
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That announcement doesn't exist.")

    audit(user, "announcement.update", "announcement", announcement_id, data)
    return {"message": "Announcement updated.", "announcement": rows[0]}


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: str, user: CurrentUser = Depends(require_super)):
    service_client().table("announcements").delete().eq("id", announcement_id).execute()
    audit(user, "announcement.delete", "announcement", announcement_id)
    return {"message": "Announcement deleted."}


# ---------------------------------------------------------------- media library


IMAGE_TYPES = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
    "image/svg+xml": ".svg",
}
MAX_IMAGE_BYTES = 8 * 1024 * 1024
BUCKET = "website-media"
CATEGORIES = {"logo", "login", "banner", "announcement", "general"}


@router.get("/media")
def list_media(user: CurrentUser = Depends(require_super)):
    rows = (service_client().table("site_media").select("*, profiles(full_name,email)")
            .order("created_at", desc=True).limit(500).execute()).data
    return {"items": rows}


@router.post("/media", status_code=201)
async def upload_media(
    file: UploadFile = File(...),
    category: str = Query("general"),
    user: CurrentUser = Depends(require_super),
):
    """Upload an approved website asset to the website-media bucket and record it."""
    if category not in CATEGORIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Category must be one of: {', '.join(sorted(CATEGORIES))}.")

    content_type = (file.content_type or "").lower().split(";")[0]
    if content_type not in IMAGE_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Images must be JPEG, PNG, WebP, GIF, AVIF or SVG. "
            f"That file is {content_type or 'of an unknown type'}.")

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Images are limited to 8 MB. That one is {len(content) / 1024 / 1024:.1f} MB.")

    svc = service_client()
    suffix = IMAGE_TYPES[content_type]
    filename = (file.filename or "asset").strip()
    key = f"{category}/{int(time.time())}-{abs(hash(filename)) % 100000}{suffix}"
    try:
        svc.storage.from_(BUCKET).upload(
            key, content, {"content-type": content_type, "upsert": "true"})
    except Exception as exc:
        message = str(exc)
        if "bucket" in message.lower() and "not found" in message.lower():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "The 'website-media' storage bucket doesn't exist. Run "
                "supabase/migrations/0004_site_admin.sql to create it.") from exc
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Supabase Storage rejected the upload: {message[:200]}") from exc

    url = f"{get_settings().supabase_url}/storage/v1/object/public/{BUCKET}/{key}"
    try:
        row = svc.table("site_media").insert({
            "filename": filename, "storage_path": key, "url": url,
            "mime_type": content_type, "size_bytes": len(content),
            "category": category, "uploaded_by": user.id,
        }).execute().data[0]
    except Exception as exc:
        raise db_error(exc, "The image uploaded but couldn't be recorded") from exc

    audit(user, "site.media.upload", "site_media", row["id"],
          {"filename": filename, "category": category})
    return row


@router.delete("/media/{media_id}")
def delete_media(media_id: str, user: CurrentUser = Depends(require_super)):
    """Remove a media asset and its storage object."""
    svc = service_client()
    rows = (svc.table("site_media").select("*").eq("id", media_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That asset doesn't exist.")

    try:
        svc.storage.from_(BUCKET).remove([rows[0]["storage_path"]])
    except Exception:
        pass  # the metadata row is the record of truth; an orphan object is harmless

    try:
        svc.table("site_media").delete().eq("id", media_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't delete that asset") from exc

    audit(user, "site.media.delete", "site_media", media_id,
          {"filename": rows[0]["filename"]})
    return {"message": "Asset deleted."}