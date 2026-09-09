import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile.
 *
 * Renders nothing when no site key is configured, and the backend independently
 * skips verification in that case. The component never reports success on its
 * own — the token it produces is validated server-side against Cloudflare, so a
 * tampered frontend gains nothing.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: (id?: string) => void;
    };
    onTurnstileReady?: () => void;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";

export function Turnstile({
  onToken, enabled = true,
}: { onToken: (token: string | null) => void; enabled?: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !SITE_KEY || !holder.current) return;

    let cancelled = false;

    function mount() {
      if (cancelled || !holder.current || !window.turnstile) return;
      if (widgetId.current) return;
      widgetId.current = window.turnstile.render(holder.current, {
        sitekey: SITE_KEY,
        theme: "light",
        size: "flexible",
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    }

    if (window.turnstile) {
      mount();
    } else if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = mount;
      document.head.appendChild(script);
    } else {
      const timer = window.setInterval(() => {
        if (window.turnstile) { window.clearInterval(timer); mount(); }
      }, 120);
      return () => window.clearInterval(timer);
    }

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* already gone */ }
        widgetId.current = null;
      }
    };
  }, [enabled, onToken]);

  if (!enabled || !SITE_KEY) return null;
  return <div ref={holder} className="min-h-[65px]" />;
}

export const turnstileConfigured = Boolean(SITE_KEY);
