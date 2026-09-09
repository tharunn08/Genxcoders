import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Truck } from "lucide-react";
import { api, ApiError, isCancelled } from "@/lib/api";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, ConfirmDialog, Field, Modal, SuccessNote } from "@/components/ui/forms";

interface Supplier {
  id: string;
  name: string;
  code: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  avg_lead_time_days: number;
  status: string;
}

export default function Suppliers() {
  const [items, setItems] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Supplier | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Supplier[] }>("/suppliers", { signal: controller.signal })
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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Suppliers</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Lead times here drive reorder points and stockout risk.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add supplier
        </button>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No suppliers yet"
          body="Add a supplier so lead times can feed the replenishment maths."
          actionLabel="Add supplier"
          onAction={() => setAdding(true)}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">Supplier</th>
                <th className="px-3 py-3 font-medium">Contact</th>
                <th className="px-3 py-3 text-right font-medium">Lead time</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{supplier.name}</p>
                    {supplier.code && (
                      <p className="text-micro text-ink-faint tnum">{supplier.code}</p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-muted">
                    {supplier.contact_email ?? "—"}
                    {supplier.contact_phone ? ` · ${supplier.contact_phone}` : ""}
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">
                    {supplier.avg_lead_time_days} days
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <button className="btn-quiet px-2 py-1 text-micro"
                              onClick={() => setEditing(supplier)}>
                        Edit
                      </button>
                      <button
                        className="btn-quiet px-2 py-1 text-micro text-critical"
                        disabled={supplier.status === "inactive"}
                        onClick={() => setDeleting(supplier)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(adding || editing) && (
        <SupplierDialog
          supplier={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={(m) => { setAdding(false); setEditing(null); refresh(m); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Deactivate ${deleting?.name ?? "supplier"}?`}
        body={"The supplier's lead times and order history are kept. It will be hidden "
          + "from new work until an admin reactivates it."}
        confirmLabel="Deactivate supplier"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.del(`/suppliers/${deleting.id}`);
            setDeleting(null);
            refresh(`${deleting.name} deactivated.`);
          } catch (e) {
            setError(e as Error);
            setDeleting(null);
          }
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function SupplierDialog({
  supplier, onClose, onSaved,
}: { supplier: Supplier | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    code: supplier?.code ?? "",
    contact_email: supplier?.contact_email ?? "",
    contact_phone: supplier?.contact_phone ?? "",
    avg_lead_time_days: String(supplier?.avg_lead_time_days ?? 7),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const set = (k: keyof typeof form, v: string) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  async function save() {
    if (!form.name.trim()) { setError(new Error("A supplier name is required.")); return; }
    const lead = Number(form.avg_lead_time_days);
    if (Number.isNaN(lead) || lead < 0) {
      setError(new Error("Lead time must be a number of days."));
      return;
    }

    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      contact_email: form.contact_email.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      avg_lead_time_days: lead,
    };
    try {
      if (supplier) await api.patch(`/suppliers/${supplier.id}`, body);
      else await api.post("/suppliers", body);
      onSaved(`${body.name} saved.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={supplier ? `Edit ${supplier.name}` : "Add supplier"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}
        <Field label="Name" required>
          <input className="field" value={form.name}
                 onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier code">
            <input className="field" value={form.code}
                   onChange={(e) => set("code", e.target.value)} />
          </Field>
          <Field label="Average lead time (days)" required>
            <input className="field tnum" inputMode="decimal"
                   value={form.avg_lead_time_days}
                   onChange={(e) => set("avg_lead_time_days", e.target.value)} />
          </Field>
          <Field label="Contact email">
            <input className="field" type="email" value={form.contact_email}
                   onChange={(e) => set("contact_email", e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <input className="field" value={form.contact_phone}
                   onChange={(e) => set("contact_phone", e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
