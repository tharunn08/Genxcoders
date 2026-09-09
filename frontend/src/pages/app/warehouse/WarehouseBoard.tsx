import { useCallback, useEffect, useState } from "react";
import {
  ClipboardList, Download, MapPin, PackageCheck, RefreshCw, Send, Truck, User,
} from "lucide-react";
import {
  api, ApiError, downloadExcel, FULFILMENT_LABEL, Order, PackingList,
  WarehouseStats,
} from "@/lib/api";
import {
  EmptyState, ErrorNote, money, PriorityChip, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import { Busy, Field, Modal, SuccessNote } from "@/components/ui/forms";
import { FulfilmentBadge } from "@/pages/app/MyOrders";

/**
 * Warehouse team board.
 *
 * Orders arrive here the moment a store manager submits one. The pipeline is
 * enforced on the server (`FULFILMENT_FLOW` in `routers/warehouse.py`), so the
 * button shown for "next stage" is a convenience — an out-of-order transition
 * posted by hand is rejected with a 409 rather than silently accepted.
 */

const TABS: { key: string; label: string }[] = [
  { key: "pending", label: "New orders" },
  { key: "accepted", label: "Accepted" },
  { key: "picking", label: "Picking" },
  { key: "packing", label: "Packing" },
  { key: "packed", label: "Packed" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "all", label: "All" },
];

/** What the server will accept next from each stage. */
const NEXT: Record<string, string> = {
  pending: "accepted",
  accepted: "picking",
  picking: "packing",
  packing: "packed",
  packed: "shipped",
  shipped: "delivered",
};

export default function WarehouseBoard() {
  const [tab, setTab] = useState("pending");
  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<WarehouseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [shipping, setShipping] = useState<Order | null>(null);
  const [packing, setPacking] = useState<Order | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<{ items: Order[] }>(
        `/warehouse/orders?fulfillment_status=${tab}&limit=100`, { dedupe: false }),
      api.get<WarehouseStats>("/warehouse/stats", { dedupe: false }),
    ])
      .then(([o, s]) => { setOrders(o.items); setStats(s); setError(""); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load the board."))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function advance(order: Order, to: string, extra: Record<string, unknown> = {}) {
    try {
      const result = await api.post<{ message: string }>(
        `/warehouse/orders/${order.id}/fulfillment`,
        { fulfillment_status: to, ...extra },
      );
      setNotice(`${order.po_number}: ${result.message}`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't update that order.");
    }
  }

  if (loading && !orders.length && !stats) return <Spinner label="Loading the warehouse board…" />;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <Truck className="h-5 w-5 text-wine" /> Warehouse
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Store orders to receive, pick, pack and ship.
          </p>
        </div>
        <button className="btn-ghost px-3 py-2 text-sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote message={error} />}

      {stats && (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <Stat label="New orders" value={stats.new_orders} accent />
          <Stat label="To pack" value={stats.to_pack} />
          <Stat label="Packed" value={stats.packed} />
          <Stat label="Shipped" value={stats.shipped} />
          <Stat label="Delivered" value={stats.delivered} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-b border-line pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-micro font-medium transition ${
              tab === t.key ? "bg-wine text-white" : "text-ink-muted hover:bg-canvas-tint"}`}
          >
            {t.label}
            {stats?.stages?.[t.key] != null && t.key !== "all" && (
              <span className="ml-1.5 tnum opacity-70">{stats.stages[t.key]}</span>
            )}
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="Nothing here"
          body={tab === "pending"
            ? "No new store orders are waiting. They appear here the moment a store manager submits one."
            : `No orders are currently ${FULFILMENT_LABEL[tab]?.toLowerCase() ?? tab}.`}
        />
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <WarehouseOrderCard
              key={order.id}
              order={order}
              onAdvance={advance}
              onShip={() => setShipping(order)}
              onPack={() => setPacking(order)}
            />
          ))}
        </ul>
      )}

      {shipping && (
        <ShipDialog
          order={shipping}
          onClose={() => setShipping(null)}
          onShip={async (tracking, carrier) => {
            await advance(shipping, "shipped",
                          { tracking_number: tracking || null, carrier: carrier || null });
            setShipping(null);
          }}
        />
      )}

      {packing && (
        <PackingDialog
          order={packing}
          onClose={() => setPacking(null)}
          onDone={(message) => { setPacking(null); setNotice(message); load(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`panel px-4 py-3 ${accent && value > 0 ? "border-wine/40 bg-wine-soft" : ""}`}>
      <p className="text-micro text-ink-muted">{label}</p>
      <p className="font-display text-2xl font-semibold tnum">{value.toLocaleString()}</p>
    </div>
  );
}

// ---------------------------------------------------------------- card

function WarehouseOrderCard({
  order, onAdvance, onShip, onPack,
}: {
  order: Order;
  onAdvance: (order: Order, to: string) => Promise<void>;
  onShip: () => void;
  onPack: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = order.fulfillment_status ?? "pending";
  const next = NEXT[state];
  const items = order.purchase_order_items ?? [];

  async function step() {
    if (!next) return;
    if (next === "shipped") { onShip(); return; }
    setBusy(true);
    await onAdvance(order, next);
    setBusy(false);
  }

  return (
    <li className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <div className="min-w-[11rem]">
          <p className="font-display text-sm font-semibold tnum">{order.po_number}</p>
          <p className="text-micro text-ink-faint">
            {new Date(order.created_at).toLocaleString()}
          </p>
        </div>

        <div className="min-w-[12rem]">
          <p className="flex items-center gap-1.5 text-sm">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            {order.stores?.name ?? "—"}
            <span className="text-ink-faint tnum">({order.stores?.code})</span>
          </p>
          <p className="flex items-center gap-1.5 text-micro text-ink-faint">
            <User className="h-3 w-3 shrink-0" />
            {order.requested_by_profile?.full_name
              ?? order.requested_by_profile?.email ?? "Store manager"}
          </p>
        </div>

        <FulfilmentBadge state={state} />
        <PriorityChip value={order.priority} />

        <div className="ml-auto flex flex-wrap items-center gap-3 text-micro text-ink-muted tnum">
          <span>{order.line_count ?? items.length} lines</span>
          <span>{units(order.unit_count ?? 0)} units</span>
          <span className="font-medium text-ink">{money(order.total_value)}</span>
        </div>

        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <button className="btn-quiet px-2.5 py-1.5 text-micro" onClick={() => setOpen(!open)}>
            {open ? "Hide items" : "View items"}
          </button>
          <button
            className="btn-quiet px-2.5 py-1.5 text-micro"
            onClick={() => downloadExcel(`/warehouse/orders/${order.id}/export`,
                                         `order-${order.po_number}.xlsx`)}
          >
            <Download className="h-3.5 w-3.5" /> Excel
          </button>
          {["picking", "packing", "packed", "shipped"].includes(state) && (
            <button className="btn-ghost px-2.5 py-1.5 text-micro" onClick={onPack}>
              <ClipboardList className="h-3.5 w-3.5" /> Packing list
            </button>
          )}
          {next && (
            <button className="btn-primary px-3 py-1.5 text-micro" onClick={step}
                    disabled={busy}>
              {busy ? <Busy label="Saving…" /> : (
                <>
                  {next === "shipped" && <Send className="h-3.5 w-3.5" />}
                  Mark {FULFILMENT_LABEL[next].toLowerCase()}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-line bg-canvas-tint/40 px-4 py-4">
          <p className="mb-2 text-micro text-ink-muted">
            Deliver to:{" "}
            <strong>
              {order.delivery_address ?? order.stores?.address
               ?? order.stores?.location ?? "No address on file"}
            </strong>
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
                    SKU {item.products?.sku} · {money(item.products?.mrp)}
                  </p>
                </div>
                <span className="font-display text-base font-semibold tnum">
                  ×{units(item.quantity)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- ship

function ShipDialog({
  order, onClose, onShip,
}: { order: Order; onClose: () => void; onShip: (t: string, c: string) => Promise<void> }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal open title={`Ship ${order.po_number}`} onClose={onClose}
           description="Tracking details are optional — the store manager sees them on their order.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Carrier">
          <input className="field" value={carrier} placeholder="Optional"
                 onChange={(e) => setCarrier(e.target.value)} />
        </Field>
        <Field label="Tracking number">
          <input className="field" value={tracking} placeholder="Optional"
                 onChange={(e) => setTracking(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn-primary px-4 py-2 text-sm" disabled={busy}
                onClick={async () => { setBusy(true); await onShip(tracking, carrier); setBusy(false); }}>
          {busy ? <Busy label="Shipping…" /> : "Mark shipped"}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- packing list

function PackingDialog({
  order, onClose, onDone,
}: { order: Order; onClose: () => void; onDone: (message: string) => void }) {
  const [existing, setExisting] = useState<PackingList[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<{ items: PackingList[] }>(`/warehouse/packing-lists?order_id=${order.id}`)
      .then((r) => setExisting(r.items))
      .catch(() => setExisting([]));
  }, [order.id]);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ message: string; packing_list: PackingList }>(
        `/warehouse/orders/${order.id}/packing-list`, { notes: notes.trim() || null });
      // Hand the file over immediately — generating and then hunting for the
      // download is the step people forget.
      await downloadExcel(
        `/warehouse/packing-lists/${result.packing_list.id}/export`,
        `packing-list-${result.packing_list.packing_number}.xlsx`);
      onDone(result.message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't generate the packing list.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`Packing list — ${order.po_number}`} onClose={onClose} wide
           description="Generating snapshots the order lines as they are now, then downloads the Excel file.">
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      {existing.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-micro font-medium text-ink-muted">
            Already generated
          </p>
          <ul className="space-y-1.5">
            {existing.map((list) => (
              <li key={list.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2 text-micro">
                <span className="font-medium tnum">{list.packing_number}</span>
                <span className="text-ink-faint">
                  {list.packing_date} · {list.total_lines} lines ·{" "}
                  {units(list.total_units)} units
                </span>
                <span className="text-ink-faint">{list.packed_by_name}</span>
                <button
                  className="btn-quiet ml-auto px-2.5 py-1"
                  onClick={() => downloadExcel(
                    `/warehouse/packing-lists/${list.id}/export`,
                    `packing-list-${list.packing_number}.xlsx`)}
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Field label="Notes on this packing list" hint="Optional — printed on the sheet.">
        <input className="field" value={notes}
               onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button className="btn-primary px-4 py-2 text-sm" onClick={generate} disabled={busy}>
          {busy ? <Busy label="Generating…" /> : (
            <><ClipboardList className="h-3.5 w-3.5" /> Generate & download</>
          )}
        </button>
      </div>
    </Modal>
  );
}
