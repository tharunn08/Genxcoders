"""Where an uploaded import file lives between wizard steps.

## Why this exists

The wizard has five steps and four of them need the file again: suggest-mapping,
validate, and commit each re-downloaded it from Supabase Storage and re-parsed
it from scratch. That made the whole feature depend on Storage being reachable
and correctly configured for every step, not just the first.

It wasn't configured. ``0002_rls.sql`` creates the ``product-images`` bucket;
the ``imports`` bucket is a manual step buried in SUPABASE_SETUP.md. If it was
missed — and it usually is — the upload endpoint inserted its ``data_imports``
row, then threw on ``storage.from_("imports").upload(...)`` and returned a 500,
leaving an orphaned row behind. From the browser that looks like "the import
just fails sometimes", because whether it failed depended on setup state nobody
had written down.

Two changes:

* **The bucket is created on demand.** The service-role key can create buckets,
  so a missing ``imports`` bucket is now a thing the server fixes rather than a
  thing the user has to read documentation about. It is created private.
* **A local cache is authoritative for the session.** The bytes are written to
  disk next to the backend as soon as they arrive, and later steps read from
  there. Storage becomes the durable archive it was meant to be rather than a
  hard dependency of every step, and steps 2-5 stop paying a download each.

If Storage is unavailable entirely, the wizard still completes end to end from
the local cache, and the response says the archive copy didn't happen instead of
failing the import.
"""
from __future__ import annotations

import logging
import re
import shutil
import time
from pathlib import Path

from ..core.config import get_settings, service_client

log = logging.getLogger("retailmind.imports")

BUCKET = "imports"
CACHE_DIR = Path(__file__).resolve().parents[2] / ".import_cache"
CACHE_TTL_SECONDS = 24 * 60 * 60


def safe_filename(name: str | None) -> str:
    """A storage-key-safe filename.

    Supabase object keys reject some characters outright and silently mangle
    others. A file called ``Stock Report (Nov'25).xlsx`` — entirely normal —
    could fail to upload, or upload to a path the download step couldn't
    reconstruct.
    """
    cleaned = (name or "upload").strip().replace("\\", "/").split("/")[-1]
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", cleaned).strip("._-")
    return (cleaned or "upload")[:120]


def _cache_path(import_id: str, filename: str) -> Path:
    return CACHE_DIR / str(import_id) / safe_filename(filename)


def _prune_cache() -> None:
    """Drop cached uploads older than a day. Best effort, never raises."""
    try:
        if not CACHE_DIR.exists():
            return
        cutoff = time.time() - CACHE_TTL_SECONDS
        for folder in CACHE_DIR.iterdir():
            try:
                if folder.is_dir() and folder.stat().st_mtime < cutoff:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                continue
    except Exception:
        pass


def ensure_bucket() -> bool:
    """Make sure the private `imports` bucket exists. True if it's usable."""
    svc = service_client()
    try:
        svc.storage.get_bucket(BUCKET)
        return True
    except Exception:
        pass

    try:
        svc.storage.create_bucket(BUCKET, options={"public": False})
        log.info("Created private Supabase Storage bucket '%s'.", BUCKET)
        return True
    except Exception as exc:
        message = str(exc).lower()
        if "already exists" in message or "duplicate" in message:
            return True
        log.warning("Couldn't create the '%s' storage bucket: %s", BUCKET, exc)
        return False


def save(import_id: str, filename: str, content: bytes,
         content_type: str | None = None) -> tuple[str | None, str | None]:
    """Persist an upload. Returns (storage_path, warning).

    The local write is the one that must succeed; the Storage write is the
    archive copy. A warning is returned rather than raised so a Storage
    misconfiguration degrades the feature instead of blocking it.
    """
    name = safe_filename(filename)
    path = _cache_path(import_id, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    _prune_cache()

    if not ensure_bucket():
        return None, ("The file was processed but couldn't be archived to Supabase "
                      "Storage — the 'imports' bucket is missing and couldn't be "
                      "created. Imports still work; the raw file just isn't kept.")

    storage_path = f"{import_id}/{name}"
    try:
        service_client().storage.from_(BUCKET).upload(
            storage_path,
            content,
            {"content-type": content_type or "application/octet-stream",
             "upsert": "true"},
        )
        return storage_path, None
    except Exception as exc:
        log.warning("Storage upload failed for %s: %s", storage_path, exc)
        return None, (f"The file was processed but couldn't be archived to Supabase "
                      f"Storage ({str(exc)[:160]}). Imports still work; the raw "
                      "file just isn't kept.")


def load(import_id: str, filename: str, storage_path: str | None) -> bytes:
    """Read an upload back, local cache first."""
    name = safe_filename(filename)
    path = _cache_path(import_id, name)

    if path.exists():
        try:
            return path.read_bytes()
        except OSError:
            pass

    if not storage_path:
        raise FileNotFoundError(
            "The uploaded file is no longer available on this server and wasn't "
            "archived to Storage. Upload it again to continue."
        )

    content = service_client().storage.from_(BUCKET).download(storage_path)

    # Repopulate the cache so the remaining steps are local again.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    except OSError:
        pass

    return content


def forget(import_id: str) -> None:
    shutil.rmtree(CACHE_DIR / str(import_id), ignore_errors=True)
