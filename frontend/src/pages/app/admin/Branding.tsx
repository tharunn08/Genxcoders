import { useEffect, useRef, useState } from "react";
import {
  ImagePlus, Palette, Save, Trash2, UploadCloud, X,
} from "lucide-react";
import { api, type Branding } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, Field, SuccessNote } from "@/components/ui/forms";

/**
 * Website & branding — every setting edited and saved independently.
 *
 * Changing the logo publishes the logo and nothing else. The tagline, platform
 * name, login image, favicon etc. each have their own Edit / Save / Cancel and
 * are never bundled into one form, so you are never forced to touch a field
 * you don't care about.
 */

export default function Branding() {
  const { branding, loaded, refresh } = useBranding();
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  if (!loaded) return <Spinner label="Loading branding…" />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Palette className="h-5 w-5 text-wine" /> Website & branding
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Each setting is edited and saved on its own — change the logo without
          touching anything else. Changes go live for every user after refresh.
        </p>
      </header>

      {notice && <SuccessNote message={notice} />}

      <LogoSection branding={branding} refresh={refresh} onSaved={setNotice} />

      <FaviconSection branding={branding} refresh={refresh} onSaved={setNotice} />

      <TextSection
        title="Platform name"
        hint="Shown in the sidebar and the browser tab."
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
        fields={[
          { key: "platform_name", label: "Platform name", required: true },
          { key: "short_name", label: "Short brand name", required: true },
          { key: "company_name", label: "Company name", required: false },
        ]}
      />

      <TextSection
        title="Tagline & website text"
        hint="The subtitle under the platform name and the browser tab title."
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
        fields={[
          { key: "website_subtitle", label: "Website subtitle", required: false },
          { key: "website_title", label: "Browser tab title", required: false },
          { key: "footer_text", label: "Footer text", required: false },
          { key: "support_email", label: "Support email", required: false },
        ]}
      />

      <TextSection
        title="Login page"
        hint="Welcome title, subtitle and any announcement on the sign-in page."
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
        fields={[
          { key: "login_welcome_title", label: "Welcome title", required: false },
          { key: "login_welcome_subtitle", label: "Welcome subtitle", required: false },
          { key: "login_announcement", label: "Announcement", required: false },
        ]}
      />

      <ImageSection
        title="Login page image"
        hint="Optional background image behind the sign-in panel."
        field="login_background_url"
        category="login"
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
      />

      <TextSection
        title="Dashboard content"
        hint="Welcome title, message and the global announcement banner."
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
        fields={[
          { key: "dashboard_welcome_title", label: "Welcome title", required: false },
          { key: "dashboard_welcome_message", label: "Welcome message", required: false },
          { key: "announcement_banner", label: "Announcement banner", required: false },
        ]}
      />

      <ImageSection
        title="Dashboard banner image"
        hint="Optional banner shown on the dashboard."
        field="dashboard_banner_url"
        category="banner"
        branding={branding}
        refresh={refresh}
        onSaved={setNotice}
      />
    </div>
  );
}

// ---------------------------------------------------------------- helpers

type BrandingKey = keyof Branding;

async function publish(values: Partial<Branding>, refresh: () => Promise<void>,
                       onSaved: (m: string) => void): Promise<void> {
  const result = await api.put<{ message: string }>("/site/branding", { values });
  await refresh();
  onSaved(result.message);
}

function dirtyValues<T extends Record<string, string | null>>(
  form: T, branding: Branding, keys: (keyof Branding)[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const current = form[key as keyof T];
    const saved = (branding as unknown as Record<string, unknown>)[key];
    if (String(current ?? "") !== String(saved ?? "")) {
      out[key as string] = current ?? null;
    }
  }
  return out;
}

function SectionCard({
  title, hint, dirty, busy, error, onSave, onCancel, children,
}: {
  title: string;
  hint?: string;
  dirty: boolean;
  busy: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="font-display text-sm font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-micro text-ink-muted">{hint}</p>}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button className="btn-ghost px-3 py-1.5 text-micro" onClick={onCancel} disabled={busy}>
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          )}
          <button
            className="btn-primary px-3 py-1.5 text-micro"
            onClick={onSave}
            disabled={!dirty || busy}
          >
            {busy ? <Busy label="Saving…" /> : <><Save className="h-3.5 w-3.5" /> Save</>}
          </button>
        </div>
      </div>
      <div className="px-5 py-4">
        {error && <div className="mb-3"><ErrorNote message={error} /></div>}
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- logo

const LOGO_FIELDS: { key: BrandingKey; label: string; hint: string }[] = [
  { key: "logo_url", label: "Main logo", hint: "Used across the website where a single logo fits." },
  { key: "logo_light_url", label: "Light logo", hint: "For light surfaces (default)." },
  { key: "logo_dark_url", label: "Dark logo", hint: "For dark surfaces." },
  { key: "dashboard_logo_url", label: "Dashboard logo", hint: "Shown in the app sidebar." },
];

function LogoSection({
  branding, refresh, onSaved,
}: {
  branding: Branding; refresh: () => Promise<void>; onSaved: (m: string) => void;
}) {
  const [form, setForm] = useState<Record<BrandingKey, string | null>>(() => {
    const initial: Record<string, string | null> = {};
    for (const f of LOGO_FIELDS) initial[f.key] = branding[f.key] as string | null;
    return initial as Record<BrandingKey, string | null>;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dirty = LOGO_FIELDS.some((f) => form[f.key] !== (branding[f.key] as string | null));

  const set = (key: BrandingKey, value: string | null) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await publish(dirtyValues(form, branding, LOGO_FIELDS.map((f) => f.key)), refresh, onSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the logo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Logo"
      hint="Change any logo independently and save just that change."
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onCancel={() => {
        const reset: Record<string, string | null> = {};
        for (const f of LOGO_FIELDS) reset[f.key] = branding[f.key] as string | null;
        setForm(reset as Record<BrandingKey, string | null>);
      }}
    >
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {LOGO_FIELDS.map((field) => (
          <LogoField
            key={field.key}
            label={field.label}
            hint={field.hint}
            value={form[field.key]}
            busy={busy}
            onFile={async (file) => {
              const formData = new FormData();
              formData.append("file", file);
              const media = await api.upload<{ url: string }>(
                `/site/media?category=logo`, formData);
              set(field.key, media.url);
            }}
            onClear={() => set(field.key, null)}
          />
        ))}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------- favicon

function FaviconSection({
  branding, refresh, onSaved,
}: {
  branding: Branding; refresh: () => Promise<void>; onSaved: (m: string) => void;
}) {
  const [value, setValue] = useState<string | null>(branding.favicon_url as string | null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = value !== (branding.favicon_url as string | null);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await publish({ favicon_url: value }, refresh, onSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the favicon.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Favicon"
      hint="The small icon shown in the browser tab."
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onCancel={() => setValue(branding.favicon_url as string | null)}
    >
      <div className="max-w-sm">
        <LogoField
          label="Favicon"
          hint="Square image, typically 32×32 or 64×64."
          value={value}
          busy={busy}
          onFile={async (file) => {
            const formData = new FormData();
            formData.append("file", file);
            const media = await api.upload<{ url: string }>(
              `/site/media?category=logo`, formData);
            setValue(media.url);
          }}
          onClear={() => setValue(null)}
        />
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------- single image

function ImageSection({
  title, hint, field, category, branding, refresh, onSaved,
}: {
  title: string;
  hint: string;
  field: BrandingKey;
  category: string;
  branding: Branding;
  refresh: () => Promise<void>;
  onSaved: (m: string) => void;
}) {
  const [value, setValue] = useState<string | null>(branding[field] as string | null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = value !== (branding[field] as string | null);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await publish({ [field]: value }, refresh, onSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the image.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={title}
      hint={hint}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onCancel={() => setValue(branding[field] as string | null)}
    >
      <div className="max-w-sm">
        <LogoField
          label={title}
          hint={hint}
          value={value}
          busy={busy}
          onFile={async (file) => {
            const formData = new FormData();
            formData.append("file", file);
            const media = await api.upload<{ url: string }>(
              `/site/media?category=${category}`, formData);
            setValue(media.url);
          }}
          onClear={() => setValue(null)}
        />
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------- text

function TextSection({
  title, hint, branding, refresh, onSaved, fields,
}: {
  title: string;
  hint: string;
  branding: Branding;
  refresh: () => Promise<void>;
  onSaved: (m: string) => void;
  fields: { key: BrandingKey; label: string; required?: boolean }[];
}) {
  const initial = () => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = String(branding[f.key] ?? "");
    return out;
  };
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dirty = fields.some((f) => form[f.key] !== String(branding[f.key] ?? ""));

  async function save() {
    if (fields.some((f) => f.required && !form[f.key].trim())) {
      setError("Fill in the required field before saving.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await publish(dirtyValues(form, branding, fields.map((f) => f.key)), refresh, onSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save these settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={title}
      hint={hint}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onCancel={() => setForm(initial())}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required}>
            <input
              className="field"
              value={form[f.key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------- image picker

function LogoField({
  label, hint, value, busy, onFile, onClear,
}: {
  label: string; hint: string; value: string | null;
  busy: boolean; onFile: (file: File) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [broken, setBroken] = useState(false);

  return (
    <div>
      <p className="mb-1.5 text-micro font-medium text-ink-muted">{label}</p>
      <div className="flex items-start gap-3">
        <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-canvas-tint">
          {value && !broken ? (
            <img src={value} alt={label} className="h-full w-full object-contain p-1"
                 onError={() => setBroken(true)} />
          ) : (
            <ImagePlus className="h-5 w-5 text-ink-faint" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-micro leading-relaxed text-ink-faint">{hint}</p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost px-3 py-1.5 text-micro"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? <Busy /> : value ? "Replace" : "Upload"}
            </button>
            {value && (
              <button className="btn-quiet px-3 py-1.5 text-micro text-critical"
                      onClick={onClear}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>
      <input
        ref={input} type="file" className="hidden"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) { setBroken(false); void onFile(file); }
          if (input.current) input.current.value = "";
        }}
      />
      {value && (
        <p className="mt-1.5 flex items-center gap-1 truncate text-micro text-ink-faint">
          <UploadCloud className="h-3 w-3 shrink-0" /> {value.slice(0, 60)}…
        </p>
      )}
    </div>
  );
}

