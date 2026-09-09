"""Inventory calculations.

Every figure the UI shows is produced here from imported data. Where a value is
derived rather than directly observed, the `basis` field says so — the front end
labels it, so a store manager can tell a measured number from an estimated one.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from statistics import mean, pstdev

DEFAULTS = {
    "safety_days": 5.0,
    "safety_method": "days",       # days | percentage | variability
    "safety_percentage": 20.0,
    "service_level_z": 1.65,
    "default_lead_time": 7.0,
    "forecast_horizon": 14,
    "risk_critical_days": 3.0,
    "risk_low_days": 7.0,
    "overstock_days": 60.0,
    "review_period_days": 7.0,
}


def settings_with_defaults(rows: list[dict] | None) -> dict:
    cfg = dict(DEFAULTS)
    for row in rows or []:
        value = row.get("value")
        if isinstance(value, str) and value.replace(".", "", 1).isdigit():
            value = float(value)
        cfg[row["key"]] = value
    return cfg


# ---------------------------------------------------------------- demand


@dataclass
class DemandResult:
    avg_daily_demand: float
    days_observed: int
    basis: str            # sku_history | store_pattern_derived | no_data
    variability: float    # standard deviation of daily demand
    note: str


def average_daily_demand(
    daily_qty: list[float],
    *,
    period_days: int | None = None,
) -> DemandResult:
    """Total quantity sold divided by number of days in the period.

    `daily_qty` should hold one entry per day in the window, including zeros —
    dropping zero-sale days inflates the average and understates stockout risk.
    """
    if not daily_qty:
        return DemandResult(0.0, 0, "no_data", 0.0,
                            "No sales history has been imported for this product.")

    days = period_days or len(daily_qty)
    if days <= 0:
        return DemandResult(0.0, 0, "no_data", 0.0, "Sales period could not be determined.")

    total = float(sum(daily_qty))
    avg = total / days
    variability = pstdev(daily_qty) if len(daily_qty) > 1 else 0.0

    note = f"{total:,.0f} units sold across {days} days of imported history."
    return DemandResult(round(avg, 3), days, "sku_history", round(variability, 3), note)


def derive_demand_from_store_pattern(
    sku_period_qty: float,
    period_days: int,
    store_daily_totals: list[float],
) -> DemandResult:
    """Fallback when a SKU has an aggregate quantity but no day-by-day history.

    Spreads the SKU total across days in proportion to the store's own daily
    sales curve. This is an estimate, and is labelled as one everywhere it appears.
    """
    if period_days <= 0 or sku_period_qty <= 0:
        return DemandResult(0.0, 0, "no_data", 0.0, "Not enough data to estimate demand.")

    avg = sku_period_qty / period_days
    variability = 0.0
    if store_daily_totals and sum(store_daily_totals) > 0:
        store_mean = mean(store_daily_totals)
        if store_mean > 0:
            # Scale the store's day-to-day variation onto this SKU's average.
            variability = round(pstdev(store_daily_totals) / store_mean * avg, 3)

    return DemandResult(
        round(avg, 3), period_days, "store_pattern_derived", variability,
        f"Estimated: {sku_period_qty:,.0f} units over {period_days} days, "
        "spread using this store's daily sales pattern.",
    )


# ---------------------------------------------------------------- stock cover


def days_of_stock(available: float, avg_daily_demand: float) -> float | None:
    """Days until stock runs out. None means demand is zero — no runway to compute."""
    if avg_daily_demand <= 0:
        return None
    if available <= 0:
        return 0.0
    return round(available / avg_daily_demand, 2)


def safety_stock(
    avg_daily_demand: float,
    lead_time_days: float,
    cfg: dict,
    *,
    demand_variability: float = 0.0,
) -> tuple[float, str]:
    """Returns (units, human-readable method description)."""
    method = cfg.get("safety_method", "days")

    if method == "percentage":
        pct = float(cfg.get("safety_percentage", 20.0))
        units = avg_daily_demand * lead_time_days * (pct / 100.0)
        return round(units, 2), f"{pct:g}% of lead-time demand"

    if method == "variability" and demand_variability > 0:
        z = float(cfg.get("service_level_z", 1.65))
        units = z * demand_variability * math.sqrt(max(lead_time_days, 0.0))
        return round(units, 2), f"demand variability at {z:g} service factor"

    days = float(cfg.get("safety_days", 5.0))
    return round(avg_daily_demand * days, 2), f"{days:g} days of demand"


def reorder_point(avg_daily_demand: float, lead_time_days: float, safety: float) -> float:
    """(demand during lead time) + safety stock."""
    return round(avg_daily_demand * lead_time_days + safety, 2)


def recommended_quantity(
    *,
    forecast_demand: float,
    safety: float,
    available_stock: float,
    on_order: float = 0.0,
    on_route: float = 0.0,
) -> float:
    """Order up to (forecast demand + safety), minus everything already coming."""
    required = forecast_demand + safety
    net_supply = available_stock + on_order + on_route
    return round(max(0.0, required - net_supply), 2)


# ---------------------------------------------------------------- risk


@dataclass
class RiskResult:
    score: float                 # 0-100
    level: str                   # low | medium | high | critical
    expected_stockout_date: str | None
    reason: str


def stockout_risk(
    *,
    available_stock: float,
    avg_daily_demand: float,
    lead_time_days: float,
    safety: float,
    on_order: float = 0.0,
    on_route: float = 0.0,
    today: date | None = None,
) -> RiskResult:
    """Risk that stock reaches zero before replenishment can land.

    The score compares days of cover against the lead time. Cover shorter than
    the lead time means an order placed today arrives too late.
    """
    today = today or date.today()
    net = available_stock + on_order + on_route

    if avg_daily_demand <= 0:
        if net <= 0:
            return RiskResult(50.0, "medium", None,
                              "Out of stock, but no demand history to size the risk.")
        return RiskResult(0.0, "low", None, "No measured demand for this product.")

    if net <= 0:
        return RiskResult(100.0, "critical", today.isoformat(),
                          "No stock on hand and nothing on order.")

    cover = net / avg_daily_demand
    horizon = max(lead_time_days, 1.0)
    safety_days_equiv = safety / avg_daily_demand if avg_daily_demand else 0.0

    # Cover at or below lead time = certain shortfall; at lead time + safety = comfortable.
    span = horizon + max(safety_days_equiv, 1.0)
    raw = (span - cover) / span
    score = round(max(0.0, min(1.0, raw)) * 100, 1)

    if score >= 80:
        level = "critical"
    elif score >= 55:
        level = "high"
    elif score >= 30:
        level = "medium"
    else:
        level = "low"

    stockout_on = today + timedelta(days=int(cover))
    if cover < horizon:
        reason = (f"{cover:.1f} days of cover against a {horizon:g}-day lead time — "
                  "an order placed today would arrive after stock runs out.")
    elif score >= 30:
        reason = (f"{cover:.1f} days of cover leaves little margin above the "
                  f"{horizon:g}-day lead time plus safety stock.")
    else:
        reason = f"{cover:.1f} days of cover comfortably exceeds the {horizon:g}-day lead time."

    return RiskResult(score, level, stockout_on.isoformat(), reason)


def classify_stock(
    *,
    available_stock: float,
    avg_daily_demand: float,
    reorder_pt: float,
    cfg: dict,
) -> str:
    """Returns one of: out_of_stock, critical, low, healthy, overstock."""
    if available_stock <= 0:
        return "out_of_stock"

    cover = days_of_stock(available_stock, avg_daily_demand)
    if cover is None:
        # Stock with no demand signal. There is no days-of-cover to compare
        # against any threshold, so guessing overstock flags every catalog row
        # with stock the same way. Report it as in stock instead; once sales
        # history exists the normal thresholds take over.
        return "healthy"

    if cover <= float(cfg.get("risk_critical_days", 3)):
        return "critical"
    if cover <= float(cfg.get("risk_low_days", 7)) or available_stock <= reorder_pt:
        return "low"
    if cover >= float(cfg.get("overstock_days", 60)):
        return "overstock"
    return "healthy"


@dataclass
class OverstockResult:
    is_overstock: bool
    days_of_supply: float | None
    excess_units: float
    excess_value: float
    recommendation: str


def overstock_analysis(
    *,
    available_stock: float,
    avg_daily_demand: float,
    unit_value: float | None,
    cfg: dict,
) -> OverstockResult:
    threshold_days = float(cfg.get("overstock_days", 60))
    cover = days_of_stock(available_stock, avg_daily_demand)

    if cover is None:
        excess = available_stock
        value = excess * (unit_value or 0.0)
        return OverstockResult(
            available_stock > 0, None, round(excess, 2), round(value, 2),
            "No demand recorded in the imported history — review whether this is dead stock.",
        )

    if cover <= threshold_days:
        return OverstockResult(False, cover, 0.0, 0.0, "Stock level is in line with demand.")

    target_units = avg_daily_demand * threshold_days
    excess = max(0.0, available_stock - target_units)
    value = excess * (unit_value or 0.0)

    if cover > threshold_days * 3:
        action = "Hold replenishment and consider a promotion or transfer to clear the excess."
    elif cover > threshold_days * 2:
        action = "Pause reordering and look for a store that can absorb the surplus."
    else:
        action = "Reduce the next replenishment cycle and keep watching demand."

    return OverstockResult(True, cover, round(excess, 2), round(value, 2), action)


def as_dict(obj) -> dict:
    return asdict(obj)
