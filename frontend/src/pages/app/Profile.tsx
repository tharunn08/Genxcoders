import { useState } from "react";
import { KeyRound, LogOut, Save, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth, ROLE_LABEL } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { ErrorNote } from "@/components/ui/primitives";
import { Busy, Field, SuccessNote } from "@/components/ui/forms";

export default function Profile() {
  const { user, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);

  async function saveName() {
    if (!fullName.trim()) { setError(new Error("A name is required.")); return; }
    setSavingName(true);
    setError(null);
    try {
      await api.patch("/auth/me", { full_name: fullName.trim() });
      await refresh();
      setNotice("Profile updated.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      setError(new Error("Use at least 8 characters with upper and lower case, a number and a symbol."));
      return;
    }
    setSavingPassword(true);
    setError(null);
    try {
      await api.post("/auth/change-password", { new_password: newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setNotice("Password changed. Use it on your next sign-in.");
    } catch (e) {
      setError(e as Error);
    } finally {
      setSavingPassword(false);
    }
  }

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">Profile and security</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your account details and password. Sign-in itself is handled securely
          by the platform.
        </p>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      <section className="panel overflow-hidden">
        <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
          Account
        </h2>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name">
              <input className="field" value={fullName}
                     onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label="Email">
              <input className="field" value={user.email} disabled />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={saveName} disabled={savingName}>
              <Save className="h-4 w-4" />
              {savingName ? <Busy label="Saving…" /> : "Save name"}
            </button>
            <span className="chip bg-peach-light text-wine">{ROLE_LABEL[user.role]}</span>
            {user.stores.length > 0 && (
              <span className="chip bg-canvas-tint text-ink-muted">
                {user.stores.map((s) => s.name).join(", ")}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <h2 className="flex items-center gap-2 border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
          <KeyRound className="h-4 w-4 text-wine" /> Change password
        </h2>
        <div className="space-y-4 px-5 py-4">
          <Field label="Current password" hint="Re-authentication happens through the platform's secure flow.">
            <input type="password" className="field" value={currentPassword}
                   onChange={(e) => setCurrentPassword(e.target.value)} />
          </Field>
          <Field label="New password">
            <input type="password" className="field" value={newPassword}
                   onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <button className="btn-primary" onClick={changePassword} disabled={savingPassword}>
            {savingPassword ? <Busy label="Updating…" /> : "Change password"}
          </button>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
          Session
        </h2>
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-ink-muted">This device is signed in as {user.email}.</span>
            <button className="btn-ghost px-3 py-2 text-micro text-critical"
                    onClick={() => { signOut(); navigate("/sign-in"); }}>
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
          <div className="flex items-center gap-2 text-micro text-ink-faint">
            <UserRound className="h-3.5 w-3.5" />
            Role: {ROLE_LABEL[user.role]} · Email verified: {user.email_verified ? "Yes" : "No"}
          </div>
        </div>
      </section>
    </div>
  );
}