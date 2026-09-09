import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { ErrorNote } from "@/components/ui/primitives";
import { AuthShell } from "./AuthShell";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/forgot-password", { email: email.trim(), captcha_token: null });
      navigate(`/verify-reset?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send a reset code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Reset your password"
      subtitle="Enter your email and we'll send a six-digit code.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorNote message={error} />}
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <input id="email" type="email" className="field" value={email} required
                 autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset code"}
        </button>
        <p className="pt-1 text-center text-sm">
          <Link to="/sign-in" className="text-brand hover:underline">Back to sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
