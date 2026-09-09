import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { ErrorNote } from "@/components/ui/primitives";
import { AuthShell } from "./AuthShell";

/**
 * Lands here after Google redirects back, and also after a sign-up/recovery
 * email link is clicked (the email's confirmation URL points here via
 * AUTH_REDIRECT_URL).
 *
 * supabase-js completes the PKCE exchange from the URL — either the OAuth
 * callback or the token_hash from an email link — then the session is handed
 * to the backend so profile, role and store assignments resolve through the
 * same path as password sign-in.
 */
export default function OAuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { adoptSession } = useAuth();
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;      // StrictMode double-invoke guard
    ran.current = true;

    (async () => {
      if (!supabase) {
        setError(new Error(
          "Google sign-in isn't configured. Add VITE_SUPABASE_URL and " +
          "VITE_SUPABASE_ANON_KEY to frontend/.env.",
        ));
        return;
      }

      try {
        let session = (await supabase.auth.getSession()).data.session;

        // Email confirmation/recovery links carry ?token_hash=...&type=...
        // instead of a completed session. Exchange the hash for a session.
        const tokenHash = params.get("token_hash");
        const linkType = params.get("type");
        if (!session && tokenHash && linkType) {
          const type = linkType === "signup" ? "email" : linkType as "email" | "recovery" | "invite" | "email_change";
          const { data, error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type,
          });
          if (verifyError) throw new Error(verifyError.message);
          session = data.session ?? (await supabase.auth.getSession()).data.session;
        }

        if (!session) {
          throw new Error(
            "The sign-in didn't return a session. This usually means the redirect " +
            "URL isn't allow-listed in Supabase under Authentication → URL " +
            "Configuration, or the link has expired — request a new code.",
          );
        }

        await adoptSession(session.access_token, session.refresh_token);
        setDone(true);
        setTimeout(() => navigate("/app", { replace: true }), 500);
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error("Sign-in could not be completed."));
      }
    })();
  }, [adoptSession, navigate, params]);

  return (
    <AuthShell
      title={done ? "Signed in" : "Finishing sign-in"}
      subtitle={done ? "Opening your workspace…" : "Confirming your Google account."}
      footer={
        error && (
          <button className="text-wine hover:underline" onClick={() => navigate("/sign-in")}>
            Back to sign in
          </button>
        )
      }
    >
      {error ? (
        <ErrorNote error={error} />
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-white/60 px-4 py-3.5 text-sm">
          {done
            ? <Check className="h-4.5 w-4.5 text-healthy" />
            : <Loader2 className="h-4.5 w-4.5 animate-spin text-wine" />}
          <span className="text-ink-muted">
            {done ? "Profile and permissions loaded." : "Verifying your account…"}
          </span>
        </div>
      )}
    </AuthShell>
  );
}
