import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound, Plus, Search, Trash2, Users as UsersIcon,
} from "lucide-react";
import { api, ApiError, isCancelled, Role, Store } from "@/lib/api";
import { ROLE_LABEL, useAuth } from "@/context/AuthContext";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, ConfirmDialog, Field, Modal, SuccessNote } from "@/components/ui/forms";

/** User administration. Super admin only, enforced again server-side.
 *
 * Users are created directly by the super admin (name, email, password, role,
 * store, status) — there is no invitation email or acceptance flow. The
 * password goes straight to Supabase Auth and is never stored or shown here.
 */

const ROLE_IDS: Record<number, Role> = {
  1: "super_admin", 2: "admin", 3: "inventory_manager", 4: "store_manager",
};

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role_id: number;
  is_active: boolean;
  email_verified: boolean;
  last_login_at: string | null;
  roles?: { name: string } | null;
  user_store_assignments?: { store_id: string; stores?: { code: string; name: string } }[];
}

export default function Users() {
  const { user: me } = useAuth();
  const [items, setItems] = useState<Profile[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Profile | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.allSettled([
      api.get<{ items: Profile[] }>("/users", { signal: controller.signal }),
      api.get<{ items: Store[] }>("/stores", { signal: controller.signal }),
    ]).then(([users, storeList]) => {
      if (controller.signal.aborted) return;
      if (users.status === "fulfilled") setItems(users.value.items);
      else if (!isCancelled(users.reason)) setError(users.reason);
      if (storeList.status === "fulfilled") setStores(storeList.value.items);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
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

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((p) =>
      `${p.full_name ?? ""} ${p.email}`.toLowerCase().includes(term));
  }, [items, search]);

  const activeCount = items.filter((p) => p.is_active).length;

  async function toggleActive(profile: Profile) {
    try {
      await api.patch(`/users/${profile.id}`, { is_active: !profile.is_active });
      refresh(`${profile.full_name ?? profile.email} is now ${!profile.is_active ? "active" : "deactivated"}.`);
    } catch (e) {
      setError(e as Error);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.del(`/users/${deleting.id}`);
      setDeleting(null);
      refresh(`${deleting.full_name ?? deleting.email} deleted.`);
    } catch (e) {
      setError(e as Error);
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Users & roles</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {items.length} user{items.length === 1 ? "" : "s"} · {activeCount} active.
            Add users directly — they sign in with the email and password you set.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add user
        </button>
      </header>

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input
          className="field py-2 pl-9"
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : shown.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={search ? "No matching users" : "No users yet"}
          body={search
            ? "Nothing matches that search."
            : "Add the first user — they can sign in immediately with the email and password you set."}
          actionLabel={search ? undefined : "Add user"}
          onAction={() => setAdding(true)}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Stores</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((profile) => {
                const role = (profile.roles?.name as Role) ?? ROLE_IDS[profile.role_id];
                const assigned = profile.user_store_assignments ?? [];
                const isMe = profile.id === me?.id;
                return (
                  <tr key={profile.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <p className="font-medium">{profile.full_name ?? "—"}</p>
                      <p className="text-micro text-ink-faint">{profile.email}</p>
                    </td>
                    <td className="px-3 py-2.5">{ROLE_LABEL[role] ?? role}</td>
                    <td className="px-3 py-2.5 text-micro text-ink-muted">
                      {role === "store_manager"
                        ? (assigned.length
                            ? assigned.map((a) => a.stores?.name ?? a.store_id).join(", ")
                            : "None assigned")
                        : "All stores"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`chip ${profile.is_active
                        ? "bg-healthy-soft text-healthy" : "bg-critical-soft text-critical"}`}>
                        {profile.is_active ? "Active" : "Deactivated"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="btn-quiet px-2 py-1 text-micro"
                          onClick={() => setEditing(profile)}
                          disabled={isMe}
                          title={isMe ? "You can't change your own account here" : undefined}
                        >
                          Edit
                        </button>
                        <button
                          className="btn-quiet px-2 py-1 text-micro"
                          onClick={() => setResetting(profile)}
                          title="Set or reset this user's password"
                        >
                          <KeyRound className="h-3.5 w-3.5" /> Password
                        </button>
                        <button
                          className="btn-quiet px-2 py-1 text-micro"
                          onClick={() => toggleActive(profile)}
                          disabled={isMe}
                        >
                          {profile.is_active ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          className="btn-quiet px-2 py-1 text-micro text-critical"
                          onClick={() => setDeleting(profile)}
                          disabled={isMe}
                          title={isMe ? "You can't delete your own account" : undefined}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddUserDialog
          stores={stores}
          onClose={() => setAdding(false)}
          onSaved={(m) => { setAdding(false); refresh(m); }}
        />
      )}

      {editing && (
        <UserDialog
          profile={editing}
          stores={stores}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); refresh(m); }}
        />
      )}

      {resetting && (
        <ResetPasswordDialog
          profile={resetting}
          onClose={() => setResetting(null)}
          onSaved={(m) => { setResetting(null); refresh(m); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={deleting ? `Delete ${deleting.full_name ?? deleting.email}?` : "Delete user?"}
        body={
          deleting
            ? "This permanently removes the account and its login. Orders, imports and "
              + "audit entries that reference this user are kept but lose the link. "
              + "This cannot be undone."
            : ""
        }
        confirmLabel="Delete user"
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- add user

function AddUserDialog({
  stores, onClose, onSaved,
}: { stores: Store[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [roleId, setRoleId] = useState(4);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isStoreManager = roleId === 4;

  async function save() {
    const errors: Record<string, string> = {};
    if (!fullName.trim()) errors.fullName = "A name is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter a valid email.";
    if (password.length < 8) errors.password = "Use at least 8 characters.";
    if (password !== confirmPassword) errors.confirmPassword = "Passwords don't match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ message: string }>("/auth/admin/users", {
        email: email.trim().toLowerCase(),
        full_name: fullName.trim(),
        password,
        role_id: roleId,
        store_ids: isStoreManager ? storeIds : [],
        is_active: active,
      });
      onSaved(result.message);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Add a user"
      description="Create the account directly. The user signs in with this email and password — no invitation needed."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Creating…" /> : "Create user"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}

        <Field label="Full name" required error={fieldErrors.fullName}>
          <input className="field" value={fullName}
                 onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Email address" required error={fieldErrors.email}>
          <input className="field" type="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" required error={fieldErrors.password}
                 hint="At least 8 characters with upper, lower, a number and a symbol.">
            <input className="field" type="password" value={password}
                   autoComplete="new-password"
                   onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password" required error={fieldErrors.confirmPassword}>
            <input className="field" type="password" value={confirmPassword}
                   autoComplete="new-password"
                   onChange={(e) => setConfirmPassword(e.target.value)} />
          </Field>
        </div>

        <Field label="Role">
          <select className="field" value={roleId}
                  onChange={(e) => setRoleId(Number(e.target.value))}>
            <option value={1}>Super admin — everything, including website management</option>
            <option value={2}>Admin — products, imports, approvals</option>
            <option value={3}>Inventory manager — stock, orders, transfers</option>
            <option value={4}>Store manager — assigned stores only</option>
          </select>
        </Field>

        {isStoreManager && (
          <Field
            label="Assigned store"
            hint="A store manager with no assignments sees nothing at all."
          >
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {stores.length === 0 && (
                <p className="px-1 py-2 text-micro text-ink-faint">No stores exist yet.</p>
              )}
              {stores.map((store) => (
                <label key={store.id} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-sm">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-wine"
                    checked={storeIds.includes(store.id)}
                    onChange={(e) => setStoreIds((prev) => e.target.checked
                      ? [...prev, store.id]
                      : prev.filter((id) => id !== store.id))}
                  />
                  {store.name}
                  <span className="text-micro text-ink-faint">{store.code}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-wine"
                 checked={active} onChange={(e) => setActive(e.target.checked)} />
          Account is active
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- edit

function UserDialog({
  profile, stores, onClose, onSaved,
}: {
  profile: Profile; stores: Store[];
  onClose: () => void; onSaved: (m: string) => void;
}) {
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const [email, setEmail] = useState(profile.email);
  const [roleId, setRoleId] = useState(profile.role_id);
  const [active, setActive] = useState(profile.is_active);
  const [storeIds, setStoreIds] = useState<string[]>(
    (profile.user_store_assignments ?? []).map((a) => a.store_id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const isStoreManager = roleId === 4;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/users/${profile.id}`, {
        full_name: fullName.trim() || null,
        role_id: roleId,
        is_active: active,
        // Only store managers are scoped, so only send assignments for them.
        store_ids: isStoreManager ? storeIds : [],
      });
      onSaved(`${profile.full_name ?? profile.email} updated.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={profile.full_name ?? profile.email}
      description="Update name, role, store access and status."
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

        <Field label="Full name">
          <input className="field" value={fullName}
                 onChange={(e) => setFullName(e.target.value)} />
        </Field>

        <Field label="Email" hint="Changing the email updates it in Supabase Auth.">
          <input className="field" type="email" value={email} disabled
                 title="Email changes are not supported here — use Reset/Set Password for access issues." />
        </Field>

        <Field label="Role">
          <select className="field" value={roleId}
                  onChange={(e) => setRoleId(Number(e.target.value))}>
            <option value={1}>Super admin — everything</option>
            <option value={2}>Admin — products, imports, approvals</option>
            <option value={3}>Inventory manager — stock, orders, transfers</option>
            <option value={4}>Store manager — assigned stores only</option>
          </select>
        </Field>

        {isStoreManager && (
          <Field
            label="Assigned stores"
            hint="A store manager with no assignments sees nothing at all."
          >
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {stores.length === 0 && (
                <p className="px-1 py-2 text-micro text-ink-faint">No stores exist yet.</p>
              )}
              {stores.map((store) => (
                <label key={store.id} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-sm">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-wine"
                    checked={storeIds.includes(store.id)}
                    onChange={(e) => setStoreIds((prev) => e.target.checked
                      ? [...prev, store.id]
                      : prev.filter((id) => id !== store.id))}
                  />
                  {store.name}
                  <span className="text-micro text-ink-faint">{store.code}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-wine"
                 checked={active} onChange={(e) => setActive(e.target.checked)} />
          Account is active
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- reset password

function ResetPasswordDialog({
  profile, onClose, onSaved,
}: {
  profile: Profile; onClose: () => void; onSaved: (m: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function save() {
    const errors: Record<string, string> = {};
    if (password.length < 8) errors.password = "Use at least 8 characters.";
    if (password !== confirmPassword) errors.confirmPassword = "Passwords don't match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ message: string }>(
        `/users/${profile.id}/reset-password`, { password });
      onSaved(result.message);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`Set password — ${profile.full_name ?? profile.email}`}
      description="The new password is applied through Supabase Auth. Existing passwords are never shown."
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Busy label="Saving…" /> : "Set password"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={error} />}
        <Field label="New password" required error={fieldErrors.password}
               hint="At least 8 characters with upper, lower, a number and a symbol.">
          <input className="field" type="password" value={password}
                 autoComplete="new-password"
                 onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm new password" required error={fieldErrors.confirmPassword}>
          <input className="field" type="password" value={confirmPassword}
                 autoComplete="new-password"
                 onChange={(e) => setConfirmPassword(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}