from __future__ import annotations

import time

from fastapi import (APIRouter, Body, Depends, File, HTTPException, Query,
                     UploadFile, status)
from pydantic import BaseModel, Field

from ..core.config import get_settings, service_client
from ..core.db import db_error, utcnow_iso
from ..core.security import (CurrentUser, audit, current_user, require_admin,
                             require_staff, require_super)

router = APIRouter(tags=["catalog"])

# Whitelisted so an arbitrary ?sort= can't reach PostgREST and 400 the page.
SORTABLE = {"name", "sku", "mrp", "cost_price", "created_at", "updated_at", "status"}


# ---------------------------------------------------------------- products


@router.get("/products")
def list_products(
    search: str | None = None,
    category_id: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    include_archived: bool = False,
    sort: str = "name",
    limit: int = Query(24, le=100),
    offset: int = 0,
    user: CurrentUser = Depends(current_user),
):
    db = user.db()
    query = (db.table("products")
             .select("*, categories(id,name), subcategories(id,name)", count="exact"))

    if search:
        # Strip the characters PostgREST treats as filter syntax; an unescaped
        # comma or bracket in a search box used to produce a 400.
        term = search.replace(",", " ").replace("(", " ").replace(")", " ")
        term = term.replace("%", " ").strip()
        if term:
            query = query.or_(
                f"name.ilike.%{term}%,sku.ilike.%{term}%,barcode.ilike.%{term}%")
    if category_id:
        query = query.eq("category_id", category_id)
    if status_filter:
        query = query.eq("status", status_filter)
    elif not include_archived:
        # Archived products stay out of the default list, otherwise "delete"
        # looks like it did nothing.
        query = query.neq("status", "archived")

    descending = sort.startswith("-")
    column = sort.lstrip("-")
    if column not in SORTABLE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Can't sort by '{column}'. Try one of: {', '.join(sorted(SORTABLE))}.")

    try:
        rows = (query.order(column, desc=descending)
                .range(offset, offset + limit - 1).execute())
    except Exception as exc:
        raise db_error(exc, "Couldn't load products") from exc

    products = rows.data
    if products:
        ids = [p["id"] for p in products]
        inv = (db.table("inventory")
               .select("product_id,current_stock,available_stock")
               .in_("product_id", ids).execute()).data
        totals: dict[str, float] = {}
        records: dict[str, int] = {}
        for row in inv:
            totals[row["product_id"]] = totals.get(row["product_id"], 0.0) + \
                float(row.get("available_stock") or 0)
            records[row["product_id"]] = records.get(row["product_id"], 0) + 1
        for product in products:
            product["available_stock"] = totals.get(product["id"], 0.0)
            # 0 = a catalog product with no stock record anywhere, which the
            # frontend shows as "Inventory not added" rather than "out of stock".
            product["inventory_records"] = records.get(product["id"], 0)

    return {"items": products, "total": rows.count or 0, "limit": limit, "offset": offset}


@router.get("/products/{product_id}")
def get_product(product_id: str, user: CurrentUser = Depends(current_user)):
    db = user.db()
    rows = (db.table("products")
            .select("*, categories(id,name), subcategories(id,name), "
                    "product_images(id,url,is_primary,source), "
                    "product_suppliers(lead_time_days,suppliers(id,name,avg_lead_time_days))")
            .eq("id", product_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That product doesn't exist.")

    inventory = (db.table("inventory")
                 .select("*, stores(id,code,name)")
                 .eq("product_id", product_id).execute()).data
    recent = (db.table("inventory_transactions")
              .select("*, stores(code,name)")
              .eq("product_id", product_id)
              .order("created_at", desc=True).limit(10).execute()).data

    return {"product": rows[0], "inventory": inventory, "recent_activity": recent}


class ProductIn(BaseModel):
    sku: str
    name: str
    barcode: str | None = None
    category_id: str | None = None
    subcategory_id: str | None = None
    mrp: float | None = Field(None, ge=0)
    cost_price: float | None = Field(None, ge=0)
    image_url: str | None = None
    description: str | None = None
    status: str = "active"
    # Per-product quantity settings. These connect to the inventory engine:
    # when a product's stock crosses low_stock_threshold the inventory status,
    # alerts, dashboard, AI insights and replenishment recommendations all
    # react, because every one of those screens is computed from these values.
    low_stock_threshold: float | None = Field(None, ge=0)
    reorder_point: float | None = Field(None, ge=0)
    safety_stock: float | None = Field(None, ge=0)
    target_stock: float | None = Field(None, ge=0)


def _without_description(data: dict) -> dict:
    return {k: v for k, v in data.items() if k != "description"}


def _write_product(operation, data: dict):
    """Run a products write, retrying once without `description`.

    `description` is added by migration 0003. A project that has only run 0001
    and 0002 doesn't have the column, and PostgREST rejects the whole payload
    with PGRST204 rather than ignoring the unknown key. Retrying without it
    means the rest of the form still saves on an un-migrated database instead of
    the Add Product button appearing broken.
    """
    try:
        return operation(data)
    except Exception as exc:
        text = f"{getattr(exc, 'message', '')} {exc}".lower()
        if "description" in text and "description" in data:
            return operation(_without_description(data))
        raise


@router.post("/products", status_code=201)
def create_product(payload: ProductIn, user: CurrentUser = Depends(require_admin)):
    data = payload.model_dump(exclude_none=True)
    data["sku"] = data["sku"].strip().upper()
    data["name"] = data["name"].strip()
    if not data["sku"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "SKU can't be empty.")
    if not data["name"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Product name can't be empty.")

    svc = service_client()
    try:
        row = _write_product(
            lambda d: svc.table("products").insert(d).execute().data[0], data)
    except Exception as exc:
        if "23505" == str(getattr(exc, "code", "")) or "duplicate" in str(exc).lower():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"SKU {data['sku']} already exists. Edit that product instead, or "
                "use a different code.") from exc
        raise db_error(exc, "Couldn't create that product") from exc
    audit(user, "product.create", "product", row["id"], {"sku": row["sku"]})
    return row


@router.patch("/products/{product_id}")
def update_product(product_id: str, payload: dict = Body(...),
                   user: CurrentUser = Depends(require_admin)):
    allowed = {"name", "barcode", "category_id", "subcategory_id", "mrp",
               "cost_price", "image_url", "status", "description", "sku",
               "low_stock_threshold", "reorder_point", "safety_stock",
               "target_stock"}
    data = {k: v for k, v in payload.items() if k in allowed}
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")
    if "sku" in data:
        data["sku"] = str(data["sku"]).strip().upper()
        if not data["sku"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "SKU can't be empty.")
    if data.get("status") and data["status"] not in ("active", "inactive", "archived"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Status must be active, inactive or archived.")

    svc = service_client()
    try:
        updated = _write_product(
            lambda d: svc.table("products").update(d).eq("id", product_id).execute().data,
            data)
    except Exception as exc:
        if "23505" == str(getattr(exc, "code", "")) or "duplicate" in str(exc).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "Another product already uses that SKU.") from exc
        raise db_error(exc, "Couldn't update that product") from exc
    if not updated:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That product doesn't exist.")
    audit(user, "product.update", "product", product_id, data)
    return {"message": "Product updated.", "product": updated[0]}


@router.delete("/products/{product_id}")
def delete_product(product_id: str, hard: bool = False,
                   user: CurrentUser = Depends(require_admin)):
    """Archive a product, or delete it outright with ?hard=true.

    Archiving is the default because products are referenced by inventory,
    sales, orders and transfers; a hard delete cascades into all of that
    history. There was no delete endpoint at all before, so the Products screen
    had no way to retire a SKU.
    """
    svc = service_client()
    existing = (svc.table("products").select("id,sku,name")
                .eq("id", product_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That product doesn't exist.")

    if not hard:
        try:
            svc.table("products").update({"status": "archived"}).eq(
                "id", product_id).execute()
        except Exception as exc:
            raise db_error(exc, "Couldn't archive that product") from exc
        audit(user, "product.archive", "product", product_id, {"sku": existing[0]["sku"]})
        return {"message": f"{existing[0]['name']} archived.", "archived": True}

    if not user.is_super:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Permanent deletion needs super admin. Archiving is available to admins.")

    try:
        svc.table("products").delete().eq("id", product_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't delete that product") from exc
    audit(user, "product.delete", "product", product_id, {"sku": existing[0]["sku"]})
    return {"message": f"{existing[0]['name']} deleted.", "archived": False}


IMAGE_TYPES = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@router.post("/products/{product_id}/image")
async def upload_image(product_id: str, file: UploadFile = File(...),
                       user: CurrentUser = Depends(require_admin)):
    """Upload a product photo.

    Three things were wrong here. The object key was built from the raw
    filename, so a perfectly ordinary name like ``Front view (2).jpg`` produced
    a key Supabase mangles or rejects. Nothing checked the content type, so a
    PDF renamed to .jpg would be stored and then fail to render forever. And a
    storage failure surfaced as a bare 500 with a stack-trace string.
    """
    content_type = (file.content_type or "").lower().split(";")[0]
    if content_type not in IMAGE_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Images must be JPEG, PNG, WebP, GIF or AVIF. "
            f"That file is {content_type or 'of an unknown type'}.")

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That image file is empty.")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Images are limited to 5 MB. That one is "
            f"{len(content) / 1024 / 1024:.1f} MB.")

    svc = service_client()
    existing = (svc.table("products").select("id")
                .eq("id", product_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That product doesn't exist.")

    # A stable, key-safe path, versioned so replacing an image busts the CDN
    # cache instead of showing the old photo.
    suffix = IMAGE_TYPES[content_type]
    key = f"{product_id}/{int(time.time())}{suffix}"

    try:
        svc.storage.from_("product-images").upload(
            key, content, {"content-type": content_type, "upsert": "true"})
    except Exception as exc:
        message = str(exc)
        if "bucket" in message.lower() and "not found" in message.lower():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "The 'product-images' storage bucket doesn't exist. Run "
                "supabase/migrations/0002_rls.sql, or create a public bucket "
                "called 'product-images' in Supabase Storage.") from exc
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Supabase Storage rejected the upload: {message[:200]}") from exc

    url = f"{get_settings().supabase_url}/storage/v1/object/public/product-images/{key}"

    try:
        svc.table("product_images").update({"is_primary": False}).eq(
            "product_id", product_id).execute()
        svc.table("product_images").insert(
            {"product_id": product_id, "url": url, "is_primary": True,
             "source": "upload"}).execute()
        svc.table("products").update({"image_url": url}).eq("id", product_id).execute()
    except Exception as exc:
        raise db_error(exc, "The image uploaded but couldn't be linked to the product") from exc

    audit(user, "product.image.upload", "product", product_id)
    return {"url": url}


@router.delete("/products/{product_id}/image")
def clear_image(product_id: str, user: CurrentUser = Depends(require_admin)):
    """Remove the product's photo and fall back to the placeholder."""
    svc = service_client()
    try:
        svc.table("product_images").delete().eq("product_id", product_id).execute()
        svc.table("products").update({"image_url": None}).eq("id", product_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't remove that image") from exc
    audit(user, "product.image.clear", "product", product_id)
    return {"message": "Image removed."}


@router.delete("/products/{product_id}/image/{image_id}")
def delete_image(product_id: str, image_id: str, user: CurrentUser = Depends(require_admin)):
    service_client().table("product_images").delete().eq("id", image_id).execute()
    audit(user, "product.image.delete", "product", product_id)
    return {"message": "Image removed."}


# ---------------------------------------------------------------- reference data


@router.get("/categories")
def categories(user: CurrentUser = Depends(current_user)):
    return {"items": user.db().table("categories").select("*").order("name").execute().data}


class CategoryIn(BaseModel):
    name: str


@router.post("/categories", status_code=201)
def create_category(payload: CategoryIn, user: CurrentUser = Depends(require_admin)):
    """Create a category inline, so Add Product doesn't dead-end on a missing one."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Category name can't be empty.")
    svc = service_client()
    existing = (svc.table("categories").select("*").ilike("name", name)
                .limit(1).execute()).data
    if existing:
        return existing[0]
    try:
        row = svc.table("categories").insert({"name": name}).execute().data[0]
    except Exception as exc:
        raise db_error(exc, "Couldn't create that category") from exc
    audit(user, "category.create", "category", row["id"], {"name": name})
    return row


@router.get("/stores")
def stores(user: CurrentUser = Depends(current_user)):
    return {"items": user.db().table("stores").select("*").order("name").execute().data}


class StoreIn(BaseModel):
    code: str
    name: str
    location: str | None = None


@router.post("/stores", status_code=201)
def create_store(payload: StoreIn, user: CurrentUser = Depends(require_super)):
    row = service_client().table("stores").insert(
        payload.model_dump(exclude_none=True)).execute().data[0]
    audit(user, "store.create", "store", row["id"], {"code": row["code"]})
    return row


class StorePatch(BaseModel):
    code: str | None = None
    name: str | None = None
    location: str | None = None
    notification_email: str | None = None
    status: str | None = None


@router.patch("/stores/{store_id}")
def update_store(store_id: str, payload: StorePatch,
                 user: CurrentUser = Depends(require_super)):
    """Edit a store. notification_email is where order notifications go."""
    data = payload.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")
    if data.get("status") and data["status"] not in ("active", "inactive", "archived"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Status must be active, inactive or archived.")
    svc = service_client()
    existing = (svc.table("stores").select("id")
                .eq("id", store_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That store doesn't exist.")
    try:
        svc.table("stores").update(data).eq("id", store_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't update that store") from exc
    audit(user, "store.update", "store", store_id, data)
    return {"message": "Store updated."}


@router.delete("/stores/{store_id}")
def delete_store(store_id: str, user: CurrentUser = Depends(require_super)):
    """Deactivate a store. Soft delete so historical records keep their link."""
    svc = service_client()
    existing = (svc.table("stores").select("id,name,code")
                .eq("id", store_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That store doesn't exist.")
    try:
        svc.table("stores").update({"status": "inactive"}).eq(
            "id", store_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't deactivate that store") from exc
    audit(user, "store.deactivate", "store", store_id,
          {"code": existing[0]["code"], "name": existing[0]["name"]})
    return {"message": f"{existing[0]['name']} deactivated."}


@router.get("/suppliers")
def suppliers(user: CurrentUser = Depends(current_user)):
    return {"items": user.db().table("suppliers").select("*").order("name").execute().data}


class SupplierIn(BaseModel):
    name: str
    code: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    avg_lead_time_days: float = 7


@router.post("/suppliers", status_code=201)
def create_supplier(payload: SupplierIn, user: CurrentUser = Depends(require_staff)):
    row = service_client().table("suppliers").insert(
        payload.model_dump(exclude_none=True)).execute().data[0]
    audit(user, "supplier.create", "supplier", row["id"])
    return row


@router.patch("/suppliers/{supplier_id}")
def update_supplier(supplier_id: str, payload: dict,
                    user: CurrentUser = Depends(require_staff)):
    allowed = {"name", "code", "contact_email", "contact_phone",
               "avg_lead_time_days", "status"}
    data = {k: v for k, v in payload.items() if k in allowed}
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")
    svc = service_client()
    existing = (svc.table("suppliers").select("id")
                .eq("id", supplier_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That supplier doesn't exist.")
    try:
        svc.table("suppliers").update(data).eq("id", supplier_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't update that supplier") from exc
    audit(user, "supplier.update", "supplier", supplier_id, data)
    return {"message": "Supplier updated."}


@router.delete("/suppliers/{supplier_id}")
def delete_supplier(supplier_id: str, user: CurrentUser = Depends(require_staff)):
    """Deactivate a supplier. Soft delete: history keeps its references."""
    svc = service_client()
    existing = (svc.table("suppliers").select("id,name")
                .eq("id", supplier_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That supplier doesn't exist.")
    try:
        svc.table("suppliers").update({"status": "inactive"}).eq(
            "id", supplier_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't deactivate that supplier") from exc
    audit(user, "supplier.deactivate", "supplier", supplier_id,
          {"name": existing[0]["name"]})
    return {"message": f"{existing[0]['name']} deactivated."}


# ---------------------------------------------------------------- search


@router.get("/search")
def global_search(q: str = Query(min_length=2), user: CurrentUser = Depends(current_user)):
    db = user.db()
    term = q.strip()

    products = (db.table("products").select("id,sku,name,image_url,mrp")
                .or_(f"name.ilike.%{term}%,sku.ilike.%{term}%,barcode.ilike.%{term}%")
                .limit(8).execute()).data
    orders = (db.table("purchase_orders").select("id,po_number,status,store_id")
              .ilike("po_number", f"%{term}%").limit(5).execute()).data
    transfers = (db.table("stock_transfers").select("id,transfer_number,status")
                 .ilike("transfer_number", f"%{term}%").limit(5).execute()).data

    return {
        "products": [{**p, "href": f"/app/products/{p['id']}"} for p in products],
        "orders": [{**o, "href": f"/app/orders/{o['id']}"} for o in orders],
        "transfers": [{**t, "href": f"/app/transfers"} for t in transfers],
    }


# ---------------------------------------------------------------- settings & admin


@router.get("/settings")
def get_settings_rows(user: CurrentUser = Depends(current_user)):
    return {"items": user.db().table("system_settings").select("*").execute().data}


@router.put("/settings/{key}")
def update_setting(key: str, payload: dict, user: CurrentUser = Depends(require_super)):
    if "value" not in payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provide a value.")
    service_client().table("system_settings").update(
        {"value": payload["value"], "updated_by": user.id,
         "updated_at": utcnow_iso()}).eq("key", key).execute()
    # The computation layer caches settings for 30s; clear it so an edit is
    # visible on the next dashboard load rather than half a minute later.
    from ..services.compute import invalidate_settings
    invalidate_settings()

    audit(user, "settings.update", "system_setting", key, payload)
    return {"message": "Setting saved."}


@router.get("/users")
def list_users(user: CurrentUser = Depends(require_admin)):
    rows = (service_client().table("profiles")
            .select("*, roles(name), user_store_assignments(store_id, stores(code,name))")
            .order("created_at", desc=True).execute()).data
    return {"items": rows}


@router.patch("/users/{user_id}")
def update_user(user_id: str, payload: dict, admin: CurrentUser = Depends(require_super)):
    allowed = {"full_name", "role_id", "is_active"}
    data = {k: v for k, v in payload.items() if k in allowed}
    svc = service_client()
    if data:
        svc.table("profiles").update(data).eq("id", user_id).execute()

    if "store_ids" in payload:
        svc.table("user_store_assignments").delete().eq("user_id", user_id).execute()
        if payload["store_ids"]:
            svc.table("user_store_assignments").insert(
                [{"user_id": user_id, "store_id": s} for s in payload["store_ids"]]).execute()

    # current_user caches resolved identities for up to a minute. A role,
    # store-assignment or deactivation change has to land immediately.
    from ..core.security import invalidate_identity
    invalidate_identity(user_id)

    audit(admin, "user.update", "profile", user_id, data)
    return {"message": "User updated."}


@router.get("/audit-logs")
def audit_logs(limit: int = Query(100, le=500), user: CurrentUser = Depends(require_super)):
    rows = (service_client().table("audit_logs").select("*")
            .order("created_at", desc=True).limit(limit).execute()).data
    return {"items": rows}


# ---------------------------------------------------------------- user lifecycle


class ResetUserPasswordIn(BaseModel):
    password: str = Field(min_length=8, max_length=128)


@router.post("/users/{user_id}/reset-password")
def reset_user_password(user_id: str, payload: ResetUserPasswordIn,
                        admin: CurrentUser = Depends(require_super)):
    """Super admin sets/resets a user's password via Supabase Auth."""
    from .auth import check_password_strength
    check_password_strength(payload.password)
    svc = service_client()
    try:
        svc.auth.admin.update_user_by_id(user_id, {"password": payload.password})
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Password could not be updated: {exc}") from exc
    audit(admin, "user.password.reset", "profile", user_id)
    return {"message": "Password updated. Tell the user to sign in with it."}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, admin: CurrentUser = Depends(require_super)):
    """Permanently delete a user (auth + profile + assignments).

    Safety guards: you cannot delete yourself, and you cannot delete the last
    active super admin. Related records keep working because their foreign keys
    are ON DELETE SET NULL / CASCADE by design.
    """
    if user_id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "You can't delete your own account from here.")

    svc = service_client()
    rows = (svc.table("profiles").select("id,email,is_active,role_id,roles(name)")
            .eq("id", user_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That user doesn't exist.")

    profile = rows[0]
    role = (profile.get("roles") or {}).get("name")
    if role == "super_admin":
        supers = (svc.table("profiles").select("id")
                  .eq("is_active", True).eq("role_id", 1).limit(2).execute()).data
        if len(supers) <= 1:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This is the only active super admin. Create another super admin "
                "before deleting it, or deactivate the account instead.")

    try:
        svc.auth.admin.delete_user(user_id)
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"The account couldn't be deleted: {exc}") from exc

    # Profiles cascade on auth.users delete; clean up defensively anyway.
    try:
        svc.table("profiles").delete().eq("id", user_id).execute()
    except Exception:
        pass

    from ..core.security import invalidate_identity
    invalidate_identity(user_id)
    audit(admin, "user.delete", "profile", user_id,
          {"email": profile.get("email")})
    return {"message": f"{profile.get('email')} deleted."}
