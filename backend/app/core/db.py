"""Database helpers shared across routers and services.

Two things live here because they were being got wrong in several places at once.

1. ``utcnow_iso``. The codebase used the literal string ``"now()"`` as a
   timestamp value in PostgREST payloads. PostgreSQL accepts ``'now'`` as a
   special datetime input but *not* ``'now()'`` — the parentheses make it a
   function call, which is not valid in a value position. Every write that used
   it risked failing with ``invalid input syntax for type timestamp with time
   zone``. The failures were especially confusing on the import commit path,
   where the rows had already been written before the status update blew up, so
   the user saw "import failed" over data that was actually saved.

2. ``db_error``. supabase-py raises ``postgrest.APIError`` carrying a Postgres
   SQLSTATE. Letting that reach the generic 500 handler threw away the one piece
   of information that explains the failure. Mapping it gives the frontend a
   real message such as "SKU ABC already exists" instead of "Something went
   wrong on our side."
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status

try:  # postgrest is always present via supabase, but never crash on import
    from postgrest.exceptions import APIError
except Exception:  # pragma: no cover
    class APIError(Exception):  # type: ignore[no-redef]
        code = None
        message = None
        details = None
        hint = None


def utcnow_iso() -> str:
    """An unambiguous timestamptz literal PostgreSQL always accepts."""
    return datetime.now(timezone.utc).isoformat()


# SQLSTATE -> (http status, human sentence)
_SQLSTATE: dict[str, tuple[int, str]] = {
    "23505": (status.HTTP_409_CONFLICT, "That record already exists."),
    "23503": (status.HTTP_400_BAD_REQUEST,
              "That references something that doesn't exist — check the store, "
              "product or category you selected."),
    "23502": (status.HTTP_400_BAD_REQUEST, "A required field was left empty."),
    "23514": (status.HTTP_400_BAD_REQUEST, "A value fell outside what this field allows."),
    "22P02": (status.HTTP_400_BAD_REQUEST,
              "A value had the wrong type — a number column probably received text."),
    "22007": (status.HTTP_400_BAD_REQUEST, "A date value couldn't be understood."),
    "22003": (status.HTTP_400_BAD_REQUEST, "A number was too large for its column."),
    "42703": (status.HTTP_400_BAD_REQUEST,
              "The database is missing a column this build expects. Run the "
              "migrations in supabase/migrations."),
    "42P01": (status.HTTP_400_BAD_REQUEST,
              "A table this build expects is missing. Run supabase/migrations/0001_schema.sql."),
    "42501": (status.HTTP_403_FORBIDDEN,
              "The database refused this write for your role (row-level security)."),
    "PGRST116": (status.HTTP_404_NOT_FOUND, "No matching record."),
    "PGRST204": (status.HTTP_400_BAD_REQUEST,
                 "The database is missing a column this build expects. Run the "
                 "migrations in supabase/migrations."),
    "PGRST301": (status.HTTP_401_UNAUTHORIZED, "Your session expired. Sign in again."),
}


def describe_db_error(exc: Exception) -> tuple[int, str, str | None]:
    """(http_status, message, detail) for any exception raised by supabase-py."""
    if isinstance(exc, HTTPException):
        return exc.status_code, str(exc.detail), None

    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None) or str(exc)
    details = getattr(exc, "details", None)
    hint = getattr(exc, "hint", None)

    mapped = _SQLSTATE.get(str(code)) if code else None
    if mapped:
        http_status, sentence = mapped
        # Postgres puts the offending constraint in the message; keeping it makes
        # "That record already exists" actionable.
        if code == "23505" and message:
            sentence = f"{sentence} ({message})"
        return http_status, sentence, details or hint or message

    text = message.lower()
    if "bucket not found" in text:
        return (status.HTTP_400_BAD_REQUEST,
                "A Supabase Storage bucket this feature needs doesn't exist yet.",
                message)
    if "jwt" in text and "expired" in text:
        return status.HTTP_401_UNAUTHORIZED, "Your session expired. Sign in again.", message

    return status.HTTP_500_INTERNAL_SERVER_ERROR, message[:300] or "Database error.", details


def db_error(exc: Exception, context: str | None = None) -> HTTPException:
    """Translate a supabase-py failure into an HTTPException worth reading."""
    http_status, message, detail = describe_db_error(exc)
    if context:
        message = f"{context}: {message}"
    return HTTPException(http_status, message) if not detail else HTTPException(
        http_status, message)
