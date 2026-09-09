import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { api, ApiError, tokens } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { ErrorNote } from "@/components/ui/primitives";
import { AuthShell } from "./AuthShell";

const OTP_LENGTH = 6;
const EXPIRY_SECONDS = 600;
const RESEND_COOLDOWN = 60;
const MAX_ATTEMPTS = 5;

/** The code itself never travels through this component's state beyond the
 *  input boxes — it is posted straight to the API and verified server-side. */
export default function VerifyOtp({ purpose = "signup" }: { purpose?: "signup" | "recovery" }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const email = params.get("email") ?? "";
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [expiresIn, setExpiresIn] = useState(EXPIRY_SECONDS);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const code = digits.join("");
  const locked = attempts >= MAX_ATTEMPTS;
  const expired = expiresIn <= 0;

  useEffect(() => {
    const timer = setInterval(() => {
      setExpiresIn((v) => (v > 0 ? v - 1 : 0));
      setCooldown((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => { inputs.current[0]?.focus(); }, []);

  const submit = useCallback(async (value: string) => {
    if (value.length !== OTP_LENGTH || busy || locked || expired) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ access_token: string; refresh_token: string }>(
        "/auth/verify-otp", { email, token: value, purpose },
      );
      tokens.set(result.access_token, result.refresh_token);
      setDone(true);

      if (purpose === "recovery") {
        setTimeout(() => navigate("/reset-password", { replace: true }), 700);
      } else {
        await refresh();
        setTimeout(() => navigate("/app", { replace: true }), 700);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Verification failed.";
      setError(message);
      setAttempts((a) => a + 1);
      setDigits(Array(OTP_LENGTH).fill(""));
      inputs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  }, [busy, email, expired, locked, navigate, purpose, refresh]);

  function setDigit(index: number, raw: string) {
    const value = raw.replace(/\D/g, "");
    if (!value) {
      setDigits((prev) => prev.map((d, i) => (i === index ? "" : d)));
      return;
    }
    const next = [...digits];
    // Support pasting the whole code into any box.
    value.split("").forEach((char, offset) => {
      if (index + offset < OTP_LENGTH) next[index + offset] = char;
    });
    setDigits(next);
    const landed = Math.min(index + value.length, OTP_LENGTH - 1);
    inputs.current[landed]?.focus();
    const joined = next.join("");
    if (joined.length === OTP_LENGTH && !joined.includes("")) void submit(joined);
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowLeft" && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < OTP_LENGTH - 1) inputs.current[index + 1]?.focus();
  }

  async function resend() {
    setError("");
    setNotice("");
    try {
      if (purpose === "recovery") await api.post("/auth/forgot-password", { email, captcha_token: null });
      else await api.post("/auth/resend-otp", { email });
      setNotice("A new code is on its way.");
      setCooldown(RESEND_COOLDOWN);
      setExpiresIn(EXPIRY_SECONDS);
      setAttempts(0);
      setDigits(Array(OTP_LENGTH).fill(""));
      inputs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send a new code.");
    }
  }

  const clock = `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, "0")}`;

  if (done) {
    return (
      <AuthShell title="Verified" subtitle="Taking you through…">
        <div className="flex items-center gap-3 rounded-lg border border-healthy/40 bg-healthy-soft px-4 py-3.5 text-healthy">
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-sm font-medium">Email confirmed.</span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Check your email"
      subtitle={`We sent a ${OTP_LENGTH}-digit code to ${email || "your address"}.`}
    >
      <div className="space-y-5">
        {error && <ErrorNote message={error} />}
        {notice && (
          <p className="rounded-lg border border-healthy/40 bg-healthy-soft px-3.5 py-2.5 text-sm text-healthy">
            {notice}
          </p>
        )}

        <div>
          <div className="flex gap-2" role="group" aria-label="Verification code">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(el) => (inputs.current[index] = el)}
                value={digit}
                onChange={(e) => setDigit(index, e.target.value)}
                onKeyDown={(e) => onKeyDown(index, e)}
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                maxLength={OTP_LENGTH}
                disabled={locked || expired || busy}
                aria-label={`Digit ${index + 1}`}
                className="field h-13 flex-1 px-0 py-3 text-center font-display text-lg tnum disabled:opacity-50"
              />
            ))}
          </div>

          <div className="mt-2.5 flex items-center justify-between text-micro">
            <span className={expired ? "text-critical" : "text-ink-muted"}>
              {expired ? "Code expired" : `Expires in ${clock}`}
            </span>
            {attempts > 0 && !locked && (
              <span className="text-ink-muted">
                {MAX_ATTEMPTS - attempts} attempt{MAX_ATTEMPTS - attempts === 1 ? "" : "s"} left
              </span>
            )}
          </div>
        </div>

        {locked && (
          <ErrorNote message="Too many incorrect attempts. Request a new code to continue." />
        )}

        <button
          className="btn-primary w-full"
          disabled={code.length !== OTP_LENGTH || busy || locked || expired}
          onClick={() => submit(code)}
        >
          {busy ? "Verifying…" : "Verify"}
        </button>

        <button
          className="btn-ghost w-full"
          disabled={cooldown > 0}
          onClick={resend}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
        </button>
      </div>
    </AuthShell>
  );
}
