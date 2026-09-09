import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Image as ImageIcon, Plus, Search, Trash2, UploadCloud } from "lucide-react";
import { api, ApiError, Branding, isCancelled, SiteMedia } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";
import { Busy, ConfirmDialog, Field, Modal, SuccessNote } from "@/components/ui/forms";

const CATEGORY_LABEL: Record<string, string> = {
  logo: "Logo", login: "Login", banner: "Banner", announcement: "Announcement", general: "General",
};

export default function Media() {
  const { branding } = useBranding();
  const [items, setItems] = useState<SiteMedia[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<SiteMedia | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: SiteMedia[] }>("/site/media", { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const refresh = useCallback((message?: string) => {
    if (message) setNotice(message);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Which branding fields reference each asset, so a delete warns properly.
  const usage = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const item of items) {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(branding as Branding)) {
        if (value === item.url) keys.push(key.replace(/_/g, " "));
      }
      if (keys.length) map[item.id] = keys;
    }
    return map;
  }, [items, branding]);

  const filtered = search.trim()
    ? items.filter((m) =>
        `${m.filename} ${m.category}`.toLowerCase().includes(search.trim().toLowerCase()))
    : items;

  async function uploadFile(file: File, category: string) {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await api.upload<SiteMedia>(`/site/media?category=${category}`, formData);
      refresh(`${file.name} uploaded to the media library.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setUploading(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setUploading(true);
    setError(null);
    try {
      await api.del(`/site/media/${deleting.id}`);
      setDeleting(null);
      refresh(`${deleting.filename} deleted.`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setUploading(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Asset URL copied.");
    } catch {
      setNotice("Copy manually — the URL is under the image.");
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <ImageIcon className="h-5 w-5 text-wine" /> Media library
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Approved website assets — logos, login images, banners. Deleting an
            asset that branding uses warns first.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input
              className="field w-56 py-2 pl-9"
              placeholder="Search media"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <UploadDialog onUpload={uploadFile} busy={uploading} />
        </div>
      </header>

      {notice && <SuccessNote message={notice} />}
      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : filtered.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title={search ? "No matching media" : "No media yet"}
          body={search
            ? "Nothing matches that search."
            : "Upload the first asset — it will be available to the branding screens."}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((item) => {
            const usedBy = usage[item.id];
            return (
              <div key={item.id} className="panel overflow-hidden">
                <div className="grid h-28 place-items-center bg-canvas-tint/60 p-2">
                  <img
                    src={item.url} alt={item.filename}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="space-y-1.5 px-3 py-2.5">
                  <p className="truncate text-sm font-medium" title={item.filename}>
                    {item.filename}
                  </p>
                  <p className="text-micro text-ink-faint">
                    {CATEGORY_LABEL[item.category] ?? item.category} ·{" "}
                    {new Date(item.created_at).toLocaleDateString("en-IN")}
                  </p>
                  {usedBy && (
                    <p className="rounded-md bg-peach-light px-2 py-1 text-micro text-wine">
                      Used by: {usedBy.join(", ")}
                    </p>
                  )}
                  <div className="flex gap-1 pt-1">
                    <button className="btn-quiet px-2 py-1 text-micro" onClick={() => copyUrl(item.url)}>
                      <Copy className="h-3.5 w-3.5" /> Copy URL
                    </button>
                    <button
                      className="btn-quiet px-2 py-1 text-micro text-critical"
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Delete ${deleting?.filename}?`}
        body={
          usage[deleting?.id ?? ""]?.length
            ? `This image is currently used by Website Branding (${usage[deleting!.id].join(", ")}). Deleting it will leave those places with the default branding.`
            : "This asset is not used by the live website. It will be removed permanently."
        }
        confirmLabel="Delete asset"
        busy={uploading}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function UploadDialog({
  onUpload, busy,
}: { onUpload: (file: File, category: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("general");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Upload
      </button>
      {open && (
        <Modal
          open
          title="Upload website asset"
          description="JPEG, PNG, WebP, GIF, AVIF or SVG, up to 8 MB."
          onClose={() => { if (!busy) setOpen(false); }}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!file || busy}
                onClick={() => { if (file) onUpload(file, category); setOpen(false); }}
              >
                {busy ? <Busy label="Uploading…" /> : <><UploadCloud className="h-4 w-4" /> Upload</>}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            {error && <p className="text-micro text-critical">{error}</p>}
            <Field label="Category">
              <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
                {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="Image file">
              <input
                type="file" className="field"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 8 * 1024 * 1024) {
                    setError("That file is larger than 8 MB.");
                    setFile(null);
                  } else {
                    setError("");
                    setFile(f);
                  }
                }}
              />
            </Field>
            {file && (
              <p className="text-micro text-ink-muted">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}