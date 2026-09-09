import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Package, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import clsx from "clsx";
import {
  api, ApiError, Category, downloadExcel, isCancelled, Paged, Product,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, Thumb, units,
} from "@/components/ui/primitives";
import {
  Busy, ConfirmDialog, Field, ImagePicker, Modal, SuccessNote,
} from "@/components/ui/forms";

/**
 * The Products screen.
 *
 * This route rendered a "screen is next up in the build" placeholder, while the
 * Dashboard and Inventory tables both linked into it — so every product row in
 * the app was a dead end. The API behind it already existed; this is the
 * missing half.
 */

const PAGE_SIZE = 24;

interface Draft {
  id?: string;
  sku: string;
  name: string;
  barcode: string;
  category_id: string;
  mrp: string;
  cost_price: string;
  description: string;
  status: "active" | "inactive" | "archived";
  image_url: string | null;
  low_stock_threshold: string;
  reorder_point: string;
  safety_stock: string;
  target_stock: string;
}

const EMPTY: Draft = {
  sku: "", name: "", barcode: "", category_id: "", mrp: "", cost_price: "",
  description: "", status: "active", image_url: null,
  low_stock_threshold: "", reorder_point: "", safety_stock: "", target_stock: "",
};

export default function Products() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [exporting, setExporting] = useState(false);

  const canManage = can("manage_products");
  const canImport = can("import_data");

  async function exportProducts() {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "10000" });
      if (debounced) params.set("search", debounced);
      if (categoryId) params.set("category_id", categoryId);
      await downloadExcel(`/export/products?${params}`, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
      setNotice("Product export downloaded.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setExporting(false);
    }
  }

  // One request per pause in typing, not one per keystroke. Each products query
  // is cheap, but the inventory board shares this pattern and each of those hits
  // the computation layer.
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
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE), offset: String(offset), sort: "name",
    });
    if (debounced) params.set("search", debounced);
    if (categoryId) params.set("category_id", categoryId);
    if (showArchived) params.set("include_archived", "true");

    api.get<Paged<Product>>(`/products?${params}`, { signal: controller.signal })
      .then((r) => { setItems(r.items); setTotal(r.total); })
      // An aborted request is the previous query being replaced, not a failure.
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [debounced, categoryId, showArchived, offset, reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function archive(product: Product, hard: boolean) {
    await api.del(`/products/${product.id}${hard ? "?hard=true" : ""}`);
    setDeleting(null);
    refresh(hard ? `${product.name} deleted.` : `${product.name} archived.`);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Products</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {total.toLocaleString("en-IN")} product{total === 1 ? "" : "s"} in the catalog.
          </p>
        </div>
        <div className="flex gap-2">
          {canImport && (
            <button className="btn-ghost"
                    onClick={() => navigate("/app/admin/imports?type=products")}>
              <Upload className="h-4 w-4" /> Import Excel
            </button>
          )}
          <button className="btn-ghost" onClick={exportProducts} disabled={exporting}>
            {exporting ? <Busy label="Exporting…" /> : <><Download className="h-4 w-4" /> Export to Excel</>}
          </button>
          {canManage && (
            <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              <Plus className="h-4 w-4" /> Add product
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            className="field py-2 pl-9"
            placeholder="Search name, SKU or barcode"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          className="field w-auto py-2"
          value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); setOffset(0); }}
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <label className="flex cursor-pointer items-center gap-2 text-micro text-ink-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-wine"
            checked={showArchived}
            onChange={(e) => { setShowArchived(e.target.checked); setOffset(0); }}
          />
          Show archived
        </label>
      </div>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? (
        <Spinner label="Loading products…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Package}
          title={debounced || categoryId ? "No matches" : "No products yet"}
          body={
            debounced || categoryId
              ? "Nothing in the catalog matches these filters."
              : "Add a product by hand, or import a product file to populate the catalog."
          }
          actionLabel={canManage && !debounced && !categoryId ? "Add product" : undefined}
          onAction={() => setEditing({ ...EMPTY })}
        />
      ) : (
        <>
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-micro text-ink-faint">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-3 py-3 font-medium">Category</th>
                  <th className="px-3 py-3 text-right font-medium">MRP</th>
                  <th className="px-3 py-3 text-right font-medium">Stock</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  {canManage && <th className="px-4 py-3 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((product) => (
                  <tr key={product.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <button
                        className="flex items-center gap-3 text-left"
                        onClick={() => navigate(`/app/products/${product.id}`)}
                      >
                        <Thumb src={product.image_url} alt={product.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{product.name}</span>
                          <span className="text-micro text-ink-faint tnum">{product.sku}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-ink-muted">
                      {product.categories?.name ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum">{money(product.mrp)}</td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(product.available_stock ?? 0)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={clsx(
                        "chip capitalize",
                        product.status === "active" ? "bg-healthy-soft text-healthy"
                          : product.status === "archived" ? "bg-critical-soft text-critical"
                          : "bg-canvas-tint text-ink-muted",
                      )}>
                        {product.status}
                      </span>
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button
                            className="btn-quiet p-1.5"
                            aria-label={`Edit ${product.name}`}
                            onClick={() => setEditing({
                              id: product.id,
                              sku: product.sku,
                              name: product.name,
                              barcode: product.barcode ?? "",
                              category_id: product.category_id ?? "",
                              mrp: product.mrp == null ? "" : String(product.mrp),
                              cost_price: product.cost_price == null ? "" : String(product.cost_price),
                              description: product.description ?? "",
                              status: product.status,
                              image_url: product.image_url,
                              low_stock_threshold: product.low_stock_threshold == null ? "" : String(product.low_stock_threshold),
                              reorder_point: product.reorder_point == null ? "" : String(product.reorder_point),
                              safety_stock: product.safety_stock == null ? "" : String(product.safety_stock),
                              target_stock: product.target_stock == null ? "" : String(product.target_stock),
                            })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="btn-quiet p-1.5 text-critical"
                            aria-label={`Archive ${product.name}`}
                            onClick={() => setDeleting(product)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between text-micro text-ink-muted">
              <span className="tnum">Page {page} of {pages}</span>
              <div className="flex gap-2">
                <button
                  className="btn-ghost px-3 py-1.5 text-micro"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  className="btn-ghost px-3 py-1.5 text-micro"
                  disabled={page >= pages}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {editing && (
        <ProductDialog
          draft={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); refresh(message); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Archive ${deleting?.name ?? "product"}?`}
        body={
          "Archiving hides the product from the catalog but keeps its stock, sales " +
          "and order history intact. You can bring it back with 'Show archived'."
        }
        confirmLabel="Archive"
        onConfirm={() => deleting && archive(deleting, false)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- dialog

function ProductDialog({
  draft, categories, onClose, onSaved,
}: {
  draft: Draft;
  categories: Category[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<Draft>(draft);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [clearImage, setClearImage] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const isNew = !form.id;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!form.sku.trim()) errors.sku = "A SKU or product code is required.";
    if (!form.name.trim()) errors.name = "A product name is required.";
    for (const key of ["mrp", "cost_price"] as const) {
      const raw = form[key].trim();
      if (raw && (Number.isNaN(Number(raw)) || Number(raw) < 0)) {
        errors[key] = "Enter a number of zero or more.";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setBusy(true);
    setError(null);

    const body: Record<string, unknown> = {
      sku: form.sku.trim().toUpperCase(),
      name: form.name.trim(),
      barcode: form.barcode.trim() || null,
      category_id: form.category_id || null,
      mrp: form.mrp.trim() === "" ? null : Number(form.mrp),
      cost_price: form.cost_price.trim() === "" ? null : Number(form.cost_price),
      description: form.description.trim() || null,
      status: form.status,
      // Quantity settings: empty = null = derive from global settings.
      low_stock_threshold: form.low_stock_threshold.trim() === "" ? null : Number(form.low_stock_threshold),
      reorder_point: form.reorder_point.trim() === "" ? null : Number(form.reorder_point),
      safety_stock: form.safety_stock.trim() === "" ? null : Number(form.safety_stock),
      target_stock: form.target_stock.trim() === "" ? null : Number(form.target_stock),
    };

    try {
      let productId = form.id;

      if (isNew) {
        // The create endpoint rejects nulls it doesn't need; strip them.
        const clean = Object.fromEntries(
          Object.entries(body).filter(([, v]) => v !== null && v !== ""));
        const created = await api.post<Product>("/products", clean);
        productId = created.id;
      } else {
        await api.patch(`/products/${productId}`, body);
      }

      // The image is a separate multipart request, and it must not be able to
      // roll back a successful save — so it reports its own failure.
      if (productId && imageFile) {
        const formData = new FormData();
        formData.append("file", imageFile);
        try {
          await api.upload(`/products/${productId}/image`, formData);
        } catch (imageError) {
          if (!mounted.current) return;
          setBusy(false);
          setError(new ApiError(
            imageError instanceof ApiError ? imageError.status : 0,
            `The product saved, but the image didn't upload: ${
              imageError instanceof Error ? imageError.message : imageError}`,
          ));
          return;
        }
      } else if (productId && clearImage && !imageFile) {
        try {
          await api.del(`/products/${productId}/image`);
        } catch { /* the product is saved; a stale thumbnail is not worth failing on */ }
      }

      onSaved(isNew ? `${body.name} added.` : `${body.name} updated.`);
    } catch (e) {
      if (mounted.current) setError(e as Error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    try {
      const created = await api.post<Category>("/categories", { name });
      set("category_id", created.id);
      setNewCategory("");
      categories.push(created);
    } catch (e) {
      setError(e as Error);
    }
  }

  return (
    <Modal
      open
      wide
      title={isNew ? "Add product" : `Edit ${draft.name}`}
      description={
        isNew
          ? "Manual entry works whether or not you ever run an import."
          : undefined
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : isNew ? "Add product" : "Save changes"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SKU / Product code" required error={fieldErrors.sku}>
            <input
              className="field"
              value={form.sku}
              onChange={(e) => set("sku", e.target.value)}
              placeholder="SKU-001"
            />
          </Field>

          <Field label="Barcode / EAN" hint="Optional, used to match imported rows.">
            <input
              className="field"
              value={form.barcode}
              onChange={(e) => set("barcode", e.target.value)}
            />
          </Field>
        </div>

        <Field label="Product name" required error={fieldErrors.name}>
          <input
            className="field"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Cotton kurta, indigo"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="MRP" hint="Retail price, in rupees." error={fieldErrors.mrp}>
            <input
              className="field tnum" inputMode="decimal"
              value={form.mrp}
              onChange={(e) => set("mrp", e.target.value)}
            />
          </Field>

          <Field label="Cost price" error={fieldErrors.cost_price}>
            <input
              className="field tnum" inputMode="decimal"
              value={form.cost_price}
              onChange={(e) => set("cost_price", e.target.value)}
            />
          </Field>
        </div>

        <Field label="Category">
          <select
            className="field"
            value={form.category_id}
            onChange={(e) => set("category_id", e.target.value)}
          >
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="…or create a new category">
              <input
                className="field"
                value={newCategory}
                placeholder="Accessories"
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void addCategory(); }
                }}
              />
            </Field>
          </div>
          <button
            type="button"
            className="btn-ghost mb-[1.35rem] px-3 py-2"
            onClick={addCategory}
            disabled={!newCategory.trim()}
          >
            Add
          </button>
        </div>

        <Field label="Description">
          <textarea
            className="field min-h-[4.5rem] resize-y"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>

        <Field label="Status">
          <select
            className="field"
            value={form.status}
            onChange={(e) => set("status", e.target.value as Draft["status"])}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </Field>

        <Field label="Product image">
          <ImagePicker
            value={form.image_url}
            disabled={busy}
            onSelect={(file) => { setImageFile(file); if (file) setClearImage(false); }}
            onRemove={() => { setClearImage(true); set("image_url", null); }}
          />
        </Field>

        <section className="rounded-xl border border-line bg-canvas-tint/50 p-4">
          <h3 className="font-display text-sm font-semibold">Quantity settings</h3>
          <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">
            These connect to the inventory engine. When stock falls to the low
            stock threshold, the product is flagged low; when it reaches the
            reorder point, replenishment is recommended — and the dashboard,
            alerts and AI insights update automatically. Leave blank to use the
            system-wide settings.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Low stock threshold" hint="Flag low at this quantity (blank = system setting).">
              <input
                className="field tnum" inputMode="decimal"
                value={form.low_stock_threshold}
                onChange={(e) => set("low_stock_threshold", e.target.value)}
              />
            </Field>
            <Field label="Reorder point" hint="Trigger replenishment at this quantity.">
              <input
                className="field tnum" inputMode="decimal"
                value={form.reorder_point}
                onChange={(e) => set("reorder_point", e.target.value)}
              />
            </Field>
            <Field label="Safety stock" hint="Extra units held above expected demand.">
              <input
                className="field tnum" inputMode="decimal"
                value={form.safety_stock}
                onChange={(e) => set("safety_stock", e.target.value)}
              />
            </Field>
            <Field label="Target / maximum stock" hint="Optional ceiling for this product.">
              <input
                className="field tnum" inputMode="decimal"
                value={form.target_stock}
                onChange={(e) => set("target_stock", e.target.value)}
              />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  );
}
