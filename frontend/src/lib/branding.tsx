import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { api, Branding } from "@/lib/api";

/**
 * Dynamic website branding.
 *
 * A super admin publishes branding through the admin panel; it lands in
 * system_settings (keys `branding.*`) and is served by GET /api/site/branding.
 * This provider loads it once and lets every surface — the sidebar, the login
 * page, the browser tab — read the active values. Nothing here is hardcoded in
 * the components that consume it.
 *
 * Fallbacks: if the backend is unreachable, the migration hasn't been run, or
 * a logo URL is broken, the default RetailMind wordmark and palette values are
 * used so one bad asset can never take the website down.
 */

export const DEFAULT_BRANDING: Branding = {
  platform_name: "RetailMind AI",
  short_name: "RetailMind",
  website_title: "RetailMind AI — Predict smarter. Stock smarter. Sell better.",
  website_subtitle: "AI-powered retail intelligence and smart inventory platform",
  company_name: "RetailMind",
  support_email: null,
  footer_text: "RetailMind AI",
  logo_url: null,
  logo_light_url: null,
  logo_dark_url: null,
  favicon_url: null,
  login_logo_url: null,
  dashboard_logo_url: null,
  login_welcome_title: "Welcome to RetailMind AI",
  login_welcome_subtitle: "Inventory intelligence for smarter retail decisions.",
  login_background_url: null,
  login_announcement: null,
  dashboard_welcome_title: null,
  dashboard_welcome_message: null,
  dashboard_banner_url: null,
  announcement_banner: null,
};

interface BrandingValue {
  branding: Branding;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingValue | null>(null);

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<Partial<Branding>>("/site/branding", {
        dedupe: true,
      });
      setBranding({ ...DEFAULT_BRANDING, ...next });
    } catch {
      // Keep the defaults; branding must never break the app.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live browser chrome: favicon and tab title follow the published values.
  useEffect(() => {
    if (branding.favicon_url) {
      const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (existing) existing.href = branding.favicon_url;
    }
    document.title = branding.website_title || DEFAULT_BRANDING.website_title;
  }, [branding.favicon_url, branding.website_title]);

  const value = useMemo(() => ({ branding, loaded, refresh }),
    [branding, loaded, refresh]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const context = useContext(BrandingContext);
  if (!context) throw new Error("useBranding must be used inside BrandingProvider");
  return context;
}