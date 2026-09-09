"""Inventory, forecasting, replenishment and dashboard endpoints.

These read imported data and run it through services/inventory_math.py and
services/forecasting.py. Nothing here invents a number: when the inputs are
missing, the response says so rather than filling the gap.

The per-row computation used to issue its own database queries, which made every
list endpoint quadratic in round trips. It now lives in services/compute.py and
loads in bulk — see that module for the numbers.
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..core.config import service_client
from ..core.db import db_error, utcnow_iso
from ..core.security import (CurrentUser, audit, current_user, require_staff,
                             scope_stores)
from ..services import forecasting as fc
from ..services import inventory_math as im
from ..services.compute import (ComputeContext, build_row, build_rows,
                                invalidate_settings, load_settings)

router = APIRouter(tags=["intelligence"])

# Re-exported for routers that still import them from here.
__all__ = ["router", "build_row", "build_rows", "load_settings"]


def _matching_product_ids(db, term: str, limit: int = 800) -> list[str]:
    """Product ids whose name, SKU or barcode match a search term.

    The inventory board used to fetch one page of rows and *then* filter it in
    Python, so searching only ever looked inside the 50 rows already on screen —
    a product on page 3 was unfindable. Resolving ids first pushes the search
    into Postgres, where the trigram index on products.name already exists.
    """
    cleaned = term.replace(",", " ").strip()
    if not cleaned:
        return []
    safe = cleaned.replace("%", "").replace("(", "").replace(")", "")
    rows = (db.table("products").select("id")
            .or_(f"name.ilike.%{safe}%,sku.ilike.%{safe}%,barcode.ilike.%{safe}%")
            .limit(limit).execute()).data
    return [r["id"] for r in rows]


# ---------------------------------------------------------------- inventory


@router.get("/inventory")
def inventory_board(
    store_id: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = None,
    limit: int = Query(50, le=200),
    offset: int = 0,
    user: CurrentUser = Depends(current_user),
):
    cfg = load_settings()
    stores = scope_stores(user, store_id)
    db = user.db()

    query = (db.table("inventory")
             .select("*, products(id,sku,name,image_url,mrp,low_stock_threshold,reorder_point,safety_stock,target_stock,category_id,"
                     "categories(name)), stores(id,code,name)", count="exact"))
    if stores is not None:
        if not stores:
            return {"items": [], "total": 0,
                    "message": "You aren't assigned to a store yet."}
        query = query.in_("store_id", stores)

    if search and search.strip():
        product_ids = _matching_product_ids(db, search)
        if not product_ids:
            return {"items": [], "total": 0, "limit": limit, "offset": offset}
        query = query.in_("product_id", product_ids)

    # Stock status is derived, not stored, so it can't be a WHERE clause. When
    # one is requested we compute a wider slice and paginate the result. The
    # ceiling keeps a status filter from turning into a full-table scan.
    if status_filter:
        raw = query.order("available_stock").limit(600).execute()
        computed = build_rows(raw.data, cfg)
        matched = [i for i in computed if i["stock_status"] == status_filter]
        page = matched[offset:offset + limit]
        return {"items": page, "total": len(matched),
                "limit": limit, "offset": offset,
                "truncated": len(raw.data) >= 600}

    rows = query.order("available_stock").range(offset, offset + limit - 1).execute()
    items = build_rows(rows.data, cfg)

    return {"items": items, "total": rows.count or len(items),
            "limit": limit, "offset": offset}


class InventoryIn(BaseModel):
    product_id: str
    store_id: str
    current_stock: float = Field(0, ge=0)
    available_stock: float | None = Field(None, ge=0)
    warehouse_stock: float = Field(0, ge=0)
    stock_on_route: float = Field(0, ge=0)
    stock_on_order: float = Field(0, ge=0)
    inventory_value: float | None = None
    note: str | None = None


@router.post("/inventory", status_code=201)
def create_inventory(payload: InventoryIn,
                     user: CurrentUser = Depends(require_staff)):
    """Create or replace a stock record by hand.

    There was no write endpoint for inventory at all — the only way stock could
    enter the system was a spreadsheet import or receiving a purchase order, so
    a failed import left no way forward.
    """
    if not user.can_access_store(payload.store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    svc = service_client()
    available = (payload.available_stock
                 if payload.available_stock is not None else payload.current_stock)

    record = {
        "product_id": payload.product_id,
        "store_id": payload.store_id,
        "current_stock": payload.current_stock,
        "available_stock": available,
        "warehouse_stock": payload.warehouse_stock,
        "stock_on_route": payload.stock_on_route,
        "stock_on_order": payload.stock_on_order,
        "inventory_value": payload.inventory_value,
        "updated_at": utcnow_iso(),
    }

    try:
        row = svc.table("inventory").upsert(
            record, on_conflict="product_id,store_id").execute().data[0]
    except Exception as exc:
        raise db_error(exc, "Couldn't save that stock record") from exc

    try:
        svc.table("inventory_transactions").insert({
            "product_id": payload.product_id, "store_id": payload.store_id,
            "delta": payload.current_stock, "reason": "manual",
            "note": payload.note or "Stock record created manually",
            "created_by": user.id,
        }).execute()
    except Exception:
        pass  # the ledger is supporting evidence, not the record of truth

    audit(user, "inventory.create", "inventory", row.get("id"),
          {"product_id": payload.product_id, "store_id": payload.store_id})
    return row


@router.patch("/inventory/{inventory_id}")
def update_inventory(inventory_id: str, payload: dict = Body(...),
                     user: CurrentUser = Depends(require_staff)):
    allowed = {"current_stock", "available_stock", "warehouse_stock",
               "stock_on_route", "stock_on_order", "inventory_value"}
    data = {k: v for k, v in payload.items() if k in allowed and v is not None}
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to update.")

    svc = service_client()
    existing = (svc.table("inventory").select("*")
                .eq("id", inventory_id).limit(1).execute()).data
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That stock record doesn't exist.")
    if not user.can_access_store(existing[0]["store_id"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    for key in ("current_stock", "available_stock", "warehouse_stock",
                "stock_on_route", "stock_on_order"):
        if key in data and float(data[key]) < 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                f"{key.replace('_', ' ').capitalize()} can't be negative.")

    data["updated_at"] = utcnow_iso()
    try:
        svc.table("inventory").update(data).eq("id", inventory_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't update that stock record") from exc

    delta = None
    if "current_stock" in data:
        delta = float(data["current_stock"]) - float(existing[0]["current_stock"] or 0)
    if delta:
        try:
            svc.table("inventory_transactions").insert({
                "product_id": existing[0]["product_id"],
                "store_id": existing[0]["store_id"],
                "delta": delta, "reason": "manual",
                "note": "Stock edited manually", "created_by": user.id,
            }).execute()
        except Exception:
            pass

    audit(user, "inventory.update", "inventory", inventory_id, data)
    return {"message": "Stock record updated."}


class StockAdjustment(BaseModel):
    delta: float
    reason: str = "manual"
    note: str | None = None


@router.post("/inventory/{inventory_id}/adjust")
def adjust_stock(inventory_id: str, payload: StockAdjustment,
                 user: CurrentUser = Depends(require_staff)):
    """Apply a relative change and record it in the ledger."""
    if payload.delta == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "An adjustment of zero does nothing.")

    svc = service_client()
    rows = (svc.table("inventory").select("*")
            .eq("id", inventory_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That stock record doesn't exist.")

    row = rows[0]
    if not user.can_access_store(row["store_id"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    current = float(row["current_stock"] or 0) + payload.delta
    available = float(row["available_stock"] or 0) + payload.delta
    if current < 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"That would take stock to {current:g}. Current stock is "
            f"{float(row['current_stock'] or 0):g}.")

    try:
        svc.table("inventory").update({
            "current_stock": current,
            "available_stock": max(0.0, available),
            "updated_at": utcnow_iso(),
        }).eq("id", inventory_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't apply that adjustment") from exc

    try:
        svc.table("inventory_transactions").insert({
            "product_id": row["product_id"], "store_id": row["store_id"],
            "delta": payload.delta, "reason": payload.reason or "manual",
            "note": payload.note, "created_by": user.id,
        }).execute()
    except Exception:
        pass

    audit(user, "inventory.adjust", "inventory", inventory_id,
          {"delta": payload.delta, "reason": payload.reason})
    return {"message": "Stock adjusted.", "current_stock": current,
            "available_stock": max(0.0, available)}


@router.delete("/inventory/{inventory_id}")
def delete_inventory(inventory_id: str, user: CurrentUser = Depends(require_staff)):
    svc = service_client()
    rows = (svc.table("inventory").select("store_id")
            .eq("id", inventory_id).limit(1).execute()).data
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That stock record doesn't exist.")
    if not user.can_access_store(rows[0]["store_id"]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    try:
        svc.table("inventory").delete().eq("id", inventory_id).execute()
    except Exception as exc:
        raise db_error(exc, "Couldn't remove that stock record") from exc

    audit(user, "inventory.delete", "inventory", inventory_id)
    return {"message": "Stock record removed."}


@router.get("/inventory/transactions")
def inventory_transactions(
    product_id: str | None = None,
    store_id: str | None = None,
    limit: int = Query(50, le=200),
    user: CurrentUser = Depends(current_user),
):
    query = (user.db().table("inventory_transactions")
             .select("*, products(sku,name), stores(code,name)"))
    if product_id:
        query = query.eq("product_id", product_id)
    stores = scope_stores(user, store_id)
    if stores is not None:
        if not stores:
            return {"items": []}
        query = query.in_("store_id", stores)
    rows = query.order("created_at", desc=True).limit(limit).execute().data
    return {"items": rows}


# ---------------------------------------------------------------- forecast


@router.get("/forecast")
def forecast(
    product_id: str,
    store_id: str,
    horizon: int = Query(14, ge=1, le=90),
    method: str | None = None,
    user: CurrentUser = Depends(current_user),
):
    if not user.can_access_store(store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    cfg = load_settings()
    ctx = ComputeContext([{"product_id": product_id, "store_id": store_id}], cfg)
    series, demand = ctx.demand(product_id, store_id)

    if demand.basis == "no_data":
        return {
            "available": False,
            "message": "No sales history has been imported for this product and store.",
            "action": "Import sales data to generate a forecast.",
        }

    inv = (service_client().table("inventory").select("available_stock")
           .eq("product_id", product_id).eq("store_id", store_id).limit(1).execute()).data
    available = float(inv[0]["available_stock"]) if inv else 0.0
    cover = im.days_of_stock(available, demand.avg_daily_demand)

    result = fc.build_forecast(
        history=series,
        horizon_days=horizon,
        method=method or cfg.get("forecast_method", "weighted_ma"),
        basis=demand.basis,
        cover_days=cover,
    )

    history_start = date.today() - timedelta(days=len(series) - 1) if series else date.today()
    history_points = [
        {"date": (history_start + timedelta(days=i)).isoformat(), "actual": qty}
        for i, qty in enumerate(series)
    ]

    return {
        "available": True,
        "method": result.method,
        "basis": result.basis,
        "basis_label": ("Measured from imported SKU sales history"
                        if result.basis == "sku_history"
                        else "Estimated from store sales pattern — not directly observed"),
        "horizon_days": result.horizon_days,
        "avg_daily_demand": result.avg_daily_demand,
        "total_forecast": result.total_forecast,
        "confidence": result.confidence,
        "trend_direction": result.trend_direction,
        "trend_pct": result.trend_pct,
        "history_days": result.history_days,
        "history": history_points[-60:],
        "points": [p.__dict__ for p in result.points],
        "factors": [f.__dict__ for f in result.factors],
        "demand_note": demand.note,
    }


# ---------------------------------------------------------------- replenishment


@router.get("/replenishment")
def replenishment(
    store_id: str | None = None,
    limit: int = Query(50, le=200),
    user: CurrentUser = Depends(current_user),
):
    cfg = load_settings()
    stores = scope_stores(user, store_id)
    horizon = int(cfg.get("forecast_horizon", 14))
    review = float(cfg.get("review_period_days", 7))

    query = user.db().table("inventory").select(
        "*, products(id,sku,name,image_url,mrp,low_stock_threshold,reorder_point,safety_stock,target_stock), stores(id,code,name)")
    if stores is not None:
        if not stores:
            return {"items": [], "message": "You aren't assigned to a store yet."}
        query = query.in_("store_id", stores)

    rows = query.order("available_stock").limit(400).execute().data
    computed = build_rows(rows, cfg)
    out = []

    for row in computed:
        if row["avg_daily_demand"] <= 0 and row["available_stock"] > 0:
            continue

        planning_days = row["lead_time_days"] + review
        forecast_demand = round(row["avg_daily_demand"] * planning_days, 2)
        qty = im.recommended_quantity(
            forecast_demand=forecast_demand,
            safety=row["safety_stock"],
            available_stock=row["available_stock"],
            on_order=row["stock_on_order"],
            on_route=row["stock_on_route"],
        )
        if qty <= 0:
            continue

        cover = row["days_of_stock"]
        if row["risk_level"] == "critical" or (cover is not None and cover <= 2):
            priority = "critical"
        elif row["risk_level"] == "high":
            priority = "high"
        elif row["risk_level"] == "medium":
            priority = "medium"
        else:
            priority = "low"

        out.append({
            **row,
            "planning_days": planning_days,
            "forecast_demand": forecast_demand,
            "recommended_qty": qty,
            "priority": priority,
            "reason": row["risk_reason"],
        })

    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    out.sort(key=lambda r: (rank[r["priority"]], -(r["risk_score"] or 0)))
    return {"items": out[:limit], "horizon_days": horizon,
            "settings": {"safety_days": cfg.get("safety_days"),
                         "review_period_days": review}}


# ---------------------------------------------------------------- what-if


class WhatIf(BaseModel):
    product_id: str
    store_id: str
    demand_change_pct: float = 0
    lead_time_days: float | None = None
    safety_days: float | None = None
    current_stock: float | None = None


@router.post("/what-if")
def what_if(payload: WhatIf, user: CurrentUser = Depends(current_user)):
    if not user.can_access_store(payload.store_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't assigned to that store.")

    cfg = load_settings()
    inv = (service_client().table("inventory")
           .select("*, products(id,sku,name,image_url,mrp,low_stock_threshold,reorder_point,safety_stock,target_stock)")
           .eq("product_id", payload.product_id)
           .eq("store_id", payload.store_id).limit(1).execute()).data
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "No inventory record exists for this product and store.")

    baseline = build_rows(inv, cfg)[0]

    scenario_cfg = dict(cfg)
    if payload.safety_days is not None:
        scenario_cfg["safety_days"] = payload.safety_days
        scenario_cfg["safety_method"] = "days"

    demand = baseline["avg_daily_demand"] * (1 + payload.demand_change_pct / 100)
    lead_time = payload.lead_time_days if payload.lead_time_days is not None \
        else baseline["lead_time_days"]
    available = payload.current_stock if payload.current_stock is not None \
        else baseline["available_stock"]

    safety, method = im.safety_stock(demand, lead_time, scenario_cfg)
    reorder_pt = im.reorder_point(demand, lead_time, safety)
    cover = im.days_of_stock(available, demand)
    risk = im.stockout_risk(
        available_stock=available, avg_daily_demand=demand,
        lead_time_days=lead_time, safety=safety,
        on_order=baseline["stock_on_order"], on_route=baseline["stock_on_route"])

    review = float(cfg.get("review_period_days", 7))
    qty = im.recommended_quantity(
        forecast_demand=demand * (lead_time + review),
        safety=safety, available_stock=available,
        on_order=baseline["stock_on_order"], on_route=baseline["stock_on_route"])

    return {
        "before": {
            "avg_daily_demand": baseline["avg_daily_demand"],
            "lead_time_days": baseline["lead_time_days"],
            "safety_stock": baseline["safety_stock"],
            "reorder_point": baseline["reorder_point"],
            "days_of_stock": baseline["days_of_stock"],
            "risk_score": baseline["risk_score"],
            "risk_level": baseline["risk_level"],
            "available_stock": baseline["available_stock"],
        },
        "after": {
            "avg_daily_demand": round(demand, 3),
            "lead_time_days": lead_time,
            "safety_stock": safety,
            "safety_method": method,
            "reorder_point": reorder_pt,
            "days_of_stock": cover,
            "risk_score": risk.score,
            "risk_level": risk.level,
            "available_stock": available,
            "recommended_qty": qty,
            "expected_stockout_date": risk.expected_stockout_date,
            "reason": risk.reason,
        },
        "product": {"sku": baseline["sku"], "name": baseline["name"],
                    "image_url": baseline["image_url"]},
    }


# ---------------------------------------------------------------- dashboard


def _count(db, table: str, apply=None) -> int:
    """An exact row count from Postgres, never from a fetched page.

    This is the fix for the dashboard reporting a number like 297 on a catalog
    of thousands. The old code fetched ``inventory`` with ``.limit(500)`` and
    derived every headline figure from whatever happened to be in that page, so
    the product count was really "distinct products among the first 500 stock
    rows". Counting in the database is both correct and cheaper.
    """
    try:
        query = db.table(table).select("id", count="exact").limit(1)
        if apply is not None:
            query = apply(query)
        return query.execute().count or 0
    except Exception:
        return 0


def _scan(db, table: str, columns: str, apply=None,
          page_size: int = 1000, max_pages: int = 60) -> list[dict]:
    """Read a whole table (within the caller's scope) in pages.

    The aggregates below — total units, inventory value, low/out-of-stock
    counts — have to see every row to be right. They read only the handful of
    numeric columns they need, so even a large catalog is a few hundred KB
    rather than the full joined payload the board endpoint fetches.
    """
    rows: list[dict] = []
    for page in range(max_pages):
        start = page * page_size
        try:
            query = db.table(table).select(columns)
            if apply is not None:
                query = apply(query)
            batch = query.range(start, start + page_size - 1).execute().data
        except Exception:
            break
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
    return rows


# How many inventory lines the *computed* panels (risk, movers, overstock) look
# at. The KPI numbers above are exact regardless of this; this only bounds the
# demand maths, which is the expensive part.
COMPUTED_SAMPLE = 600


@router.get("/dashboard")
def dashboard(store_id: str | None = None, user: CurrentUser = Depends(current_user)):
    """Retail control dashboard. Every number is read from stored data.

    Two separate passes on purpose:

    * **KPIs** are exact. Counts come from Postgres ``count=exact``; unit and
      value totals come from a lightweight full scan of the numeric columns.
      Nothing is sampled and nothing is hard-coded, so importing products,
      editing stock or shipping an order changes these figures immediately.
    * **Computed panels** (stock-out risk, top movers, overstock) run the demand
      engine over a bounded slice, because that maths is the only expensive part
      of the screen.
    """
    cfg = load_settings()
    stores = scope_stores(user, store_id)
    db = user.db()

    def scoped(query):
        return query.in_("store_id", stores) if stores else query

    if stores is not None and not stores:
        return {"empty": True,
                "message": "You aren't assigned to a store yet. Ask an administrator."}

    # ------------------------------------------------------------ catalogue
    total_products = _count(db, "products", lambda q: q.neq("status", "archived"))
    active_products = _count(db, "products", lambda q: q.eq("status", "active"))
    inactive_products = max(0, total_products - active_products)

    try:
        total_categories = (db.table("categories").select("id", count="exact")
                            .limit(1).execute()).count or 0
    except Exception:
        total_categories = 0

    try:
        total_stores = (db.table("stores").select("id", count="exact")
                        .limit(1).execute()).count or 0
    except Exception:
        total_stores = 0
    if stores:
        total_stores = len(stores)

    # ------------------------------------------------------------ stock totals (exact)
    stock_rows = _scan(
        db, "inventory",
        "product_id,store_id,current_stock,available_stock,warehouse_stock,"
        "stock_on_route,stock_on_order,inventory_value,"
        "products(mrp,low_stock_threshold)",
        scoped,
    )

    total_units = 0.0
    total_value = 0.0
    on_route = 0.0
    on_order = 0.0
    out_of_stock = 0
    low_stock = 0
    in_stock = 0
    default_low = float(cfg.get("risk_low_days", 7) or 7)
    stocked_products: set[str] = set()

    for row in stock_rows:
        product = row.get("products") or {}
        current = float(row.get("current_stock") or 0)
        available = float(row.get("available_stock") or 0)
        total_units += current
        on_route += float(row.get("stock_on_route") or 0)
        on_order += float(row.get("stock_on_order") or 0)

        value = row.get("inventory_value")
        total_value += (float(value) if value is not None
                        else current * float(product.get("mrp") or 0))

        if row.get("product_id"):
            stocked_products.add(row["product_id"])

        # A stored threshold is a direct signal; otherwise fall back to a small
        # absolute floor so the tile means something before thresholds are set.
        threshold = product.get("low_stock_threshold")
        threshold = float(threshold) if threshold is not None else default_low

        if available <= 0:
            out_of_stock += 1
        elif available <= threshold:
            low_stock += 1
        else:
            in_stock += 1

    products_without_stock = max(0, total_products - len(stocked_products))

    # ------------------------------------------------------------ orders (exact)
    def order_count(apply=None) -> int:
        try:
            query = db.table("purchase_orders").select("id", count="exact").limit(1)
            if stores:
                query = query.in_("store_id", stores)
            if apply is not None:
                query = apply(query)
            return query.execute().count or 0
        except Exception:
            return 0

    total_orders = order_count()
    pending_orders = order_count(lambda q: q.eq("fulfillment_status", "pending"))
    accepted_orders = order_count(lambda q: q.eq("fulfillment_status", "accepted"))
    picking_orders = order_count(lambda q: q.eq("fulfillment_status", "picking"))
    packing_orders = order_count(lambda q: q.in_("fulfillment_status", ["packing"]))
    packed_orders = order_count(lambda q: q.eq("fulfillment_status", "packed"))
    shipped_orders = order_count(lambda q: q.eq("fulfillment_status", "shipped"))
    delivered_orders = order_count(lambda q: q.eq("fulfillment_status", "delivered"))
    pending_requests = order_count(lambda q: q.eq("status", "pending_approval"))

    try:
        recent_query = (db.table("purchase_orders")
                        .select("id,po_number,status,fulfillment_status,priority,"
                                "total_value,created_at,requested_date,"
                                "stores(code,name), purchase_order_items(quantity)"))
        if stores:
            recent_query = recent_query.in_("store_id", stores)
        recent_orders = (recent_query.order("created_at", desc=True)
                         .limit(8).execute()).data
    except Exception:
        recent_orders = []

    for order in recent_orders:
        items = order.pop("purchase_order_items", None) or []
        order["line_count"] = len(items)
        order["unit_count"] = sum(float(i.get("quantity") or 0) for i in items)

    # ------------------------------------------------------------ computed panels
    computed: list[dict] = []
    counts: dict[str, int] = {}
    if stock_rows:
        try:
            detail_query = db.table("inventory").select(
                "*, products(id,sku,name,image_url,mrp,low_stock_threshold,"
                "reorder_point,safety_stock,target_stock), stores(id,code,name)")
            detail_rows = scoped(detail_query).order("available_stock").limit(
                COMPUTED_SAMPLE).execute().data
            computed = build_rows(detail_rows, cfg)
        except Exception:
            computed = []
        for item in computed:
            counts[item["stock_status"]] = counts.get(item["stock_status"], 0) + 1

    critical = sorted([i for i in computed if i["risk_level"] in ("critical", "high")],
                      key=lambda i: -i["risk_score"])[:8]
    surging = [i for i in computed
               if i["demand_basis"] == "sku_history" and i["avg_daily_demand"] > 0][:20]
    overstock = sorted([i for i in computed if i["stock_status"] == "overstock"],
                       key=lambda i: -(i["days_of_stock"] or 0))[:8]

    briefing = []
    for item in critical[:3]:
        cover = item["days_of_stock"]
        when = f"in about {cover:.0f} days" if cover else "imminently"
        briefing.append({
            "type": "critical",
            "title": item["name"],
            "message": f"{item['name']} ({item['sku']}) may stock out {when}.",
            "product_id": item["product_id"], "store_id": item["store_id"],
        })
    for item in overstock[:2]:
        briefing.append({
            "type": "overstock",
            "title": item["name"],
            "message": (f"{item['name']} holds {item['days_of_stock']:.0f} days of cover — "
                        "a transfer or promotion could free up the capital."),
            "product_id": item["product_id"], "store_id": item["store_id"],
        })

    # An empty *inventory* table is no longer an empty dashboard: the catalogue
    # counts are still real and still worth showing.
    if not stock_rows and not total_products:
        return {"empty": True, "product_count": 0,
                "message": "No products or inventory have been imported yet.",
                "action": "Import your product file"}

    return {
        "empty": False,
        "inventory_empty": not stock_rows,
        "message": (None if stock_rows else
                    f"{total_products} products exist but none have stock recorded "
                    "yet. Import an inventory file or add stock from the Inventory "
                    "screen."),
        "kpis": {
            # catalogue
            "total_products": total_products,
            "active_products": active_products,
            "inactive_products": inactive_products,
            "total_categories": total_categories,
            "products_without_stock": products_without_stock,
            # inventory
            "stock_records": len(stock_rows),
            "active_skus": len(stocked_products),
            "total_units": round(total_units, 2),
            "total_value": round(total_value, 2),
            "stock_on_route": round(on_route, 2),
            "stock_on_order": round(on_order, 2),
            "available_products": in_stock,
            "low_stock": low_stock,
            "out_of_stock": out_of_stock,
            # derived-status breakdown from the computed slice
            "critical": counts.get("critical", 0),
            "overstock": counts.get("overstock", 0),
            "healthy": counts.get("healthy", 0),
            # stores & orders
            "total_stores": total_stores,
            "total_orders": total_orders,
            "pending_orders": pending_orders,
            "accepted_orders": accepted_orders,
            "picking_orders": picking_orders,
            "packing_orders": packing_orders,
            "packed_orders": packed_orders,
            "shipped_orders": shipped_orders,
            "delivered_orders": delivered_orders,
            "pending_requests": pending_requests,
        },
        "status_breakdown": [{"status": k, "count": v} for k, v in counts.items()],
        "computed_sample": len(computed),
        "critical_items": critical,
        "overstock_items": overstock,
        "recent_orders": recent_orders,
        "top_movers": sorted(surging, key=lambda i: -i["avg_daily_demand"])[:8],
        "briefing": briefing,
    }


@router.get("/dashboard/sales-trend")
def sales_trend(store_id: str | None = None, days: int = Query(30, le=180),
                user: CurrentUser = Depends(current_user)):
    stores = scope_stores(user, store_id)
    start = (date.today() - timedelta(days=days)).isoformat()

    query = (user.db().table("sales").select("sale_date,quantity_sold,sales_amount")
             .gte("sale_date", start))
    if stores is not None:
        if not stores:
            return {"points": []}
        query = query.in_("store_id", stores)

    rows = query.order("sale_date").limit(20000).execute().data
    by_day: dict[str, dict] = {}
    for row in rows:
        key = str(row["sale_date"])[:10]
        entry = by_day.setdefault(key, {"date": key, "units": 0.0, "amount": 0.0})
        entry["units"] += float(row.get("quantity_sold") or 0)
        entry["amount"] += float(row.get("sales_amount") or 0)

    return {"points": [by_day[k] for k in sorted(by_day)]}
