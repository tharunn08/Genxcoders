import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { api, ApiError, isCancelled } from "@/lib/api";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/primitives";

interface Entry {
  id: number;
  user_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export default function AuditLogs() {
  const [items, setItems] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.get<{ items: Entry[] }>("/audit-logs?limit=200", { signal: controller.signal })
      .then((r) => setItems(r.items))
      .catch((e) => { if (!isCancelled(e)) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  // Filtering happens here because the whole page is already in memory and the
  // endpoint caps at 200 rows.
  const shown = filter.trim()
    ? items.filter((e) =>
        `${e.action} ${e.user_email ?? ""} ${e.entity_type ?? ""}`
          .toLowerCase().includes(filter.trim().toLowerCase()))
    : items;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">Audit logs</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The 200 most recent actions taken in the system.
        </p>
      </header>

      <input
        className="field sm:max-w-xs"
        placeholder="Filter by action, user or entity"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {error && <ErrorNote error={error} />}

      {loading ? <Spinner /> : shown.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={filter ? "No matches" : "Nothing logged yet"}
          body={filter
            ? "No entries match that filter."
            : "Actions are recorded here as people use the system."}
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-micro text-ink-faint">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">Who</th>
                <th className="px-3 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-micro text-ink-faint tnum">
                    {new Date(entry.created_at).toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-2.5 text-micro">{entry.user_email ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <span className="chip bg-canvas-tint text-ink-muted">{entry.action}</span>
                  </td>
                  <td className="max-w-[22rem] truncate px-4 py-2.5 text-micro text-ink-muted">
                    {entry.entity_type ? `${entry.entity_type} · ` : ""}
                    {entry.detail ? JSON.stringify(entry.detail) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
