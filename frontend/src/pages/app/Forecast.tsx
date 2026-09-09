import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowRight, CalendarRange, Download, LineChart as LineChartIcon, Store as StoreIcon, TrendingDown, TrendingUp, Minus, Upload } from "lucide-react";
import { api, downloadExcel, ForecastResult, Product, Store } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  ErrorNote, money, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import { Busy } from "@/components/ui/forms";

const HORIZONS = [7, 14, 30, 60, 90];
const METHODS: [string, string][] = [
  ["", "Auto (weighted moving average)"],
  ["moving_average", "Moving average"],
  ["weighted_ma", "Weighted moving average"],
  ["linear_trend", "Linear trend"],
];

export default function Forecast() {
  const { activeStore, can } = useAuth();
  const navigate = useNavigate();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState(activeStore?.id ?? "");
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [horizon, setHorizon] = useState(14);
  const [method, setMethod] = useState("");
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  async function exportForecast() {
    setExporting(true);
    setError("");
    try {
      const params = new URLSearchParams({ horizon: String(horizon), limit: "250" });
      if (activeStore) params.set("store_id", activeStore.id);
      await downloadExcel(`/export/forecast?${params}`, `forecast-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    api.get<{ items: Store[] }>("/stores")
      .then((r) => {
        setStores(r.items);
        setStoreId((current) => current || (r.items.length === 1 ? r.items[0].id : ""));
      })
      .catch(() => { /* stores stay empty; the form explains itself */ });
  }, []);

  useEffect(() => {
    if (!activeStore) return;
    setStoreId(activeStore.id);
  }, [activeStore?.id]);

  useEffect(() => {
    if (productQuery.trim().length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.get<{ items: Product[] }>(
        `/products?search=${encodeURIComponent(productQuery.trim())}&limit=8`,
        { signal: controller.signal })
        .then((r) => setMatches(r.items))
        .catch(() => setMatches([]));
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [productQuery]);

  useEffect(() => {
    if (!product || !storeId) { setResult(null); return; }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      product_id: product.id, store_id: storeId, horizon: String(horizon),
    });
    if (method) params.set("method", method);
    api.get<ForecastResult>(`/forecast?${params}`, { signal: controller.signal })
      .then((r) => setResult(r))
      .catch((e) => { if (e.name !== "ApiError" || e.status !== -1) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [product?.id, storeId, horizon, method]);

  const chart = useMemo(() => {
    if (!result?.available || !result.history || !result.points) return null;
    // Historical actuals, then forecast points (with a confidence band).
    const history = result.history.map((h) => ({ date: h.date, actual: h.actual }));
    const forecast = result.points.map((p) => ({
      date: p.date, predicted: p.predicted_qty,
      lower: p.lower_bound ?? null, upper: p.upper_bound ?? null,
    }));
    const firstForecast = forecast[0]?.date;
    return { history, forecast, firstForecast };
  }, [result]);

  const trend = result?.trend_direction;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Demand forecast</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Historical demand → forecasted demand → recommended action, computed from
            your imported sales data.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("import_data") && (
            <button className="btn-ghost"
                    onClick={() => navigate("/app/admin/imports?type=store_sales")}>
              <Upload className="h-4 w-4" /> Import sales history
            </button>
          )}
          <button className="btn-ghost" onClick={exportForecast} disabled={exporting}>
            {exporting ? <Busy label="Exporting…" /> : <><Download className="h-4 w-4" /> Export forecast to Excel</>}
          </button>
        </div>
      </header>

      <div className="panel grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Product</label>
          {product ? (
            <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <Thumb src={product.image_url} alt={product.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{product.name}</span>
                <span className="text-micro text-ink-faint tnum">{product.sku}</span>
              </span>
              <button className="btn-quiet px-2 py-1 text-micro"
                      onClick={() => { setProduct(null); setProductQuery(""); }}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className="field"
                placeholder="Search by name or SKU"
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
              />
              {matches.length > 0 && (
                <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-line">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover"
                        onClick={() => { setProduct(p); setMatches([]); }}
                      >
                        <Thumb src={p.image_url} alt={p.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{p.name}</span>
                          <span className="text-micro text-ink-faint tnum">{p.sku}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Store</label>
          <select className="field" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Choose a store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Forecast period</label>
          <div className="flex flex-wrap gap-1.5">
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`rounded-lg border px-2.5 py-1.5 text-micro transition-colors ${
                  horizon === h ? "border-wine bg-peach-light text-wine"
                                : "border-line text-ink-muted hover:bg-surface-hover"}`}
              >
                {h}d
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Method</label>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map(([value, label]) => (
              <option key={value || "auto"} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      {!product || !storeId ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="rounded-2xl bg-peach-light p-3.5">
            <LineChartIcon className="h-5 w-5 text-wine" />
          </div>
          <h3 className="font-display text-lg font-medium">Choose a product and store</h3>
          <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
            The forecast is computed per product per store from that store's
            imported sales history. Pick both to see the projection.
          </p>
        </div>
      ) : loading ? (
        <Spinner label="Computing the forecast…" />
      ) : !result ? null : !result.available ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="rounded-2xl bg-canvas-tint p-3.5">
            <CalendarRange className="h-5 w-5 text-ink-faint" />
          </div>
          <h3 className="font-display text-lg font-medium">Insufficient historical data for forecasting</h3>
          <p className="max-w-md text-sm leading-relaxed text-ink-muted">
            {result.message ?? "No sales history has been imported for this product and store."}
          </p>
          {result.action && (
            <p className="text-micro text-wine">{result.action}</p>
          )}
        </div>
      ) : (
        <>
          <section className="panel p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-sm font-semibold">
                Demand — history vs forecast ({result.horizon_days} days)
              </h2>
              <span className="chip bg-canvas-tint text-ink-muted">
                Method: {String(result.method ?? "").replace(/_/g, " ")}
              </span>
            </div>
            {chart && (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart
                  data={[...chart.history, ...chart.forecast]}
                  margin={{ top: 8, right: 8, bottom: 0, left: -14 }}
                >
                  <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#9A908C", fontSize: 10 }}
                         tickFormatter={(d: string) => d.slice(5)}
                         tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis tick={{ fill: "#9A908C", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(122,31,43,0.14)",
                      boxShadow: "0 12px 32px -16px rgba(90,20,32,.3)", color: "#1C1717",
                      borderRadius: 10, fontSize: 12 }}
                    labelStyle={{ color: "#6F6663" }}
                  />
                  <Bar dataKey="actual" name="Historical demand" fill="#F3A58B"
                       radius={[3, 3, 0, 0]} barSize={8} />
                  <Area dataKey="lower" name="Lower bound" stroke="none"
                        fill="rgba(122,31,43,0.06)" stackId="band" />
                  <Area dataKey="upper" name="Upper bound" stroke="none"
                        fill="rgba(122,31,43,0.06)" stackId="band" />
                  <Line type="monotone" dataKey="predicted" name="Forecast"
                        stroke="#7A1F2B" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Forecast summary</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Average daily demand" value={`${units(result.avg_daily_demand)} units`} />
                <Row label="Total forecast" value={`${units(result.total_forecast)} units over ${result.horizon_days}d`} />
                <Row label="Confidence" value={`${result.confidence ?? "—"}%`} />
                <Row label="History used" value={`${result.history_days ?? 0} days`} />
                <Row label="Trend" value={trend ? trend : "—"} />
              </dl>
            </section>

            <section className="glass wash-peach p-5">
              <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
                <ArrowRight className="h-4 w-4 text-wine" /> Recommended action
              </h2>
              <div className="mt-4 flex items-start gap-3">
                {trend === "up" ? (
                  <TrendingUp className="mt-0.5 h-5 w-5 shrink-0 text-healthy" />
                ) : trend === "down" ? (
                  <TrendingDown className="mt-0.5 h-5 w-5 shrink-0 text-overstock" />
                ) : (
                  <Minus className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" />
                )}
                <div>
                  <p className="text-sm leading-relaxed">
                    {trend === "up" && (
                      <>Demand is expected to <strong className="text-healthy">
                        increase by {Math.abs(result.trend_pct ?? 0).toFixed(0)}%</strong> over
                        the next {result.horizon_days} days.</>
                    )}
                    {trend === "down" && (
                      <>Demand is expected to <strong>decline by
                        {Math.abs(result.trend_pct ?? 0).toFixed(0)}%</strong> over
                        the next {result.horizon_days} days.</>
                    )}
                    {trend === "flat" && (
                      <>Demand is expected to stay <strong>flat</strong> over the next
                        {result.horizon_days} days.</>
                    )}
                  </p>
                  <p className="mt-2 text-micro leading-relaxed text-ink-muted">
                    {trend === "up"
                      ? "Increase replenishment quantities to avoid stockouts as demand grows."
                      : trend === "down"
                        ? "Align replenishment with the expected decline to avoid overstock."
                        : "Maintain current replenishment cadence and keep monitoring."}
                    {" "}Open Smart Replenishment for the exact order quantity.
                  </p>
                </div>
              </div>
            </section>

            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Why this forecast</h2>
              <p className="mt-3 text-micro leading-relaxed text-ink-muted">
                {result.basis_label}
              </p>
              {result.demand_note && (
                <p className="mt-2 text-micro leading-relaxed text-ink-muted">
                  {result.demand_note}
                </p>
              )}
              {(result.factors?.length ?? 0) > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {result.factors!.map((f, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 text-micro">
                      <span className="text-ink-muted">{f.factor}</span>
                      <span className={`chip shrink-0 ${
                        f.direction === "positive" ? "bg-healthy-soft text-healthy"
                          : f.direction === "negative" ? "bg-critical-soft text-critical"
                          : "bg-canvas-tint text-ink-muted"}`}>
                        {f.direction}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <p className="flex items-center gap-2 text-micro text-ink-faint">
            <StoreIcon className="h-3.5 w-3.5" />
            Forecast basis: {result.basis_label} · MRP {product ? money(product.mrp) : "—"}
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium tnum">{value}</dd>
    </div>
  );
}