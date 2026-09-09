import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Boxes, Lightbulb, PackageX, Sparkles, TrendingUp } from "lucide-react";
import { api, InventoryRow, isCancelled } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  ErrorNote, money, PriorityChip, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";

interface DashboardData {
  empty: boolean;
  kpis: Record<string, number>;
  critical_items: InventoryRow[];
  overstock_items: InventoryRow[];
  top_movers: InventoryRow[];
  briefing: { type: string; title: string; message: string }[];
}

interface Alert {
  id: string;
  priority: string;
  title: string;
  message: string;
  recommended_action: string | null;
  products?: { id: string; sku: string; name: string; image_url: string | null } | null;
  stores?: { code: string; name: string } | null;
}

/**
 * AI insights — composed entirely from live calculations: the dashboard risk
 * engine, the replenishment maths and the open alerts feed. Nothing here is
 * generated text; every card names the number it came from.
 */
export default function Insights() {
  const { activeStore } = useAuth();
  const navigate = useNavigate();
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [recs, setRecs] = useState<InventoryRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = activeStore ? `?store_id=${activeStore.id}` : "";

    Promise.allSettled([
      api.get<DashboardData>(`/dashboard${query}`, { signal: controller.signal }),
      api.get<{ items: InventoryRow[] }>(`/replenishment${query}`, { signal: controller.signal }),
      api.get<{ items: Alert[] }>(
        `/alerts?state=open&limit=50${activeStore ? `&store_id=${activeStore.id}` : ""}`,
        { signal: controller.signal }),
    ]).then(([d, r, a]) => {
      if (controller.signal.aborted) return;
      if (d.status === "fulfilled") setDash(d.value);
      else if (!isCancelled(d.reason)) setError(d.reason?.message ?? "Couldn't load insights.");
      if (r.status === "fulfilled") setRecs(r.value.items);
      if (a.status === "fulfilled") setAlerts(a.value.items);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [activeStore?.id]);

  if (loading) return <Spinner label="Analysing your inventory…" />;
  if (error) return <ErrorNote message={error} />;
  if (!dash || dash.empty) {
    return (
      <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
        <div className="rounded-2xl bg-peach-light p-3.5">
          <Sparkles className="h-5 w-5 text-wine" />
        </div>
        <h3 className="font-display text-lg font-medium">No data to analyse yet</h3>
        <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
          Import products, inventory and sales data and these insights will be
          calculated from them automatically.
        </p>
      </div>
    );
  }

  const k = dash.kpis;
  const critical = dash.critical_items.filter((i) => i.stock_status === "out_of_stock" || i.risk_level === "critical");
  const highRisk = dash.critical_items.filter((i) => i.risk_level === "high");
  const surging = dash.top_movers.filter((i) => i.demand_basis === "sku_history").slice(0, 5);
  const topPriority = recs.slice(0, 6);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Sparkles className="h-5 w-5 text-wine" /> AI insights
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Calculated from your live inventory, sales and lead-time data. Every
          recommendation traces back to a real number.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <RiskKpi label="Stockout risk" value={String(k.critical + k.out_of_stock)} sub="products critical or out" tone="critical" />
        <RiskKpi label="Replenishment" value={String(recs.length)} sub="recommendations open" tone="low" />
        <RiskKpi label="Overstock" value={String(k.overstock)} sub="products holding excess" tone="overstock" />
        <RiskKpi label="Open alerts" value={String(alerts.length)} sub="in the current view" tone="wine" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="glass wash-peach overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
              <Lightbulb className="h-4 w-4 text-wine" /> Priority actions
            </h2>
            <button className="btn-quiet px-2 py-1 text-sm" onClick={() => navigate("/app/replenishment")}>
              All recommendations <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {topPriority.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-muted">
              Nothing needs reordering right now.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {topPriority.map((item) => (
                <li key={`${item.product_id}-${item.store_id}`}
                    className="flex items-start gap-3 px-5 py-3.5">
                  <Thumb src={item.image_url} alt={item.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityChip value={item.priority ?? "medium"} />
                      <span className="text-sm font-medium">{item.name}</span>
                    </div>
                    <p className="mt-1 text-micro leading-relaxed text-ink-muted">
                      {item.reason}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-base font-semibold tnum">
                      {units(item.recommended_qty)}
                    </p>
                    <p className="text-micro text-ink-faint">order units</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
              <PackageX className="h-4 w-4 text-critical" /> Stockout predictions
            </h2>
          </div>
          {critical.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-muted">
              No products are predicted to stock out in the current window.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {critical.map((item) => (
                <li key={`${item.product_id}-${item.store_id}`}
                    className="flex items-start gap-3 px-5 py-3.5">
                  <Thumb src={item.image_url} alt={item.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="mt-0.5 text-micro text-ink-faint tnum">
                      {item.sku} · {item.store_name ?? ""}
                    </p>
                    <p className="mt-1 text-micro leading-relaxed text-ink-muted">
                      {item.risk_reason}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-base font-semibold text-critical tnum">
                      {item.expected_stockout_date
                        ? new Date(item.expected_stockout_date + "T00:00:00").toLocaleDateString("en-IN", { month: "short", day: "numeric" })
                        : "Now"}
                    </p>
                    <p className="text-micro text-ink-faint">stockout</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel overflow-hidden">
          <h2 className="border-b border-line px-5 py-4 font-display text-sm font-semibold">
            Overstock detection
          </h2>
          {dash.overstock_items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-muted">
              No overstock detected.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {dash.overstock_items.map((item) => (
                <li key={`${item.product_id}-${item.store_id}`}
                    className="flex items-start gap-3 px-5 py-3.5">
                  <Thumb src={item.image_url} alt={item.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="mt-0.5 text-micro text-ink-faint tnum">{item.sku}</p>
                    <p className="mt-1 text-micro leading-relaxed text-ink-muted">
                      {item.days_of_stock == null
                        ? "Holds stock with no recorded demand."
                        : `Holds ${item.days_of_stock.toFixed(0)} days of cover.`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-base font-semibold tnum">
                      {units(item.current_stock)}
                    </p>
                    <p className="text-micro text-ink-faint">{money(item.mrp)} each</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel overflow-hidden">
          <h2 className="border-b border-line px-5 py-4 font-display text-sm font-semibold">
            Demand leaders & anomalies
          </h2>
          {surging.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-muted">
              No SKU-level demand detected yet. Import sales history to see movers.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {surging.map((item) => (
                <li key={`${item.product_id}-${item.store_id}`}
                    className="flex items-start gap-3 px-5 py-3.5">
                  <Thumb src={item.image_url} alt={item.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="mt-0.5 text-micro text-ink-faint tnum">{item.sku}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="flex items-center gap-1 font-display text-base font-semibold tnum">
                      <TrendingUp className="h-4 w-4 text-healthy" />
                      {units(item.avg_daily_demand)}/day
                    </p>
                    <p className="text-micro text-ink-faint">measured demand</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-low" /> Open alerts
          </h2>
          <button className="btn-quiet px-2 py-1 text-sm" onClick={() => navigate("/app/alerts")}>
            Alerts feed <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {alerts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">
            No open alerts.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {alerts.slice(0, 8).map((alert) => (
              <li key={alert.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{alert.title}</span>
                    <PriorityChip value={alert.priority} />
                  </div>
                  <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">
                    {alert.message}
                  </p>
                </div>
                {alert.recommended_action && (
                  <p className="max-w-[16rem] shrink-0 text-micro text-wine">
                    {alert.recommended_action}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-canvas-tint/60 px-5 py-4">
        <Boxes className="h-4 w-4 text-wine" />
        <p className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{dash.kpis.active_skus ?? 0} SKUs</span> are
          being tracked with demand signals. Insights update automatically as
          stock and sales data change.
        </p>
        <button className="btn-ghost ml-auto px-3 py-2 text-micro"
                onClick={() => navigate("/app/analytics")}>
          Open analytics
        </button>
      </section>
    </div>
  );
}

const TONES: Record<string, string> = {
  critical: "text-critical", low: "text-low",
  overstock: "text-overstock", wine: "text-wine",
};

function RiskKpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className={`mt-1 font-display text-xl font-semibold tnum ${TONES[tone] ?? ""}`}>{value}</p>
      <p className="mt-0.5 text-micro text-ink-faint">{sub}</p>
    </div>
  );
}