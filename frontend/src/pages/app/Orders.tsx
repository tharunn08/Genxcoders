import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, Download, Eye, FileSpreadsheet, Plus, ShoppingCart, Truck, X } from "lucide-react";
import clsx from "clsx";
import {
  api, ApiError, downloadExcel, Order, OrderItem, Product, Store,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, PriorityChip, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import { Busy, Field, Modal, SuccessNote } from "@/components/ui/forms";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-canvas-tint text-ink-muted",
  pending_approval: "bg-low-soft text-low",
  approved: "bg-peach-light text-wine",
  ordered: "bg-peach-light text-wine",
  in_transit: "bg-overstock-soft text-overstock",
  partially_received: "bg-overstock-soft text-overstock",
  received: "bg-healthy-soft text-healthy",
  rejected: "bg-critical-soft text-critical",
  cancelled: "bg-critical-soft text-critical",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", pending_approval: "Pending approval", approved: "Approved",
  ordered: "Ordered", in_transit: "In transit",
  partially_received: "Partially received", received: "Received",
  rejected: "Rejected", cancelled: "Cancelled",
};

const ORDER_FILTERS = ["", "pending_approval", "approved", "ordered", "in_transit", "received", "cancelled"];

export default function Orders() {
  const { activeStore, can } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState<Order[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<Order | null>(null);
  const [exporting, setExporting] = useState(false);

  const canApprove = can("approve_orders");
  const canCreate = can("create_requests");
  const canImport = can("import_data");

  async function exportOrders() {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "10000" });
      if (activeStore) params.set("store_id", activeStore.id);
      if (filter) params.set("status", filter);
      await downloadExcel(`/export/orders?${params}`, `orders-${new Date().toISOString().slice(0, 10)}.xlsx`);
      setNotice("Orders exported to Excel.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: "100" });
    if (activeStore) params.set("store_id", activeStore.id);
    if (filter) params.set("status", filter);
    api.get<{ items: Order[] }>(`/orders?${params}`, { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (e.name !== "ApiError" || e.status !== -1) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [activeStore?.id, filter, reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // /app/orders/:id (from global search) opens that order's detail when loaded.
  useEffect(() => {
    if (!id || !items.length) return;
    const order = items.find((o) => o.id === id);
    if (order) setViewing(order);
  }, [id, items]);

  const lineCount = (o: Order) => (o.purchase_order_items ?? []).length;
  const lineQty = (o: Order) =>
    (o.purchase_order_items ?? []).reduce((s, i) => s + Number(i.quantity), 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Orders</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Purchase orders from draft to received. Receiving moves real stock.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canImport && (
            <button
              className="btn-ghost"
              onClick={() => navigate("/app/admin/imports?type=orders")}
            >
              <FileSpreadsheet className="h-4 w-4" /> Import from Excel
            </button>
          )}
          <button className="btn-ghost" onClick={exportOrders} disabled={exporting}>
            {exporting ? <Busy label="Exporting…" /> : <><Download className="h-4 w-4" /> Export to Excel</>}
          </button>
          {canCreate && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Create order
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {ORDER_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-lg border px-2.5 py-1.5 text-micro transition-colors ${
              filter === s ? "border-wine bg-peach-light text-wine"
                           : "border-line text-ink-muted hover:bg-surface-hover"}`}
          >
            {s ? STATUS_LABEL[s] : "All"}
          </button>
        ))}
      </div>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={filter ? "No orders in this state" : "No orders yet"}
          body={filter
            ? "No purchase orders match this status."
            : "Create an order by hand, or raise one straight from the replenishment screen."}
          actionLabel={canCreate && !filter ? "Create order" : undefined}
          onAction={() => setCreating(true)}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-3 py-3 font-medium">Supplier</th>
                <th className="px-3 py-3 font-medium">Products</th>
                <th className="px-3 py-3 text-right font-medium">Quantity</th>
                <th className="px-3 py-3 text-right font-medium">Value</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Created</th>
                <th className="px-3 py-3 font-medium">Expected</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((order) => (
                <tr key={order.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <p className="font-medium tnum">{order.po_number}</p>
                    <p className="text-micro text-ink-faint">
                      {order.stores?.name ?? "—"}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {order.suppliers?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex -space-x-2">
                      {(order.purchase_order_items ?? []).slice(0, 4).map((i) => (
                        <Thumb key={i.id} src={i.products?.image_url} alt={i.products?.name ?? ""}
                               size="sm" />
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">{units(lineQty(order))}</td>
                  <td className="px-3 py-2.5 text-right tnum">{money(order.total_value)}</td>
                  <td className="px-3 py-2.5">
                    <span className={clsx("chip", STATUS_STYLE[order.status] ?? "bg-canvas-tint")}>
                      {STATUS_LABEL[order.status] ?? order.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-faint tnum">
                    {new Date(order.created_at).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-faint tnum">
                    {order.expected_date ? new Date(order.expected_date).toLocaleDateString("en-IN") : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      className="btn-quiet px-2 py-1 text-micro"
                      onClick={() => setViewing(order)}
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateOrderDialog
          defaultStoreId={activeStore?.id ?? ""}
          onClose={() => setCreating(false)}
          onSaved={(m) => { setCreating(false); refresh(m); }}
        />
      )}

      {viewing && (
        <OrderDetailDialog
          order={viewing}
          canApprove={canApprove}
          onClose={() => setViewing(null)}
          onChanged={(m) => { setViewing(null); refresh(m); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- create

interface LineDraft {
  product: Product | null;
  quantity: string;
}

function CreateOrderDialog({
  defaultStoreId, onClose, onSaved,
}: { defaultStoreId: string; onClose: () => void; onSaved: (m: string) => void }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ product: null, quantity: "" }]);
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [notes, setNotes] = useState("");
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    Promise.allSettled([
      api.get<{ items: Store[] }>("/stores"),
      api.get<{ items: { id: string; name: string }[] }>("/suppliers"),
    ]).then(([s, sup]) => {
      if (s.status === "fulfilled") {
        setStores(s.value.items);
        setStoreId((cur) => cur || (s.value.items.length === 1 ? s.value.items[0].id : ""));
      }
      if (sup.status === "fulfilled") setSuppliers(sup.value.items);
    });
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

  function pickProduct(lineIndex: number, product: Product) {
    setLines((prev) => prev.map((l, i) => i === lineIndex ? { ...l, product } : l));
    setMatches([]);
    setProductQuery("");
  }

  async function save() {
    const valid = lines.filter((l) => l.product && Number(l.quantity) > 0);
    if (!storeId) { setError(new Error("Choose a store.")); return; }
    if (!valid.length) { setError(new Error("Add at least one product with a quantity.")); return; }

    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ po_number: string }>("/orders", {
        store_id: storeId,
        supplier_id: supplierId || null,
        notes: notes.trim() || null,
        submit,
        items: valid.map((l) => ({
          product_id: l.product!.id,
          quantity: Number(l.quantity),
          unit_price: l.product!.mrp,
        })),
      });
      onSaved(`${created.po_number} ${submit ? "submitted for approval." : "saved as a draft."}`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      title="Create order"
      description="Lines are priced at the product's current MRP unless changed on receipt."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Creating…" /> : submit ? "Create & submit" : "Save draft"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Store" required>
            <select className="field" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">Choose a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
              ))}
            </select>
          </Field>
          <Field label="Supplier">
            <select className="field" value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">No supplier</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              {line.product ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-3 py-2">
                  <Thumb src={line.product.image_url} alt={line.product.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{line.product.name}</span>
                    <span className="text-micro text-ink-faint tnum">{line.product.sku}</span>
                  </span>
                  <button className="btn-quiet px-2 py-1 text-micro"
                          onClick={() => { if (line.product) pickProduct(index, line.product); }}>
                    Change
                  </button>
                </div>
              ) : (
                <div className="relative min-w-0 flex-1">
                  <input
                    className="field"
                    placeholder="Search product…"
                    value={productQuery}
                    onChange={(e) => setProductQuery(e.target.value)}
                  />
                  {matches.length > 0 && (
                    <ul className="absolute z-20 mt-1 w-full overflow-y-auto rounded-lg border border-line bg-white shadow-card">
                      {matches.map((p) => (
                        <li key={p.id}>
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                            onClick={() => pickProduct(index, p)}
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
                </div>
              )}
              <input
                className="field w-24 tnum"
                inputMode="decimal"
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => setLines((prev) => prev.map((l, i) =>
                  i === index ? { ...l, quantity: e.target.value } : l))}
              />
              {lines.length > 1 && (
                <button
                  className="btn-quiet p-2 text-critical"
                  aria-label="Remove line"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          <button className="btn-ghost px-3 py-2 text-micro" onClick={() => setLines((prev) => [...prev, { product: null, quantity: "" }])}>
            <Plus className="h-3.5 w-3.5" /> Add product
          </button>
        </div>

        <Field label="Notes">
          <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-wine" checked={submit}
                 onChange={(e) => setSubmit(e.target.checked)} />
          Submit for approval now (otherwise saved as a draft)
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- detail

function OrderDetailDialog({
  order, canApprove, onClose, onChanged,
}: { order: Order; canApprove: boolean; onClose: () => void; onChanged: (m: string) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [received, setReceived] = useState<Record<string, string>>({});

  async function setStatus(status: string, body?: Record<string, unknown>) {
    setBusy(status);
    setError(null);
    try {
      await api.post(`/orders/${order.id}/status`, { status, ...body });
      onChanged(`Order ${order.po_number} marked ${status.replace(/_/g, " ")}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy("");
    }
  }

  const canReceive = ["ordered", "in_transit"].includes(order.status);

  const actions: { label: string; status: string; tone?: "danger" }[] = [];
  if (order.status === "pending_approval" && canApprove) {
    actions.push({ label: "Approve", status: "approved" });
    actions.push({ label: "Reject", status: "rejected", tone: "danger" });
  }
  if (order.status === "approved" && canApprove) actions.push({ label: "Mark ordered", status: "ordered" });
  if (order.status === "ordered" && canApprove) actions.push({ label: "Mark in transit", status: "in_transit" });
  if (order.status === "in_transit" && canApprove) actions.push({ label: "Receive", status: "receive" });
  if (["pending_approval", "approved", "ordered", "in_transit"].includes(order.status)) {
    actions.push({ label: "Cancel", status: "cancelled", tone: "danger" });
  }

  return (
    <Modal
      open
      wide
      title={`${order.po_number} — ${order.stores?.name ?? ""}`}
      description={
        `${STATUS_LABEL[order.status] ?? order.status} · ` +
        `Created ${new Date(order.created_at).toLocaleString("en-IN")}`
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {!receiving && actions.map((a) => (
            <button
              key={a.status}
              className={a.tone === "danger" ? "btn-ghost text-critical" : "btn-primary"}
              disabled={busy === a.status}
              onClick={() => a.status === "receive" ? setReceiving(true) : setStatus(a.status)}
            >
              {busy === a.status ? <Busy /> : a.label}
            </button>
          ))}
          {receiving && (
            <button
              className="btn-primary"
              disabled={busy === "receive"}
              onClick={() => {
                const receivedMap: Record<string, number> = {};
                for (const item of order.purchase_order_items ?? []) {
                  const qty = Number(received[item.id]);
                  if (!Number.isNaN(qty) && qty > 0) receivedMap[item.id] = qty;
                }
                void setStatus("received", { received: receivedMap });
              }}
            >
              {busy === "receive" ? <Busy /> : <Check className="h-4 w-4" />} Confirm receipt
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Info label="Supplier" value={order.suppliers?.name ?? "—"} />
          <Info label="Priority" value={order.priority} />
          <Info label="Expected" value={order.expected_date
            ? new Date(order.expected_date).toLocaleDateString("en-IN") : "—"} />
          <Info label="Total value" value={money(order.total_value)} />
        </div>

        {order.notes && (
          <p className="rounded-xl bg-canvas-tint px-4 py-3 text-sm text-ink-muted">{order.notes}</p>
        )}

        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas-tint/60 text-left text-micro text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-3 py-2.5 text-right font-medium">Ordered</th>
                <th className="px-3 py-2.5 text-right font-medium">Received</th>
                <th className="px-3 py-2.5 text-right font-medium">Unit price</th>
                {receiving && <th className="px-4 py-2.5 text-right font-medium">Receiving now</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(order.purchase_order_items ?? []).map((item: OrderItem) => (
                <tr key={item.id}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Thumb src={item.products?.image_url} alt={item.products?.name ?? ""} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{item.products?.name ?? "—"}</p>
                        <p className="text-micro text-ink-faint tnum">{item.products?.sku}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">{units(item.quantity)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{units(item.received_quantity)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{money(item.unit_price)}</td>
                  {receiving && (
                    <td className="px-4 py-2.5 text-right">
                      <input
                        className="field w-24 py-1.5 text-right tnum"
                        inputMode="decimal"
                        placeholder={String(item.quantity)}
                        value={received[item.id] ?? ""}
                        onChange={(e) => setReceived((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canReceive && !receiving && (
          <p className="flex items-center gap-2 text-micro text-ink-muted">
            <Truck className="h-3.5 w-3.5" />
            Receiving adds the quantities to stock and records the movement.
          </p>
        )}
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-micro text-ink-faint">{label}</p>
      <p className="mt-0.5 text-sm font-medium capitalize tnum">{value}</p>
    </div>
  );
}