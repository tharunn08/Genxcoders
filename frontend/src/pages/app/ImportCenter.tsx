import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, FileSpreadsheet, Upload, XCircle,
} from "lucide-react";
import clsx from "clsx";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";

type MappingEntry = { source: string | null; confidence: number; label: string; required: boolean };
type Mapping = Record<string, MappingEntry>;

interface Sheet { name: string; headers: string[]; row_count: number; sample_rows: any[] }

const IMPORT_TYPES = [
  { value: "products", label: "Product master", hint: "SKU, name, category, MRP, image link" },
  { value: "inventory", label: "Inventory & stock", hint: "Stock on hand, warehouse, in transit" },
  { value: "sales", label: "Sales history (per SKU)", hint: "Date, SKU, quantity sold" },
  // Most real DSR exports are per store per day with no SKU column at all.
  // Forcing those through the SKU-required "sales" type sent every row to the
  // unmatched queue, so they get their own type that writes store_daily_sales.
  { value: "store_sales", label: "Store daily sales (no SKU)",
    hint: "Date, store, total sales amount — daily takings per store" },
  { value: "orders", label: "Orders", hint: "Order number, date, SKU, quantity, status" },
  { value: "suppliers", label: "Suppliers", hint: "Supplier name and lead times" },
  { value: "replenishment", label: "Replenishment", hint: "Required and replenishment quantities" },
];

const STEPS = ["Upload", "Type & sheet", "Map columns", "Validate", "Import"];

export default function ImportCenter() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [importId, setImportId] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetName, setSheetName] = useState("");
  const [importType, setImportType] = useState(() => {
    const requested = params.get("type");
    return IMPORT_TYPES.some((t) => t.value === requested) ? (requested as string) : "products";
  });
  const [mapping, setMapping] = useState<Mapping>({});
  const [validation, setValidation] = useState<any>(null);
  const [mode, setMode] = useState("upsert");
  const [result, setResult] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState("");
  const [createMissing, setCreateMissing] = useState(true);
  const [warning, setWarning] = useState("");
  const [apiError, setApiError] = useState<ApiError | Error | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ imports: any[] }>("/imports").then((r) => setHistory(r.imports)).catch(() => {});
    api.get<{ items: any[] }>("/stores").then((r) => setStores(r.items)).catch(() => {});
  }, [result]);

  if (!can("import_data")) {
    return <EmptyState title="Not available" body="Importing data needs admin access." />;
  }

  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];

  async function handleFile(file: File) {
    setBusy(true); setError(""); setApiError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("import_type", importType);
    try {
      const response = await api.upload<any>("/imports/upload", form);
      setImportId(response.import_id);
      setSheets(response.sheets);
      setSheetName(response.sheets[0]?.name ?? "");
      // A storage archive failure is worth saying out loud, but it does not
      // stop the import — the file is processed from the server's local copy.
      setWarning(response.warning ?? "");
      setStep(1);
    } catch (e) {
      setApiError(e as Error);
    } finally { setBusy(false); }
  }

  async function loadMapping() {
    setBusy(true); setError(""); setApiError(null);
    try {
      const response = await api.post<any>(`/imports/${importId}/suggest-mapping`, {
        import_type: importType, sheet_name: sheetName,
      });
      setMapping(response.mapping);
      setStep(2);
    } catch (e) {
      setApiError(e as Error);
    } finally { setBusy(false); }
  }

  async function runValidation() {
    setBusy(true); setError(""); setApiError(null);
    try {
      setValidation(await api.post<any>(`/imports/${importId}/validate`, {
        import_type: importType, sheet_name: sheetName, mapping,
      }));
      setStep(3);
    } catch (e) {
      setApiError(e as Error);
    } finally { setBusy(false); }
  }

  async function runImport() {
    setBusy(true); setError(""); setApiError(null);
    try {
      setResult(await api.post<any>(`/imports/${importId}/commit`, {
        import_type: importType, sheet_name: sheetName, mapping, mode,
        store_id: storeId || null, skip_invalid: true,
        create_missing_products: createMissing,
      }));
      setStep(4);
    } catch (e) {
      setApiError(e as Error);
    } finally { setBusy(false); }
  }

  function reset() {
    setStep(0); setImportId(""); setSheets([]); setMapping({});
    setValidation(null); setResult(null); setError(""); setApiError(null);
    setWarning("");
  }

  const missingRequired = Object.entries(mapping)
    .filter(([, entry]) => entry.required && !entry.source)
    .map(([, entry]) => entry.label);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold">Data imports</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Bring in Excel, CSV or JSON files. Column names don't need to match — you'll
          confirm the mapping before anything is written.
        </p>
      </header>

      <ol className="flex flex-wrap gap-x-2 gap-y-1.5 text-micro">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span className={clsx(
              "grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold",
              index < step ? "bg-healthy text-white"
                : index === step ? "bg-wine text-white" : "bg-canvas-tint text-ink-faint",
            )}>
              {index < step ? "✓" : index + 1}
            </span>
            <span className={index === step ? "text-ink" : "text-ink-faint"}>{label}</span>
            {index < STEPS.length - 1 && <span className="text-ink-faint">·</span>}
          </li>
        ))}
      </ol>

      {error && <ErrorNote message={error} />}
      {apiError && <ErrorNote error={apiError} />}
      {warning && (
        <div className="rounded-xl border border-low/25 bg-low-soft px-4 py-3 text-sm text-low">
          {warning}
        </div>
      )}
      {busy && (
        <Spinner label={
          step === 3 ? "Importing rows — large files can take a minute…" : "Working…"
        } />
      )}

      {!busy && step === 0 && (
        <>
          <div
            className="panel flex flex-col items-center gap-3 border-dashed px-6 py-14 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <div className="rounded-full bg-canvas-tint p-3">
              <Upload className="h-5 w-5 text-ink-muted" />
            </div>
            <p className="font-display font-semibold">Drop a file here</p>
            <p className="max-w-sm text-sm text-ink-muted">
              Excel (.xlsx), CSV or JSON, up to 50 MB. Every row is stored exactly as
              uploaded before any processing.
            </p>
            <input
              ref={fileInput} type="file" className="hidden"
              accept=".xlsx,.xls,.xlsm,.csv,.tsv,.json"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
            <button className="btn-primary mt-1" onClick={() => fileInput.current?.click()}>
              Choose a file
            </button>
          </div>

          {history.length > 0 && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3.5 font-display text-sm font-semibold">
                Recent imports
              </h2>
              <ul className="divide-y divide-line">
                {history.slice(0, 8).map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.filename}</span>
                      <span className="text-micro text-ink-faint">
                        {row.import_type} · {new Date(row.created_at).toLocaleString("en-IN")}
                      </span>
                    </span>
                    <span className="shrink-0 text-micro tnum text-ink-muted">
                      {row.created_count + row.updated_count} rows
                    </span>
                    <span className={clsx("chip shrink-0",
                      row.status === "completed" ? "bg-healthy-soft text-healthy"
                        : row.status === "failed" ? "bg-critical-soft text-critical"
                        : "bg-canvas-tint text-ink-muted")}>
                      {row.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {!busy && step === 1 && sheet && (
        <div className="space-y-4">
          <section className="panel p-5">
            <h2 className="font-display text-sm font-semibold">What kind of data is this?</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {IMPORT_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setImportType(type.value)}
                  className={clsx(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    importType === type.value
                      ? "border-wine bg-peach-light"
                      : "border-line hover:bg-surface-hover",
                  )}
                >
                  <span className="block text-sm font-medium">{type.label}</span>
                  <span className="mt-0.5 block text-micro text-ink-muted">{type.hint}</span>
                </button>
              ))}
            </div>
          </section>

          {sheets.length > 1 && (
            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Which sheet?</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {sheets.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => setSheetName(s.name)}
                    className={clsx("rounded-lg border px-3 py-2 text-sm",
                      sheetName === s.name ? "border-wine bg-peach-light" : "border-line")}
                  >
                    {s.name}
                    <span className="ml-2 text-micro text-ink-faint tnum">
                      {s.row_count.toLocaleString()} rows
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {["inventory", "sales", "replenishment", "orders"].includes(importType) && (
            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Default store</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Used for rows where the file has no store column. If you leave this
                blank and the file has no store, the first store in the system is
                used — or one called Main Store is created.
              </p>
              <select className="field mt-3" value={storeId}
                      onChange={(e) => setStoreId(e.target.value)}>
                <option value="">Use the file's store column, or the default store</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {stores.length === 0 && (
                <p className="mt-2 text-micro text-ink-faint">
                  No stores exist yet. One will be created automatically.
                </p>
              )}
            </section>
          )}

          {importType === "inventory" && (
            <section className="panel p-5">
              <h2 className="font-display text-sm font-semibold">Products not in the catalog</h2>
              <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-wine"
                  checked={createMissing}
                  onChange={(e) => setCreateMissing(e.target.checked)}
                />
                <span>
                  Create products for SKUs this file references but the catalog
                  doesn't have.
                  <span className="mt-0.5 block text-micro text-ink-muted">
                    With this off, those rows go to the unmatched queue instead —
                    which is what you want only if you plan to import a product
                    master first.
                  </span>
                </span>
              </label>
            </section>
          )}

          <SamplePreview sheet={sheet} />

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={reset}>
              <ArrowLeft className="h-4 w-4" /> Start over
            </button>
            <button className="btn-primary" onClick={loadMapping}>
              Map columns <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {!busy && step === 2 && sheet && (
        <div className="space-y-4">
          <section className="panel overflow-hidden">
            <div className="border-b border-line px-5 py-3.5">
              <h2 className="font-display text-sm font-semibold">Match your columns</h2>
              <p className="mt-0.5 text-micro text-ink-muted">
                We guessed these from your headers. Change anything that looks wrong.
              </p>
            </div>
            <ul className="divide-y divide-line">
              {Object.entries(mapping).map(([field, entry]) => (
                <li key={field} className="grid gap-2 px-5 py-3 sm:grid-cols-[1fr_auto_1.2fr] sm:items-center">
                  <div>
                    <span className="text-sm font-medium">{entry.label}</span>
                    {entry.required && <span className="ml-1.5 text-critical">*</span>}
                    {entry.source && entry.confidence < 85 && (
                      <span className="ml-2 text-micro text-low">check this</span>
                    )}
                  </div>
                  <ArrowLeft className="hidden h-4 w-4 text-ink-faint sm:block" />
                  <select
                    className="field py-2"
                    value={entry.source ?? ""}
                    onChange={(e) => setMapping((prev) => ({
                      ...prev,
                      [field]: { ...prev[field], source: e.target.value || null, confidence: 100 },
                    }))}
                  >
                    <option value="">Not in this file</option>
                    {sheet.headers.map((header) => (
                      <option key={header} value={header}>{header}</option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          {missingRequired.length > 0 && (
            <ErrorNote message={`Map these before continuing: ${missingRequired.join(", ")}.`} />
          )}

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(1)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
            <button className="btn-primary" disabled={missingRequired.length > 0}
                    onClick={runValidation}>
              Validate rows <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {!busy && step === 3 && validation && (
        <div className="space-y-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total rows" value={validation.total_rows} />
            <Stat label="Ready to import" value={validation.valid_rows} tone="healthy" />
            <Stat label="Duplicates" value={validation.duplicate_rows} tone="low" />
            <Stat label="With errors" value={validation.invalid_rows} tone="critical" />
          </section>

          {validation.errors.length > 0 && (
            <section className="panel overflow-hidden">
              <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">
                First {Math.min(validation.errors.length, 10)} problems
              </h2>
              <ul className="divide-y divide-line text-sm">
                {validation.errors.slice(0, 10).map((e: any, i: number) => (
                  <li key={i} className="flex gap-3 px-5 py-2.5">
                    <span className="w-16 shrink-0 text-micro text-ink-faint tnum">
                      Row {e.row_number}
                    </span>
                    <span className="text-ink-muted">{e.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel overflow-hidden">
            <h2 className="border-b border-line px-5 py-3 font-display text-sm font-semibold">
              Preview
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-micro text-ink-faint">
                    <th className="px-5 py-2 font-medium">Row</th>
                    {Object.keys(validation.preview[0]?.data ?? {}).slice(0, 6).map((key) => (
                      <th key={key} className="px-3 py-2 font-medium">{key}</th>
                    ))}
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {validation.preview.slice(0, 10).map((row: any) => (
                    <tr key={row.row_number}>
                      <td className="px-5 py-2 text-micro text-ink-faint tnum">{row.row_number}</td>
                      {Object.keys(validation.preview[0].data).slice(0, 6).map((key) => (
                        <td key={key} className="max-w-[10rem] truncate px-3 py-2 text-ink-muted">
                          {row.data[key] ?? "—"}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <span className={clsx("chip",
                          row.status === "valid" ? "bg-healthy-soft text-healthy"
                            : row.status === "duplicate" ? "bg-low-soft text-low"
                            : "bg-critical-soft text-critical")}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="font-display text-sm font-semibold">How should existing records be handled?</h2>
            <div className="mt-3 space-y-2">
              {[
                ["upsert", "Create new records and update existing ones"],
                ["create_only", "Only create new records, leave existing untouched"],
                ["update_only", "Only update records that already exist"],
                ["skip_duplicates", "Skip anything that already exists"],
              ].map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input type="radio" name="mode" value={value} checked={mode === value}
                         onChange={(e) => setMode(e.target.value)}
                         className="h-4 w-4 accent-wine" />
                  {label}
                </label>
              ))}
            </div>
          </section>

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(2)}>
              <ArrowLeft className="h-4 w-4" /> Back to mapping
            </button>
            <button className="btn-primary" onClick={runImport} disabled={validation.valid_rows === 0}>
              Import {validation.valid_rows.toLocaleString()} rows
            </button>
          </div>
        </div>
      )}

      {!busy && step === 4 && result && (
        <div className="space-y-4">
          <div className="panel flex items-start gap-3 p-5">
            {result.failed > 0
              ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-low" />
              : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-healthy" />}
            <div>
              <h2 className="font-display font-semibold">
                {result.created + result.updated > 0
                  ? "Import finished"
                  : "Import finished — but nothing was written"}
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                {result.created + result.updated > 0
                  ? "Your data is now live across the dashboard, inventory and forecasts."
                  : "Every row was skipped, unmatched or rejected. The details below say why."}
              </p>
            </div>
          </div>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Created" value={result.created} tone="healthy" />
            <Stat label="Updated" value={result.updated} />
            <Stat label="Skipped" value={result.skipped} />
            <Stat label="Failed" value={result.failed} tone={result.failed ? "critical" : undefined} />
            <Stat label="Unmatched" value={result.unmatched} tone={result.unmatched ? "low" : undefined} />
          </section>

          {result.unmatched > 0 && (
            <ErrorNote message={`${result.unmatched} rows couldn't be matched to a product. Review them in the unmatched queue.`} />
          )}
          {result.messages?.length > 0 && (
            <div className="panel p-4 text-micro text-ink-muted">
              {result.messages.map((m: string, i: number) => <p key={i}>{m}</p>)}
            </div>
          )}

          <button className="btn-primary" onClick={reset}>Import another file</button>
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  healthy: "text-healthy", low: "text-low", critical: "text-critical",
};

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-micro text-ink-muted">{label}</p>
      <p className={clsx("mt-0.5 font-display text-xl font-semibold tnum",
        (tone && TONE[tone]) ?? "text-ink")}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function SamplePreview({ sheet }: { sheet: Sheet }) {
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-line px-5 py-3">
        <h2 className="font-display text-sm font-semibold">What we found</h2>
        <p className="mt-0.5 text-micro text-ink-muted tnum">
          {sheet.headers.length} columns · {sheet.row_count.toLocaleString()} rows
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-micro text-ink-faint">
              {sheet.headers.slice(0, 7).map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sheet.sample_rows.slice(0, 4).map((row, i) => (
              <tr key={i}>
                {sheet.headers.slice(0, 7).map((h) => (
                  <td key={h} className="max-w-[9rem] truncate px-4 py-2 text-ink-muted">
                    {String(row[h] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
