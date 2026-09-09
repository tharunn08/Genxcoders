import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Check, Lightbulb, Plus, Truck, X } from "lucide-react";
import clsx from "clsx";
import { api, ApiError, Product, Store, Transfer, TransferSuggestion } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, PriorityChip, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import { Busy, Field, Modal, SuccessNote } from "@/components/ui/forms";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-canvas-tint text-ink-muted",
  pending: "bg-low-soft text-low",
  approved: "bg-peach-light text-wine",
  in_transit: "bg-overstock-soft text-overstock",
  received: "bg-healthy-soft text-healthy",
  rejected: "bg-critical-soft text-critical",
  cancelled: "bg-critical-soft text-critical",
};

interface TransferPrefill {
  source_store_id: string;
  dest_store_id: string;
  product_id: string;
  quantity: string;
  reason: string;
}

const OPEN_NEW: TransferPrefill = {
  source_store_id: "", dest_store_id: "", product_id: "", quantity: "", reason: "",
};

export default function Transfers() {
  const { activeStore, can } = useAuth();
  const [items, setItems] = useState<Transfer[]>([]);
  const [suggestions, setSuggestions] = useState<TransferSuggestion[]>([]);
  const [suggestionsOn, setSuggestionsOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState<false | TransferPrefill>(false);
  const [busyId, setBusyId] = useState("");

  const canManage = can("approve_orders");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Transfer[] }>("/transfers", { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (e.name !== "ApiError" || e.status !== -1) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!suggestionsOn) { setSuggestions([]); return; }
    api.get<{ items: TransferSuggestion[] }>("/transfers/suggestions")
      .then((r) => setSuggestions(r.items))
      .catch(() => setSuggestions([]));
  }, [suggestionsOn, reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function setStatus(transfer: Transfer, status: string) {
    setBusyId(transfer.id);
    setError(null);
    try {
      await api.post(`/transfers/${transfer.id}/status`, { status });
      refresh(`Transfer ${transfer.transfer_number} marked ${status.replace(/_/g, " ")}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Stock transfers</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Move stock between stores. Receiving a transfer adjusts both stores' levels.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className={clsx("btn-ghost", suggestionsOn && "border-wine bg-peach-light text-wine")}
            onClick={() => setSuggestionsOn((v) => !v)}
          >
            <Lightbulb className="h-4 w-4" /> AI suggestions
          </button>
          <button className="btn-primary" onClick={() => setCreating(OPEN_NEW)}>
            <Plus className="h-4 w-4" /> New transfer
          </button>
        </div>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {suggestionsOn && (
        <section className="glass wash-peach overflow-hidden">
          <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
            Suggested transfers — pair a short store with a surplus store
          </h2>
          {suggestions.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-muted">
              No transfer pairs found. A suggestion needs one store overstocked on a
              SKU while another is short of it.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {suggestions.map((s) => (
                <li key={`${s.product_id}-${s.source_store_id}-${s.dest_store_id}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <Thumb src={s.image_url} alt={s.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{s.name}</p>
                    <p className="text-micro text-ink-faint tnum">{s.sku}</p>
                  </div>
                  <div className="flex items-center gap-2 text-micro">
                    <span className="text-right">
                      <span className="block font-medium">{s.source_store_name}</span>
                      <span className="text-ink-faint">{units(s.source_available)} available</span>
                    </span>
                    <ArrowRightLeft className="h-3.5 w-3.5 text-wine" />
                    <span className="text-left">
                      <span className="block font-medium">{s.dest_store_name}</span>
                      <span className="text-ink-faint">{units(s.dest_available)} available</span>
                    </span>
                  </div>
                  <span className="chip bg-peach-light text-wine tnum">{units(s.quantity)} units</span>
                  <button
                    className="btn-quiet px-2 py-1 text-micro"
                    onClick={() => setCreating({
                      source_store_id: s.source_store_id,
                      dest_store_id: s.dest_store_id,
                      product_id: s.product_id,
                      quantity: String(s.quantity),
                      reason: s.reason,
                    })}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No transfers yet"
          body="Create a transfer to rebalance stock between stores."
          actionLabel="New transfer"
          onAction={() => setCreating(OPEN_NEW)}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">Transfer</th>
                <th className="px-3 py-3 font-medium">Route</th>
                <th className="px-3 py-3 font-medium">Product</th>
                <th className="px-3 py-3 text-right font-medium">Qty</th>
                <th className="px-3 py-3 font-medium">Priority</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((transfer) => (
                <tr key={transfer.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5 font-medium tnum">{transfer.transfer_number}</td>
                  <td className="px-3 py-2.5 text-micro">
                    <span className="block">{transfer.source?.name ?? "—"}</span>
                    <span className="block text-ink-faint">→ {transfer.dest?.name ?? "—"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {(transfer.stock_transfer_items ?? []).map((item) => (
                      <div key={item.id} className="flex items-center gap-2">
                        <Thumb src={item.products?.image_url} alt={item.products?.name ?? ""} size="sm" />
                        <span className="min-w-0">
                          <span className="block max-w-[14rem] truncate">{item.products?.name ?? "—"}</span>
                          <span className="text-micro text-ink-faint tnum">{item.products?.sku}</span>
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">
                    {(transfer.stock_transfer_items ?? []).reduce((s, i) => s + Number(i.quantity), 0)}
                  </td>
                  <td className="px-3 py-2.5"><PriorityChip value={transfer.priority} /></td>
                  <td className="px-3 py-2.5">
                    <span className={clsx("chip", STATUS_STYLE[transfer.status] ?? "bg-canvas-tint")}>
                      {transfer.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-faint tnum">
                    {new Date(transfer.created_at).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      {transfer.status === "pending" && canManage && (
                        <>
                          <button className="btn-quiet px-2 py-1 text-micro text-healthy"
                                  disabled={busyId === transfer.id}
                                  onClick={() => setStatus(transfer, "approved")}>
                            <Check className="h-3.5 w-3.5" /> Approve
                          </button>
                          <button className="btn-quiet px-2 py-1 text-micro text-critical"
                                  disabled={busyId === transfer.id}
                                  onClick={() => setStatus(transfer, "rejected")}>
                            <X className="h-3.5 w-3.5" /> Reject
                          </button>
                        </>
                      )}
                      {transfer.status === "approved" && canManage && (
                        <button className="btn-quiet px-2 py-1 text-micro"
                                disabled={busyId === transfer.id}
                                onClick={() => setStatus(transfer, "in_transit")}>
                          Mark in transit
                        </button>
                      )}
                      {transfer.status === "in_transit" && canManage && (
                        <button className="btn-quiet px-2 py-1 text-micro text-healthy"
                                disabled={busyId === transfer.id}
                                onClick={() => setStatus(transfer, "received")}>
                          <Check className="h-3.5 w-3.5" /> Receive
                        </button>
                      )}
                      {["pending", "approved", "in_transit"].includes(transfer.status) && canManage && (
                        <button className="btn-quiet px-2 py-1 text-micro text-critical"
                                disabled={busyId === transfer.id}
                                onClick={() => setStatus(transfer, "cancelled")}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateTransferDialog
          prefill={creating || undefined}
          activeStoreId={activeStore?.id ?? ""}
          onClose={() => setCreating(false)}
          onSaved={(m) => { setCreating(false); refresh(m); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- create

function CreateTransferDialog({
  prefill, activeStoreId, onClose, onSaved,
}: {
  prefill?: { source_store_id: string; dest_store_id: string; product_id: string;
              quantity: string; reason: string };
  activeStoreId: string;
  onClose: () => void; onSaved: (m: string) => void;
}) {
  const [stores, setStores] = useState<Store[]>([]);
  const [sourceStoreId, setSourceStoreId] = useState(prefill?.source_store_id ?? "");
  const [destStoreId, setDestStoreId] = useState(prefill?.dest_store_id ?? "");
  const [product, setProduct] = useState<Product | null>(null);
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [quantity, setQuantity] = useState(prefill?.quantity ?? "");
  const [reason, setReason] = useState(prefill?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    api.get<{ items: Store[] }>("/stores")
      .then((r) => {
        setStores(r.items);
        setSourceStoreId((cur) => cur || (r.items.length >= 2 ? r.items[0].id : ""));
        setDestStoreId((cur) => cur || (r.items.length >= 2 ? r.items[1].id : ""));
      })
      .catch(() => {});
  }, []);

  // Resolve a prefilled product id (from an AI suggestion).
  useEffect(() => {
    if (!prefill?.product_id) return;
    api.get<Product>(`/products/${prefill.product_id}`)
      .then((p) => setProduct(p))
      .catch(() => {});
  }, [prefill?.product_id]);

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

  async function save() {
    if (!sourceStoreId || !destStoreId) { setError(new Error("Choose source and destination stores.")); return; }
    if (sourceStoreId === destStoreId) { setError(new Error("Source and destination must differ.")); return; }
    if (!product) { setError(new Error("Choose a product.")); return; }
    const qty = Number(quantity);
    if (!qty || qty <= 0) { setError(new Error("Enter a quantity greater than zero.")); return; }

    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ transfer_number: string }>("/transfers", {
        source_store_id: sourceStoreId,
        dest_store_id: destStoreId,
        product_id: product.id,
        quantity: qty,
        reason: reason.trim() || null,
      });
      onSaved(`${created.transfer_number} requested.`);
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
      title="New stock transfer"
      description="Source stock is reduced and destination stock increased when the transfer is received."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Submitting…" /> : "Submit transfer request"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source store" required>
            <select className="field" value={sourceStoreId}
                    onChange={(e) => setSourceStoreId(e.target.value)}>
              <option value="">Choose</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Destination store" required>
            <select className="field" value={destStoreId}
                    onChange={(e) => setDestStoreId(e.target.value)}>
              <option value="">Choose</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Product" required>
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
        </Field>

        <Field label="Quantity" required>
          <input className="field tnum" inputMode="decimal" value={quantity}
                 onChange={(e) => setQuantity(e.target.value)} />
        </Field>

        <Field label="Reason">
          <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}