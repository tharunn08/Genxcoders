import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, tokens } from "@/lib/api";
import { ErrorNote } from "@/components/ui/primitives";
import { PasswordField, strengthOf } from "./PasswordField";
import { AuthShell } from "./AuthShell";

/** Reached only after verify-otp with purpose=recovery has returned a session. */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (strengthOf(password).score < 4) {
      setError("Choose a stronger password before continuing.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/reset-password", { new_password: password });
      tokens.clear();
      navigate("/sign-in?reset=1", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Choose a new password" subtitle="You'll sign in with this from now on.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorNote message={error} />}
        <PasswordField value={password} onChange={setPassword} label="New password" showMeter />
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Confirm password</label>
          <input type="password" className="field" value={confirm} required
                 autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          {mismatch && <p className="text-micro text-critical">The two passwords don't match.</p>}
        </div>
        <button className="btn-primary w-full" disabled={busy || mismatch}>
          {busy ? "Updating…" : "Update password"}
        </button>
      </form>
    </AuthShell>
  );
}
