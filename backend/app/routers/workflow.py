"""Order and transfer workflow.

Receiving is the only path that changes stock levels, and it always writes an
inventory_transactions row alongside the update so the movement is traceable.
"""
from __future__ import annotations

import threading
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..core.db import utcnow_iso
from ..core.config import service_client
from ..core.security import CurrentUser, audit, current_user, require_staff, scope_stores

router = APIRouter(tags=["workflow"])

ALLOWED_TRANSITIONS = {
    "draft": {"pending_approval", "cancelled"},
    "pending_approval": {"approved", "rejected", "cancelled"},
    "approved": {"ordered", "cancelled"},
    "ordered": {"in_transit", "partially_received", "received", "cancelled"},
    "in_transit": {"partially_received", "received", "cancelled"},
    "partially_received": {"received", "cancelled"},
    "received": set(),
    "rejected": set(),
    "cancelled": set(),
}


def next_number(prefix: str, table: str, column: str) -> str:
    rows = (service_client().table(table).select(column)
            .order("created_at", desc=True).limit(1).execute()).data
    sequence = 1
    if rows:
        try:
            sequence = int(str(rows[0][column]).split("-")[-1]) + 1
        except (ValueError, IndexError):
            sequence = 1
    return f"{prefix}-{date.today():%Y%m}-{sequence:04d}"


# ---------------------------------------------------------------- orders


class OrderItemIn(BaseModel):
    product_id: str
    quantity: float = Field(gt=0)
    unit_price: float | None = None
    recommendation_id: str | None = None


class OrderIn(BaseModel):
    store_id: str
    supplier_id: str | None = None
    priority: str = "medium"
    expected_date: str | None = None
    notes: str | None = None
    items: list[OrderItemIn] = Field(min_length=1)
    submit: bool = True
    # "store" marks an order raised by a store manager from the ordering
    # catalogue. Those are the orders the warehouse board shows first.
    source: str = "internal"
    delivery_address: str | None = None


@router.post("/orders", status_code=201)
def create_order(payload: OrderIn, user: CurrentUser = Depends(current_user)):
    if not user.can_access_store(payload.store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    svc = service_client()
    expected = payload.expected_date
    if not expected and payload.supplier_id:
        rows = (svc.table("suppliers").select("avg_lead_time_days")
                .eq("id", payload.supplier_id).limit(1).execute()).data
        lead = float(rows[0]["avg_lead_time_days"]) if rows else 7
        expected = (date.today() + timedelta(days=lead)).isoformat()

    # Fall back to the store's own address so the packing list and the order
    # email always have somewhere to deliver to.
    delivery_address = payload.delivery_address
    if not delivery_address:
        try:
            rows = (svc.table("stores").select("address,location")
                    .eq("id", payload.store_id).limit(1).execute()).data
            if rows:
                delivery_address = rows[0].get("address") or rows[0].get("location")
        except Exception:
            delivery_address = None

    # Unit price defaults to the product MRP, so a store order carries a real
    # value instead of a blank total.
    price_by_product: dict[str, float] = {}
    missing_price = [i.product_id for i in payload.items if i.unit_price is None]
    if missing_price:
        try:
            for row in (svc.table("products").select("id,mrp")
                        .in_("id", missing_price).execute()).data:
                if row.get("mrp") is not None:
                    price_by_product[row["id"]] = float(row["mrp"])
        except Exception:
            price_by_product = {}

    def unit_price_for(item: OrderItemIn) -> float | None:
        if item.unit_price is not None:
            return item.unit_price
        return price_by_product.get(item.product_id)

    total = sum(i.quantity * (unit_price_for(i) or 0) for i in payload.items)
    order = svc.table("purchase_orders").insert({
        "po_number": next_number("PO", "purchase_orders", "po_number"),
        "store_id": payload.store_id,
        "supplier_id": payload.supplier_id,
        "status": "pending_approval" if payload.submit else "draft",
        "priority": payload.priority,
        "requested_by": user.id,
        "expected_date": expected,
        "notes": payload.notes,
        "total_value": total or None,
        # Warehouse pipeline starts the moment the order is submitted.
        "fulfillment_status": "pending" if payload.submit else "pending",
        "order_source": payload.source,
        "delivery_address": delivery_address,
    }).execute().data[0]

    svc.table("purchase_order_items").insert([{
        "purchase_order_id": order["id"],
        "product_id": i.product_id,
        "recommendation_id": i.recommendation_id,
        "quantity": i.quantity,
        "unit_price": unit_price_for(i),
        "line_total": (unit_price_for(i) or 0) * i.quantity or None,
    } for i in payload.items]).execute()

    for item in payload.items:
        if item.recommendation_id:
            svc.table("replenishment_recommendations").update(
                {"status": "actioned"}).eq("id", item.recommendation_id).execute()

    if payload.submit:
        try:
            from .warehouse import record_event
            record_event(order["id"], to_state="pending", kind="fulfillment",
                         note="Order submitted by the store and queued for the warehouse.",
                         user=user)
        except Exception:
            pass

        svc.table("alerts").insert({
            "type": "pending_approval",
            "priority": payload.priority,
            "store_id": payload.store_id,
            "title": f"{order['po_number']} needs approval",
            "message": f"{user.full_name or user.email} submitted a replenishment request "
                       f"with {len(payload.items)} line(s).",
            "recommended_action": "Review and approve or reject the request.",
        }).execute()

    audit(user, "order.create", "purchase_order", order["id"],
          {"po_number": order["po_number"], "items": len(payload.items)})

    if payload.submit:
        # Manager email with an Excel attachment, fired in the background so it
        # can never slow down or break the order save. A failed email is logged
        # and reported in the audit trail; the order itself is already saved.
        def _notify(order_id: str) -> None:
            try:
                from ..services.email_service import (manager_emails_for_store,
                                                      send_order_notification,
                                                      warehouse_recipients)
                rows = (service_client().table("purchase_orders")
                        .select("*, stores(code,name,address,location), suppliers(name), "
                                "requested_by_profile:profiles!purchase_orders_requested_by_fkey"
                                "(full_name,email), "
                                "purchase_order_items(id,quantity,unit_price,line_total,"
                                "products(id,sku,name,image_url,mrp))")
                        .eq("id", order_id).limit(1).execute()).data
                if not rows:
                    return
                detail = rows[0]
                items = detail.get("purchase_order_items") or []
                # The warehouse team is the primary recipient; approvers are
                # copied so nothing that used to be notified stops being.
                recipients = warehouse_recipients(detail.get("store_id"))
                for email in manager_emails_for_store(detail.get("store_id")):
                    if email not in recipients:
                        recipients.append(email)
                sent, error = send_order_notification(detail, items, recipients)
                try:
                    service_client().table("order_email_log").insert({
                        "order_id": order_id,
                        "po_number": detail.get("po_number"),
                        "recipients": recipients,
                        "sent": sent,
                        "error": error,
                    }).execute()
                except Exception:
                    pass  # the log table is optional; never fail the order
            except Exception as exc:
                import logging
                logging.getLogger("retailmind.email").warning(
                    "Order notification for %s failed: %s", order_id, exc)

        threading.Thread(target=_notify, args=(order["id"],), daemon=True).start()

    return order


@router.get("/orders")
def list_orders(store_id: str | None = None, status_filter: str | None = Query(None, alias="status"),
                limit: int = Query(50, le=200), user: CurrentUser = Depends(current_user)):
    stores = scope_stores(user, store_id)
    query = (user.db().table("purchase_orders")
             .select("*, stores(code,name), suppliers(name), "
                     "purchase_order_items(id,quantity,received_quantity,unit_price,"
                     "products(id,sku,name,image_url))"))
    if stores is not None:
        if not stores:
            return {"items": []}
        query = query.in_("store_id", stores)
    if status_filter:
        query = query.eq("status", status_filter)

    rows = query.order("created_at", desc=True).limit(limit).execute().data
    return {"items": rows}


@router.get("/orders/{order_id}")
def get_order(order_id: str, user: CurrentUser = Depends(current_user)):
    rows = (user.db().table("purchase_orders")
            .select("*, stores(code,name,location), suppliers(name,code,contact_email,"
                    "avg_lead_time_days), purchase_order_items(*, products(id,sku,name,"
                    "image_url,mrp,barcode))")
            .eq("id", order_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That order doesn't exist.")
    return rows[0]


class StatusChange(BaseModel):
    status: str
    reason: str | None = None
    received: dict[str, float] | None = None   # order_item_id -> quantity received


@router.post("/orders/{order_id}/status")
def change_status(order_id: str, payload: StatusChange,
                  user: CurrentUser = Depends(current_user)):
    svc = service_client()
    rows = (svc.table("purchase_orders")
            .select("*, purchase_order_items(id,product_id,quantity,received_quantity)")
            .eq("id", order_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That order doesn't exist.")

    order = rows[0]
    if not user.can_access_store(order["store_id"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    current = order["status"]
    if payload.status not in ALLOWED_TRANSITIONS.get(current, set()):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"An order that is {current.replace('_', ' ')} can't move to "
            f"{payload.status.replace('_', ' ')}.")

    approval_states = {"approved", "rejected", "ordered", "in_transit",
                       "received", "partially_received"}
    if payload.status in approval_states and not user.is_staff:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Only an inventory manager or admin can do this.")

    update: dict = {"status": payload.status}
    if payload.status == "approved":
        update["approved_by"] = user.id
    if payload.status == "rejected":
        update["rejection_reason"] = payload.reason
        update["approved_by"] = user.id

    # Receiving moves real stock.
    if payload.status in ("received", "partially_received"):
        update["received_date"] = date.today().isoformat()
        for item in order.get("purchase_order_items", []):
            qty = (payload.received or {}).get(item["id"])
            if qty is None:
                qty = float(item["quantity"]) - float(item["received_quantity"] or 0)
            qty = float(qty)
            if qty <= 0:
                continue

            svc.table("purchase_order_items").update({
                "received_quantity": float(item["received_quantity"] or 0) + qty
            }).eq("id", item["id"]).execute()

            existing = (svc.table("inventory").select("*")
                        .eq("product_id", item["product_id"])
                        .eq("store_id", order["store_id"]).limit(1).execute()).data
            if existing:
                row = existing[0]
                svc.table("inventory").update({
                    "current_stock": float(row["current_stock"]) + qty,
                    "available_stock": float(row["available_stock"]) + qty,
                    "stock_on_order": max(0.0, float(row["stock_on_order"]) - qty),
                }).eq("id", row["id"]).execute()
            else:
                svc.table("inventory").insert({
                    "product_id": item["product_id"], "store_id": order["store_id"],
                    "current_stock": qty, "available_stock": qty,
                }).execute()

            svc.table("inventory_transactions").insert({
                "product_id": item["product_id"], "store_id": order["store_id"],
                "delta": qty, "reason": "order_received",
                "reference_type": "purchase_order", "reference_id": order_id,
                "note": f"Received against {order['po_number']}", "created_by": user.id,
            }).execute()

    svc.table("purchase_orders").update(update).eq("id", order_id).execute()
    audit(user, f"order.{payload.status}", "purchase_order", order_id,
          {"from": current, "to": payload.status})
    return {"message": f"Order marked {payload.status.replace('_', ' ')}."}


# ---------------------------------------------------------------- transfers


@router.get("/transfers/suggestions")
def transfer_suggestions(user: CurrentUser = Depends(require_staff)):
    """Pairs a store that is short on a SKU with one holding surplus of the same SKU."""
    from ..services.compute import build_rows, load_settings

    cfg = load_settings()
    rows = (service_client().table("inventory")
            .select("*, products(id,sku,name,image_url,mrp,low_stock_threshold,reorder_point,safety_stock,target_stock), stores(id,code,name)")
            .limit(600).execute()).data

    # build_rows loads sales, store curves and lead times once for all 600 rows.
    # The previous per-row build_row made roughly 1,800 sequential queries here.
    by_product: dict[str, list[dict]] = {}
    for computed in build_rows(rows, cfg):
        by_product.setdefault(computed["product_id"], []).append(computed)

    suggestions = []
    for product_id, entries in by_product.items():
        if len(entries) < 2:
            continue
        short = [e for e in entries if e["stock_status"] in ("critical", "low", "out_of_stock")]
        surplus = [e for e in entries if e["stock_status"] == "overstock"]
        for need in short:
            for have in surplus:
                if have["store_id"] == need["store_id"]:
                    continue
                gap = max(0.0, need["reorder_point"] - need["available_stock"])
                spare = max(0.0, have["available_stock"] - have["reorder_point"] * 2)
                qty = round(min(gap, spare), 0)
                if qty <= 0:
                    continue
                suggestions.append({
                    "product_id": product_id,
                    "sku": need["sku"], "name": need["name"],
                    "image_url": need["image_url"],
                    "source_store_id": have["store_id"],
                    "source_store_name": have["store_name"],
                    "source_available": have["available_stock"],
                    "dest_store_id": need["store_id"],
                    "dest_store_name": need["store_name"],
                    "dest_available": need["available_stock"],
                    "dest_risk": need["risk_level"],
                    "quantity": qty,
                    "reason": (f"{need['store_name']} has {need['days_of_stock'] or 0:.1f} days "
                               f"of cover while {have['store_name']} holds "
                               f"{have['days_of_stock'] or 0:.0f} days."),
                })
                break

    suggestions.sort(key=lambda s: {"critical": 0, "high": 1, "medium": 2,
                                    "low": 3}.get(s["dest_risk"], 4))
    return {"items": suggestions[:40]}


class TransferIn(BaseModel):
    source_store_id: str
    dest_store_id: str
    product_id: str
    quantity: float = Field(gt=0)
    reason: str | None = None
    priority: str = "medium"


@router.post("/transfers", status_code=201)
def create_transfer(payload: TransferIn, user: CurrentUser = Depends(current_user)):
    if payload.source_store_id == payload.dest_store_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Source and destination must be different stores.")
    if not (user.can_access_store(payload.source_store_id)
            or user.can_access_store(payload.dest_store_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You aren't assigned to either store.")

    svc = service_client()
    transfer = svc.table("stock_transfers").insert({
        "transfer_number": next_number("TR", "stock_transfers", "transfer_number"),
        "source_store_id": payload.source_store_id,
        "dest_store_id": payload.dest_store_id,
        "status": "pending",
        "priority": payload.priority,
        "requested_by": user.id,
        "reason": payload.reason,
    }).execute().data[0]

    svc.table("stock_transfer_items").insert({
        "transfer_id": transfer["id"],
        "product_id": payload.product_id,
        "quantity": payload.quantity,
    }).execute()

    audit(user, "transfer.create", "stock_transfer", transfer["id"],
          {"number": transfer["transfer_number"]})
    return transfer


@router.get("/transfers")
def list_transfers(user: CurrentUser = Depends(current_user)):
    rows = (user.db().table("stock_transfers")
            .select("*, source:stores!stock_transfers_source_store_id_fkey(code,name), "
                    "dest:stores!stock_transfers_dest_store_id_fkey(code,name), "
                    "stock_transfer_items(*, products(id,sku,name,image_url))")
            .order("created_at", desc=True).limit(100).execute()).data
    return {"items": rows}


@router.post("/transfers/{transfer_id}/status")
def transfer_status(transfer_id: str, payload: StatusChange,
                    user: CurrentUser = Depends(require_staff)):
    svc = service_client()
    rows = (svc.table("stock_transfers")
            .select("*, stock_transfer_items(id,product_id,quantity)")
            .eq("id", transfer_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That transfer doesn't exist.")

    transfer = rows[0]
    if payload.status == "received":
        for item in transfer.get("stock_transfer_items", []):
            qty = float(item["quantity"])
            for store_id, delta, reason in (
                (transfer["source_store_id"], -qty, "transfer_out"),
                (transfer["dest_store_id"], qty, "transfer_in"),
            ):
                existing = (svc.table("inventory").select("*")
                            .eq("product_id", item["product_id"])
                            .eq("store_id", store_id).limit(1).execute()).data
                if existing:
                    row = existing[0]
                    svc.table("inventory").update({
                        "current_stock": max(0.0, float(row["current_stock"]) + delta),
                        "available_stock": max(0.0, float(row["available_stock"]) + delta),
                    }).eq("id", row["id"]).execute()
                elif delta > 0:
                    svc.table("inventory").insert({
                        "product_id": item["product_id"], "store_id": store_id,
                        "current_stock": delta, "available_stock": delta}).execute()

                svc.table("inventory_transactions").insert({
                    "product_id": item["product_id"], "store_id": store_id,
                    "delta": delta, "reason": reason,
                    "reference_type": "stock_transfer", "reference_id": transfer_id,
                    "note": f"Transfer {transfer['transfer_number']}",
                    "created_by": user.id,
                }).execute()

    update = {"status": payload.status}
    if payload.status in ("approved", "rejected"):
        update["approved_by"] = user.id
    svc.table("stock_transfers").update(update).eq("id", transfer_id).execute()

    audit(user, f"transfer.{payload.status}", "stock_transfer", transfer_id)
    return {"message": f"Transfer marked {payload.status.replace('_', ' ')}."}


# ---------------------------------------------------------------- alerts


@router.get("/alerts")
def list_alerts(store_id: str | None = None, state: str = "open",
                limit: int = Query(50, le=200),
                user: CurrentUser = Depends(current_user)):
    stores = scope_stores(user, store_id)
    query = user.db().table("alerts").select("*, products(id,sku,name,image_url), stores(code,name)")
    if stores is not None and stores:
        query = query.in_("store_id", stores)
    if state != "all":
        query = query.eq("state", state)
    rows = query.order("created_at", desc=True).limit(limit).execute().data
    return {"items": rows}


@router.post("/alerts/generate")
def generate_alerts(store_id: str | None = None,
                    user: CurrentUser = Depends(require_staff)):
    """Recomputes stock risk across the catalog and raises alerts for anything at risk."""
    from ..services.compute import build_rows, load_settings

    cfg = load_settings()
    svc = service_client()
    query = svc.table("inventory").select("*, products(id,sku,name,image_url,mrp,low_stock_threshold,reorder_point,safety_stock,target_stock)")
    if store_id:
        query = query.eq("store_id", store_id)

    created = 0
    for computed in build_rows(query.limit(500).execute().data, cfg):
        status_label = computed["stock_status"]
        if status_label not in ("critical", "out_of_stock", "low", "overstock"):
            continue

        alert_type = {"critical": "critical_stockout", "out_of_stock": "out_of_stock",
                      "low": "low_stock", "overstock": "overstock"}[status_label]
        priority = {"critical_stockout": "critical", "out_of_stock": "critical",
                    "low_stock": "high", "overstock": "low"}[alert_type]

        existing = (svc.table("alerts").select("id")
                    .eq("product_id", computed["product_id"])
                    .eq("store_id", computed["store_id"])
                    .eq("type", alert_type).eq("state", "open").limit(1).execute()).data
        if existing:
            continue

        cover = computed["days_of_stock"]
        if alert_type == "overstock":
            message = (f"{computed['name']} holds about {cover:.0f} days of cover, "
                       "well beyond expected demand.")
            action = "Consider a transfer to another store or pausing replenishment."
        elif alert_type == "out_of_stock":
            message = f"{computed['name']} has no available stock."
            action = f"Order {computed['reorder_point']:.0f} units to return to the reorder point."
        else:
            when = f"about {cover:.1f} days" if cover is not None else "soon"
            message = f"{computed['name']} has {when} of cover left. {computed['risk_reason']}"
            action = "Review the replenishment recommendation and raise a request."

        svc.table("alerts").insert({
            "type": alert_type, "priority": priority,
            "store_id": computed["store_id"], "product_id": computed["product_id"],
            "title": f"{computed['name']} — {status_label.replace('_', ' ')}",
            "message": message, "recommended_action": action,
        }).execute()
        created += 1

    audit(user, "alerts.generate", "alert", None, {"created": created})
    return {"created": created}


@router.post("/alerts/{alert_id}/state")
def set_alert_state(alert_id: str, payload: dict,
                    user: CurrentUser = Depends(current_user)):
    state = payload.get("state")
    if state not in ("open", "read", "resolved", "dismissed"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown alert state.")
    update = {"state": state}
    if state == "resolved":
        update.update({"resolved_by": user.id, "resolved_at": utcnow_iso()})
    service_client().table("alerts").update(update).eq("id", alert_id).execute()
    return {"message": f"Alert marked {state}."}
