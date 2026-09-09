import { AlertTriangle, ImageOff, Inbox, Loader2 } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { ApiError, StockStatus } from "@/lib/api";

// ---------------------------------------------------------------- formatting

export const money = (value?: number | null) =>
  value == null ? "—" : `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export const units = (value?: number | null) =>
  value == null ? "—" : Number(value).toLocaleString("en-IN", { maximumFractionDigits: 1 });

export const compact = (value?: number | null) =>
  value == null ? "—" : Intl.NumberFormat("en-IN", {
    notation: "compact", maximumFractionDigits: 1,
  }).format(value);

// ---------------------------------------------------------------- status

const STATUS_STYLE: Record<StockStatus, { label: string; className: string }> = {
  out_of_stock: { label: "Out of stock", className: "bg-critical-soft text-critical" },
  critical: { label: "Critical", className: "bg-critical-soft text-critical" },
  low: { label: "Low stock", className: "bg-low-soft text-low" },
  healthy: { label: "Healthy", className: "bg-healthy-soft text-healthy" },
  overstock: { label: "Overstock", className: "bg-overstock-soft text-overstock" },
};

export function StatusChip({ status }: { status: StockStatus }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.healthy;
  return (
    <span className={clsx("chip", style.className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {style.label}
    </span>
  );
}

const PRIORITY_STYLE: Record<string, string> = {
  critical: "bg-critical-soft text-critical",
  high: "bg-low-soft text-low",
  medium: "bg-peach-light text-wine",
  low: "bg-canvas-tint text-ink-muted",
};

export function PriorityChip({ value }: { value: string }) {
  return (
    <span className={clsx("chip capitalize", PRIORITY_STYLE[value] ?? PRIORITY_STYLE.low)}>
      {value}
    </span>
  );
}

/** Marks numbers the engine estimated rather than measured. */
export function BasisTag({ basis }: { basis: string }) {
  if (basis === "sku_history") return null;
  const text = basis === "no_data" ? "No sales history" : "Estimated";
  return (
    <span
      className="chip bg-canvas-tint text-ink-faint"
      title={
        basis === "no_data"
          ? "No sales data has been imported for this product."
          : "Derived from store-level sales patterns, not observed SKU sales."
      }
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- states

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-20 text-ink-muted">
      <Loader2 className="h-4 w-4 animate-spin text-wine" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({
  title, body, actionLabel, onAction, icon: Icon = Inbox,
}: {
  title: string; body: string; actionLabel?: string;
  onAction?: () => void; icon?: typeof Inbox;
}) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
      <div className="rounded-2xl bg-peach-light p-3.5">
        <Icon className="h-5 w-5 text-wine" />
      </div>
      <h3 className="font-display text-lg font-medium">{title}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-ink-muted">{body}</p>
      {actionLabel && onAction && (
        <button className="btn-primary mt-2" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

/**
 * Shows what actually failed.
 *
 * In development it also surfaces the underlying cause and a remediation hint,
 * because "something went wrong" costs more time than it saves.
 */
export function ErrorNote({
  error, message,
}: { error?: Error | ApiError | null; message?: string }) {
  const headline = message ?? error?.message ?? "Something went wrong.";
  const api = error instanceof ApiError ? error : null;
  const showDetail = Boolean(import.meta.env.DEV && (api?.detail || api?.hint));

  return (
    <div
      role="alert"
      className="animate-fade-rise rounded-xl border border-critical/25 bg-critical-soft px-4 py-3"
    >
      <div className="flex items-start gap-2.5 text-sm text-critical">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{headline}</p>
          {api?.hint && (
            <p className="mt-1 text-micro leading-relaxed text-critical/80">{api.hint}</p>
          )}
          {showDetail && api?.detail && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-micro text-critical/70">
                Technical detail
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-white/60 p-2 text-micro text-ink-muted">
                {api.detail}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- product image

export function Thumb({
  src, alt, size = "md",
}: { src?: string | null; alt: string; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const box = { sm: "h-9 w-9", md: "h-12 w-12", lg: "h-full w-full aspect-square" }[size];

  if (!src || failed) {
    return (
      <div className={clsx(box, "grid shrink-0 place-items-center rounded-xl bg-canvas-tint")}>
        <ImageOff className="h-4 w-4 text-ink-faint" />
      </div>
    );
  }
  return (
    <img
      src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}
      className={clsx(box, "shrink-0 rounded-xl border border-line bg-canvas-tint object-cover")}
    />
  );
}
