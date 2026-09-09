import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, Boxes, Database, Image, Megaphone, Package, Palette, ScrollText,
  Settings, ShieldCheck, Store as StoreIcon, Truck, Users,
} from "lucide-react";
import { api, ApiError, isCancelled } from "@/lib/api";
import { ErrorNote, money, Spinner, units } from "@/components/ui/primitives";
import { SuccessNote } from "@/components/ui/forms";

interface Stats {
  users: number;
  activeUsers: number;
  stores: number;
  products: number;
  units: number;
  value: number;
  alerts: number;
}

const SECTIONS = [
  {
    heading: "Administration",
    items: [
      { to: "/app/admin/users", label: "Users & roles", icon: Users, desc: "Add users directly, assign roles and stores, activate or deactivate." },
      { to: "/app/admin/stores", label: "Stores", icon: StoreIcon, desc: "Add and manage store locations." },
      { to: "/app/admin/suppliers", label: "Suppliers", icon: Truck, desc: "Lead times that drive reorder points." },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/app/admin/branding", label: "Website & branding", icon: Palette, desc: "Logos, platform name, login and dashboard content." },
      { to: "/app/admin/media", label: "Media library", icon: Image, desc: "Approved website assets, uploads and usage." },
      { to: "/app/admin/announcements", label: "Announcements", icon: Megaphone, desc: "Publish notices to all users or selected roles." },
      { to: "/app/admin/settings", label: "System settings", icon: Settings, desc: "Safety stock, forecasting and stock thresholds." },
      { to: "/app/admin/audit", label: "Audit logs", icon: ScrollText, desc: "Every important change, who did it and when." },
    ],
  },
  {
    heading: "Data management",
    items: [
      { to: "/app/products", label: "Products", icon: Package, desc: "The product catalog with images and MRP." },
      { to: "/app/inventory", label: "Inventory", icon: Boxes, desc: "Stock positions, adjustments and value." },
      { to: "/app/admin/imports", label: "Data imports", icon: Database, desc: "Import product, inventory and sales files." },
    ],
  },
];

export default function AdminHome() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.allSettled([
      api.get<{ items: { is_active: boolean }[] }>("/users?limit=200",
        { signal: controller.signal }),
      api.get<{ items: unknown[] }>("/stores", { signal: controller.signal }),
      api.get<{ total: number }>("/products?limit=1", { signal: controller.signal }),
      api.get<{ empty: boolean; kpis: Record<string, number> }>("/dashboard",
        { signal: controller.signal }),
      api.get<{ items: unknown[] }>("/alerts?state=open&limit=50",
        { signal: controller.signal }),
    ]).then(([users, stores, products, dash, alerts]) => {
      if (controller.signal.aborted) return;
      const s: Stats = { users: 0, activeUsers: 0, stores: 0, products: 0, units: 0, value: 0, alerts: 0 };
      if (users.status === "fulfilled") {
        s.users = users.value.items.length;
        s.activeUsers = users.value.items.filter((u) => u.is_active).length;
      }
      if (stores.status === "fulfilled") s.stores = stores.value.items.length;
      if (products.status === "fulfilled") s.products = products.value.total;
      if (dash.status === "fulfilled" && !dash.value.empty) {
        s.units = dash.value.kpis.total_units ?? 0;
        s.value = dash.value.kpis.total_value ?? 0;
      }
      if (alerts.status === "fulfilled") s.alerts = alerts.value.items.length;
      setStats(s);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  if (loading) return <Spinner label="Loading the admin panel…" />;

  const s = stats ?? { users: 0, activeUsers: 0, stores: 0, products: 0, units: 0, value: 0, alerts: 0 };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <ShieldCheck className="h-5 w-5 text-wine" /> Admin panel
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Website management and system control centre. Only super admins see this.
        </p>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote message={error} />}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <Stat label="Total users" value={String(s.users)} />
        <Stat label="Active users" value={String(s.activeUsers)} />
        <Stat label="Stores" value={String(s.stores)} />
        <Stat label="Products" value={String(s.products)} />
        <Stat label="Inventory units" value={units(s.units)} />
        <Stat label="Inventory value" value={money(s.value)} />
        <Stat label="Open alerts" value={String(s.alerts)} tone={s.alerts > 0 ? "text-critical" : ""} />
      </section>

      {SECTIONS.map((section) => (
        <section key={section.heading}>
          <h2 className="mb-2.5 font-display text-sm font-semibold text-ink-muted">
            {section.heading}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.items.map((item) => (
              <button
                key={item.to}
                onClick={() => navigate(item.to)}
                className="panel group flex items-start gap-3.5 p-4 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-peach-light">
                  <item.icon className="h-4.5 w-4.5 text-wine" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-wine" />
                  </span>
                  <span className="mt-1 block text-micro leading-relaxed text-ink-muted">
                    {item.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className={`mt-1 font-display text-xl font-semibold tnum ${tone}`}>{value}</p>
    </div>
  );
}