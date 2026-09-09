import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, Trash2, X } from "lucide-react";
import clsx from "clsx";

/**
 * Dialog and form pieces shared by the Products, Inventory and admin screens.
 *
 * Deliberately built from the classes already in index.css (`panel`, `field`,
 * `btn-primary`, `btn-ghost`, the peach/wine palette) rather than a new design
 * system — the brief was to fix behaviour, not restyle the app.
 */

export function Modal({
  open, title, description, onClose, children, footer, wide,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Stop the page behind from scrolling while a dialog is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>(
      "input,select,textarea,button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <button
        className="fixed inset-0 bg-wine-deep/25 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          "panel animate-fade-rise relative my-auto w-full overflow-hidden shadow-lift",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold">{title}</h2>
            {description && (
              <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <button className="btn-quiet -mr-1 p-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas-tint/60 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Field({
  label, hint, error, required, children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-micro font-medium text-ink-muted">
        {label}
        {required && <span className="ml-1 text-critical">*</span>}
      </span>
      {children}
      {error
        ? <span className="mt-1 block text-micro text-critical">{error}</span>
        : hint && <span className="mt-1 block text-micro text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Busy({ label = "Working…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </span>
  );
}

export function ConfirmDialog({
  open, title, body, confirmLabel = "Confirm", danger, busy, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={clsx("btn-primary", danger && "!bg-critical hover:!bg-critical/90")}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Busy /> : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        {danger && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-critical" />}
        <p className="text-sm leading-relaxed text-ink-muted">{body}</p>
      </div>
    </Modal>
  );
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Product image picker: local preview before upload, plus explicit replace and
 * remove. Validation runs in the browser first so an oversized or wrong-typed
 * file is rejected instantly instead of after a round trip.
 */
export function ImagePicker({
  value, onSelect, onRemove, disabled,
}: {
  value: string | null;
  onSelect: (file: File | null) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [broken, setBroken] = useState(false);

  // Object URLs leak unless they're revoked when they change.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function choose(file: File | null) {
    setError("");
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Images must be JPEG, PNG, WebP, GIF or AVIF.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`);
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    setBroken(false);
    onSelect(file);
  }

  const shown = preview ?? (broken ? null : value);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-canvas-tint">
          {shown ? (
            <img
              src={shown}
              alt="Product"
              className="h-full w-full object-cover"
              onError={() => setBroken(true)}
            />
          ) : (
            <ImagePlus className="h-5 w-5 text-ink-faint" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-micro leading-relaxed text-ink-muted">
            JPEG, PNG, WebP, GIF or AVIF, up to 5 MB. Products without an image
            show a placeholder rather than a broken picture.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-micro"
              onClick={() => input.current?.click()}
              disabled={disabled}
            >
              {shown ? "Replace image" : "Choose image"}
            </button>
            {shown && (
              <button
                type="button"
                className="btn-quiet px-3 py-1.5 text-micro text-critical"
                onClick={() => {
                  if (preview) URL.revokeObjectURL(preview);
                  setPreview(null);
                  setBroken(false);
                  onSelect(null);
                  onRemove?.();
                  if (input.current) input.current.value = "";
                }}
                disabled={disabled}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={input}
        type="file"
        className="hidden"
        accept={IMAGE_TYPES.join(",")}
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />

      {error && <p className="text-micro text-critical">{error}</p>}
    </div>
  );
}

/** Inline success note, so a save confirms itself without a toast system. */
export function SuccessNote({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="animate-fade-rise rounded-xl border border-healthy/25 bg-healthy-soft px-4 py-3 text-sm text-healthy"
    >
      {message}
    </div>
  );
}
