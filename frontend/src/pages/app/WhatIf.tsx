import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, Info } from "lucide-react";
import { api, ApiError, Product, Store } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  ErrorNote, Spinner, Thumb, units,
} from "@/components/ui/primitives";

interface Scenario {
  before: Record<string, any>;
  after: Record<string, any>;
  product: { sku: string; name: string; image_url: string | null };
}

export default function WhatIf() {
  const { activeStore } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState(activeStore?.id ?? "");
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [demandPct, setDemandPct] = useState(10);
  const [leadTime, setLeadTime] = useState("");
  const [safetyDays, setSafetyDays] = useState("");
  const [currentStock, setCurrentStock] = useState("");
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    api.get<{ items: Store[] }>("/stores")
      .then((r) => {
        setStores(r.items);
        setStoreId((cur) => cur || (r.items.length === 1 ? r.items[0].id : ""));
      })
      .catch(() => {});
  }, []);

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

  async function run() {
    if (!product || !storeId) { setError(new Error("Choose a product and a store.")); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<Scenario>("/what-if", {
        product_id: product.id,
        store_id: storeId,
        demand_change_pct: demandPct,
        lead_time_days: leadTime.trim() === "" ? null : Number(leadTime),
        safety_days: safetyDays.trim() === "" ? null : Number(safetyDays),
        current_stock: currentStock.trim() === "" ? null : Number(currentStock),
      });
      setScenario(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">What-if simulator</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Change demand, lead time or stock and see the effect on risk and the
          recommended order — using the same maths as the live screens.
        </p>
      </header>

      <div className="panel grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
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
              <input className="field" placeholder="Search by name or SKU"
                     value={productQuery} onChange={(e) => setProductQuery(e.target.value)} />
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
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">
            Demand change: {demandPct > 0 ? "+" : ""}{demandPct}%
          </label>
          <input
            type="range" min={-50} max={100} step={5} value={demandPct}
            onChange={(e) => setDemandPct(Number(e.target.value))}
            className="w-full accent-wine"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Lead time (days)</label>
          <input className="field tnum" inputMode="decimal" placeholder="Use current"
                 value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Safety days</label>
          <input className="field tnum" inputMode="decimal" placeholder="Use current"
                 value={safetyDays} onChange={(e) => setSafetyDays(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-micro font-medium text-ink-muted">Current stock</label>
          <input className="field tnum" inputMode="decimal" placeholder="Use current"
                 value={currentStock} onChange={(e) => setCurrentStock(e.target.value)} />
        </div>

        <div className="flex items-end sm:col-span-2 lg:col-span-3">
          <button className="btn-primary" onClick={run} disabled={loading || !product || !storeId}>
            <FlaskConical className="h-4 w-4" />
            {loading ? "Running…" : "Run simulation"}
          </button>
        </div>
      </div>

      {error && <ErrorNote error={error} />}

      {scenario && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="panel p-5">
            <h2 className="font-display text-sm font-semibold">Current position</h2>
            <MetricGrid data={scenario.before} />
          </section>
          <section className="glass wash-peach p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold">After the change</h2>
              <ArrowRight className="h-4 w-4 text-wine" />
            </div>
            <MetricGrid data={scenario.after} highlight />
            {scenario.after.reason && (
              <p className="mt-4 rounded-xl bg-white/60 px-4 py-3 text-micro leading-relaxed text-ink-muted">
                {scenario.after.reason}
              </p>
            )}
            {scenario.after.recommended_qty > 0 && (
              <div className="mt-4 flex items-center justify-between rounded-xl bg-wine px-4 py-3 text-white">
                <span className="text-sm">Recommended order</span>
                <span className="font-display text-xl font-semibold tnum">
                  {units(scenario.after.recommended_qty)} units
                </span>
              </div>
            )}
          </section>
        </div>
      )}

      <p className="flex items-center gap-2 text-micro text-ink-faint">
        <Info className="h-3.5 w-3.5" />
        The simulator does not change any data — it only recomputes the maths.
      </p>
    </div>
  );
}

const METRICS: { key: string; label: string; format?: (v: any) => string }[] = [
  { key: "avg_daily_demand", label: "Daily demand", format: (v) => `${units(v)} units` },
  { key: "lead_time_days", label: "Lead time", format: (v) => `${v}d` },
  { key: "safety_stock", label: "Safety stock", format: units },
  { key: "reorder_point", label: "Reorder point", format: units },
  { key: "days_of_stock", label: "Days of stock", format: (v) => (v == null ? "—" : v.toFixed(1)) },
  { key: "risk_score", label: "Risk score", format: (v) => `${v}/100` },
  { key: "risk_level", label: "Risk level" },
  { key: "available_stock", label: "Available stock", format: units },
];

function MetricGrid({ data, highlight }: { data: Record<string, any>; highlight?: boolean }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {METRICS.map((m) => (
        <div key={m.key} className="flex items-center justify-between gap-2 border-b border-line pb-2">
          <dt className="text-micro text-ink-muted">{m.label}</dt>
          <dd className={`font-medium capitalize tnum ${highlight ? "text-wine" : ""}`}>
            {m.format ? m.format(data[m.key]) : String(data[m.key] ?? "—")}
          </dd>
        </div>
      ))}
      {data.expected_stockout_date && (
        <div className="col-span-2">
          <dt className="text-micro text-ink-muted">Expected stockout</dt>
          <dd className="font-medium tnum">
            {new Date(data.expected_stockout_date + "T00:00:00").toLocaleDateString("en-IN")}
          </dd>
        </div>
      )}
    </dl>
  );
}