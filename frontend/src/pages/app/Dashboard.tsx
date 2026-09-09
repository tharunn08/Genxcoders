import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ArrowRight, Database, Megaphone, Sparkles, TrendingUp,
} from "lucide-react";
import { api, Announcement, InventoryRow, isCancelled } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useBranding } from "@/lib/branding";
import {
  BasisTag, compact, EmptyState, ErrorNote, money, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";

const STATUS_COLOR: Record<string, string> = {
  healthy: "#2E6B4F", low: "#B8792C", critical: "#A63A45",
  out_of_stock: "#A63A45", overstock: "#4A5578",
};

interface DashboardData {
  empty: boolean;
  inventory_empty?: boolean;
  product_count?: number;
  message?: string;
  action?: string;
  computed_sample?: number;
  recent_orders?: RecentOrder[];
  kpis: Record<string, number>;
  status_breakdown: { status: string; count: number }[];
  critical_items: InventoryRow[];
  overstock_items: InventoryRow[];
  top_movers: InventoryRow[];
  briefing: { type: string; title: string; message: string; product_id: string }[];
}

interface RecentOrder {
  id: string;
  po_number: string;
  status: string;
  fulfillment_status: string;
  priority: string;
  total_value: number | null;
  created_at: string;
  line_count: number;
  unit_count: number;
  stores?: { code: string; name: string } | null;
}

export default function Dashboard() {
  const { activeStore, user, can } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [trend, setTrend] = useState<{ date: string; units: number; amount: number }[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [error, setError] = useState("");
  const [trendFailed, setTrendFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setTrendFailed(false);

    const query = activeStore ? `?store_id=${activeStore.id}` : "";

    // allSettled, not all. The sales trend and announcements are secondary
    // panels; if they fail they leave a note in their own card instead of
    // blanking the entire dashboard.
    Promise.allSettled([
      api.get<DashboardData>(`/dashboard${query}`, { signal: controller.signal }),
      api.get<{ points: any[] }>(
        `/dashboard/sales-trend${query}${query ? "&" : "?"}days=30`,
        { signal: controller.signal }),
      api.get<{ items: Announcement[] }>("/site/announcements?limit=10",
        { signal: controller.signal }),
    ])
      .then(([summary, series, anns]) => {
        if (controller.signal.aborted) return;

        if (summary.status === "fulfilled") {
          setData(summary.value);
        } else if (!isCancelled(summary.reason)) {
          setError(summary.reason?.message ?? "Couldn't load the dashboard.");
        }

        if (series.status === "fulfilled") {
          setTrend(series.value.points);
        } else if (!isCancelled(series.reason)) {
          setTrendFailed(true);
        }

        if (anns.status === "fulfilled") {
          setAnnouncements(anns.value.items);
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [activeStore?.id, reloadKey]);

  if (loading) return <Spinner label="Loading your inventory position…" />;

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorNote message={error} />
        <button className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
          Try again
        </button>
      </div>
    );
  }

  if (!data || data.empty) {
    // Products can exist with no stock recorded yet. Show the real catalog
    // count and point at the right next action instead of a bare empty panel.
    const count = data?.product_count ?? 0;
    return (
      <EmptyState
        icon={Database}
        title={count > 0 ? `${count.toLocaleString("en-IN")} products in the catalog` : "No inventory data yet"}
        body={data?.message ?? "Import your product and inventory files to bring this dashboard to life."}
        actionLabel={can("import_data") ? "Import data" : undefined}
        onAction={can("import_data") ? () => navigate("/app/admin/imports") : undefined}
      />
    );
  }

  const k = data.kpis;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (user?.full_name ?? "").split(" ")[0];
  const welcomeTitle = branding.dashboard_welcome_title
    ?? `${greeting}${firstName ? `, ${firstName}` : ""}`;
  const welcomeMessage = branding.dashboard_welcome_message
    ?? (activeStore ? activeStore.name : "All stores")
    + " · " + new Date().toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long",
    });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold">{welcomeTitle}</h1>
        <p className="mt-1 text-sm text-ink-muted">{welcomeMessage}</p>
      </header>

      {announcements.length > 0 && (
        <section className="space-y-2">
          {announcements.map((a) => (
            <div
              key={a.id}
              className="flex items-start gap-3 rounded-2xl border border-peach/50 bg-peach-light/50 px-4 py-3"
            >
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-wine" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{a.title}</p>
                <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">{a.message}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {branding.dashboard_banner_url && (
        <img
          src={branding.dashboard_banner_url}
          alt=""
          className="h-32 w-full rounded-2xl object-cover"
        />
      )}

      <section className="glass wash-peach overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-wine" />
            AI daily briefing
          </h2>
          <button className="btn-quiet px-2 py-1 text-sm"
                  onClick={() => navigate("/app/insights")}>
            Open AI insights <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="grid gap-px border-b border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          <BriefStat
            value={`${(k.critical + k.out_of_stock).toLocaleString("en-IN")}`}
            label="products at risk of stockout"
            tone="critical"
          />
          <BriefStat value={String(k.out_of_stock)} label="products out of stock" tone="critical" />
          <BriefStat value={String(k.low_stock)} label="products below the low-stock threshold" tone="low" />
          <BriefStat value={String(k.overstock)} label="products holding excess stock" tone="overstock" />
        </div>
        <ul className="divide-y divide-line">
          {data.briefing.length === 0 && (
            <li className="px-5 py-4 text-sm text-ink-muted">
              No urgent items today — stock covers forecast demand everywhere.
            </li>
          )}
          {data.briefing.map((item, index) => (
            <li key={index} className="flex items-start gap-3 px-5 py-3.5">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  item.type === "critical" ? "bg-critical" : "bg-wine"
                }`}
              />
              <p className="text-sm leading-relaxed text-ink-muted">{item.message}</p>
            </li>
          ))}
        </ul>
        <p className="px-5 py-2.5 text-micro text-ink-faint">
          Calculated from your live inventory, sales and lead-time data — not generated text.
        </p>
      </section>

      {/* Catalogue. These four are exact counts from the database, not a
          sample of a page of inventory rows. */}
      <section>
        <h2 className="mb-2 text-micro font-medium text-ink-faint">Catalogue</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Total products" value={compact(k.total_products)} />
          <Kpi label="Categories" value={compact(k.total_categories)} />
          <Kpi label="Stores" value={compact(k.total_stores)} />
          <Kpi label="Not yet stocked" value={compact(k.products_without_stock)} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-micro font-medium text-ink-faint">Inventory</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Inventory units" value={compact(k.total_units)} />
          <Kpi label="Inventory value" value={money(k.total_value)} />
          <Kpi label="Available products" value={compact(k.available_products)} tone="healthy" />
          <Kpi label="Out of stock" value={compact(k.out_of_stock)} tone="critical" />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <MiniStat label="Healthy" value={k.healthy} tone="healthy" />
        <MiniStat label="Low stock" value={k.low_stock} tone="low" />
        <MiniStat label="Critical" value={k.critical} tone="critical" />
        <MiniStat label="Out of stock" value={k.out_of_stock} tone="critical" />
        <MiniStat label="Overstock" value={k.overstock} tone="overstock" />
      </section>

      {/* Warehouse pipeline. Every figure is a count=exact query against
          purchase_orders.fulfillment_status. */}
      <section>
        <h2 className="mb-2 text-micro font-medium text-ink-faint">Warehouse operations</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat label="Pending" value={k.pending_orders} tone="low" />
          <MiniStat label="Accepted" value={k.accepted_orders} />
          <MiniStat label="Picking" value={k.picking_orders} />
          <MiniStat label="Packing" value={k.packing_orders} />
          <MiniStat label="Packed" value={k.packed_orders} tone="healthy" />
          <MiniStat label="Shipped" value={k.shipped_orders} tone="healthy" />
        </div>
      </section>

      {(data.recent_orders?.length ?? 0) > 0 && (
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="font-display text-sm font-semibold">Recent orders</h2>
            <button className="btn-quiet px-2 py-1 text-sm"
                    onClick={() => navigate("/app/orders")}>
              All orders <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="divide-y divide-line">
            {data.recent_orders!.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="min-w-[9rem] font-medium tnum">{order.po_number}</span>
                <span className="min-w-[9rem] truncate text-sm text-ink-muted">
                  {order.stores?.name ?? "—"}
                </span>
                <span className="rounded-full border border-line bg-canvas-tint px-2 py-0.5 text-micro capitalize">
                  {(order.fulfillment_status ?? "pending").replace(/_/g, " ")}
                </span>
                <span className="ml-auto flex gap-4 text-micro text-ink-muted tnum">
                  <span>{order.line_count} lines</span>
                  <span>{units(order.unit_count)} units</span>
                  <span className="font-medium text-ink">{money(order.total_value)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-2">
          <h2 className="font-display text-sm font-semibold">Sales, last 30 days</h2>
          {trendFailed ? (
            <p className="py-16 text-center text-sm text-ink-muted">
              The sales trend didn't load this time. Everything else on this page
              is current.
              <button
                className="btn-quiet ml-2 px-2 py-1 text-micro"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                Retry
              </button>
            </p>
          ) : trend.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-muted">
              No sales data has been imported for this period.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={trend} margin={{ top: 16, right: 4, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F3A58B" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#F3A58B" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#9A908C", fontSize: 11 }}
                       tickFormatter={(d) => d.slice(5)} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: "#9A908C", fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(122,31,43,0.14)", boxShadow: "0 12px 32px -16px rgba(90,20,32,.3)", color: "#1C1717",
                    borderRadius: 10, fontSize: 12 }}
                  labelStyle={{ color: "#6F6663" }}
                />
                <Area type="monotone" dataKey="units" stroke="#7A1F2B" strokeWidth={2}
                      fill="url(#fill)" name="Units sold" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </section>

        <section className="panel p-5">
          <h2 className="font-display text-sm font-semibold">Inventory health</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.status_breakdown} margin={{ top: 16, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="rgba(122,31,43,0.10)" vertical={false} />
              <XAxis dataKey="status" tick={{ fill: "#9A908C", fontSize: 10 }}
                     tickFormatter={(s) => s.replace(/_/g, " ")} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "#9A908C", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: "rgba(243,165,139,0.14)" }}
                contentStyle={{ background: "#FFFFFF", border: "1px solid rgba(122,31,43,0.14)", boxShadow: "0 12px 32px -16px rgba(90,20,32,.3)", color: "#1C1717",
                  borderRadius: 10, fontSize: 12 }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {data.status_breakdown.map((entry) => (
                  <Cell key={entry.status} fill={STATUS_COLOR[entry.status] ?? "#7A1F2B"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ProductList
          title="Highest stockout risk"
          items={data.critical_items}
          empty="Nothing is at risk right now."
          onOpen={(id) => navigate(`/app/products/${id}`)}
          render={(item) => (
            <>
              <StatusChip status={item.stock_status} />
              <span className="text-micro text-ink-faint tnum">
                {item.days_of_stock == null ? "—" : `${item.days_of_stock.toFixed(1)}d cover`}
              </span>
            </>
          )}
        />
        <ProductList
          title="Top products"
          items={data.top_movers}
          empty="Import sales data to see demand leaders."
          onOpen={(id) => navigate(`/app/products/${id}`)}
          render={(item) => (
            <>
              <span className="text-micro text-ink-faint tnum">
                {money(item.mrp)} · {units(item.current_stock)} in stock
              </span>
              <span className="chip bg-peach-light text-wine">
                <TrendingUp className="h-3 w-3" />
                {units(item.avg_daily_demand)}/day
              </span>
              <BasisTag basis={item.demand_basis} />
            </>
          )}
        />
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  low: "text-low", critical: "text-critical",
  overstock: "text-overstock", healthy: "text-healthy",
};

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const color = (tone && TONE[tone]) ?? "text-ink";
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className={`mt-1 font-display text-xl font-semibold tnum ${color}`}>{value}</p>
    </div>
  );
}

function MiniStat({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className={`mt-1 font-display text-lg font-semibold tnum ${TONE[tone] ?? ""}`}>
        {value.toLocaleString("en-IN")}
      </p>
    </div>
  );
}

function BriefStat({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <div className="bg-surface px-5 py-3.5">
      <p className={`font-display text-xl font-semibold tnum ${TONE[tone] ?? "text-ink"}`}>{value}</p>
      <p className="mt-0.5 text-micro leading-snug text-ink-muted">{label}</p>
    </div>
  );
}

function ProductList({
  title, items, empty, onOpen, render,
}: {
  title: string;
  items: InventoryRow[];
  empty: string;
  onOpen: (id: string) => void;
  render: (item: InventoryRow) => React.ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={`${item.product_id}-${item.store_id}`}>
              <button
                className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover"
                onClick={() => onOpen(item.product_id)}
              >
                <Thumb src={item.image_url} alt={item.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="text-micro text-ink-faint tnum">{item.sku}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">{render(item)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}