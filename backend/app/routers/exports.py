"""Excel export endpoints.

Each endpoint reads the same live tables the screens use and streams a real
.xlsx file built by services/excel_export.py. Nothing here generates data —
when there is nothing to export the workbook says so. Access mirrors the read
permissions of the equivalent screen (store managers are scoped to their stores).
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse

from ..core.db import db_error
from ..core.security import CurrentUser, current_user, scope_stores
from ..services import excel_export as xl
from ..services import forecasting as fc
from ..services.compute import build_rows, load_settings
from ..services.inventory_math import days_of_stock

router = APIRouter(prefix="/export", tags=["export"])

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Safety cap: exports are for real analysis, not for dumping millions of rows.
MAX_ROWS = 10_000


def _stream(content: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        iter([content]),
        media_type=XLSX_MEDIA,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


def _today() -> str:
    return date.today().isoformat()


# ---------------------------------------------------------------- inventory


@router.get("/inventory")
def export_inventory(
    store_id: str | None = None,
    limit: int = Query(5000, le=MAX_ROWS),
    user: CurrentUser = Depends(current_user),
):
    cfg = load_settings()
    stores = scope_stores(user, store_id)
    db = user.db()

    query = (db.table("inventory")
             .select("*, products(id,sku,name,image_url,mrp,category_id,"
                     "low_stock_threshold,reorder_point,safety_stock,target_stock,"
                     "categories(name)), stores(id,code,name)")
             .order("available_stock"))
    if stores is not None:
        if not stores:
            return _stream(xl.inventory_workbook([]),
                           f"inventory-{_today()}.xlsx")
        query = query.in_("store_id", stores)

    try:
        rows = query.limit(limit).execute().data
    except Exception as exc:
        raise db_error(exc, "Couldn't export inventory") from exc

    computed = build_rows(rows, cfg)
    return _stream(xl.inventory_workbook(computed), f"inventory-{_today()}.xlsx")


# ---------------------------------------------------------------- products


@router.get("/products")
def export_products(
    search: str | None = None,
    category_id: str | None = None,
    limit: int = Query(5000, le=MAX_ROWS),
    user: CurrentUser = Depends(current_user),
):
    db = user.db()
    query = (db.table("products")
             .select("*, categories(id,name), subcategories(id,name)")
             .neq("status", "archived"))
    if search and search.strip():
        term = search.strip().replace(",", " ").replace("%", " ").replace("(", " ").replace(")", " ")
        if term:
            query = query.or_(f"name.ilike.%{term}%,sku.ilike.%{term}%,barcode.ilike.%{term}%")
    if category_id:
        query = query.eq("category_id", category_id)

    try:
        rows = query.order("name").limit(limit).execute().data
    except Exception as exc:
        raise db_error(exc, "Couldn't export products") from exc

    if rows:
        ids = [p["id"] for p in rows]
        try:
            inv = (db.table("inventory")
                   .select("product_id,available_stock")
                   .in_("product_id", ids).execute()).data
        except Exception:
            inv = []
        totals: dict[str, float] = {}
        records: dict[str, int] = {}
        for row in inv:
            totals[row["product_id"]] = totals.get(row["product_id"], 0.0) + \
                float(row.get("available_stock") or 0)
            records[row["product_id"]] = records.get(row["product_id"], 0) + 1
        for product in rows:
            product["available_stock"] = totals.get(product["id"], 0.0)
            product["inventory_records"] = records.get(product["id"], 0)

    return _stream(xl.products_workbook(rows), f"products-{_today()}.xlsx")


# ---------------------------------------------------------------- orders


@router.get("/orders")
def export_orders(
    store_id: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(5000, le=MAX_ROWS),
    user: CurrentUser = Depends(current_user),
):
    stores = scope_stores(user, store_id)
    db = user.db()
    query = (db.table("purchase_orders")
             .select("*, stores(code,name), suppliers(name), "
                     "requested_by_profile:profiles!purchase_orders_requested_by_fkey(full_name,email), "
                     "purchase_order_items(id,quantity,received_quantity,unit_price,line_total,"
                     "products(id,sku,name,image_url))")
             .order("created_at", desc=True))
    if stores is not None:
        if not stores:
            return _stream(xl.orders_workbook([]), f"orders-{_today()}.xlsx")
        query = query.in_("store_id", stores)
    if status_filter:
        query = query.eq("status", status_filter)

    try:
        rows = query.limit(limit).execute().data
    except Exception as exc:
        raise db_error(exc, "Couldn't export orders") from exc

    return _stream(xl.orders_workbook(rows), f"orders-{_today()}.xlsx")


# ---------------------------------------------------------------- forecast


@router.get("/forecast")
def export_forecast(
    store_id: str | None = None,
    horizon: int = Query(14, ge=1, le=90),
    limit: int = Query(250, le=1000),
    user: CurrentUser = Depends(current_user),
):
    """Forecast results computed from real sales history.

    Products with no demand data are honestly excluded — the workbook notes it
    when that happens instead of inventing numbers.
    """
    cfg = load_settings()
    stores = scope_stores(user, store_id)
    db = user.db()

    query = (db.table("inventory")
             .select("*, products(id,sku,name,image_url,mrp,category_id), "
                     "stores(id,code,name)")
             .order("available_stock"))
    if stores is not None:
        if not stores:
            return _stream(xl.forecast_workbook([]), f"forecast-{_today()}.xlsx")
        query = query.in_("store_id", stores)

    try:
        rows = query.limit(limit * 3).execute().data
    except Exception as exc:
        raise db_error(exc, "Couldn't export forecasts") from exc

    computed = build_rows(rows, cfg, keep_series=True)
    method = cfg.get("forecast_method", "weighted_ma")
    out = []
    skipped = 0

    for row in computed:
        series = row.get("_series") or []
        if row["avg_daily_demand"] <= 0:
            skipped += 1
            continue

        cover = days_of_stock(row["available_stock"], row["avg_daily_demand"])
        forecast = fc.build_forecast(
            history=series, horizon_days=horizon, method=method,
            basis=row["demand_basis"], cover_days=cover,
        )

        start = (date.today() + timedelta(days=1)).isoformat()
        end = (date.today() + timedelta(days=horizon)).isoformat()

        level = row["risk_level"]
        priority = {"critical": "critical", "high": "high",
                    "medium": "medium", "low": "low"}.get(level, "low")
        if level == "critical":
            action = "Reorder immediately — stock may run out before replenishment arrives."
        elif level == "high":
            action = "Place an order soon for the recommended quantity."
        elif level == "medium":
            action = "Monitor; consider ordering at the next review cycle."
        else:
            action = "No action needed at current demand."

        out.append({
            "name": row["name"],
            "sku": row["sku"],
            "store_name": row["store_name"],
            "period": f"{start} to {end}",
            "history_summary": (f"{sum(series):,.0f} units over "
                                f"{forecast.history_days} days of imported history"),
            "avg_daily_demand": forecast.avg_daily_demand,
            "forecasted_demand": forecast.total_forecast,
            "trend": forecast.trend_direction,
            "trend_pct": forecast.trend_pct,
            "recommended_action": action,
            "priority": priority,
            "basis_label": ("Measured from imported SKU sales history"
                            if forecast.basis == "sku_history"
                            else "Estimated from store sales pattern"),
            "confidence": forecast.confidence,
        })

    if skipped and not out:
        # Nothing forecastable — say so inside the file rather than returning
        # an empty sheet that looks like a bug.
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Forecast"
        ws.append(["Forecast export"])
        ws.append([f"{skipped} product/store pairs had no sales history to "
                   "forecast from. Import sales data and try again."])
        return _stream(xl.workbook_bytes(wb), f"forecast-{_today()}.xlsx")

    return _stream(xl.forecast_workbook(out[:limit]), f"forecast-{_today()}.xlsx")