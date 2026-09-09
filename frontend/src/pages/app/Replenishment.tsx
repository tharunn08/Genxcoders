import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Database, Download, Send, Upload } from "lucide-react";
import { api, ApiError, downloadExcel, InventoryRow } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, PriorityChip, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";
import { Busy } from "@/components/ui/forms";

export default function Replenishment() {
  const { activeStore, can } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<InventoryRow[]>([]);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** The recommendations as an Excel file, straight from the live computation. */
  async function exportRecommendations() {
    setExporting(true);
    setError("");
    try {
      const query = activeStore ? `?store_id=${activeStore.id}` : "";
      await downloadExcel(
        `/export/inventory${query}`,
        `replenishment-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't export.");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    const query = activeStore ? `?store_id=${activeStore.id}` : "";
    api.get<{ items: InventoryRow[] }>(`/replenishment${query}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [activeStore?.id, sent]);

  const chosen = Object.entries(selected).filter(([, qty]) => qty > 0);

  async function submitRequest() {
    if (!chosen.length) return;
    setBusy(true);
    setError("");
    try {
      const storeId = activeStore?.id ?? items[0]?.store_id;
      const order = await api.post<{ po_number: string }>("/orders", {
        store_id: storeId,
        priority: items.some((i) => selected[i.product_id] && i.priority === "critical")
          ? "critical" : "high",
        notes: "Raised from replenishment recommendations.",
        items: chosen.map(([productId, quantity]) => {
          const row = items.find((i) => i.product_id === productId);
          return { product_id: productId, quantity, unit_price: row?.mrp ?? null };
        }),
        submit: true,
      });
      setSelected({});
      setSent(order.po_number);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the request.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Calculating recommendations…" />;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Smart replenishment</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Ordered by urgency. Quantities cover forecast demand over the lead time plus
            safety stock, less anything already on its way.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("import_data") && (
            <button className="btn-ghost"
                    onClick={() => navigate("/app/admin/imports?type=replenishment")}>
              <Upload className="h-4 w-4" /> Import Excel
            </button>
          )}
          <button className="btn-ghost" onClick={exportRecommendations}
                  disabled={exporting || !items.length}>
            {exporting ? <Busy label="Exporting…" />
                       : <><Download className="h-4 w-4" /> Export to Excel</>}
          </button>
        </div>
      </header>

      {sent && (
        <div className="flex items-center gap-3 rounded-lg border border-healthy/40 bg-healthy-soft px-4 py-3 text-sm text-healthy">
          <CheckCircle2 className="h-4.5 w-4.5 shrink-0" />
          <span>Request {sent} submitted for approval.</span>
          <button className="ml-auto underline" onClick={() => navigate("/app/orders")}>
            Track it
          </button>
        </div>
      )}
      {error && <ErrorNote message={error} />}

      {items.length === 0 ? (
        <EmptyState
          icon={Database}
          title="Nothing needs reordering"
          body="Either stock covers forecast demand everywhere, or no sales and inventory data has been imported yet."
          actionLabel={can("import_data") ? "Import data" : undefined}
          onAction={() => navigate("/app/admin/imports")}
        />
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((item) => {
              const qty = selected[item.product_id] ?? 0;
              return (
                <li key={`${item.product_id}-${item.store_id}`} className="panel p-4">
                  <div className="flex flex-wrap items-start gap-4">
                    <Thumb src={item.image_url} alt={item.name} />

                    <div className="min-w-[12rem] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <PriorityChip value={item.priority ?? "medium"} />
                        <StatusChip status={item.stock_status} />
                      </div>
                      <p className="mt-1.5 font-medium">{item.name}</p>
                      <p className="text-micro text-ink-faint tnum">
                        {item.sku} · {money(item.mrp)}
                      </p>
                      <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
                        {item.reason}
                      </p>
                    </div>

                    <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 text-micro sm:grid-cols-3">
                      <Metric label="On hand" value={units(item.available_stock)} />
                      <Metric label="Daily demand" value={units(item.avg_daily_demand)} />
                      <Metric label="Days left" value={
                        item.days_of_stock == null ? "—" : item.days_of_stock.toFixed(1)} />
                      <Metric label="Lead time" value={`${item.lead_time_days}d`} />
                      <Metric label="Safety stock" value={units(item.safety_stock)} />
                      <Metric label="Reorder at" value={units(item.reorder_point)} />
                    </dl>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <span className="text-micro text-ink-muted">Recommended</span>
                      <input
                        type="number"
                        min={0}
                        className="field w-28 py-2 text-right tnum"
                        value={qty || Math.round(item.recommended_qty ?? 0)}
                        onChange={(e) => setSelected((prev) => ({
                          ...prev, [item.product_id]: Number(e.target.value),
                        }))}
                        aria-label={`Order quantity for ${item.name}`}
                      />
                      <button
                        className={qty > 0 ? "btn-primary w-28 py-2" : "btn-ghost w-28 py-2"}
                        onClick={() => setSelected((prev) => ({
                          ...prev,
                          [item.product_id]: qty > 0 ? 0 : Math.round(item.recommended_qty ?? 0),
                        }))}
                      >
                        {qty > 0 ? "Added" : "Add"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {chosen.length > 0 && (
            <div className="sticky bottom-4 z-10">
              <div className="glass flex flex-wrap items-center gap-3 px-5 py-4 shadow-lift">
                <span className="text-sm">
                  <span className="font-display font-semibold tnum">{chosen.length}</span>{" "}
                  product{chosen.length === 1 ? "" : "s"} ·{" "}
                  <span className="tnum">
                    {chosen.reduce((sum, [, q]) => sum + q, 0).toLocaleString()}
                  </span>{" "}
                  units
                </span>
                <div className="ml-auto flex gap-2">
                  <button className="btn-ghost" onClick={() => setSelected({})}>Clear</button>
                  <button className="btn-primary" onClick={submitRequest} disabled={busy}>
                    <Send className="h-4 w-4" />
                    {busy ? "Submitting…" : "Create replenishment request"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-medium tnum">{value}</dd>
    </div>
  );
}
