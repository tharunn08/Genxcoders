"""Batched computation of inventory lines.

## The problem this replaces

``build_row`` needed three things per inventory line: the SKU's daily sales
series, the store's own sales curve as a fallback, and the supplier lead time.
Each was fetched with its own Supabase query, inside the loop:

```python
for row in rows:            # /dashboard passed 500 rows
    build_row(row, cfg)     # -> demand_for()   1-3 queries
                            # -> lead_time_for() 1 query
```

So a single dashboard load issued somewhere between 1,000 and 2,000 sequential
HTTPS round trips to Supabase. At a realistic 40-80 ms each that is 40 seconds
to two and a half minutes for one screen, entirely serialised. ``/replenishment``
did the same for 400 rows, ``/transfers/suggestions`` for 600, and
``/alerts/generate`` for 500.

That is the whole of the "sections take too long to load" report, and it is also
where "API not connected" comes from: the browser abandons the request long
before the backend finishes, and a client that can't tell a timeout from a
refused connection reports the backend as down while it is in fact still working.

## What this does instead

``ComputeContext`` loads everything the whole page needs in a fixed, small
number of queries — regardless of row count — and the per-row maths then runs in
memory against those dictionaries:

* sales rows for the page's products and stores, over the demand window
* aggregate store curves for the page's stores
* lead times for the page's products

Product ids are chunked so no single PostgREST URL grows unreasonably long, and
each query pages until exhausted rather than trusting a default row cap. A
500-row dashboard now costs roughly 8-15 queries instead of ~1,500.
"""
from __future__ import annotations

import threading
import time
from datetime import date, timedelta
from typing import Any, Iterable, Sequence

from ..core.config import service_client
from ..services import forecasting as fc
from ..services import inventory_math as im

WINDOW_DAYS = 90

# PostgREST puts `in.(...)` filters in the query string. 120 uuids is ~4.5 KB,
# comfortably inside every proxy default; 500 would not be.
ID_CHUNK = 120
PAGE_SIZE = 1000
MAX_PAGES = 60  # 60k rows is far more than any single screen needs


def _chunk(items: Sequence[str], size: int = ID_CHUNK) -> Iterable[Sequence[str]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _paged(build_query, page_size: int = PAGE_SIZE) -> list[dict]:
    """Run a PostgREST query to exhaustion.

    ``build_query`` is a callable so each page gets a fresh builder — the
    supabase-py builders are stateful and can't be re-ranged.
    """
    rows: list[dict] = []
    for page in range(MAX_PAGES):
        start = page * page_size
        try:
            batch = build_query().range(start, start + page_size - 1).execute().data
        except Exception:
            break
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
    return rows


# ---------------------------------------------------------------- settings cache

_settings_cache: tuple[float, dict] | None = None
_settings_lock = threading.Lock()
SETTINGS_TTL = 30.0


def load_settings(force: bool = False) -> dict:
    """System settings, cached briefly.

    Every computed endpoint called this, so a dashboard paid for four identical
    ``system_settings`` selects before doing any work. The values change when a
    super admin edits them, and that path clears the cache explicitly.
    """
    global _settings_cache
    now = time.time()
    with _settings_lock:
        if not force and _settings_cache and _settings_cache[0] > now:
            return _settings_cache[1]

    rows = service_client().table("system_settings").select("key,value").execute().data
    cfg = im.settings_with_defaults(rows)

    with _settings_lock:
        _settings_cache = (now + SETTINGS_TTL, cfg)
    return cfg


def invalidate_settings() -> None:
    global _settings_cache
    with _settings_lock:
        _settings_cache = None


# ---------------------------------------------------------------- context


class ComputeContext:
    """Everything the per-row maths needs, loaded up front in bulk."""

    def __init__(self, items: list[dict], cfg: dict, window_days: int = WINDOW_DAYS):
        self.cfg = cfg
        self.window_days = window_days
        self.end = date.today()
        self.start = self.end - timedelta(days=window_days - 1)

        self.product_ids = sorted({i["product_id"] for i in items if i.get("product_id")})
        self.store_ids = sorted({i["store_id"] for i in items if i.get("store_id")})

        self.sales: dict[tuple[str, str], list[dict]] = {}
        self.totals: dict[tuple[str, str], float] = {}
        self.store_curve: dict[str, list[float]] = {}
        self.lead_times: dict[str, float] = {}

        if self.product_ids and self.store_ids:
            self._load_sales()
            self._load_fallback_totals(items)
            self._load_store_curves()
            self._load_lead_times()

        self._demand_cache: dict[tuple[str, str], tuple[list[float], Any]] = {}

    # -- loading ---------------------------------------------------------

    def _load_sales(self) -> None:
        svc = service_client()
        start_iso, end_iso = self.start.isoformat(), self.end.isoformat()
        for chunk in _chunk(self.product_ids):
            rows = _paged(lambda c=chunk: (
                svc.table("sales")
                .select("product_id,store_id,sale_date,quantity_sold")
                .in_("product_id", list(c))
                .in_("store_id", self.store_ids)
                .gte("sale_date", start_iso)
                .lte("sale_date", end_iso)
                .order("sale_date")
            ))
            for row in rows:
                key = (row["product_id"], row["store_id"])
                self.sales.setdefault(key, []).append(row)

    def _load_fallback_totals(self, items: list[dict]) -> None:
        """All-time quantity for pairs with nothing in the demand window.

        Mirrors the original second query in ``demand_for``: when a SKU has no
        day-level history in the window, its period total is spread across the
        store's own sales curve. Only the pairs that actually need it are
        queried, so a catalog with recent sales costs nothing extra here.
        """
        missing = [
            (i["product_id"], i["store_id"]) for i in items
            if i.get("product_id") and i.get("store_id")
            and (i["product_id"], i["store_id"]) not in self.sales
        ]
        if not missing:
            return

        svc = service_client()
        product_ids = sorted({p for p, _ in missing})
        store_ids = sorted({s for _, s in missing})
        for chunk in _chunk(product_ids):
            rows = _paged(lambda c=chunk: (
                svc.table("sales")
                .select("product_id,store_id,quantity_sold")
                .in_("product_id", list(c))
                .in_("store_id", store_ids)
            ))
            for row in rows:
                key = (row["product_id"], row["store_id"])
                self.totals[key] = self.totals.get(key, 0.0) + float(
                    row.get("quantity_sold") or 0)

    def _load_store_curves(self) -> None:
        svc = service_client()
        rows = _paged(lambda: (
            svc.table("store_daily_sales")
            .select("store_id,sale_date,total_units,total_amount")
            .in_("store_id", self.store_ids)
            .gte("sale_date", self.start.isoformat())
            .order("sale_date")
        ))
        for row in rows:
            value = row.get("total_units")
            if value is None:
                value = row.get("total_amount")
            self.store_curve.setdefault(row["store_id"], []).append(float(value or 0))

    def _load_lead_times(self) -> None:
        svc = service_client()
        for chunk in _chunk(self.product_ids):
            try:
                rows = (svc.table("product_suppliers")
                        .select("product_id,lead_time_days,suppliers(avg_lead_time_days)")
                        .in_("product_id", list(chunk)).execute()).data
            except Exception:
                continue
            for row in rows:
                product_id = row["product_id"]
                if product_id in self.lead_times:
                    continue  # first supplier wins, matching the old .limit(1)
                direct = row.get("lead_time_days")
                if direct:
                    self.lead_times[product_id] = float(direct)
                    continue
                supplier = row.get("suppliers") or {}
                if supplier.get("avg_lead_time_days"):
                    self.lead_times[product_id] = float(supplier["avg_lead_time_days"])

    # -- lookups ---------------------------------------------------------

    def lead_time(self, product_id: str) -> float:
        return self.lead_times.get(
            product_id, float(self.cfg.get("default_lead_time", 7) or 7))

    def demand(self, product_id: str, store_id: str):
        """(daily series, DemandResult) — identical maths, no queries."""
        key = (product_id, store_id)
        cached = self._demand_cache.get(key)
        if cached is not None:
            return cached

        rows = self.sales.get(key) or []
        if rows:
            series = fc.series_from_rows(rows, self.start, self.end)
            result = (series, im.average_daily_demand(series))
            self._demand_cache[key] = result
            return result

        # No day-level history in the window. Spread whatever total exists
        # across the store's own curve, exactly as before.
        total_qty = self.totals.get(key, 0.0)
        if total_qty <= 0:
            result = ([], im.average_daily_demand([]))
            self._demand_cache[key] = result
            return result

        derived = im.derive_demand_from_store_pattern(
            total_qty, self.window_days, self.store_curve.get(store_id, []))
        result = ([derived.avg_daily_demand] * self.window_days, derived)
        self._demand_cache[key] = result
        return result


# ---------------------------------------------------------------- row builder


def build_row(item: dict, cfg: dict, ctx: ComputeContext | None = None) -> dict:
    """One fully-computed inventory line: demand, cover, reorder point, risk, status.

    ``ctx`` carries the pre-loaded data. It stays optional so a caller computing
    a single row (the what-if simulator) doesn't have to build one, but any loop
    must pass it — that is the whole point of this module.
    """
    if ctx is None:
        ctx = ComputeContext([item], cfg)

    product = item.get("products") or {}
    product_id, store_id = item["product_id"], item["store_id"]

    series, demand = ctx.demand(product_id, store_id)
    lead_time = ctx.lead_time(product_id)
    available = float(item.get("available_stock") or 0)

    # Per-product quantity settings (migration 0005) override the derived
    # values. NULL means "derive from global settings" so an untouched catalog
    # behaves exactly as before. Because every screen is computed from this
    # row, editing a product's thresholds or a stock level propagates to the
    # inventory status, alerts, dashboard, AI insights and replenishment
    # recommendations automatically.
    safety_override = product.get("safety_stock")
    if safety_override is not None:
        safety, safety_method = float(safety_override), "product setting"
    else:
        safety, safety_method = im.safety_stock(
            demand.avg_daily_demand, lead_time, cfg,
            demand_variability=demand.variability)

    reorder_pt_override = product.get("reorder_point")
    if reorder_pt_override is not None:
        reorder_pt = float(reorder_pt_override)
    else:
        reorder_pt = im.reorder_point(demand.avg_daily_demand, lead_time, safety)
    cover = im.days_of_stock(available, demand.avg_daily_demand)

    risk = im.stockout_risk(
        available_stock=available,
        avg_daily_demand=demand.avg_daily_demand,
        lead_time_days=lead_time,
        safety=safety,
        on_order=float(item.get("stock_on_order") or 0),
        on_route=float(item.get("stock_on_route") or 0),
    )
    status_label = im.classify_stock(
        available_stock=available, avg_daily_demand=demand.avg_daily_demand,
        reorder_pt=reorder_pt, cfg=cfg)

    # A product-level low-stock threshold is a direct signal: once stock falls
    # to (or below) it, the product is low — unless the derived engine already
    # flagged something more severe (out of stock / critical).
    low_stock_threshold = product.get("low_stock_threshold")
    if (low_stock_threshold is not None and available > 0
            and available <= float(low_stock_threshold)
            and status_label in ("healthy", "overstock")):
        status_label = "low"

    store = item.get("stores") or {}

    return {
        "inventory_id": item.get("id"),
        "product_id": product_id,
        "store_id": store_id,
        "store_name": store.get("name"),
        "store_code": store.get("code"),
        "sku": product.get("sku"),
        "name": product.get("name"),
        "image_url": product.get("image_url"),
        "mrp": product.get("mrp"),
        "category_id": product.get("category_id"),
        "category_name": (product.get("categories") or {}).get("name"),
        "current_stock": float(item.get("current_stock") or 0),
        "available_stock": available,
        "warehouse_stock": float(item.get("warehouse_stock") or 0),
        "stock_on_route": float(item.get("stock_on_route") or 0),
        "stock_on_order": float(item.get("stock_on_order") or 0),
        "inventory_value": item.get("inventory_value"),
        "avg_daily_demand": demand.avg_daily_demand,
        "demand_basis": demand.basis,
        "demand_note": demand.note,
        "days_of_stock": cover,
        "lead_time_days": lead_time,
        "safety_stock": safety,
        "safety_method": safety_method,
        "reorder_point": reorder_pt,
        "low_stock_threshold": product.get("low_stock_threshold"),
        "safety_override": product.get("safety_stock"),
        "target_stock": product.get("target_stock"),
        "stock_status": status_label,
        "risk_score": risk.score,
        "risk_level": risk.level,
        "risk_reason": risk.reason,
        "expected_stockout_date": risk.expected_stockout_date,
        "_series": series,
    }


def build_rows(items: list[dict], cfg: dict, *, keep_series: bool = False) -> list[dict]:
    """The batched entry point. Use this anywhere more than one row is computed."""
    if not items:
        return []
    ctx = ComputeContext(items, cfg)
    rows = [build_row(item, cfg, ctx) for item in items]
    if not keep_series:
        for row in rows:
            row.pop("_series", None)
    return rows
