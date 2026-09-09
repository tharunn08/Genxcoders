"""The import wizard, one endpoint per step.

Every row is written to import_staging_rows before anything is normalised, so
the raw data survives regardless of how the mapping turns out.

## What changed

* **Order of operations.** The upload endpoint used to insert the
  ``data_imports`` row, then store the file, then throw if Storage wasn't set
  up — leaving an orphaned row and returning a 500 with the file already
  accepted. The file is now parsed first (so an unreadable file costs no rows),
  then recorded, then persisted.
* **Storage is no longer a hard dependency of every step.** See
  services/import_store.py.
* **Real timestamps.** ``"completed_at": "now()"`` is not a valid timestamptz
  literal in PostgreSQL — ``'now'`` is, ``'now()'`` is a function call in a value
  position. That update ran *after* the rows were written, so a successful
  import reported itself as a failure.
* **Errors say what went wrong.** Parse failures, mapping mistakes, permission
  failures and database failures are now distinguished instead of collapsing
  into one 500.
"""
from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from ..core.config import service_client
from ..core.db import db_error, utcnow_iso
from ..core.security import CurrentUser, audit, require_admin
from ..services import import_engine as ie
from ..services import import_store
from ..services._parsing import FileUnreadable
from ..services.import_commit import commit_import

router = APIRouter(prefix="/imports", tags=["imports"])
log = logging.getLogger("retailmind.imports")

MAX_BYTES = 50 * 1024 * 1024
ALLOWED_SUFFIXES = (".xlsx", ".xls", ".xlsm", ".csv", ".tsv", ".txt", ".json")


def _load_import(import_id: str) -> dict:
    svc = service_client()
    rows = (svc.table("data_imports")
            .select("id,filename,storage_path,import_type,sheet_name,status")
            .eq("id", import_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "That import doesn't exist. It may have been deleted — upload the "
            "file again to start over.")
    return rows[0]


def _fetch_file(import_id: str) -> tuple[bytes, str]:
    record = _load_import(import_id)
    try:
        content = import_store.load(
            import_id, record["filename"], record.get("storage_path"))
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_410_GONE, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "The uploaded file couldn't be read back from Supabase Storage: "
            f"{str(exc)[:200]}") from exc
    return content, record["filename"]


@router.post("/upload", status_code=201)
async def upload(
    file: UploadFile = File(...),
    import_type: str = Form("other"),
    user: CurrentUser = Depends(require_admin),
):
    """Step 1 and 2: read the file, detect its shape, suggest a mapping."""
    filename = file.filename or "upload"
    if not filename.lower().endswith(ALLOWED_SUFFIXES):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"'{filename}' isn't a supported format. Upload .xlsx, .xls, .xlsm, "
            ".csv, .tsv or .json.")

    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "Files are limited to 50 MB.")
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That file is empty.")

    # Parse before writing anything. An unreadable file should cost a 400 and no
    # database rows, not a 500 and an orphaned import record.
    try:
        profile = ie.profile_file(content, filename)
    except FileUnreadable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:
        log.exception("Unexpected parse failure for %s", filename)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This file couldn't be read: {type(exc).__name__}: {exc}") from exc

    if not profile.sheets:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That file has no readable rows.")

    svc = service_client()
    try:
        record = svc.table("data_imports").insert({
            "filename": import_store.safe_filename(filename),
            "file_type": profile.file_type,
            "import_type": import_type if import_type in ie.FIELD_SPECS else "other",
            "status": "profiled",
            "uploaded_by": user.id,
            "detected_headers": {s.name: s.headers for s in profile.sheets},
            "total_rows": sum(s.row_count for s in profile.sheets),
        }).execute().data[0]
    except Exception as exc:
        raise db_error(exc, "Couldn't record this import") from exc

    storage_path, warning = import_store.save(
        record["id"], filename, content, file.content_type)

    if storage_path:
        try:
            svc.table("data_imports").update(
                {"storage_path": storage_path}).eq("id", record["id"]).execute()
        except Exception:
            pass

    audit(user, "import.upload", "data_import", record["id"], {"filename": filename})

    first = profile.sheets[0]
    return {
        "import_id": record["id"],
        "file_type": profile.file_type,
        "warning": warning,
        "sheets": [
            {"name": s.name, "headers": s.headers, "row_count": s.row_count,
             "sample_rows": s.sample_rows}
            for s in profile.sheets
        ],
        "suggested_mapping": ie.suggest_mapping(first.headers, import_type)
        if import_type in ie.FIELD_SPECS else {},
    }


class MappingRequest(BaseModel):
    import_type: str
    sheet_name: str | None = None


@router.post("/{import_id}/suggest-mapping")
def suggest(import_id: str, payload: MappingRequest,
            user: CurrentUser = Depends(require_admin)):
    """Step 3 and 4: recompute suggestions after the admin picks a type or sheet."""
    if payload.import_type not in ie.FIELD_SPECS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown import type '{payload.import_type}'. Choose one of: "
            f"{', '.join(ie.FIELD_SPECS)}.")

    content, filename = _fetch_file(import_id)
    try:
        profile = ie.profile_file(content, filename)
    except FileUnreadable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    sheet = next((s for s in profile.sheets if s.name == payload.sheet_name),
                 profile.sheets[0])

    try:
        service_client().table("data_imports").update({
            "import_type": payload.import_type,
            "sheet_name": sheet.name,
        }).eq("id", import_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't save the import type") from exc

    return {
        "headers": sheet.headers,
        "row_count": sheet.row_count,
        "sample_rows": sheet.sample_rows,
        "mapping": ie.suggest_mapping(sheet.headers, payload.import_type),
        "fields": {
            name: {"label": spec["label"], "required": spec["required"]}
            for name, spec in ie.FIELD_SPECS[payload.import_type].items()
        },
    }


class ValidateRequest(BaseModel):
    import_type: str
    sheet_name: str | None = None
    mapping: dict


@router.post("/{import_id}/validate")
def validate(import_id: str, payload: ValidateRequest,
             user: CurrentUser = Depends(require_admin)):
    """Step 5 and 6: validate every row and return counts plus a preview."""
    if payload.import_type not in ie.FIELD_SPECS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown import type '{payload.import_type}'.")

    content, filename = _fetch_file(import_id)
    try:
        rows = ie.load_rows(content, filename, payload.sheet_name)
    except FileUnreadable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    if not rows:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "That sheet has no data rows once blank rows are removed.")

    missing = [spec["label"] for name, spec in ie.FIELD_SPECS[payload.import_type].items()
               if spec["required"] and not (payload.mapping.get(name) or {}).get("source")]
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"These required columns aren't mapped yet: {', '.join(missing)}.")

    report = ie.validate_rows(rows, payload.mapping, payload.import_type)

    svc = service_client()
    try:
        svc.table("data_imports").update({
            "status": "validated",
            "column_mapping": payload.mapping,
            "sheet_name": payload.sheet_name,
            "total_rows": report.total_rows,
            "valid_rows": report.valid_rows,
            "invalid_rows": report.invalid_rows,
            "duplicate_rows": report.duplicate_rows,
        }).eq("id", import_id).execute()

        svc.table("data_import_errors").delete().eq("import_id", import_id).execute()
        if report.errors:
            svc.table("data_import_errors").insert([
                {"import_id": import_id, "row_number": e.row_number,
                 "column_name": e.column_name, "error_code": e.error_code,
                 "message": e.message}
                for e in report.errors[:500]
            ]).execute()
    except Exception as exc:
        # Validation itself succeeded; failing to record it shouldn't lose the
        # result the user is waiting for.
        log.warning("Couldn't persist validation report for %s: %s", import_id, exc)

    return {
        "total_rows": report.total_rows,
        "valid_rows": report.valid_rows,
        "invalid_rows": report.invalid_rows,
        "duplicate_rows": report.duplicate_rows,
        "preview": report.preview,
        "errors": [asdict(e) for e in report.errors[:100]],
    }


class CommitRequest(BaseModel):
    import_type: str
    sheet_name: str | None = None
    mapping: dict
    mode: str = "upsert"
    store_id: str | None = None
    skip_invalid: bool = True
    create_missing_products: bool = True


@router.post("/{import_id}/commit")
def commit(import_id: str, payload: CommitRequest,
           user: CurrentUser = Depends(require_admin)):
    """Step 7 and 8: write the rows, then report exactly what happened."""
    if payload.mode not in ("upsert", "create_only", "update_only", "skip_duplicates"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown import mode '{payload.mode}'.")

    content, filename = _fetch_file(import_id)
    try:
        rows = ie.load_rows(content, filename, payload.sheet_name)
    except FileUnreadable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "There are no rows to import.")

    svc = service_client()
    svc.table("data_imports").update({"status": "importing"}).eq("id", import_id).execute()

    # Preserve raw rows before touching the operational tables.
    try:
        svc.table("import_staging_rows").delete().eq("import_id", import_id).execute()
        staged = [{"import_id": import_id, "row_number": i, "raw": row}
                  for i, row in enumerate(rows, start=1)]
        for start in range(0, len(staged), 500):
            svc.table("import_staging_rows").insert(staged[start:start + 500]).execute()
    except Exception as exc:
        log.warning("Couldn't stage raw rows for %s: %s", import_id, exc)

    skipped_invalid = 0
    if payload.skip_invalid:
        report = ie.validate_rows(rows, payload.mapping, payload.import_type,
                                  preview_size=0)
        bad = {e.row_number for e in report.errors}
        if bad:
            rows = [row for i, row in enumerate(rows, start=1) if i not in bad]
            skipped_invalid = len(bad)
        if not rows:
            svc.table("data_imports").update(
                {"status": "failed"}).eq("id", import_id).execute()
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Every row failed validation, so nothing was imported. Check the "
                "column mapping — a required column is probably pointed at the "
                "wrong source column.")

    try:
        result = commit_import(
            svc, import_id=import_id, rows=rows, mapping=payload.mapping,
            import_type=payload.import_type, mode=payload.mode,
            default_store_id=payload.store_id,
            create_missing_products=payload.create_missing_products,
            actor_id=user.id,
        )
    except Exception as exc:
        svc.table("data_imports").update({"status": "failed"}).eq("id", import_id).execute()
        log.exception("Import %s failed", import_id)
        raise db_error(exc, "Import failed") from exc

    result.skipped += skipped_invalid

    try:
        svc.table("data_imports").update({
            "status": "completed",
            "created_count": result.created,
            "updated_count": result.updated,
            "skipped_count": result.skipped,
            "failed_count": result.failed,
            "options": {"mode": payload.mode, "unmatched": result.unmatched},
            "target_store_id": payload.store_id,
            "completed_at": utcnow_iso(),
        }).eq("id", import_id).execute()
    except Exception as exc:
        # The rows are in. Reporting that they are in must not undo them.
        log.warning("Import %s completed but the status update failed: %s", import_id, exc)

    audit(user, "import.commit", "data_import", import_id,
          {"type": payload.import_type, "created": result.created,
           "updated": result.updated})

    return {
        "created": result.created,
        "updated": result.updated,
        "skipped": result.skipped,
        "failed": result.failed,
        "unmatched": result.unmatched,
        "messages": result.messages,
    }


@router.get("")
def history(limit: int = 25, user: CurrentUser = Depends(require_admin)):
    try:
        rows = (service_client().table("data_imports")
                .select("*, profiles(full_name,email)")
                .order("created_at", desc=True).limit(limit).execute()).data
    except Exception:
        # The embed needs a foreign key PostgREST can see. If the schema cache
        # hasn't picked it up, the history list is still worth showing.
        rows = (service_client().table("data_imports").select("*")
                .order("created_at", desc=True).limit(limit).execute()).data
    return {"imports": rows}


@router.delete("/{import_id}")
def delete_import(import_id: str, user: CurrentUser = Depends(require_admin)):
    """Remove an import record. Rows already imported are not touched."""
    svc = service_client()
    record = _load_import(import_id)
    if record.get("storage_path"):
        try:
            svc.storage.from_(import_store.BUCKET).remove([record["storage_path"]])
        except Exception:
            pass
    import_store.forget(import_id)
    try:
        svc.table("data_imports").delete().eq("id", import_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't delete that import") from exc
    audit(user, "import.delete", "data_import", import_id)
    return {"message": "Import record removed."}


@router.get("/{import_id}/errors")
def errors(import_id: str, limit: int = 200, user: CurrentUser = Depends(require_admin)):
    rows = (service_client().table("data_import_errors").select("*")
            .eq("import_id", import_id).limit(limit).execute()).data
    return {"errors": rows}


@router.get("/unmatched/queue")
def unmatched(limit: int = 100, user: CurrentUser = Depends(require_admin)):
    rows = (service_client().table("unmatched_records")
            .select("*").eq("state", "pending")
            .order("created_at", desc=True).limit(limit).execute()).data
    return {"records": rows}


class ResolveUnmatched(BaseModel):
    action: str            # match | create | ignore
    product_id: str | None = None


@router.post("/unmatched/{record_id}/resolve")
def resolve_unmatched(record_id: str, payload: ResolveUnmatched,
                      user: CurrentUser = Depends(require_admin)):
    svc = service_client()
    rows = (svc.table("unmatched_records").select("*")
            .eq("id", record_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That record doesn't exist.")

    record = rows[0]
    if payload.action == "create":
        raw = record["raw"] or {}
        sku = ie.clean_sku(raw.get("sku") or raw.get("SKU") or raw.get("Product Code"))
        name = ie.to_text(raw.get("name") or raw.get("Product Name")) or sku
        if not sku:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "This row has no SKU to create a product from.")
        try:
            svc.table("products").upsert({"sku": sku, "name": name},
                                         on_conflict="sku").execute()
        except Exception as exc:
            raise db_error(exc, "Couldn't create that product") from exc
        state = "created"
    elif payload.action == "match":
        if not payload.product_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a product to match to.")
        state = "matched"
    elif payload.action == "ignore":
        state = "ignored"
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Action must be 'match', 'create' or 'ignore'.")

    svc.table("unmatched_records").update({
        "state": state,
        "candidate_product_id": payload.product_id,
        "resolved_by": user.id,
        "resolved_at": utcnow_iso(),
    }).eq("id", record_id).execute()

    audit(user, f"import.unmatched.{state}", "unmatched_record", record_id)
    return {"message": f"Record {state}."}
