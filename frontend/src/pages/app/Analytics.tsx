import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { BarChart3, Database, Store as StoreIcon } from "lucide-react";
import { api, InventoryRow, isCancelled } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";

const STATUS_COLOR: Record<string, string> = {
  healthy: "#2E6B4F", low: "#B8792C", critical: "#A63A45",
  out_of_stock: "#A63A45", overstock: "#4A5578",
};

const TOOLTIP_STYLE = {
  background: "#FFFFFF", border: "1px solid rgba(122,31,43,0.14)",
  boxShadow: "0 12px 32px -16px rgba(90,20,32,.3)", color: "#1C1717",
  borderRadius: 10, fontSize: 12,
} as const;

interface DashboardData {
  empty: boolean;
  kpis: Record<string, number>;
  status_breakdown: { status: string; count: number }[];
}

export default function Analytics() {
  const { activeStore } = useAuth();
  const navigate = useNavigate();
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [trend, setTrend] = useState<{ date: string; units: number; amount: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = activeStore ? `?store_id=${activeStore.id}` : "";

    Promise.allSettled([
      api.get<DashboardData>(`/dashboard${query}`, { signal: controller.signal }),
      api.get<{ items: InventoryRow[] }>(`/inventory?limit=200${query ? `&${query.slice(1)}` : ""}`,
        { signal: controller.signal }),
      api.get<{ points: { date: string; units: number; amount: number }[] }>(
        `/dashboard/sales-trend${query}${query ? "&" : "?"}days=60`,
        { signal: controller.signal }),
    ]).then(([d, inv, series]) => {
      if (controller.signal.aborted) return;
      if (d.status === "fulfilled") setDash(d.value);
      else if (!isCancelled(d.reason)) setError(d.reason?.message ?? "Couldn't load analytics.");
      if (inv.status === "fulfilled") setRows(inv.value.items);
      if (series.status === "fulfilled") setTrend(series.value.points);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [activeStore?.id]);

  const value = (r: InventoryRow) => Number(r.current_stock ?? 0) * Number(r.mrp ?? 0);

  const categoryData = useMemo(() => {
    const by: Record<string, { name: string; units: number; value: number }> = {};
    for (const row of rows) {
      const name = row.category_name ?? "Uncategorised";
      const entry = by[name] ?? (by[name] = { name, units: 0, value: 0 });
      entry.units += Number(row.current_stock ?? 0);
      entry.value += value(row);
    }
    return Object.values(by).sort((a, b) => b.value - a.value);
  }, [rows]);

  const storeData = useMemo(() => {
    const by: Record<string, { name: string; units: number; value: number }> = {};
    for (const row of rows) {
      const name = row.store_name ?? "Unknown store";
      const entry = by[name] ?? (by[name] = { name, units: 0, value: 0 });
      entry.units += Number(row.current_stock ?? 0);
      entry.value += value(row);
    }
    return Object.values(by).sort((a, b) => b.value - a.value);
  }, [rows]);

  const topStocked = useMemo(
    () => [...rows].sort((a, b) => (b.current_stock ?? 0) - (a.current_stock ?? 0)).slice(0, 8),
    [rows]);

  if (loading) return <Spinner label="Crunching your numbers…" />;
  if (error) return <ErrorNote message={error} />;

  const k = dash?.kpis;
  const empty = !dash || dash.empty || rows.length === 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">Analytics</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Inventory value, stock distribution and demand trends from your live data.
        </p>
      </header>

      {empty ? (
        <EmptyState
          icon={Database}
          title="Not enough data yet"
          body="Analytics needs inventory and sales records to build charts. Import data or add stock first."
          actionLabel="Import data"
          onAction={() => navigate("/app/admin/imports")}
        />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Inventory value" value={money(k?.total_value)} />
            <Kpi label="Inventory units" value={units(k?.total_units)} />
            <Kpi label="Products tracked" value={String(k?.active_skus ?? rows.length)} />
            <Kpi label="Stores" value={String(storeData.length)} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Stock distribution</h2>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={dash?.status_breakdown ?? []}
                          margin={{ top: 16, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                  <XAxis dataKey="status" tick={{ fill: "#9A908C", fontSize: 10 }}
                         tickFormatter={(s: string) => s.replace(/_/g, " ")}
                         tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "#9A908C", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "rgba(243,165,139,0.14)" }}
                           contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {(dash?.status_breakdown ?? []).map((entry) => (
                      <Cell key={entry.status}
                            fill={STATUS_COLOR[entry.status] ?? "#7A1F2B"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </section>

            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Category distribution by value</h2>
              {categoryData.length === 0 ? (
                <p className="py-16 text-center text-sm text-ink-muted">No category data.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={categoryData} dataKey="value" nameKey="name"
                         innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {categoryData.map((entry, i) => (
                        <Cell key={entry.name}
                              fill={["#7A1F2B", "#F3A58B", "#B8792C", "#4A5578", "#2E6B4F", "#A63A45"][i % 6]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                             formatter={(v: number) => money(v)} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </section>
          </div>

          <section className="panel p-5">
            <h2 className="font-display text-sm font-semibold">Sales trend — last 60 days</h2>
            {trend.length === 0 ? (
              <p className="py-16 text-center text-sm text-ink-muted">
                No sales data imported for this period.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={trend} margin={{ top: 16, right: 4, bottom: 0, left: -16 }}>
                  <defs>
                    <linearGradient id="an-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#F3A58B" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#F3A58B" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#9A908C", fontSize: 10 }}
                         tickFormatter={(d: string) => d.slice(5)} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "#9A908C", fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#6F6663" }} />
                  <Area type="monotone" dataKey="units" stroke="#7A1F2B" strokeWidth={2}
                        fill="url(#an-fill)" name="Units sold" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
                Top stocked products
              </h2>
              <ul className="divide-y divide-line">
                {topStocked.map((item) => (
                  <li key={`${item.product_id}-${item.store_id}`}>
                    <button
                      className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover"
                      onClick={() => navigate(`/app/products/${item.product_id}`)}
                    >
                      <Thumb src={item.image_url} alt={item.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        <span className="text-micro text-ink-faint tnum">{item.sku}</span>
                      </span>
                      <span className="text-right">
                        <span className="block text-sm font-medium tnum">{units(item.current_stock)}</span>
                        <span className="text-micro text-ink-faint tnum">{money(value(item))}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
                Store comparison
              </h2>
              {storeData.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-ink-muted">No store data.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {storeData.map((store) => (
                    <li key={store.name} className="flex items-center gap-3 px-5 py-3.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-peach-light">
                        <StoreIcon className="h-4 w-4 text-wine" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{store.name}</span>
                        <span className="text-micro text-ink-faint tnum">
                          {units(store.units)} units
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block text-sm font-medium tnum">{money(store.value)}</span>
                        <span className="text-micro text-ink-faint">inventory value</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel overflow-hidden">
            <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
              Low stock & stockout watch
            </h2>
            {rows.filter((r) => ["low", "critical", "out_of_stock"].includes(r.stock_status)).length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-ink-muted">
                Nothing is low in the current view.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {rows
                  .filter((r) => ["low", "critical", "out_of_stock"].includes(r.stock_status))
                  .slice(0, 8)
                  .map((item) => (
                    <li key={`${item.product_id}-${item.store_id}`}
                        className="flex items-center gap-3 px-5 py-3">
                      <Thumb src={item.image_url} alt={item.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        <span className="text-micro text-ink-faint tnum">
                          {item.sku} · {item.store_name ?? ""}
                        </span>
                      </span>
                      <span className="tnum text-sm">{units(item.current_stock)} left</span>
                      <StatusChip status={item.stock_status} />
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <p className="flex items-center gap-2 text-micro text-ink-faint">
            <BarChart3 className="h-3.5 w-3.5" />
            Charts reflect the {activeStore ? activeStore.name : "combined"} view and
            update on every load.
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className="mt-1 font-display text-xl font-semibold tnum">{value}</p>
    </div>
  );
}