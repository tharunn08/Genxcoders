"""Warehouse team endpoints: the store-order fulfilment pipeline.

A store manager submits an order from the ordering catalogue. That order lands
here with ``fulfillment_status = 'pending'`` and the warehouse team moves it
through:

    pending -> accepted -> picking -> packing -> packed -> shipped -> delivered

Two design points worth knowing:

* **Fulfilment is a separate axis from ``purchase_orders.status``.** The
  commercial status (draft / approved / received) already existed and other
  screens read it; adding a second column means the warehouse pipeline could be
  built without changing the meaning of anything that shipped before.
* **The packing list is a saved snapshot, not a view.** ``packing_lists`` and
  ``packing_list_items`` copy the product name, SKU, MRP and image at the moment
  the list is generated, so re-downloading it later reproduces what was packed
  even if the catalogue has since changed.

Every write here is authorised by ``require_warehouse`` *before* it reaches the
database, and again by row-level security (migration 0006). Hiding a button in
the frontend is not the control.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..core.config import service_client
from ..core.db import db_error, utcnow_iso
from ..core.security import (CurrentUser, audit, current_user, require_warehouse,
                             scope_stores)
from ..services.excel_export import (order_attachment_workbook,
                                     packing_list_workbook)

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

# The pipeline. Each state lists what may follow it, so an order can't jump from
# pending straight to shipped and leave the store manager's tracking view lying.
FULFILMENT_FLOW: dict[str, set[str]] = {
    "pending":   {"accepted", "cancelled"},
    "accepted":  {"picking", "cancelled"},
    "picking":   {"packing", "cancelled"},
    "packing":   {"packed", "cancelled"},
    "packed":    {"shipped", "cancelled"},
    "shipped":   {"delivered"},
    "delivered": set(),
    "cancelled": set(),
}

FULFILMENT_ORDER = ["pending", "accepted", "picking", "packing",
                    "packed", "shipped", "delivered"]

ORDER_SELECT = (
    "*, stores(id,code,name,location,address,contact_phone), suppliers(name), "
    "requested_by_profile:profiles!purchase_orders_requested_by_fkey(full_name,email), "
    "purchase_order_items(id,quantity,received_quantity,unit_price,line_total,"
    "products(id,sku,name,image_url,mrp,barcode))"
)


def _stream(content: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _load_order(order_id: str) -> dict:
    rows = (service_client().table("purchase_orders").select(ORDER_SELECT)
            .eq("id", order_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That order doesn't exist.")
    return rows[0]


def record_event(order_id: str, *, to_state: str, from_state: str | None = None,
                 kind: str = "fulfillment", note: str | None = None,
                 user: CurrentUser | None = None) -> None:
    """Append to the order's history. Never allowed to break the caller."""
    try:
        service_client().table("order_events").insert({
            "order_id": order_id,
            "kind": kind,
            "from_state": from_state,
            "to_state": to_state,
            "note": note,
            "actor_id": user.id if user else None,
            "actor_name": (user.full_name or user.email) if user else None,
        }).execute()
    except Exception:
        pass


# ---------------------------------------------------------------- board


@router.get("/stats")
def warehouse_stats(user: CurrentUser = Depends(require_warehouse)):
    """Counts per pipeline stage, read from the database with count=exact."""
    svc = service_client()

    def count(apply=None) -> int:
        try:
            query = svc.table("purchase_orders").select("id", count="exact").limit(1)
            if apply is not None:
                query = apply(query)
            return query.execute().count or 0
        except Exception:
            return 0

    stages = {state: count(lambda q, s=state: q.eq("fulfillment_status", s))
              for state in FULFILMENT_FLOW}

    today = date.today().isoformat()
    return {
        "stages": stages,
        "new_orders": stages.get("pending", 0),
        "to_pack": stages.get("accepted", 0) + stages.get("picking", 0)
                   + stages.get("packing", 0),
        "packed": stages.get("packed", 0),
        "shipped": stages.get("shipped", 0),
        "delivered": stages.get("delivered", 0),
        "total": count(),
        "shipped_today": count(lambda q: q.gte("shipped_at", today)),
    }


@router.get("/orders")
def warehouse_orders(
    fulfillment_status: str | None = Query(None),
    store_id: str | None = None,
    search: str | None = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
    user: CurrentUser = Depends(require_warehouse),
):
    """Every store order the warehouse needs to act on, newest first."""
    svc = service_client()
    query = svc.table("purchase_orders").select(ORDER_SELECT, count="exact")

    if fulfillment_status and fulfillment_status != "all":
        if fulfillment_status == "open":
            query = query.in_("fulfillment_status",
                              ["pending", "accepted", "picking", "packing", "packed"])
        else:
            query = query.eq("fulfillment_status", fulfillment_status)
    if store_id:
        query = query.eq("store_id", store_id)
    if search and search.strip():
        safe = search.replace(",", " ").replace("(", "").replace(")", "").strip()
        if safe:
            query = query.ilike("po_number", f"%{safe}%")

    try:
        rows = (query.order("created_at", desc=True)
                .range(offset, offset + limit - 1).execute())
    except Exception as exc:
        raise db_error(exc, "Couldn't load warehouse orders") from exc

    items = rows.data
    for order in items:
        lines = order.get("purchase_order_items") or []
        order["line_count"] = len(lines)
        order["unit_count"] = sum(float(i.get("quantity") or 0) for i in lines)

    return {"items": items, "total": rows.count or len(items),
            "limit": limit, "offset": offset}


@router.get("/orders/{order_id}")
def warehouse_order(order_id: str, user: CurrentUser = Depends(require_warehouse)):
    order = _load_order(order_id)
    svc = service_client()
    try:
        events = (svc.table("order_events").select("*")
                  .eq("order_id", order_id)
                  .order("created_at", desc=True).limit(50).execute()).data
    except Exception:
        events = []
    try:
        packing = (svc.table("packing_lists").select("*")
                   .eq("order_id", order_id)
                   .order("created_at", desc=True).execute()).data
    except Exception:
        packing = []
    return {"order": order, "events": events, "packing_lists": packing}


# ---------------------------------------------------------------- fulfilment


class FulfilmentChange(BaseModel):
    fulfillment_status: str
    note: str | None = None
    tracking_number: str | None = None
    carrier: str | None = None


@router.post("/orders/{order_id}/fulfillment")
def set_fulfillment(order_id: str, payload: FulfilmentChange,
                    user: CurrentUser = Depends(require_warehouse)):
    """Move one order to the next pipeline stage.

    The store manager's tracking view reads the same column and the same event
    history, so an update here is visible to them immediately.
    """
    svc = service_client()
    rows = (svc.table("purchase_orders")
            .select("id,po_number,store_id,status,fulfillment_status")
            .eq("id", order_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That order doesn't exist.")

    order = rows[0]
    current = order.get("fulfillment_status") or "pending"
    target = payload.fulfillment_status

    if target not in FULFILMENT_FLOW:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"'{target}' isn't a warehouse status.")
    if target == current:
        return {"message": f"Order is already {target}.", "fulfillment_status": current}
    if target not in FULFILMENT_FLOW[current]:
        allowed = ", ".join(sorted(FULFILMENT_FLOW[current])) or "nothing further"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"An order that is {current} can only move to {allowed}.")

    now = utcnow_iso()
    update: dict = {"fulfillment_status": target, "updated_at": now}
    if payload.note:
        update["warehouse_notes"] = payload.note
    if payload.tracking_number:
        update["tracking_number"] = payload.tracking_number
    if payload.carrier:
        update["carrier"] = payload.carrier

    if target == "accepted":
        update["accepted_by"] = user.id
        update["accepted_at"] = now
        # An accepted warehouse order is an approved commercial order.
        if order.get("status") in ("draft", "pending_approval"):
            update["status"] = "approved"
            update["approved_by"] = user.id
    if target == "packed":
        update["packed_by"] = user.id
        update["packed_at"] = now
    if target == "shipped":
        update["shipped_at"] = now
        if order.get("status") in ("approved", "ordered"):
            update["status"] = "in_transit"
    if target == "delivered":
        update["delivered_at"] = now
        update["received_date"] = date.today().isoformat()

    try:
        svc.table("purchase_orders").update(update).eq("id", order_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't update the order") from exc

    record_event(order_id, from_state=current, to_state=target,
                 note=payload.note, user=user)
    audit(user, "warehouse.fulfillment", "purchase_order", order_id,
          {"from": current, "to": target, "po_number": order.get("po_number")})

    return {"message": f"Order marked {target}.",
            "fulfillment_status": target,
            "po_number": order.get("po_number")}


# ---------------------------------------------------------------- packing list


def _warehouse_setting(key: str, fallback: str | None = None) -> str | None:
    try:
        rows = (service_client().table("system_settings").select("value")
                .eq("key", key).limit(1).execute()).data
        value = rows[0].get("value") if rows else None
        return value if isinstance(value, str) and value.strip() else fallback
    except Exception:
        return fallback


def _next_packing_number() -> str:
    rows = (service_client().table("packing_lists").select("packing_number")
            .order("created_at", desc=True).limit(1).execute()).data
    sequence = 1
    if rows:
        try:
            sequence = int(str(rows[0]["packing_number"]).split("-")[-1]) + 1
        except (ValueError, IndexError, KeyError):
            sequence = 1
    return f"PL-{date.today():%Y%m}-{sequence:04d}"


class PackingListIn(BaseModel):
    notes: str | None = None
    # order_item_id -> quantity actually packed. Omitted lines default to the
    # quantity that was ordered.
    packed: dict[str, float] | None = None


@router.post("/orders/{order_id}/packing-list", status_code=201)
def generate_packing_list(order_id: str, payload: PackingListIn = Body(default=PackingListIn()),
                          user: CurrentUser = Depends(require_warehouse)):
    """Snapshot the order into a packing list the warehouse can print."""
    order = _load_order(order_id)
    store = order.get("stores") or {}
    requester = order.get("requested_by_profile") or {}
    items = order.get("purchase_order_items") or []
    if not items:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That order has no lines to pack.")

    svc = service_client()
    packed_map = payload.packed or {}
    total_units = 0.0
    rows = []
    for item in items:
        product = item.get("products") or {}
        ordered = float(item.get("quantity") or 0)
        packed = float(packed_map.get(item["id"], ordered))
        total_units += packed
        rows.append({
            "product_id": product.get("id"),
            "sku": product.get("sku"),
            "product_name": product.get("name"),
            "image_url": product.get("image_url"),
            "mrp": product.get("mrp"),
            "quantity": ordered,
            "packed_quantity": packed,
        })

    record = {
        "order_id": order_id,
        "packing_number": _next_packing_number(),
        "store_id": order.get("store_id"),
        "store_name": store.get("name"),
        "store_address": (order.get("delivery_address") or store.get("address")
                          or store.get("location")),
        "store_manager": requester.get("full_name") or requester.get("email"),
        "packed_by": user.id,
        "packed_by_name": user.full_name or user.email,
        "packing_date": date.today().isoformat(),
        "total_lines": len(rows),
        "total_units": total_units,
        "notes": payload.notes,
    }

    try:
        packing = svc.table("packing_lists").insert(record).execute().data[0]
        svc.table("packing_list_items").insert(
            [dict(r, packing_list_id=packing["id"]) for r in rows]).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't generate the packing list") from exc

    record_event(order_id, to_state=order.get("fulfillment_status") or "pending",
                 kind="note",
                 note=f"Packing list {packing['packing_number']} generated.",
                 user=user)
    audit(user, "warehouse.packing_list", "purchase_order", order_id,
          {"packing_number": packing["packing_number"], "lines": len(rows)})

    return {"packing_list": packing, "items": rows,
            "message": f"Packing list {packing['packing_number']} generated."}


@router.get("/packing-lists")
def list_packing_lists(order_id: str | None = None, limit: int = Query(50, le=200),
                       user: CurrentUser = Depends(require_warehouse)):
    query = service_client().table("packing_lists").select("*, purchase_orders(po_number)")
    if order_id:
        query = query.eq("order_id", order_id)
    rows = query.order("created_at", desc=True).limit(limit).execute().data
    return {"items": rows}


def _load_packing(packing_id: str) -> tuple[dict, list[dict]]:
    svc = service_client()
    rows = (svc.table("packing_lists")
            .select("*, purchase_orders(po_number,fulfillment_status,store_id)")
            .eq("id", packing_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That packing list doesn't exist.")
    packing = rows[0]
    packing["po_number"] = (packing.get("purchase_orders") or {}).get("po_number")
    packing["warehouse_name"] = _warehouse_setting("warehouse.name", "Central Warehouse")
    items = (svc.table("packing_list_items").select("*")
             .eq("packing_list_id", packing_id).execute()).data
    return packing, items


@router.get("/packing-lists/{packing_id}")
def get_packing_list(packing_id: str, user: CurrentUser = Depends(current_user)):
    """Readable by the warehouse and by the store the order belongs to."""
    packing, items = _load_packing(packing_id)
    store_id = (packing.get("purchase_orders") or {}).get("store_id")
    if not user.can_access_store(store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That order isn't yours.")
    return {"packing_list": packing, "items": items}


@router.get("/packing-lists/{packing_id}/export")
def download_packing_list(packing_id: str, user: CurrentUser = Depends(current_user)):
    packing, items = _load_packing(packing_id)
    store_id = (packing.get("purchase_orders") or {}).get("store_id")
    if not user.can_access_store(store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That order isn't yours.")

    content = packing_list_workbook(packing, items)
    return _stream(content, f"packing-list-{packing.get('packing_number')}.xlsx")


# ---------------------------------------------------------------- order excel


@router.get("/orders/{order_id}/export")
def download_order_excel(order_id: str, user: CurrentUser = Depends(current_user)):
    """The order as an Excel file.

    This is the same workbook that is attached to the warehouse notification
    email, so what the warehouse receives by mail and what anyone downloads from
    the UI are byte-for-byte the same document.
    """
    order = _load_order(order_id)
    if not user.can_access_store(order.get("store_id")):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "That order isn't yours.")

    items = order.get("purchase_order_items") or []
    content = order_attachment_workbook(order, items)
    return _stream(content, f"order-{order.get('po_number')}.xlsx")


@router.post("/orders/{order_id}/resend-email")
def resend_order_email(order_id: str, user: CurrentUser = Depends(require_warehouse)):
    """Retry the warehouse notification for an order that already saved.

    Email delivery is deliberately decoupled from the order write, so a failure
    here never means a lost order — it means a mail that can be re-sent.
    """
    from ..services.email_service import send_order_notification, warehouse_recipients

    order = _load_order(order_id)
    recipients = warehouse_recipients(order.get("store_id"))
    if not recipients:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No warehouse recipient is configured. Set warehouse.notification_email "
            "in System settings, or add a user with the warehouse role.")

    sent, error = send_order_notification(order, order.get("purchase_order_items") or [],
                                          recipients)
    try:
        service_client().table("order_email_log").insert({
            "order_id": order_id, "po_number": order.get("po_number"),
            "recipients": recipients, "sent": sent, "error": error,
        }).execute()
    except Exception:
        pass

    audit(user, "warehouse.resend_email", "purchase_order", order_id,
          {"sent": sent, "recipients": len(recipients)})
    return {"sent": sent, "error": error, "recipients": recipients}


# ---------------------------------------------------------------- store view


@router.get("/my-orders")
def my_orders(limit: int = Query(50, le=200), offset: int = 0,
              store_id: str | None = None,
              user: CurrentUser = Depends(current_user)):
    """A store manager's own purchase history, with warehouse tracking.

    Scoped by ``scope_stores``, which for a store manager resolves to only the
    stores they are assigned to — so this cannot return another store's orders
    even if an id is passed by hand.
    """
    stores = scope_stores(user, store_id)
    db = user.db()
    query = db.table("purchase_orders").select(
        "*, stores(id,code,name,address,location), "
        "purchase_order_items(id,quantity,received_quantity,unit_price,line_total,"
        "products(id,sku,name,image_url,mrp))", count="exact")
    if stores is not None:
        if not stores:
            return {"items": [], "total": 0,
                    "message": "You aren't assigned to a store yet."}
        query = query.in_("store_id", stores)

    rows = (query.order("created_at", desc=True)
            .range(offset, offset + limit - 1).execute())

    items = rows.data
    ids = [o["id"] for o in items]
    events: dict[str, list[dict]] = {}
    if ids:
        try:
            for event in (db.table("order_events").select("*")
                          .in_("order_id", ids)
                          .order("created_at", desc=True).limit(500).execute()).data:
                events.setdefault(event["order_id"], []).append(event)
        except Exception:
            events = {}

    for order in items:
        lines = order.get("purchase_order_items") or []
        order["line_count"] = len(lines)
        order["unit_count"] = sum(float(i.get("quantity") or 0) for i in lines)
        order["events"] = events.get(order["id"], [])
        current = order.get("fulfillment_status") or "pending"
        order["fulfillment_step"] = (FULFILMENT_ORDER.index(current) + 1
                                     if current in FULFILMENT_ORDER else 0)
        order["fulfillment_total_steps"] = len(FULFILMENT_ORDER)

    return {"items": items, "total": rows.count or len(items),
            "limit": limit, "offset": offset}
