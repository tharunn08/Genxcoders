import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Database, Download, Pencil, Plus, Search, SlidersHorizontal, Upload,
} from "lucide-react";
import {
  api, ApiError, Category, downloadExcel, InventoryRow, isCancelled, Paged,
  Product, StockStatus, Store,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  BasisTag, EmptyState, ErrorNote, money, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";
import { Busy, Field, Modal, SuccessNote } from "@/components/ui/forms";

/**
 * The inventory board.
 *
 * Two behavioural bugs and one missing feature:
 *
 * * Search and the status filter were applied by the backend *after*
 *   pagination, so they only ever matched within the 50 rows already fetched —
 *   searching for a SKU on page three returned nothing. The endpoint now
 *   filters before paging; this screen just passes the terms through.
 * * Every keystroke fired a request, and each request was expensive. Input is
 *   debounced, and superseded requests are cancelled so a slow early response
 *   can't overwrite a fast later one.
 * * There was no way to add or correct stock by hand — the only paths into the
 *   inventory table were a spreadsheet import or receiving a purchase order.
 */

const FILTERS: { value: StockStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "low", label: "Low" },
  { value: "healthy", label: "Healthy" },
  { value: "overstock", label: "Overstock" },
  { value: "out_of_stock", label: "Out of stock" },
];

const SORTS: { value: string; label: string }[] = [
  { value: "stock_desc", label: "Highest stock" },
  { value: "stock_asc", label: "Lowest stock" },
  { value: "value_desc", label: "Highest value" },
  { value: "value_asc", label: "Lowest value" },
];

/** Inventory value = current stock × MRP, matching the dashboard definition. */
const rowValue = (r: InventoryRow) => Number(r.current_stock ?? 0) * Number(r.mrp ?? 0);

export default function Inventory() {
  const { activeStore, can, user } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<StockStatus | "">("");
  const [sort, setSort] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showNoStock, setShowNoStock] = useState(false);
  const [noStock, setNoStock] = useState<Product[]>([]);
  const [noStockLoading, setNoStockLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InventoryRow | null>(null);
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const canManage = can("update_inventory");
  const canImport = can("import_data");

  async function exportExcel() {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "10000" });
      if (activeStore) params.set("store_id", activeStore.id);
      await downloadExcel(
        `/export/inventory?${params}`,
        `inventory-${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      setNotice("Inventory exported to Excel.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    api.get<{ items: Category[] }>("/categories")
      .then((r) => setCategories(r.items))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ limit: "100" });
    if (activeStore) params.set("store_id", activeStore.id);
    if (filter) params.set("status", filter);
    if (debounced) params.set("search", debounced);

    api.get<{ items: InventoryRow[]; truncated?: boolean }>(
      `/inventory?${params}`, { signal: controller.signal })
      .then((r) => { setRows(r.items); setTruncated(Boolean(r.truncated)); })
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [activeStore?.id, filter, debounced, reloadKey]);

  // Catalog products with no stock record anywhere: shown as "Inventory not
  // added" rather than a made-up status. Fetched only when the toggle is on.
  useEffect(() => {
    if (!showNoStock) { setNoStock([]); return; }
    const controller = new AbortController();
    setNoStockLoading(true);
    api.get<Paged<Product>>("/products?limit=100&sort=name", { signal: controller.signal })
      .then((r) => setNoStock(r.items.filter((p) => (p.inventory_records ?? 0) === 0)))
      .catch(() => setNoStock([]))
      .finally(() => { if (!controller.signal.aborted) setNoStockLoading(false); });
    return () => controller.abort();
  }, [showNoStock, reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const hasFilters = Boolean(debounced || filter || categoryFilter);

  // Sorting and category filtering are client-side: the board already holds up
  // to 100 computed rows, and the backend sorts by stock on its side.
  const visibleRows = [...rows]
    .filter((r) => !categoryFilter || r.category_id === categoryFilter)
    .sort((a, b) => {
      switch (sort) {
        case "stock_desc": return (b.current_stock ?? 0) - (a.current_stock ?? 0);
        case "stock_asc": return (a.current_stock ?? 0) - (b.current_stock ?? 0);
        case "value_desc": return rowValue(b) - rowValue(a);
        case "value_asc": return rowValue(a) - rowValue(b);
        default: return 0;
      }
    });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Inventory</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Stock position with demand, cover and reorder points computed from imported data.
          </p>
        </div>
        <div className="flex gap-2">
          {canImport && (
            <button className="btn-ghost"
                    onClick={() => navigate("/app/admin/imports?type=inventory")}>
              <Upload className="h-4 w-4" /> Import Excel
            </button>
          )}
          <button className="btn-ghost" onClick={exportExcel} disabled={exporting}>
            {exporting ? <Busy label="Exporting…" /> : <><Download className="h-4 w-4" /> Export to Excel</>}
          </button>
          {canManage && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add stock
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            className="field py-2 pl-9"
            placeholder="Search name or SKU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          className="field w-auto py-2"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select
          className="field w-auto py-2"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort inventory"
        >
          <option value="">Sort…</option>
          {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.value)}
              className={`rounded-lg border px-2.5 py-1.5 text-micro transition-colors ${
                filter === f.value ? "border-wine bg-peach-light text-wine"
                                   : "border-line text-ink-muted hover:bg-surface-hover"}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-micro text-ink-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-wine"
            checked={showNoStock}
            onChange={(e) => setShowNoStock(e.target.checked)}
          />
          Products without stock records
        </label>
      </div>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}
      {truncated && (
        <p className="text-micro text-ink-faint">
          Showing the first 600 stock records matched by this filter. Narrow the
          search or pick a store for a complete view.
        </p>
      )}

      {loading ? <Spinner /> : visibleRows.length === 0 && !showNoStock ? (
        <EmptyState
          icon={Database}
          title="Nothing to show"
          body={hasFilters
            ? "No products match these filters."
            : "No inventory data has been recorded yet. Add stock by hand, or import a stock file."}
          actionLabel={canManage && !hasFilters ? "Add stock" : undefined}
          onAction={() => setAdding(true)}
        />
      ) : (
        <>
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[74rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-micro text-ink-faint">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-3 py-3 font-medium">Store</th>
                  <th className="px-3 py-3 text-right font-medium">MRP</th>
                  <th className="px-3 py-3 text-right font-medium">Available</th>
                  <th className="px-3 py-3 text-right font-medium">Warehouse</th>
                  <th className="px-3 py-3 text-right font-medium">On order</th>
                  <th className="px-3 py-3 text-right font-medium">Value</th>
                  <th className="px-3 py-3 text-right font-medium">Daily demand</th>
                  <th className="px-3 py-3 text-right font-medium">Days left</th>
                  <th className="px-3 py-3 text-right font-medium">Reorder at</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  {canManage && <th className="px-4 py-3 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibleRows.map((row) => (
                  <tr key={`${row.product_id}-${row.store_id}`} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <button
                        className="flex items-center gap-3 text-left"
                        onClick={() => navigate(`/app/products/${row.product_id}`)}
                      >
                        <Thumb src={row.image_url} alt={row.name} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{row.name}</p>
                          <p className="text-micro text-ink-faint tnum">
                            {row.sku}{row.category_name ? ` · ${row.category_name}` : ""}
                          </p>
                        </div>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-micro text-ink-muted">
                      {row.store_name ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum">{money(row.mrp)}</td>
                    <td className="px-3 py-2.5 text-right tnum">{units(row.available_stock)}</td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(row.warehouse_stock)}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(row.stock_on_order)}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum font-medium">
                      {money(rowValue(row))}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="tnum">{units(row.avg_daily_demand)}</span>
                      <span className="ml-1.5"><BasisTag basis={row.demand_basis} /></span>
                    </td>
                    <td className="px-3 py-2.5 text-right tnum">
                      {row.days_of_stock == null ? "—" : row.days_of_stock.toFixed(1)}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(row.reorder_point)}
                    </td>
                    <td className="px-4 py-2.5"><StatusChip status={row.stock_status} /></td>
                    {canManage && (
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button
                            className="btn-quiet p-1.5"
                            aria-label={`Adjust stock for ${row.name}`}
                            title="Adjust stock"
                            onClick={() => setAdjusting(row)}
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="btn-quiet p-1.5"
                            aria-label={`Edit stock for ${row.name}`}
                            title="Edit stock record"
                            onClick={() => setEditing(row)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {showNoStock && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
                Products without a stock record
              </h2>
              {noStockLoading ? <Spinner /> : noStock.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-ink-muted">
                  Every product in this page of the catalog has stock recorded.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {noStock.map((product) => (
                    <li key={product.id}
                        className="flex items-center gap-3 px-5 py-3">
                      <Thumb src={product.image_url} alt={product.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{product.name}</p>
                        <p className="text-micro text-ink-faint tnum">
                          {product.sku} · {money(product.mrp)}
                        </p>
                      </div>
                      <span className="chip bg-canvas-tint text-ink-muted">
                        Inventory not added
                      </span>
                      {canManage && (
                        <button
                          className="btn-quiet px-2 py-1 text-micro"
                          onClick={() => setAdding(true)}
                        >
                          Add stock
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {adding && (
        <AddStockDialog
          stores={user?.stores ?? []}
          defaultStoreId={activeStore?.id ?? ""}
          onClose={() => setAdding(false)}
          onSaved={(m) => { setAdding(false); refresh(m); }}
        />
      )}

      {editing && (
        <EditStockDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); refresh(m); }}
        />
      )}

      {adjusting && (
        <AdjustStockDialog
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={(m) => { setAdjusting(null); refresh(m); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add

function AddStockDialog({
  stores, defaultStoreId, onClose, onSaved,
}: {
  stores: Store[];
  defaultStoreId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [allStores, setAllStores] = useState<Store[]>(stores);
  const [productQuery, setProductQuery] = useState("");
  const [matches, setMatches] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [form, setForm] = useState({
    current_stock: "", available_stock: "", warehouse_stock: "",
    stock_on_route: "", stock_on_order: "", note: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  // A store manager's session only carries their own stores; an admin's carries
  // none, so the full list has to be fetched.
  useEffect(() => {
    api.get<{ items: Store[] }>("/stores")
      .then((r) => {
        setAllStores(r.items);
        setStoreId((current) => current || (r.items.length === 1 ? r.items[0].id : ""));
      })
      .catch(() => { /* fall back to the stores already on the session */ });
  }, []);

  useEffect(() => {
    if (productQuery.trim().length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.get<{ items: Product[] }>(
        `/products?search=${encodeURIComponent(productQuery.trim())}&limit=8`,
        { signal: controller.signal })
        .then((r) => setMatches(r.items))
        .catch(() => { /* a failed lookup shouldn't clear what's on screen */ });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [productQuery]);

  const number = (v: string) => (v.trim() === "" ? 0 : Number(v));

  async function save() {
    if (!product) { setError(new Error("Choose a product first.")); return; }
    if (!storeId) { setError(new Error("Choose a store.")); return; }
    for (const [key, value] of Object.entries(form)) {
      if (key === "note") continue;
      if (value.trim() && (Number.isNaN(Number(value)) || Number(value) < 0)) {
        setError(new Error(`${key.replace(/_/g, " ")} must be a number of zero or more.`));
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      await api.post("/inventory", {
        product_id: product.id,
        store_id: storeId,
        current_stock: number(form.current_stock),
        available_stock: form.available_stock.trim() === ""
          ? null : number(form.available_stock),
        warehouse_stock: number(form.warehouse_stock),
        stock_on_route: number(form.stock_on_route),
        stock_on_order: number(form.stock_on_order),
        note: form.note || null,
      });
      onSaved(`Stock recorded for ${product.name}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Modal
      open
      wide
      title="Add stock"
      description="Records a stock level for one product in one store. Re-adding for the same pair updates the existing record."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !product}>
            {busy ? <Busy label="Saving…" /> : "Add stock"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <Field label="Product" required hint="Type at least two characters to search.">
          {product ? (
            <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <Thumb src={product.image_url} alt={product.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{product.name}</span>
                <span className="text-micro text-ink-faint tnum">{product.sku}</span>
              </span>
              <button
                className="btn-quiet px-2 py-1 text-micro"
                onClick={() => { setProduct(null); setProductQuery(""); }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className="field"
                placeholder="Search by name or SKU"
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
              />
              {matches.length > 0 && (
                <ul className="mt-1.5 max-h-52 overflow-y-auto rounded-lg border border-line">
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

        <Field label="Store" required>
          <select className="field" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Choose a store</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current stock" required>
            <input className="field tnum" inputMode="decimal"
                   value={form.current_stock}
                   onChange={(e) => set("current_stock", e.target.value)} />
          </Field>
          <Field label="Available stock" hint="Defaults to current stock if left blank.">
            <input className="field tnum" inputMode="decimal"
                   value={form.available_stock}
                   onChange={(e) => set("available_stock", e.target.value)} />
          </Field>
          <Field label="Warehouse stock">
            <input className="field tnum" inputMode="decimal"
                   value={form.warehouse_stock}
                   onChange={(e) => set("warehouse_stock", e.target.value)} />
          </Field>
          <Field label="In transit">
            <input className="field tnum" inputMode="decimal"
                   value={form.stock_on_route}
                   onChange={(e) => set("stock_on_route", e.target.value)} />
          </Field>
          <Field label="On order">
            <input className="field tnum" inputMode="decimal"
                   value={form.stock_on_order}
                   onChange={(e) => set("stock_on_order", e.target.value)} />
          </Field>
        </div>

        <Field label="Note" hint="Recorded against the stock movement.">
          <input className="field" value={form.note}
                 onChange={(e) => set("note", e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- edit

function EditStockDialog({
  row, onClose, onSaved,
}: { row: InventoryRow; onClose: () => void; onSaved: (m: string) => void }) {
  const [form, setForm] = useState({
    current_stock: String(row.current_stock ?? 0),
    available_stock: String(row.available_stock ?? 0),
    warehouse_stock: String(row.warehouse_stock ?? 0),
    stock_on_route: String(row.stock_on_route ?? 0),
    stock_on_order: String(row.stock_on_order ?? 0),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    if (!row.inventory_id) {
      setError(new Error("This stock record has no id — reload the page and try again."));
      return;
    }
    const body: Record<string, number> = {};
    for (const [key, value] of Object.entries(form)) {
      const n = Number(value);
      if (value.trim() === "" || Number.isNaN(n) || n < 0) {
        setError(new Error(`${key.replace(/_/g, " ")} must be a number of zero or more.`));
        return;
      }
      body[key] = n;
    }

    setBusy(true);
    setError(null);
    try {
      await api.patch(`/inventory/${row.inventory_id}`, body);
      onSaved(`Stock updated for ${row.name}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`Edit stock — ${row.name}`}
      description={`${row.sku}${row.store_name ? ` · ${row.store_name}` : ""}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : "Save changes"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current stock">
            <input className="field tnum" inputMode="decimal" value={form.current_stock}
                   onChange={(e) => set("current_stock", e.target.value)} />
          </Field>
          <Field label="Available stock">
            <input className="field tnum" inputMode="decimal" value={form.available_stock}
                   onChange={(e) => set("available_stock", e.target.value)} />
          </Field>
          <Field label="Warehouse stock">
            <input className="field tnum" inputMode="decimal" value={form.warehouse_stock}
                   onChange={(e) => set("warehouse_stock", e.target.value)} />
          </Field>
          <Field label="In transit">
            <input className="field tnum" inputMode="decimal" value={form.stock_on_route}
                   onChange={(e) => set("stock_on_route", e.target.value)} />
          </Field>
          <Field label="On order">
            <input className="field tnum" inputMode="decimal" value={form.stock_on_order}
                   onChange={(e) => set("stock_on_order", e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- adjust

const REASONS: [string, string][] = [
  ["manual", "Manual correction"],
  ["stock_count", "Stock count"],
  ["damage", "Damage or loss"],
  ["return", "Customer return"],
  ["theft", "Shrinkage"],
];

function AdjustStockDialog({
  row, onClose, onSaved,
}: { row: InventoryRow; onClose: () => void; onSaved: (m: string) => void }) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("manual");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const parsed = Number(delta);
  const valid = delta.trim() !== "" && !Number.isNaN(parsed) && parsed !== 0;
  const projected = row.current_stock + (valid ? parsed : 0);

  async function save() {
    if (!row.inventory_id) {
      setError(new Error("This stock record has no id — reload the page and try again."));
      return;
    }
    if (!valid) { setError(new Error("Enter a non-zero change.")); return; }
    if (projected < 0) {
      setError(new Error(
        `That would take stock to ${projected}. Current stock is ${row.current_stock}.`));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post(`/inventory/${row.inventory_id}/adjust`,
                     { delta: parsed, reason, note: note || null });
      onSaved(`${row.name} adjusted by ${parsed > 0 ? "+" : ""}${parsed}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`Adjust stock — ${row.name}`}
      description="Applies a relative change and records it in the movement history."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? <Busy label="Applying…" /> : "Apply adjustment"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <div className="rounded-xl bg-canvas-tint px-4 py-3 text-sm">
          <span className="text-ink-muted">Current stock</span>
          <span className="ml-2 font-display font-semibold tnum">
            {units(row.current_stock)}
          </span>
          {valid && (
            <>
              <span className="mx-2 text-ink-faint">→</span>
              <span className={`font-display font-semibold tnum ${
                projected < 0 ? "text-critical" : "text-healthy"}`}>
                {units(projected)}
              </span>
            </>
          )}
        </div>

        <Field
          label="Change"
          required
          hint="Use a negative number to reduce stock, e.g. -3 for damage."
        >
          <input
            className="field tnum" inputMode="decimal" placeholder="e.g. 12 or -3"
            value={delta} onChange={(e) => setDelta(e.target.value)}
          />
        </Field>

        <Field label="Reason">
          <select className="field" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>

        <Field label="Note">
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
