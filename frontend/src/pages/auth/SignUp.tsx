import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { ErrorNote } from "@/components/ui/primitives";
import { PasswordField, strengthOf } from "./PasswordField";
import { Turnstile, turnstileConfigured } from "@/components/ui/Turnstile";
import { useAuth } from "@/context/AuthContext";
import { AuthShell } from "./AuthShell";

export default function SignUp() {
  const navigate = useNavigate();
  const { config } = useAuth();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (strengthOf(password).score < 4) {
      setError("Choose a stronger password before continuing.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/sign-up", {
        email: email.trim(), password,
        full_name: fullName.trim(), captcha_token: captchaToken,
      });
      navigate(`/verify?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="We'll email a code to confirm it's you.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <ErrorNote message={error} />}
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium">Full name</label>
          <input id="name" className="field" value={fullName} required
                 onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">Work email</label>
          <input id="email" type="email" className="field" value={email} required
                 onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                 placeholder="you@company.com" />
        </div>
        <PasswordField value={password} onChange={setPassword} label="Password" showMeter />
        {config?.captcha_enabled && turnstileConfigured && (
          <Turnstile onToken={setCaptchaToken} />
        )}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <p className="pt-1 text-center text-sm text-ink-muted">
          Already have an account? <Link to="/sign-in" className="text-brand hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
