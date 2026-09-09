import { useState } from "react";
import { Link } from "react-router-dom";
import { useBranding } from "@/lib/branding";

/**
 * Split authentication layout.
 *
 * The left panel is the one place in the product where the peach-to-wine
 * gradient runs at full strength; everywhere past sign-in the palette is mostly
 * ivory with red as an accent. The card itself is glass — one of the four
 * places glass is used at all.
 *
 * Branding is dynamic: a super admin can publish a login logo, a welcome title
 * and subtitle, a background image and a notice from the admin panel. Every
 * value falls back to the defaults when nothing has been published.
 */
export function AuthShell({
  title, subtitle, children, footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { branding } = useBranding();
  const [bgBroken, setBgBroken] = useState(false);

  return (
    <div className="relative min-h-screen overflow-hidden bg-canvas lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* Ambient warmth, mobile included */}
      <div aria-hidden className="pointer-events-none absolute inset-0 wash-peach lg:hidden" />

      <aside className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-14">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(150deg, #7A1F2B 0%, #5A1420 55%, #3D0D16 100%)",
          }}
        />
        {branding.login_background_url && !bgBroken && (
          <img
            aria-hidden
            src={branding.login_background_url}
            alt=""
            onError={() => setBgBroken(true)}
            className="absolute inset-0 h-full w-full object-cover opacity-25"
          />
        )}
        <div
          aria-hidden
          className="absolute -left-32 top-1/4 h-[34rem] w-[34rem] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, #F3A58B 0%, transparent 70%)" }}
        />

        <Brand tone="light" />

        <div className="relative max-w-md">
          <p className="font-display text-[2.6rem] font-medium leading-[1.12] text-white">
            Predict smarter.<br />Stock smarter.<br />
            <span className="text-peach-soft">Sell better.</span>
          </p>
          <p className="mt-6 text-[0.9375rem] leading-relaxed text-white/70">
            {branding.website_subtitle}
          </p>

          <dl className="mt-10 grid grid-cols-3 gap-6 border-t border-white/15 pt-7">
            {[
              ["Forecast", "demand per SKU"],
              ["Detect", "stockout risk"],
              ["Act", "on replenishment"],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="font-display text-[0.9375rem] text-peach">{term}</dt>
                <dd className="mt-1 text-micro leading-snug text-white/55">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-micro text-white/40">
          Retail decision intelligence
        </p>
      </aside>

      <main className="relative flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[26rem]">
          <div className="mb-8 lg:hidden"><Brand tone="dark" /></div>

          <div className="glass animate-fade-rise p-7 sm:p-9">
            {branding.login_announcement && (
              <p className="mb-5 rounded-xl border border-peach/50 bg-peach-light/70 px-3.5 py-2.5 text-micro leading-relaxed text-wine">
                {branding.login_announcement}
              </p>
            )}
            <h1 className="font-display text-[1.75rem] font-medium leading-tight">{title}</h1>
            <p className="mb-7 mt-2 text-sm leading-relaxed text-ink-muted">{subtitle}</p>
            {children}
          </div>

          {footer && <div className="mt-6 text-center text-sm">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export function Brand({ tone = "dark" }: { tone?: "light" | "dark" }) {
  const light = tone === "light";
  const { branding } = useBranding();
  const [logoBroken, setLogoBroken] = useState(false);
  const logo = branding.login_logo_url ?? branding.logo_url;

  if (logo && !logoBroken) {
    return (
      <Link to="/" className="relative inline-flex items-center gap-3">
        <img
          src={logo}
          alt={branding.platform_name}
          onError={() => setLogoBroken(true)}
          className="max-h-10 w-auto max-w-[10rem] object-contain"
        />
      </Link>
    );
  }

  return (
    <Link to="/" className="relative inline-flex items-center gap-3">
      <span
        className="grid h-10 w-10 place-items-center rounded-xl"
        style={{
          background: light
            ? "linear-gradient(140deg,#F8C7B5,#F3A58B)"
            : "linear-gradient(140deg,#7A1F2B,#5A1420)",
        }}
      >
        <Mark className={light ? "text-wine-deep" : "text-peach-soft"} />
      </span>
      <span className={`font-display text-lg font-medium ${light ? "text-white" : "text-ink"}`}>
        {branding.short_name} <span className={light ? "text-peach" : "text-wine"}>AI</span>
      </span>
    </Link>
  );
}

/** Three stacked bars of unequal height: stock levels, not a generic box icon. */
function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-5 w-5 ${className}`} fill="none" aria-hidden>
      <rect x="2.5" y="11" width="3.6" height="6.5" rx="1.2" fill="currentColor" opacity=".55" />
      <rect x="8.2" y="6.5" width="3.6" height="11" rx="1.2" fill="currentColor" opacity=".8" />
      <rect x="13.9" y="2.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
    </svg>
  );
}
