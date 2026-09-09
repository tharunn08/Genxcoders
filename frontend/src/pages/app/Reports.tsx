import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import clsx from "clsx";
import { api, ForecastResult, InventoryRow, Product } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";

type ReportTab = "inventory" | "low" | "stockout" | "replenishment" | "forecast";

const TABS: { value: ReportTab; label: string }[] = [
  { value: "inventory", label: "Inventory report" },
  { value: "low", label: "Low stock" },
  { value: "stockout", label: "Stockout" },
  { value: "replenishment", label: "Replenishment" },
  { value: "forecast", label: "Forecast" },
];

const rowValue = (r: InventoryRow) => Number(r.current_stock ?? 0) * Number(r.mrp ?? 0);

export default function Reports() {
  const { activeStore } = useAuth();
  const [tab, setTab] = useState<ReportTab>("inventory");
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [recs, setRecs] = useState<InventoryRow[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = activeStore ? `?store_id=${activeStore.id}` : "";

    Promise.allSettled([
      api.get<{ items: InventoryRow[] }>(`/inventory?limit=200${query}`,
        { signal: controller.signal }),
      api.get<{ items: InventoryRow[] }>(`/replenishment${query}`,
        { signal: controller.signal }),
      api.get<{ empty: boolean; kpis: Record<string, number> }>(`/dashboard${query}`,
        { signal: controller.signal }),
    ]).then(([inv, rep, dash]) => {
      if (controller.signal.aborted) return;
      if (inv.status === "fulfilled") setRows(inv.value.items);
      else if (inv.status === "rejected") setError(inv.reason?.message ?? "Couldn't load the report.");
      if (rep.status === "fulfilled") setRecs(rep.value.items);
      if (dash.status === "fulfilled" && !dash.value.empty) setSummary(dash.value.kpis);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [activeStore?.id]);

  const inventoryRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((r) => !term || `${r.name} ${r.sku}`.toLowerCase().includes(term))
      .filter((r) => !statusFilter || r.stock_status === statusFilter);
  }, [rows, search, statusFilter]);

  function exportCsv(name: string, header: string[], lines: (string | number)[][]) {
    const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const blob = new Blob([[header.map(escape).join(","),
      ...lines.map((l) => l.map(escape).join(","))].join("\n")],
      { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const inventoryCsv = () => exportCsv(
    "inventory-report",
    ["SKU", "Product", "Category", "Store", "MRP", "Current stock", "Value", "Status"],
    reportRows.map((r) => [r.sku, r.name, r.category_name ?? "", r.store_name ?? "",
      r.mrp ?? "", r.current_stock, Math.round(rowValue(r)), r.stock_status]));

  const replenishmentCsv = () => exportCsv(
    "replenishment-report",
    ["SKU", "Product", "Current stock", "Forecast demand", "Lead time", "Safety stock",
     "Reorder point", "Recommended qty", "Priority"],
    recs.map((r) => [r.sku, r.name, r.available_stock, r.forecast_demand ?? "",
      r.lead_time_days, r.safety_stock, r.reorder_point, r.recommended_qty ?? "",
      r.priority ?? ""]));

  const reportRows: InventoryRow[] =
    tab === "replenishment" ? recs
      : tab === "low" ? rows.filter((r) => ["low", "critical"].includes(r.stock_status))
      : tab === "stockout" ? rows.filter((r) => r.stock_status === "out_of_stock")
      : inventoryRows;

  if (loading) return <Spinner label="Preparing report…" />;
  if (error) return <ErrorNote message={error} />;

  const k = summary ?? {};

  return (
    <div className="print-area space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="font-display text-2xl font-semibold">Reports</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Professional, exportable views of the same live data you see everywhere else.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </button>
          {tab !== "forecast" && (
            <button className="btn-ghost"
                    onClick={tab === "replenishment" ? replenishmentCsv : inventoryCsv}>
              <Download className="h-4 w-4" /> Export CSV
            </button>
          )}
        </div>
      </header>

      {/* Summary block appears on the screen and in print. */}
      <section className="panel grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-6 print:border print:p-4">
        <Sum label="Total products" value={k.total_products ?? 0} />
        <Sum label="Total units" value={k.total_units ?? 0} />
        <Sum label="Inventory value" value={money(k.total_value)} />
        <Sum label="Low stock" value={k.low_stock ?? 0} />
        <Sum label="Out of stock" value={k.out_of_stock ?? 0} />
        <Sum label="Overstock" value={k.overstock ?? 0} />
      </section>

      <div className="flex flex-wrap gap-1.5 print:hidden">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`rounded-lg border px-3 py-1.5 text-micro transition-colors ${
              tab === t.value ? "border-wine bg-peach-light text-wine"
                              : "border-line text-ink-muted hover:bg-surface-hover"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "forecast" && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <input
            className="field max-w-xs py-2"
            placeholder={tab === "replenishment" ? "Filter recommendations…" : "Search name or SKU"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {tab === "inventory" && (
            <select className="field w-auto py-2" value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {["out_of_stock", "critical", "low", "healthy", "overstock"].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {tab === "forecast" ? (
        <ForecastReport />
      ) : reportRows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nothing in this report"
          body={
            tab === "stockout"
              ? "No products are out of stock in the current view."
              : tab === "low"
                ? "No products are below the low-stock threshold."
                : tab === "replenishment"
                  ? "No replenishment recommendations are open."
                  : "No inventory records match the filters."
          }
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[64rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-3 py-3 font-medium">Category</th>
                <th className="px-3 py-3 text-right font-medium">MRP</th>
                <th className="px-3 py-3 text-right font-medium">Current stock</th>
                {tab === "replenishment"
                  ? <><th className="px-3 py-3 text-right font-medium">Forecast demand</th>
                     <th className="px-3 py-3 text-right font-medium">Reorder point</th>
                     <th className="px-3 py-3 text-right font-medium">Recommended</th></>
                  : <th className="px-3 py-3 text-right font-medium">Value</th>}
                <th className="px-3 py-3 font-medium">Store</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {reportRows.map((row) => (
                <tr key={`${row.product_id}-${row.store_id}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Thumb src={row.image_url} alt={row.name} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{row.name}</p>
                        <p className="text-micro text-ink-faint tnum">{row.sku}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{row.category_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right tnum">{money(row.mrp)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{units(row.current_stock)}</td>
                  {tab === "replenishment" ? (
                    <>
                      <td className="px-3 py-2.5 text-right tnum">{units(row.forecast_demand ?? 0)}</td>
                      <td className="px-3 py-2.5 text-right tnum">{units(row.reorder_point)}</td>
                      <td className="px-3 py-2.5 text-right tnum font-medium">{units(row.recommended_qty ?? 0)}</td>
                    </>
                  ) : (
                    <td className="px-3 py-2.5 text-right tnum">{money(rowValue(row))}</td>
                  )}
                  <td className="px-3 py-2.5 text-micro text-ink-muted">{row.store_name ?? "—"}</td>
                  <td className="px-4 py-2.5"><StatusChip status={row.stock_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Sum({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-micro text-ink-muted">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold tnum">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------- forecast report

function ForecastReport() {
  const { activeStore } = useAuth();
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState(activeStore?.id ?? "");
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<{ items: { id: string; name: string }[] }>("/stores")
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

  useEffect(() => {
    if (!product || !storeId) { setResult(null); return; }
    const controller = new AbortController();
    setLoading(true);
    api.get<ForecastResult>(`/forecast?product_id=${product.id}&store_id=${storeId}&horizon=14`,
      { signal: controller.signal })
      .then(setResult)
      .catch(() => setResult(null))
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [product?.id, storeId]);

  function exportForecast() {
    if (!result?.points) return;
    const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const blob = new Blob([["date,predicted_qty,lower_bound,upper_bound",
      ...result.points.map((p) => [p.date, p.predicted_qty, p.lower_bound ?? "", p.upper_bound ?? ""]
        .map(escape).join(","))].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `forecast-${product?.sku ?? "report"}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="panel grid gap-4 p-5 sm:grid-cols-2 print:hidden">
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
      </div>

      {loading ? <Spinner /> : !result ? (
        <p className="text-sm text-ink-muted">
          {product && storeId ? "No forecast could be produced (insufficient sales history)." : "Choose a product and store to generate the forecast report."}
        </p>
      ) : !result.available ? (
        <p className="text-sm text-ink-muted">{result.message}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
            <Sum label="Daily demand" value={`${units(result.avg_daily_demand)} units`} />
            <Sum label="14-day forecast" value={`${units(result.total_forecast)} units`} />
            <Sum label="Trend" value={`${result.trend_direction} ${Math.abs(result.trend_pct ?? 0).toFixed(0)}%`} />
            <Sum label="Confidence" value={`${result.confidence ?? "—"}%`} />
          </div>
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-micro text-ink-faint">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-3 py-3 text-right font-medium">Predicted qty</th>
                  <th className="px-3 py-3 text-right font-medium">Lower bound</th>
                  <th className="px-4 py-3 text-right font-medium">Upper bound</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.points!.map((p) => (
                  <tr key={p.date}>
                    <td className="px-4 py-2 tnum">{p.date}</td>
                    <td className="px-3 py-2 text-right tnum">{p.predicted_qty}</td>
                    <td className="px-3 py-2 text-right tnum">{p.lower_bound ?? "—"}</td>
                    <td className="px-4 py-2 text-right tnum">{p.upper_bound ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn-ghost px-3 py-2 text-micro print:hidden"
                  onClick={exportForecast}>
            <Download className="h-3.5 w-3.5" /> Export forecast CSV
          </button>
        </div>
      )}
    </div>
  );
}