import { useCallback, useEffect, useState } from "react";
import { Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { api, ApiError, Announcement, isCancelled } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import {
  EmptyState, ErrorNote, PriorityChip, Spinner,
} from "@/components/ui/primitives";
import { Busy, ConfirmDialog, Field, Modal, SuccessNote } from "@/components/ui/forms";

const ROLES = ["super_admin", "admin", "inventory_manager", "store_manager"];

export default function Announcements() {
  const { user } = useAuth();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Announcement | null>(null);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Announcement[] }>("/site/announcements", { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function togglePublish(announcement: Announcement) {
    setBusyId(announcement.id);
    setError(null);
    try {
      await api.patch(`/site/announcements/${announcement.id}`, {
        is_published: !announcement.is_published,
      });
      refresh(announcement.is_published ? "Announcement unpublished." : "Announcement published.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyId("");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusyId(deleting.id);
    setError(null);
    try {
      await api.del(`/site/announcements/${deleting.id}`);
      setDeleting(null);
      refresh("Announcement deleted.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyId("");
    }
  }

  const now = new Date().toISOString();
  const live = (a: Announcement) =>
    a.is_published && (!a.start_at || a.start_at <= now) && (!a.end_at || a.end_at >= now);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <Megaphone className="h-5 w-5 text-wine" /> Announcements
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Notices shown on the dashboard and to targeted roles. Published, in-window
            announcements are live for users after refresh.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New announcement
        </button>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No announcements yet"
          body="Create the first announcement — it will appear on the dashboard for the targeted roles."
          actionLabel="New announcement"
          onAction={() => setCreating(true)}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">Announcement</th>
                <th className="px-3 py-3 font-medium">Audience</th>
                <th className="px-3 py-3 font-medium">Window</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((a) => (
                <tr key={a.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.title}</span>
                      <PriorityChip value={a.priority} />
                    </div>
                    <p className="mt-0.5 max-w-[28rem] truncate text-micro text-ink-muted">
                      {a.message}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-muted">
                    {a.target_roles?.length
                      ? a.target_roles.map((r) => r.replace(/_/g, " ")).join(", ")
                      : "Everyone"}
                  </td>
                  <td className="px-3 py-2.5 text-micro text-ink-faint tnum">
                    {a.start_at ? new Date(a.start_at).toLocaleDateString("en-IN") : "—"}
                    {" → "}
                    {a.end_at ? new Date(a.end_at).toLocaleDateString("en-IN") : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`chip ${live(a)
                      ? "bg-healthy-soft text-healthy"
                      : a.is_published ? "bg-low-soft text-low" : "bg-canvas-tint text-ink-muted"}`}>
                      {live(a) ? "Live" : a.is_published ? "Scheduled" : "Draft"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button className="btn-quiet px-2 py-1 text-micro"
                              onClick={() => setEditing(a)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button className="btn-quiet px-2 py-1 text-micro"
                              disabled={busyId === a.id}
                              onClick={() => togglePublish(a)}>
                        {busyId === a.id ? <Busy /> : a.is_published ? "Unpublish" : "Publish"}
                      </button>
                      <button className="btn-quiet px-2 py-1 text-micro text-critical"
                              onClick={() => setDeleting(a)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <AnnouncementDialog
          announcement={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={(m) => { setCreating(false); setEditing(null); refresh(m); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Delete "${deleting?.title}"?`}
        body="The announcement will be removed for everyone. This cannot be undone."
        confirmLabel="Delete"
        busy={busyId === deleting?.id}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function AnnouncementDialog({
  announcement, onClose, onSaved,
}: {
  announcement: Announcement | null;
  onClose: () => void; onSaved: (m: string) => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState(announcement?.title ?? "");
  const [message, setMessage] = useState(announcement?.message ?? "");
  const [imageUrl, setImageUrl] = useState(announcement?.image_url ?? "");
  const [priority, setPriority] = useState(announcement?.priority ?? "medium");
  const [everyone, setEveryone] = useState(!announcement?.target_roles?.length);
  const [roles, setRoles] = useState<string[]>(
    announcement?.target_roles ?? (user?.role ? [user.role] : []));
  const [startAt, setStartAt] = useState(announcement?.start_at?.slice(0, 16) ?? "");
  const [endAt, setEndAt] = useState(announcement?.end_at?.slice(0, 16) ?? "");
  const [published, setPublished] = useState(announcement?.is_published ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  async function save() {
    if (!title.trim() || !message.trim()) {
      setError(new Error("Title and message are both required."));
      return;
    }
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      title: title.trim(),
      message: message.trim(),
      image_url: imageUrl.trim() || null,
      priority,
      target_roles: everyone ? [] : roles,
      start_at: startAt ? new Date(startAt).toISOString() : null,
      end_at: endAt ? new Date(endAt).toISOString() : null,
      is_published: published,
    };
    try {
      if (announcement) {
        await api.patch(`/site/announcements/${announcement.id}`, body);
        onSaved("Announcement updated.");
      } else {
        await api.post("/site/announcements", body);
        onSaved("Announcement created.");
      }
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
      title={announcement ? "Edit announcement" : "New announcement"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : "Save announcement"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <Field label="Title" required>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Message" required>
          <textarea className="field min-h-[4.5rem] resize-y" value={message}
                    onChange={(e) => setMessage(e.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Image URL" hint="Optional — paste a media library URL.">
            <input className="field" value={imageUrl}
                   onChange={(e) => setImageUrl(e.target.value)} />
          </Field>
          <Field label="Priority">
            <select className="field" value={priority}
                    onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
        </div>

        <Field label="Audience">
          <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-wine" checked={everyone}
                   onChange={(e) => setEveryone(e.target.checked)} />
            All users
          </label>
          {!everyone && (
            <div className="flex flex-wrap gap-2">
              {ROLES.map((role) => (
                <label key={role}
                       className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-micro transition-colors ${
                         roles.includes(role)
                           ? "border-wine bg-peach-light text-wine"
                           : "border-line text-ink-muted hover:bg-surface-hover"}`}>
                  <input
                    type="checkbox" className="hidden"
                    checked={roles.includes(role)}
                    onChange={(e) => setRoles((prev) => e.target.checked
                      ? [...prev, role]
                      : prev.filter((r) => r !== role))}
                  />
                  {role.replace(/_/g, " ")}
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start date/time">
            <input type="datetime-local" className="field" value={startAt}
                   onChange={(e) => setStartAt(e.target.value)} />
          </Field>
          <Field label="End date/time">
            <input type="datetime-local" className="field" value={endAt}
                   onChange={(e) => setEndAt(e.target.value)} />
          </Field>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-wine" checked={published}
                 onChange={(e) => setPublished(e.target.checked)} />
          Publish immediately (otherwise saved as a draft)
        </label>
      </div>
    </Modal>
  );
}