import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ApiError } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { signInWithGoogle, supabaseConfigured } from "@/lib/supabase";
import { ErrorNote } from "@/components/ui/primitives";
import { Turnstile, turnstileConfigured } from "@/components/ui/Turnstile";
import { AuthShell } from "./AuthShell";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reflects the real request lifecycle. Nothing here is on a timer. */
type Phase = "idle" | "authenticating" | "loading-profile" | "success";

export default function SignIn() {
  const { signIn, config } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [email, setEmail] = useState(localStorage.getItem("rm.remembered") ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(!!localStorage.getItem("rm.remembered"));
  const [reveal, setReveal] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<ApiError | Error | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const captchaRequired = config?.captcha_enabled && turnstileConfigured;
  const busy = phase !== "idle";

  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (params.get("expired")) setNotice("Your session expired. Sign in to continue.");
    if (params.get("reset")) setNotice("Password updated. Sign in with your new password.");
    if (params.get("verified")) setNotice("Email verified. You can sign in now.");
  }, [params]);

  const handleToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setNotice("");

    const found: typeof errors = {};
    if (!email.trim()) found.email = "Enter your email address.";
    else if (!EMAIL_RE.test(email.trim())) found.email = "That doesn't look like an email address.";
    if (!password) found.password = "Enter your password.";
    setErrors(found);
    if (Object.keys(found).length) return;

    if (captchaRequired && !captchaToken) {
      setFailure(new Error("Complete the verification challenge below."));
      return;
    }

    setPhase("authenticating");
    try {
      // Phase flips only when the request actually resolves.
      const promise = signIn(email.trim(), password, { remember, captchaToken });
      setPhase("loading-profile");
      const { user } = await promise;

      if (remember) localStorage.setItem("rm.remembered", email.trim());
      else localStorage.removeItem("rm.remembered");

      setPhase("success");
      // Just long enough for the confirmation to register visually.
      setTimeout(() => navigate("/app", { replace: true }), 520);

      if (!user.email_verified) {
        navigate(`/verify?email=${encodeURIComponent(email.trim())}`, { replace: true });
      }
    } catch (error) {
      setPhase("idle");
      const err = error instanceof Error ? error : new Error("Sign in failed.");
      if (err instanceof ApiError && err.status === 403 &&
          err.message.toLowerCase().includes("verify")) {
        navigate(`/verify?email=${encodeURIComponent(email.trim())}`);
        return;
      }
      setFailure(err);
    }
  }

  async function google() {
    setFailure(null);
    setGoogleBusy(true);
    try {
      await signInWithGoogle();   // full-page redirect; nothing after this runs
    } catch (error) {
      setGoogleBusy(false);
      setFailure(error instanceof Error ? error : new Error("Google sign-in failed."));
    }
  }

  const label = {
    idle: "Sign in",
    authenticating: "Verifying credentials",
    "loading-profile": "Loading your workspace",
    success: "Signed in",
  }[phase];

  return (
    <AuthShell
      title={branding.login_welcome_title}
      subtitle={branding.login_welcome_subtitle}
      footer={
        <span className="text-ink-muted">
          Need an account?{" "}
          <Link to="/sign-up" className="font-medium text-wine hover:underline">
            Create one
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {failure && <ErrorNote error={failure} />}
        {notice && !failure && (
          <p className="rounded-xl border border-healthy/25 bg-healthy-soft px-4 py-3 text-sm text-healthy">
            {notice}
          </p>
        )}

        {supabaseConfigured && (
          <>
            <button
              type="button"
              onClick={google}
              disabled={busy || googleBusy}
              className="btn-ghost w-full"
            >
              {googleBusy
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <GoogleMark />}
              Continue with Google
            </button>

            <div className="flex items-center gap-4 py-1">
              <span className="h-px flex-1 bg-line" />
              <span className="text-micro text-ink-faint">or use your email</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <input
            id="email" type="email" autoComplete="email" className="field"
            value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" disabled={busy}
            aria-invalid={!!errors.email}
          />
          {errors.email && <p className="text-micro text-critical">{errors.email}</p>}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <Link to="/forgot-password" className="text-micro text-wine hover:underline">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <input
              id="password" type={reveal ? "text" : "password"}
              autoComplete="current-password" className="field pr-12"
              value={password} onChange={(e) => setPassword(e.target.value)}
              disabled={busy} aria-invalid={!!errors.password}
            />
            <button
              type="button" onClick={() => setReveal((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-faint transition-colors hover:text-ink"
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password && <p className="text-micro text-critical">{errors.password}</p>}
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-muted">
          <input
            type="checkbox" checked={remember} disabled={busy}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-wine"
          />
          Keep me signed in on this device
        </label>

        {captchaRequired && (
          <div className="pt-1"><Turnstile onToken={handleToken} /></div>
        )}

        <button type="submit" className="btn-primary relative w-full overflow-hidden" disabled={busy}>
          {busy && phase !== "success" && (
            <span
              aria-hidden
              className="absolute inset-y-0 w-1/3 animate-sheen bg-white/20 blur-md"
            />
          )}
          <span className="relative flex items-center gap-2">
            {phase === "success"
              ? <Check className="h-4 w-4" />
              : busy
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ShieldCheck className="h-4 w-4" />}
            {label}
          </span>
        </button>

        <p className="pt-1 text-center text-micro leading-relaxed text-ink-faint">
          Protected by encrypted sign-in. Your session is scoped to the stores
          assigned to your account.
        </p>
      </form>
    </AuthShell>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
