import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Bell, Boxes, ChevronDown, Database, FileText, Image, LayoutDashboard,
  LineChart, LogOut, Megaphone, Menu, Moon, Package, Palette, RefreshCw,
  Search, Settings, ShieldCheck, ShoppingCart, Sparkles, Store as StoreIcon,
  Sun, TriangleAlert, Truck, Users, Warehouse, ClipboardList, X,
} from "lucide-react";
import clsx from "clsx";
import { useAuth, ROLE_LABEL, Permission } from "@/context/AuthContext";
import type { Role } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { api, Branding, Store } from "@/lib/api";
import { Spinner, Thumb } from "@/components/ui/primitives";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
  /** Roles this entry is hidden from, when a permission isn't the right test. */
  hideFor?: Role[];
}

const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Ordering",
    items: [
      { to: "/app/order", label: "Order products", icon: ShoppingCart,
        permission: "order_products" },
      { to: "/app/my-orders", label: "My orders", icon: ClipboardList,
        permission: "order_products" },
      { to: "/app/warehouse", label: "Warehouse", icon: Warehouse,
        permission: "fulfil_orders" },
    ],
  },
  {
    heading: "Main",
    items: [
      { to: "/app", label: "Dashboard", icon: LayoutDashboard, hideFor: ["warehouse"] },
      { to: "/app/inventory", label: "Inventory", icon: Boxes, hideFor: ["warehouse"] },
      { to: "/app/products", label: "Products", icon: Package, hideFor: ["warehouse"] },
      { to: "/app/forecast", label: "Demand forecast", icon: LineChart,
        hideFor: ["warehouse", "store_manager"] },
      { to: "/app/replenishment", label: "Smart replenishment", icon: RefreshCw,
        hideFor: ["warehouse"] },
      { to: "/app/orders", label: "Orders", icon: ShoppingCart, hideFor: ["warehouse"] },
      { to: "/app/transfers", label: "Stock transfers", icon: Truck,
        hideFor: ["warehouse", "store_manager"] },
      { to: "/app/alerts", label: "Alerts", icon: TriangleAlert, hideFor: ["warehouse"] },
      { to: "/app/analytics", label: "Analytics", icon: LineChart,
        hideFor: ["warehouse", "store_manager"] },
      { to: "/app/reports", label: "Reports", icon: FileText, hideFor: ["warehouse"] },
    ],
  },
  {
    heading: "Intelligence",
    items: [
      { to: "/app/insights", label: "AI insights", icon: Sparkles,
        hideFor: ["warehouse", "store_manager"] },
      { to: "/app/what-if", label: "What-if simulator", icon: Sparkles,
        hideFor: ["warehouse", "store_manager"] },
    ],
  },
  {
    heading: "Administration",
    items: [
      { to: "/app/admin", label: "Admin panel", icon: ShieldCheck, permission: "manage_users" },
      { to: "/app/admin/users", label: "Users & roles", icon: Users, permission: "manage_users" },
      { to: "/app/admin/stores", label: "Stores", icon: StoreIcon, permission: "manage_stores" },
      { to: "/app/admin/suppliers", label: "Suppliers", icon: Truck, permission: "manage_suppliers" },
      { to: "/app/admin/branding", label: "Website & branding", icon: Palette, permission: "manage_settings" },
      { to: "/app/admin/media", label: "Media library", icon: Image, permission: "manage_settings" },
      { to: "/app/admin/announcements", label: "Announcements", icon: Megaphone, permission: "manage_settings" },
      { to: "/app/admin/imports", label: "Data imports", icon: Database, permission: "import_data" },
      { to: "/app/admin/settings", label: "System settings", icon: Settings, permission: "manage_settings" },
      { to: "/app/admin/audit", label: "Audit logs", icon: ShieldCheck, permission: "view_audit" },
    ],
  },
];

/** A logo image from branding, falling back to the stock-level brand mark. */
export function BrandMark({ branding, dark }: { branding: Branding; dark?: boolean }) {
  const src = dark ? (branding.logo_dark_url ?? branding.logo_url)
    : (branding.logo_light_url ?? branding.logo_url);
  const [broken, setBroken] = useState(false);

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={branding.short_name || "RetailMind"}
        className="max-h-8 w-auto max-w-[8.5rem] object-contain"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-wine text-white">
        <Boxes className="h-4.5 w-4.5" />
      </span>
      <span className="font-display font-semibold">{branding.platform_name}</span>
    </>
  );
}

export default function AppLayout() {
  const { user, activeStore, setActiveStore, signOut, can } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [dark, setDark] = useState(
    () => localStorage.getItem("rm.theme") === "dark",
  );
  const [alertCount, setAlertCount] = useState(0);
  const [allStores, setAllStores] = useState<Store[]>([]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    localStorage.setItem("rm.theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    api.get<{ items: unknown[] }>("/alerts?state=open&limit=50")
      .then((r) => setAlertCount(r.items.length))
      .catch(() => setAlertCount(0));
  }, [activeStore?.id]);

  // The full store list, for the store picker. Store managers are scoped by RLS
  // to their own stores; everyone else sees all.
  useEffect(() => {
    api.get<{ items: Store[] }>("/stores")
      .then((r) => setAllStores(r.items))
      .catch(() => setAllStores(user?.stores ?? []));
  }, [user?.id]);

  const showPicker = allStores.length > 1;

  return (
    <div className="min-h-screen lg:flex">
      {navOpen && (
        <button
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <nav
        className={clsx(
          "print:hidden fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-canvas-tint",
          "transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <NavLink to="/app" className="flex items-center gap-2.5" onClick={() => setNavOpen(false)}>
            <BrandMark branding={branding} />
          </NavLink>
          <button className="btn-quiet p-1.5 lg:hidden" onClick={() => setNavOpen(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
          {SECTIONS.map((section) => {
            const items = section.items.filter((i) =>
              (!i.permission || can(i.permission))
              && !(user && i.hideFor?.includes(user.role)));
            if (!items.length) return null;
            return (
              <div key={section.heading}>
                <p className="px-2.5 pb-1.5 text-micro font-medium text-ink-faint">
                  {section.heading}
                </p>
                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === "/app" || item.to === "/app/admin"}
                        onClick={() => setNavOpen(false)}
                        className={({ isActive }) =>
                          clsx(
                            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                            isActive
                              ? "bg-peach-light font-medium text-wine shadow-[inset_2px_0_0_#7A1F2B]"
                              : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                          )
                        }
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.label}
                        {item.to === "/app/alerts" && alertCount > 0 && (
                          <span className="ml-auto rounded-full bg-critical/15 px-1.5 text-micro text-critical tnum">
                            {alertCount}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="px-5 py-4 text-micro text-ink-faint">
          {branding.footer_text || branding.platform_name}
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="print:hidden sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-luxe sm:px-6">
          <button className="btn-quiet p-2 lg:hidden" onClick={() => setNavOpen(true)}
                  aria-label="Open navigation">
            <Menu className="h-4.5 w-4.5" />
          </button>

          {showPicker && (
            <StorePicker
              stores={allStores}
              active={activeStore}
              onPick={setActiveStore}
            />
          )}

          <GlobalSearch />

          <div className="ml-auto flex items-center gap-1">
            <button className="btn-quiet p-2" onClick={() => setDark((v) => !v)}
                    aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
              {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
            </button>

            <button className="btn-quiet relative p-2" onClick={() => navigate("/app/alerts")}
                    aria-label={`Alerts, ${alertCount} open`}>
              <Bell className="h-4.5 w-4.5" />
              {alertCount > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-critical ring-2 ring-canvas" />
              )}
            </button>

            <ProfileMenu onSignOut={() => { signOut(); navigate("/sign-in"); }} />
          </div>
        </header>

        {branding.announcement_banner && (
          <div className="print:hidden border-b border-line bg-peach-light/60 px-4 py-2 text-center text-micro text-wine sm:px-6">
            {branding.announcement_banner}
          </div>
        )}

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {/* The Suspense boundary sits here rather than around the whole
              layout so that switching routes keeps the sidebar and header on
              screen. A boundary above AppLayout would unmount the entire shell
              on every navigation, which reads as the app reloading. */}
          <Suspense fallback={<Spinner label="Loading…" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function StorePicker({ stores, active, onPick }: any) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="btn-ghost gap-2 px-3 py-2" onClick={() => setOpen((v) => !v)}>
        <StoreIcon className="h-4 w-4 text-ink-muted" />
        <span className="max-w-[9rem] truncate">{active?.name ?? "All stores"}</span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-10" onClick={() => setOpen(false)} tabIndex={-1} />
          <ul className="panel absolute left-0 z-20 mt-1.5 w-60 overflow-hidden p-1">
            <li>
              <button
                className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-hover"
                onClick={() => { onPick(null); setOpen(false); }}
              >
                <span className="block truncate">All stores</span>
                <span className="text-micro text-ink-faint">Combined view</span>
              </button>
            </li>
            {stores.map((store: any) => (
              <li key={store.id}>
                <button
                  className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => { onPick(store); setOpen(false); }}
                >
                  <span className="block truncate">{store.name}</span>
                  <span className="text-micro text-ink-faint">{store.code}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function GlobalSearch() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<any>(null);
  const navigate = useNavigate();
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (term.trim().length < 2) { setResults(null); return; }
    timer.current = window.setTimeout(() => {
      api.get<any>(`/search?q=${encodeURIComponent(term.trim())}`)
        .then(setResults).catch(() => setResults(null));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [term]);

  const hits = results
    ? [...results.products, ...results.orders, ...results.transfers]
    : [];

  return (
    <div className="relative hidden min-w-0 flex-1 max-w-md sm:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        className="field py-2 pl-9"
        placeholder="Search products, SKU, barcode, order number"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {hits.length > 0 && (
        <ul className="panel absolute z-30 mt-1.5 max-h-80 w-full overflow-y-auto p-1">
          {results.products.map((p: any) => (
            <li key={p.id}>
              <button
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-hover"
                onClick={() => { navigate(p.href); setTerm(""); }}
              >
                <Thumb src={p.image_url} alt={p.name} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="text-micro text-ink-faint tnum">{p.sku}</span>
                </span>
              </button>
            </li>
          ))}
          {results.orders.map((o: any) => (
            <li key={o.id}>
              <button
                className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-surface-hover"
                onClick={() => { navigate(o.href); setTerm(""); }}
              >
                {o.po_number}
                <span className="ml-2 text-micro text-ink-faint">{o.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileMenu({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!user) return null;

  const initials = (user.full_name ?? user.email)
    .split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="relative">
      <button
        className="ml-1 grid h-8 w-8 place-items-center rounded-full bg-peach-light text-micro font-semibold text-wine"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
      >
        {initials}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-10" onClick={() => setOpen(false)} tabIndex={-1} />
          <div className="panel absolute right-0 z-20 mt-2 w-60 p-1">
            <div className="border-b border-line px-3 py-2.5">
              <p className="truncate text-sm font-medium">{user.full_name ?? user.email}</p>
              <p className="truncate text-micro text-ink-faint">{user.email}</p>
              <p className="mt-1.5 text-micro text-wine">{ROLE_LABEL[user.role]}</p>
            </div>
            <button
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-hover"
              onClick={() => { navigate("/app/profile"); setOpen(false); }}
            >
              Profile and security
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-critical hover:bg-surface-hover"
              onClick={onSignOut}
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}