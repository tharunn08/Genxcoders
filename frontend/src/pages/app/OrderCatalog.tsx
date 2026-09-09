import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2, Minus, Package, Plus, Search, ShoppingCart, Trash2, X,
} from "lucide-react";
import { api, ApiError, Category, Paged, Product } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import { Busy, Field, Modal } from "@/components/ui/forms";

/**
 * Product ordering catalogue — the store manager's purchase screen.
 *
 * This reads the *real* products table through `/products`, the same endpoint
 * the admin catalogue uses. There is deliberately no separate list: a product a
 * super admin adds or imports is orderable here the moment it is saved, because
 * there is only ever one source.
 *
 * Two things make it usable on a large catalogue:
 *
 * * The grid is paginated server-side (24 a page) and images are lazy — loading
 *   thousands of products at once is what made earlier screens crawl.
 * * The basket lives outside the page of results, so paging or searching never
 *   loses what has already been added.
 */

const PAGE_SIZE = 24;

interface Line {
  product: Product;
  quantity: number;
}

export default function OrderCatalog() {
  const { activeStore, user } = useAuth();
  const navigate = useNavigate();

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);

  const [basket, setBasket] = useState<Record<string, Line>>({});
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState("");

  // Typing in the search box shouldn't fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search.trim());
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    api.get<{ items: Category[] }>("/categories")
      .then((r) => setCategories(r.items))
      .catch(() => setCategories([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      status: "active",
      sort: "name",
    });
    if (debounced) params.set("search", debounced);
    if (categoryId) params.set("category_id", categoryId);

    api.get<Paged<Product>>(`/products?${params}`)
      .then((r) => { setItems(r.items); setTotal(r.total); setError(""); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load products."))
      .finally(() => setLoading(false));
  }, [debounced, categoryId, offset]);

  useEffect(() => { load(); }, [load]);

  const lines = useMemo(
    () => Object.values(basket).filter((l) => l.quantity > 0),
    [basket],
  );
  const basketUnits = lines.reduce((sum, l) => sum + l.quantity, 0);
  const basketValue = lines.reduce(
    (sum, l) => sum + l.quantity * Number(l.product.mrp ?? 0), 0,
  );

  const setQuantity = (product: Product, quantity: number) =>
    setBasket((prev) => {
      const next = { ...prev };
      if (quantity <= 0) delete next[product.id];
      else next[product.id] = { product, quantity };
      return next;
    });

  if (loading && !items.length) return <Spinner label="Loading the catalogue…" />;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-5 pb-24">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <ShoppingCart className="h-5 w-5 text-wine" /> Order products
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Everything the central catalogue stocks. Set a quantity, add it to your
            order, then submit — the warehouse team receives it straight away.
          </p>
        </div>
        <button className="btn-ghost px-3 py-2 text-sm"
                onClick={() => navigate("/app/my-orders")}>
          My order history
        </button>
      </header>

      {submitted && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-healthy/40 bg-healthy-soft px-4 py-3 text-sm text-healthy">
          <CheckCircle2 className="h-4.5 w-4.5 shrink-0" />
          <span>Order {submitted} submitted and sent to the warehouse.</span>
          <button className="ml-auto underline" onClick={() => navigate("/app/my-orders")}>
            Track it
          </button>
        </div>
      )}
      {error && <ErrorNote message={error} />}

      {!activeStore && user?.role === "store_manager" && (
        <ErrorNote message="You aren't assigned to a store yet, so an order can't be raised. Ask an administrator to assign one." />
      )}

      {/* ------------------------------------------------------------ filters */}
      <div className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            className="field pl-9"
            placeholder="Search by name, SKU or barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="field max-w-[14rem]"
          value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); setOffset(0); }}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <span className="text-micro text-ink-faint tnum">
          {total.toLocaleString()} product{total === 1 ? "" : "s"}
        </span>
      </div>

      {/* ------------------------------------------------------------ grid */}
      {items.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products match"
          body={debounced || categoryId
            ? "Try a different search or category."
            : "No products have been added to the catalogue yet. A super admin adds or imports them."}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              quantity={basket[product.id]?.quantity ?? 0}
              onChange={(q) => setQuantity(product, q)}
            />
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button
            className="btn-ghost px-3 py-2 text-sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <span className="text-micro text-ink-faint tnum">Page {page} of {pages}</span>
          <button
            className="btn-ghost px-3 py-2 text-sm"
            disabled={page >= pages || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------ basket bar */}
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <ShoppingCart className="h-4.5 w-4.5 text-wine" />
            <span className="text-sm tnum">
              <strong>{lines.length}</strong> line{lines.length === 1 ? "" : "s"} ·{" "}
              <strong>{units(basketUnits)}</strong> units · {money(basketValue)}
            </span>
            <button className="btn-quiet ml-auto px-3 py-2 text-sm"
                    onClick={() => setBasket({})}>
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
            <button className="btn-primary px-4 py-2 text-sm"
                    onClick={() => setReviewing(true)}>
              Review & submit
            </button>
          </div>
        </div>
      )}

      {reviewing && (
        <ReviewOrder
          lines={lines}
          storeId={activeStore?.id ?? user?.stores?.[0]?.id ?? null}
          storeName={activeStore?.name ?? user?.stores?.[0]?.name ?? null}
          onClose={() => setReviewing(false)}
          onChange={setQuantity}
          onSubmitted={(poNumber) => {
            setBasket({});
            setReviewing(false);
            setSubmitted(poNumber);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- card

function ProductCard({
  product, quantity, onChange,
}: { product: Product; quantity: number; onChange: (q: number) => void }) {
  const stock = product.available_stock ?? 0;
  const tracked = (product.inventory_records ?? 0) > 0;

  return (
    <li className="panel flex flex-col overflow-hidden">
      <div className="aspect-square bg-canvas-tint">
        <Thumb src={product.image_url} alt={product.name} size="lg" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="min-h-[3.5rem]">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{product.name}</p>
          <p className="mt-1 truncate text-micro text-ink-faint tnum">
            {product.sku}
            {product.categories?.name ? ` · ${product.categories.name}` : ""}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-base font-semibold tnum">
            {money(product.mrp)}
          </span>
          <Availability stock={stock} tracked={tracked} />
        </div>

        <div className="mt-auto flex items-center gap-2 pt-1">
          <div className="flex items-center rounded-lg border border-line">
            <button
              className="grid h-9 w-9 place-items-center text-ink-muted disabled:opacity-40"
              disabled={quantity <= 0}
              onClick={() => onChange(quantity - 1)}
              aria-label="Decrease quantity"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              className="w-12 border-x border-line bg-transparent py-1.5 text-center text-sm tnum outline-none"
              inputMode="numeric"
              value={quantity || ""}
              placeholder="0"
              onChange={(e) => {
                const next = Number(e.target.value.replace(/[^0-9]/g, ""));
                onChange(Number.isFinite(next) ? next : 0);
              }}
            />
            <button
              className="grid h-9 w-9 place-items-center text-ink-muted"
              onClick={() => onChange(quantity + 1)}
              aria-label="Increase quantity"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            className={quantity > 0 ? "btn-quiet flex-1 py-2 text-micro" : "btn-primary flex-1 py-2 text-micro"}
            onClick={() => onChange(quantity > 0 ? quantity : 1)}
          >
            {quantity > 0 ? "In order" : "Add to order"}
          </button>
        </div>
      </div>
    </li>
  );
}

function Availability({ stock, tracked }: { stock: number; tracked: boolean }) {
  if (!tracked) {
    return <span className="text-micro text-ink-faint">Stock not tracked</span>;
  }
  if (stock <= 0) {
    return <span className="text-micro font-medium text-critical">Out of stock</span>;
  }
  return (
    <span className="text-micro font-medium text-healthy tnum">
      {units(stock)} available
    </span>
  );
}

// ---------------------------------------------------------------- review

function ReviewOrder({
  lines, storeId, storeName, onClose, onChange, onSubmitted,
}: {
  lines: Line[];
  storeId: string | null;
  storeName: string | null;
  onClose: () => void;
  onChange: (product: Product, quantity: number) => void;
  onSubmitted: (poNumber: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  const totalValue = lines.reduce(
    (s, l) => s + l.quantity * Number(l.product.mrp ?? 0), 0,
  );

  async function submit() {
    if (!storeId) { setError("No store is selected for this order."); return; }
    if (guard.current) return;          // a double-click must not raise two orders
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const order = await api.post<{ po_number: string }>("/orders", {
        store_id: storeId,
        priority,
        notes: notes.trim() || null,
        source: "store",
        submit: true,
        items: lines.map((l) => ({
          product_id: l.product.id,
          quantity: l.quantity,
          unit_price: l.product.mrp ?? null,
        })),
      });
      onSubmitted(order.po_number);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't submit the order.");
      guard.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Review your order" onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          Delivering to <strong>{storeName ?? "your store"}</strong>. The warehouse
          team receives this order with an Excel copy as soon as you submit.
        </p>

        {error && <ErrorNote message={error} />}

        <ul className="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
          {lines.map((line) => (
            <li key={line.product.id}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <Thumb src={line.product.image_url} alt={line.product.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{line.product.name}</p>
                <p className="truncate text-micro text-ink-faint tnum">
                  {line.product.sku} · {money(line.product.mrp)}
                </p>
              </div>
              <input
                className="field w-20 text-center tnum"
                inputMode="numeric"
                value={line.quantity}
                onChange={(e) => {
                  const next = Number(e.target.value.replace(/[^0-9]/g, ""));
                  onChange(line.product, Number.isFinite(next) ? next : 0);
                }}
              />
              <span className="w-24 text-right text-sm tnum">
                {money(line.quantity * Number(line.product.mrp ?? 0))}
              </span>
              <button className="text-ink-faint hover:text-critical"
                      onClick={() => onChange(line.product, 0)}
                      aria-label="Remove line">
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Priority">
            <select className="field" value={priority}
                    onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Notes for the warehouse">
            <input className="field" value={notes} placeholder="Optional"
                   onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <span className="text-sm tnum">
            {lines.length} lines · <strong>{units(totalUnits)}</strong> units ·{" "}
            <strong>{money(totalValue)}</strong>
          </span>
          <button className="btn-ghost ml-auto px-4 py-2 text-sm" onClick={onClose}
                  disabled={busy}>
            Keep shopping
          </button>
          <button className="btn-primary px-4 py-2 text-sm" onClick={submit}
                  disabled={busy || !lines.length || !storeId}>
            {busy ? <Busy label="Submitting…" /> : "Submit order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
