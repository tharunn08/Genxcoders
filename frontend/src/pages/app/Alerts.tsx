import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BellOff, Check, RefreshCw, TriangleAlert, X } from "lucide-react";
import clsx from "clsx";
import { api, ApiError, isCancelled } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, PriorityChip, Spinner, Thumb,
} from "@/components/ui/primitives";
import { Busy, SuccessNote } from "@/components/ui/forms";

/** Alerts feed. The API existed; this route rendered a placeholder. */

interface Alert {
  id: string;
  type: string;
  priority: string;
  title: string;
  message: string;
  recommended_action: string | null;
  state: string;
  created_at: string;
  products?: { id: string; sku: string; name: string; image_url: string | null } | null;
  stores?: { code: string; name: string } | null;
}

const STATES = [
  { value: "open", label: "Open" },
  { value: "read", label: "Read" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

export default function Alerts() {
  const { activeStore, can } = useAuth();
  const navigate = useNavigate();

  const [items, setItems] = useState<Alert[]>([]);
  const [state, setState] = useState("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ state, limit: "100" });
    if (activeStore) params.set("store_id", activeStore.id);

    api.get<{ items: Alert[] }>(`/alerts?${params}`, { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [state, activeStore?.id, reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function setAlertState(alert: Alert, next: string) {
    // Optimistic: the row disappears immediately when it leaves the filter.
    setItems((prev) => prev.filter((a) => a.id !== alert.id || state === "all"));
    try {
      await api.post(`/alerts/${alert.id}/state`, { state: next });
      refresh();
    } catch (e) {
      setError(e as Error);
      refresh();
    }
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.post<{ created: number }>(
        `/alerts/generate${activeStore ? `?store_id=${activeStore.id}` : ""}`);
      refresh(result.created
        ? `${result.created} new alert${result.created === 1 ? "" : "s"} raised.`
        : "No new alerts — nothing has crossed a threshold.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Alerts</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Raised when stock crosses a threshold in system settings.
          </p>
        </div>
        {can("update_inventory") && (
          <button className="btn-ghost" onClick={generate} disabled={generating}>
            {generating
              ? <Busy label="Recalculating…" />
              : <><RefreshCw className="h-4 w-4" /> Recalculate alerts</>}
          </button>
        )}
      </header>

      <div className="flex flex-wrap gap-1.5">
        {STATES.map((s) => (
          <button
            key={s.value}
            onClick={() => setState(s.value)}
            className={`rounded-lg border px-2.5 py-1.5 text-micro transition-colors ${
              state === s.value ? "border-wine bg-peach-light text-wine"
                                : "border-line text-ink-muted hover:bg-surface-hover"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="Nothing to review"
          body={state === "open"
            ? "No open alerts. Recalculate to check current stock against your thresholds."
            : `No ${state} alerts.`}
        />
      ) : (
        <ul className="space-y-2">
          {items.map((alert) => (
            <li key={alert.id} className="panel flex items-start gap-3 p-4">
              <div className="mt-0.5 shrink-0">
                {alert.products?.image_url
                  ? <Thumb src={alert.products.image_url} alt={alert.title} size="sm" />
                  : <TriangleAlert className="h-4 w-4 text-low" />}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{alert.title}</span>
                  <PriorityChip value={alert.priority} />
                  {alert.stores?.name && (
                    <span className="text-micro text-ink-faint">{alert.stores.name}</span>
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{alert.message}</p>
                {alert.recommended_action && (
                  <p className="mt-1 text-micro text-wine">{alert.recommended_action}</p>
                )}
                <p className="mt-1.5 text-micro text-ink-faint">
                  {new Date(alert.created_at).toLocaleString("en-IN")}
                </p>
              </div>

              <div className="flex shrink-0 flex-col gap-1">
                {alert.products?.id && (
                  <button
                    className="btn-quiet px-2 py-1 text-micro"
                    onClick={() => navigate(`/app/products/${alert.products!.id}`)}
                  >
                    View
                  </button>
                )}
                {alert.state !== "resolved" && (
                  <button
                    className="btn-quiet px-2 py-1 text-micro text-healthy"
                    onClick={() => setAlertState(alert, "resolved")}
                  >
                    <Check className="h-3.5 w-3.5" /> Resolve
                  </button>
                )}
                {alert.state === "open" && (
                  <button
                    className="btn-quiet px-2 py-1 text-micro"
                    onClick={() => setAlertState(alert, "dismissed")}
                  >
                    <X className="h-3.5 w-3.5" /> Dismiss
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
