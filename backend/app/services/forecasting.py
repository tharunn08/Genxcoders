"""Forecasting engine.

Three baseline models, chosen for explainability over sophistication: every
predicted number can be traced to specific days of imported sales. Swapping in
Prophet or XGBoost later means adding a function with the same signature and
registering it in MODELS — nothing else changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import mean, pstdev


@dataclass
class ForecastPoint:
    forecast_date: str
    predicted_qty: float
    lower_bound: float
    upper_bound: float


@dataclass
class Factor:
    factor: str
    impact: str        # low | medium | high
    direction: str     # positive | negative | neutral
    detail: str
    weight: float


@dataclass
class Forecast:
    method: str
    basis: str
    horizon_days: int
    avg_daily_demand: float
    total_forecast: float
    confidence: float
    trend_direction: str
    trend_pct: float
    history_days: int
    points: list[ForecastPoint] = field(default_factory=list)
    factors: list[Factor] = field(default_factory=list)


# ---------------------------------------------------------------- models


def moving_average(history: list[float], horizon: int, window: int = 14) -> list[float]:
    if not history:
        return [0.0] * horizon
    window = min(window, len(history))
    base = mean(history[-window:])
    return [round(base, 3)] * horizon


def weighted_moving_average(history: list[float], horizon: int, window: int = 14) -> list[float]:
    """Recent days weighted more heavily — responds faster to a demand shift."""
    if not history:
        return [0.0] * horizon
    window = min(window, len(history))
    recent = history[-window:]
    weights = list(range(1, len(recent) + 1))
    base = sum(v * w for v, w in zip(recent, weights)) / sum(weights)
    return [round(base, 3)] * horizon


def linear_trend(history: list[float], horizon: int, window: int = 28) -> list[float]:
    """Least-squares fit, projected forward and floored at zero."""
    if not history:
        return [0.0] * horizon
    window = min(window, len(history))
    y = history[-window:]
    n = len(y)
    if n < 3:
        return moving_average(history, horizon)

    xs = list(range(n))
    x_mean, y_mean = mean(xs), mean(y)
    denom = sum((x - x_mean) ** 2 for x in xs)
    slope = 0.0 if denom == 0 else sum((x - x_mean) * (v - y_mean) for x, v in zip(xs, y)) / denom
    intercept = y_mean - slope * x_mean

    return [round(max(0.0, intercept + slope * (n + i)), 3) for i in range(horizon)]


MODELS = {
    "moving_average": moving_average,
    "weighted_ma": weighted_moving_average,
    "linear_trend": linear_trend,
}


# ---------------------------------------------------------------- driver


def _trend(history: list[float]) -> tuple[str, float]:
    """Compare the most recent week against the week before it."""
    if len(history) < 14:
        return "flat", 0.0
    recent, prior = mean(history[-7:]), mean(history[-14:-7])
    if prior == 0:
        return ("up", 100.0) if recent > 0 else ("flat", 0.0)
    pct = (recent - prior) / prior * 100
    if pct > 5:
        return "up", round(pct, 1)
    if pct < -5:
        return "down", round(pct, 1)
    return "flat", round(pct, 1)


def _confidence(history: list[float], basis: str) -> float:
    """Lower confidence for short history, volatile demand, or derived data."""
    if not history:
        return 0.0

    days = len(history)
    coverage = min(1.0, days / 60)              # 60+ days of history = full marks

    avg = mean(history)
    if avg > 0 and days > 1:
        cv = pstdev(history) / avg              # coefficient of variation
        stability = max(0.0, 1.0 - min(cv, 1.5) / 1.5)
    else:
        stability = 0.3

    score = (coverage * 0.55 + stability * 0.45) * 100
    if basis == "store_pattern_derived":
        score *= 0.65                            # estimated inputs, not observed
    return round(min(95.0, max(5.0, score)), 1)


def _factors(history: list[float], trend_dir: str, trend_pct: float,
             basis: str, cover_days: float | None) -> list[Factor]:
    """Explanations derived from the same numbers that produced the forecast."""
    out: list[Factor] = []

    if trend_dir != "flat":
        impact = "high" if abs(trend_pct) >= 20 else "medium"
        direction = "positive" if trend_dir == "up" else "negative"
        verb = "rose" if trend_dir == "up" else "fell"
        out.append(Factor(
            "Recent sales trend", impact, direction,
            f"Average daily sales {verb} {abs(trend_pct):.1f}% over the last 7 days "
            "compared with the 7 days before.",
            round(abs(trend_pct) / 100, 2),
        ))
    else:
        out.append(Factor(
            "Recent sales trend", "low", "neutral",
            "Daily sales held steady across the last two weeks.", 0.1,
        ))

    days = len(history)
    if days >= 60:
        out.append(Factor("Length of sales history", "high", "positive",
                          f"{days} days of imported sales support this forecast.", 0.3))
    elif days >= 21:
        out.append(Factor("Length of sales history", "medium", "neutral",
                          f"{days} days of history — enough for a short horizon.", 0.2))
    else:
        out.append(Factor("Length of sales history", "medium", "negative",
                          f"Only {days} days of history, so the forecast is provisional.", 0.2))

    if history and mean(history) > 0:
        cv = pstdev(history) / mean(history) if days > 1 else 0
        if cv > 0.8:
            out.append(Factor("Demand consistency", "high", "negative",
                              "Daily sales swing widely, which widens the forecast range.", 0.25))
        elif cv > 0.4:
            out.append(Factor("Demand consistency", "medium", "neutral",
                              "Sales vary moderately day to day.", 0.15))
        else:
            out.append(Factor("Demand consistency", "medium", "positive",
                              "Sales are steady day to day, tightening the forecast range.", 0.15))

    if cover_days is not None:
        if cover_days < 7:
            out.append(Factor("Inventory velocity", "high", "negative",
                              f"Current stock covers roughly {cover_days:.1f} days at this rate.", 0.3))
        elif cover_days > 60:
            out.append(Factor("Inventory velocity", "medium", "negative",
                              f"Stock covers about {cover_days:.0f} days — well beyond demand.", 0.2))

    if basis == "store_pattern_derived":
        out.append(Factor("Data basis", "high", "neutral",
                          "No day-level sales for this SKU. Demand was estimated from the "
                          "product's period total spread across the store's sales pattern.", 0.35))

    return out


def build_forecast(
    *,
    history: list[float],
    horizon_days: int = 14,
    method: str = "weighted_ma",
    basis: str = "sku_history",
    start_date: date | None = None,
    cover_days: float | None = None,
) -> Forecast:
    """`history` is one value per day, oldest first, zeros included."""
    start = (start_date or date.today()) + timedelta(days=1)
    model = MODELS.get(method, weighted_moving_average)
    predictions = model(history, horizon_days)

    trend_dir, trend_pct = _trend(history)
    confidence = _confidence(history, basis)

    # Interval width tracks both demand volatility and how much we trust the model.
    spread = pstdev(history) if len(history) > 1 else 0.0
    band = spread * (1.0 + (100 - confidence) / 100)

    points = [
        ForecastPoint(
            (start + timedelta(days=i)).isoformat(),
            qty,
            round(max(0.0, qty - band), 3),
            round(qty + band, 3),
        )
        for i, qty in enumerate(predictions)
    ]

    total = round(sum(predictions), 2)
    return Forecast(
        method=method,
        basis=basis,
        horizon_days=horizon_days,
        avg_daily_demand=round(total / horizon_days, 3) if horizon_days else 0.0,
        total_forecast=total,
        confidence=confidence,
        trend_direction=trend_dir,
        trend_pct=trend_pct,
        history_days=len(history),
        points=points,
        factors=_factors(history, trend_dir, trend_pct, basis, cover_days),
    )


def series_from_rows(rows: list[dict], start: date, end: date,
                     date_key: str = "sale_date", qty_key: str = "quantity_sold") -> list[float]:
    """Turn sparse sales rows into a dense daily series, filling missing days with zero."""
    by_day: dict[str, float] = {}
    for row in rows:
        key = str(row[date_key])[:10]
        by_day[key] = by_day.get(key, 0.0) + float(row.get(qty_key) or 0)

    series, cursor = [], start
    while cursor <= end:
        series.append(by_day.get(cursor.isoformat(), 0.0))
        cursor += timedelta(days=1)
    return series
