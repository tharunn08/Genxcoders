import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client, used only for the Google OAuth redirect dance.
 *
 * Password sign-in deliberately does NOT go through here — it goes to FastAPI,
 * so profile, role and store assignment resolve on the server through one code
 * path. OAuth has to start in the browser because it is a full-page redirect.
 *
 * Only the anon key is used. It is designed to be public and is constrained by
 * row-level security; the service-role key must never reach the frontend.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

if (!supabaseConfigured && import.meta.env.DEV) {
  console.warn(
    "[RetailMind] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. " +
    "Google sign-in will be unavailable. Email and password sign-in still works, " +
    "because it runs through the backend.",
  );
}

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
        flowType: "pkce",
      },
    })
  : null;

export async function signInWithGoogle(): Promise<void> {
  if (!supabase) {
    throw new Error(
      "Google sign-in isn't configured. Add VITE_SUPABASE_URL and " +
      "VITE_SUPABASE_ANON_KEY to frontend/.env.",
    );
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: { access_type: "offline", prompt: "select_account" },
    },
  });

  if (error) throw new Error(error.message);
}
