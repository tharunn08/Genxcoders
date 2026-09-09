import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Store as StoreIcon, Trash2 } from "lucide-react";
import { api, ApiError, isCancelled, Store } from "@/lib/api";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, ConfirmDialog, Field, Modal, SuccessNote } from "@/components/ui/forms";

export default function Stores() {
  const [items, setItems] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Store | null>(null);
  const [deleting, setDeleting] = useState<Store | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Store[] }>("/stores", { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const refresh = useCallback((m?: string) => {
    if (m) setNotice(m);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.del(`/stores/${deleting.id}`);
      setDeleting(null);
      refresh(`${deleting.name} deactivated.`);
    } catch (e) {
      setError(e as Error);
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Stores</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Stock, sales and orders are all scoped to a store. Deactivating a
            store keeps its history but removes it from new work.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add store
        </button>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title="No stores yet"
          body="Add your first store, or let an inventory import create one for you."
          actionLabel="Add store"
          onAction={() => setAdding(true)}
        />
      ) : (
        <div className="panel overflow-hidden">
          <ul className="divide-y divide-line">
            {items.map((store) => (
              <li key={store.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-peach-light">
                  <StoreIcon className="h-4 w-4 text-wine" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {store.name}
                    {store.status === "inactive" && (
                      <span className="ml-2 chip bg-canvas-tint text-ink-muted">Inactive</span>
                    )}
                  </span>
                  <span className="text-micro text-ink-faint tnum">
                    {store.code}{store.location ? ` · ${store.location}` : ""}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    className="btn-quiet p-1.5"
                    aria-label={`Edit ${store.name}`}
                    onClick={() => setEditing(store)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="btn-quiet p-1.5 text-critical"
                    aria-label={`Deactivate ${store.name}`}
                    disabled={store.status === "inactive"}
                    onClick={() => setDeleting(store)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <StoreDialog
          onClose={() => setAdding(false)}
          onSaved={(m) => { setAdding(false); refresh(m); }}
        />
      )}

      {editing && (
        <StoreDialog
          store={editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); refresh(m); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Deactivate ${deleting?.name ?? "store"}?`}
        body={"The store's stock, sales and order history is kept. It will be hidden "
          + "from new work until an admin reactivates it."}
        confirmLabel="Deactivate store"
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function StoreDialog({
  store, onClose, onSaved,
}: { store?: Store | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [code, setCode] = useState(store?.code ?? "");
  const [name, setName] = useState(store?.name ?? "");
  const [location, setLocation] = useState(store?.location ?? "");
  const [notificationEmail, setNotificationEmail] = useState(store?.notification_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const isEdit = Boolean(store);

  async function save() {
    if (!code.trim() || !name.trim()) {
      setError(new Error("A code and a name are both required."));
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      code: code.trim().toUpperCase(),
      name: name.trim(),
      location: location.trim() || null,
      notification_email: notificationEmail.trim() || null,
    };
    try {
      if (store) await api.patch(`/stores/${store.id}`, body);
      else await api.post("/stores", body);
      onSaved(`${body.name} ${store ? "updated" : "added"}.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={isEdit ? `Edit ${store?.name}` : "Add store"}
      description={isEdit
        ? "The notification email receives order notifications for this store."
        : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : isEdit ? "Save changes" : "Add store"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}
        <Field label="Store code" required hint="Short and unique, e.g. BLR-01.">
          <input className="field" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Store name" required>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Location">
          <input className="field" value={location}
                 onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Notification email" hint="Where order notifications for this store are emailed.">
          <input className="field" type="email" value={notificationEmail}
                 onChange={(e) => setNotificationEmail(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}