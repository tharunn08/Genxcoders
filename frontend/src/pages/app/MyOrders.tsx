import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown, ChevronRight, Download, FileSpreadsheet, PackageSearch, RefreshCw,
} from "lucide-react";
import {
  api, ApiError, downloadExcel, FULFILMENT_LABEL, FULFILMENT_STAGES, Order,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, Thumb, units,
} from "@/components/ui/primitives";

/**
 * Purchase history for a store manager.
 *
 * Scoped server-side by `scope_stores`, so this only ever returns orders for the
 * stores the signed-in manager is assigned to — passing another store's id by
 * hand returns a 403 rather than someone else's data.
 *
 * The warehouse status shown here is the same `fulfillment_status` column the
 * warehouse board writes, plus the `order_events` history, so a status change
 * in the warehouse is visible on this screen on the next load.
 */

const PAGE_SIZE = 20;

export default function MyOrders() {
  const { activeStore } = useAuth();
  const navigate = useNavigate();

  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE), offset: String(offset),
    });
    if (activeStore) params.set("store_id", activeStore.id);

    api.get<{ items: Order[]; total: number }>(`/warehouse/my-orders?${params}`,
      { dedupe: false })
      .then((r) => { setOrders(r.items); setTotal(r.total); setError(""); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load your orders."))
      .finally(() => setLoading(false));
  }, [activeStore?.id, offset]);

  useEffect(() => { load(); }, [load]);

  if (loading && !orders.length) return <Spinner label="Loading your orders…" />;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">My orders</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every order raised for your store, with live warehouse status.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost px-3 py-2 text-sm" onClick={load} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button className="btn-primary px-3 py-2 text-sm"
                  onClick={() => navigate("/app/order")}>
            New order
          </button>
        </div>
      </header>

      {error && <ErrorNote message={error} />}

      {orders.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="No orders yet"
          body="Orders you raise from the ordering catalogue appear here, along with the warehouse's progress on each one."
          actionLabel="Order products"
          onAction={() => navigate("/app/order")}
        />
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              open={expanded === order.id}
              onToggle={() => setExpanded(expanded === order.id ? null : order.id)}
            />
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button className="btn-ghost px-3 py-2 text-sm"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>
          <span className="text-micro text-ink-faint tnum">Page {page} of {pages}</span>
          <button className="btn-ghost px-3 py-2 text-sm"
                  disabled={page >= pages || loading}
                  onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- row

function OrderRow({
  order, open, onToggle,
}: { order: Order; open: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = order.purchase_order_items ?? [];
  const state = order.fulfillment_status ?? "pending";

  async function download() {
    setBusy(true);
    setError("");
    try {
      await downloadExcel(`/warehouse/orders/${order.id}/export`,
                          `order-${order.po_number}.xlsx`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't download that order.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <button className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-canvas-tint"
                onClick={onToggle}
                aria-label={open ? "Collapse order" : "Expand order"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-[10rem]">
          <p className="font-display text-sm font-semibold tnum">{order.po_number}</p>
          <p className="text-micro text-ink-faint">
            {new Date(order.created_at).toLocaleDateString()} ·{" "}
            {order.stores?.name ?? "—"}
          </p>
        </div>

        <FulfilmentBadge state={state} />

        <div className="ml-auto flex flex-wrap items-center gap-4 text-micro text-ink-muted tnum">
          <span>{order.line_count ?? items.length} lines</span>
          <span>{units(order.unit_count ?? 0)} units</span>
          <span className="font-medium text-ink">{money(order.total_value)}</span>
          <button className="btn-quiet px-2.5 py-1.5" onClick={download} disabled={busy}>
            <Download className="h-3.5 w-3.5" /> Excel
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-4 border-t border-line bg-canvas-tint/40 px-4 py-4">
          {error && <ErrorNote message={error} />}

          <Tracker state={state} />

          <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
            <div>
              <p className="mb-2 text-micro font-medium text-ink-muted">
                Products ordered
              </p>
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.id}
                      className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
                    <Thumb src={item.products?.image_url} alt={item.products?.name ?? "Product"}
                           size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{item.products?.name}</p>
                      <p className="truncate text-micro text-ink-faint tnum">
                        {item.products?.sku} · {money(item.products?.mrp)}
                      </p>
                    </div>
                    <span className="text-sm tnum">×{units(item.quantity)}</span>
                    <span className="w-20 text-right text-sm tnum">
                      {money(item.line_total)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-3">
              <Detail label="Delivery address"
                      value={order.delivery_address ?? order.stores?.address
                             ?? order.stores?.location ?? "—"} />
              <Detail label="Approval status" value={order.status.replace(/_/g, " ")} />
              <Detail label="Warehouse status" value={FULFILMENT_LABEL[state] ?? state} />
              {order.tracking_number && (
                <Detail label="Tracking"
                        value={`${order.carrier ? order.carrier + " · " : ""}${order.tracking_number}`} />
              )}
              {order.shipped_at && (
                <Detail label="Shipped"
                        value={new Date(order.shipped_at).toLocaleString()} />
              )}
              {order.warehouse_notes && (
                <Detail label="Warehouse note" value={order.warehouse_notes} />
              )}
              {order.notes && <Detail label="Your note" value={order.notes} />}
            </div>
          </div>

          {(order.events?.length ?? 0) > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-micro font-medium text-ink-muted">
                <FileSpreadsheet className="h-3.5 w-3.5" /> History
              </p>
              <ul className="space-y-1.5">
                {order.events!.map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-2 text-micro text-ink-muted">
                    <span className="tnum text-ink-faint">
                      {new Date(event.created_at).toLocaleString()}
                    </span>
                    <span className="font-medium text-ink">
                      {FULFILMENT_LABEL[event.to_state ?? ""] ?? event.to_state}
                    </span>
                    {event.note && <span>· {event.note}</span>}
                    {event.actor_name && <span className="text-ink-faint">· {event.actor_name}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-micro text-ink-faint">{label}</p>
      <p className="text-sm capitalize-first">{value}</p>
    </div>
  );
}

export function FulfilmentBadge({ state }: { state: string }) {
  const tone: Record<string, string> = {
    pending: "border-line bg-canvas-tint text-ink-muted",
    accepted: "border-wine/30 bg-wine-soft text-wine",
    picking: "border-wine/30 bg-wine-soft text-wine",
    packing: "border-wine/30 bg-wine-soft text-wine",
    packed: "border-healthy/40 bg-healthy-soft text-healthy",
    shipped: "border-healthy/40 bg-healthy-soft text-healthy",
    delivered: "border-healthy/40 bg-healthy-soft text-healthy",
    cancelled: "border-critical/40 bg-critical-soft text-critical",
  };
  return (
    <span className={`rounded-full border px-2.5 py-1 text-micro font-medium ${
      tone[state] ?? tone.pending}`}>
      {FULFILMENT_LABEL[state] ?? state}
    </span>
  );
}

/** The seven-stage pipeline, with everything up to the current stage filled. */
function Tracker({ state }: { state: string }) {
  if (state === "cancelled") {
    return (
      <p className="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-micro text-critical">
        This order was cancelled by the warehouse.
      </p>
    );
  }
  const index = FULFILMENT_STAGES.indexOf(state as typeof FULFILMENT_STAGES[number]);

  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {FULFILMENT_STAGES.map((stage, i) => (
        <li key={stage} className="flex items-center gap-1.5">
          <span className={`rounded-full px-2.5 py-1 text-micro font-medium ${
            i <= index
              ? "bg-wine text-white"
              : "border border-line bg-canvas text-ink-faint"}`}>
            {FULFILMENT_LABEL[stage]}
          </span>
          {i < FULFILMENT_STAGES.length - 1 && (
            <span className={`h-px w-4 ${i < index ? "bg-wine" : "bg-line"}`} />
          )}
        </li>
      ))}
    </ol>
  );
}
