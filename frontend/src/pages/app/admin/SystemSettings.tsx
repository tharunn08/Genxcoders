import { useCallback, useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { api, ApiError, isCancelled } from "@/lib/api";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, SuccessNote } from "@/components/ui/forms";

/**
 * System settings.
 *
 * Every threshold the forecasting and replenishment maths uses lives in
 * `system_settings`. The API was live; this screen was a placeholder, so the
 * numbers were only editable by hand in the Supabase table editor.
 */

interface Setting {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string | null;
}

const GROUPS: { heading: string; keys: string[] }[] = [
  { heading: "Safety stock", keys: ["safety_method", "safety_days", "safety_percentage", "service_level_z"] },
  { heading: "Forecasting", keys: ["forecast_method", "forecast_horizon", "default_lead_time", "review_period_days"] },
  { heading: "Stock thresholds", keys: ["risk_critical_days", "risk_low_days", "overstock_days"] },
  { heading: "Authentication", keys: ["otp_expiry_minutes"] },
];

const CHOICES: Record<string, string[]> = {
  safety_method: ["days", "percentage", "variability"],
  forecast_method: ["moving_average", "weighted_ma", "linear_trend"],
};

export default function SystemSettings() {
  const [items, setItems] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Setting[] }>("/settings", { signal: controller.signal })
      .then((r) => {
        setItems(r.items);
        setDrafts(Object.fromEntries(
          r.items.map((s) => [s.key, unwrap(s.value)])));
      })
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Settings are stored as JSONB: 5, "days", 1.65. Show the bare value. */
  function unwrap(value: unknown): string {
    if (typeof value === "string") return value;
    return String(value ?? "");
  }

  /** Send back the same JSON shape the row already had. */
  function wrap(key: string, raw: string): unknown {
    if (CHOICES[key]) return raw;
    const asNumber = Number(raw);
    return raw.trim() !== "" && !Number.isNaN(asNumber) ? asNumber : raw;
  }

  const save = useCallback(async (key: string) => {
    setSaving(key);
    setError(null);
    try {
      await api.put(`/settings/${key}`, { value: wrap(key, drafts[key] ?? "") });
      setNotice(`${key.replace(/_/g, " ")} saved. New values apply on the next load.`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e as Error);
    } finally {
      setSaving("");
    }
  }, [drafts]);

  const byKey = Object.fromEntries(items.map((s) => [s.key, s]));
  const grouped = GROUPS.map((g) => ({
    ...g, settings: g.keys.map((k) => byKey[k]).filter(Boolean),
  })).filter((g) => g.settings.length);
  const ungrouped = items.filter(
    (s) => !GROUPS.some((g) => g.keys.includes(s.key)));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">System settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          These values drive safety stock, reorder points and stock status across
          the whole application.
        </p>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState
          icon={SettingsIcon}
          title="No settings found"
          body="Run supabase/migrations/0001_schema.sql — it seeds the default thresholds."
        />
      ) : (
        <>
          {[...grouped, ...(ungrouped.length
            ? [{ heading: "Other", settings: ungrouped }] : [])].map((group) => (
            <section key={group.heading} className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
                {group.heading}
              </h2>
              <ul className="divide-y divide-line">
                {group.settings.map((setting) => (
                  <li key={setting.key}
                      className="grid gap-2 px-5 py-3.5 sm:grid-cols-[1.4fr_1fr_auto] sm:items-center">
                    <div>
                      <p className="text-sm font-medium">
                        {setting.key.replace(/_/g, " ")}
                      </p>
                      {setting.description && (
                        <p className="mt-0.5 text-micro leading-relaxed text-ink-muted">
                          {setting.description}
                        </p>
                      )}
                    </div>

                    {CHOICES[setting.key] ? (
                      <select
                        className="field py-2"
                        value={drafts[setting.key] ?? ""}
                        onChange={(e) => setDrafts((d) => ({
                          ...d, [setting.key]: e.target.value }))}
                      >
                        {CHOICES[setting.key].map((choice) => (
                          <option key={choice} value={choice}>
                            {choice.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="field tnum py-2"
                        inputMode="decimal"
                        value={drafts[setting.key] ?? ""}
                        onChange={(e) => setDrafts((d) => ({
                          ...d, [setting.key]: e.target.value }))}
                      />
                    )}

                    <button
                      className="btn-ghost px-3 py-2 text-micro"
                      onClick={() => save(setting.key)}
                      disabled={
                        saving === setting.key ||
                        (drafts[setting.key] ?? "") === unwrap(setting.value)
                      }
                    >
                      {saving === setting.key ? <Busy label="Saving…" /> : "Save"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
