import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Boxes, History, Store as StoreIcon } from "lucide-react";
import { api, ApiError, InventoryRow, Product } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, money, Spinner, StatusChip, Thumb, units,
} from "@/components/ui/primitives";

/**
 * Product detail.
 *
 * Every product row on the Dashboard and the Inventory board navigated to
 * `/app/products/:id`, which rendered a placeholder. This is that page: the
 * product, its stock in each store, and the recent movements behind those
 * numbers.
 */

interface Detail {
  product: Product & {
    product_images?: { id: string; url: string; is_primary: boolean }[];
    product_suppliers?: {
      lead_time_days: number | null;
      suppliers: { id: string; name: string; avg_lead_time_days: number } | null;
    }[];
  };
  inventory: (InventoryRow & {
    id: string;
    stores: { id: string; code: string; name: string } | null;
  })[];
  recent_activity: {
    id: string; delta: number; reason: string; note: string | null;
    created_at: string; stores?: { code: string; name: string } | null;
  }[];
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();

  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api.get<Detail>(`/products/${id}`, { signal: controller.signal })
      .then(setData)
      .catch((e) => { if (e?.status !== -1) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [id]);

  if (loading) return <Spinner label="Loading product…" />;

  if (error) {
    return (
      <div className="space-y-4">
        <button className="btn-ghost" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <ErrorNote error={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        title="Product not found"
        body="That product may have been deleted."
        actionLabel="Back to products"
        onAction={() => navigate("/app/products")}
      />
    );
  }

  const { product, inventory, recent_activity: activity } = data;
  const totalStock = inventory.reduce(
    (sum, row) => sum + Number(row.available_stock ?? 0), 0);
  const supplier = product.product_suppliers?.[0]?.suppliers;

  return (
    <div className="space-y-5">
      <button className="btn-ghost" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <section className="panel flex flex-col gap-5 p-5 sm:flex-row">
        <div className="w-full shrink-0 sm:w-40">
          <Thumb src={product.image_url} alt={product.name} size="lg" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h1 className="font-display text-2xl font-semibold">{product.name}</h1>
            <p className="mt-1 text-sm text-ink-muted tnum">
              {product.sku}
              {product.barcode ? ` · ${product.barcode}` : ""}
              {product.categories?.name ? ` · ${product.categories.name}` : ""}
            </p>
          </div>

          {product.description && (
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
              {product.description}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="MRP" value={money(product.mrp)} />
            <Metric label="Cost" value={money(product.cost_price)} />
            <Metric label="Total available" value={units(totalStock)} />
            <Metric
              label="Lead time"
              value={
                supplier
                  ? `${product.product_suppliers?.[0]?.lead_time_days
                      ?? supplier.avg_lead_time_days} days`
                  : "—"
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Low stock threshold" value={
              product.low_stock_threshold == null ? "Auto" : units(product.low_stock_threshold)} />
            <Metric label="Reorder point" value={
              product.reorder_point == null ? "Auto" : units(product.reorder_point)} />
            <Metric label="Safety stock" value={
              product.safety_stock == null ? "Auto" : units(product.safety_stock)} />
            <Metric label="Target stock" value={
              product.target_stock == null ? "Not set" : units(product.target_stock)} />
          </div>

          {can("manage_products") && (
            <button className="btn-ghost" onClick={() => navigate("/app/products")}>
              Manage in Products
            </button>
          )}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <h2 className="flex items-center gap-2 border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
          <StoreIcon className="h-4 w-4 text-ink-muted" /> Stock by store
        </h2>
        {inventory.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-muted">
            No stock has been recorded for this product yet. Add it from the
            Inventory screen, or import a stock file.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-micro text-ink-faint">
                  <th className="px-5 py-2.5 font-medium">Store</th>
                  <th className="px-3 py-2.5 text-right font-medium">Current</th>
                  <th className="px-3 py-2.5 text-right font-medium">Available</th>
                  <th className="px-3 py-2.5 text-right font-medium">Warehouse</th>
                  <th className="px-3 py-2.5 text-right font-medium">On order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inventory.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-2.5">
                      {row.stores?.name ?? "—"}
                      <span className="ml-2 text-micro text-ink-faint">
                        {row.stores?.code}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tnum">{units(row.current_stock)}</td>
                    <td className="px-3 py-2.5 text-right tnum">{units(row.available_stock)}</td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(row.warehouse_stock)}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-muted">
                      {units(row.stock_on_order)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel overflow-hidden">
        <h2 className="flex items-center gap-2 border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
          <History className="h-4 w-4 text-ink-muted" /> Recent stock movements
        </h2>
        {activity.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-muted">
            No movements recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {activity.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <Boxes className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block capitalize">{row.reason.replace(/_/g, " ")}</span>
                  <span className="text-micro text-ink-faint">
                    {row.stores?.name ? `${row.stores.name} · ` : ""}
                    {new Date(row.created_at).toLocaleString("en-IN")}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </span>
                <span className={`shrink-0 tnum ${
                  row.delta >= 0 ? "text-healthy" : "text-critical"}`}>
                  {row.delta >= 0 ? "+" : ""}{units(row.delta)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-canvas-tint px-3 py-2.5">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className="mt-0.5 font-display text-base font-semibold tnum">{value}</p>
    </div>
  );
}
