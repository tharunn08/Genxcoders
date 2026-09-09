/**
 * API client.
 *
 * Two rules this file exists to enforce:
 *
 * 1. The URL is built once, correctly. A trailing slash, a missing /api, or a
 *    duplicated /api all resolve to the same correct endpoint.
 * 2. A failure reports what actually failed. `fetch` rejects with an opaque
 *    TypeError for connection-refused and CORS-rejection alike — reporting both
 *    as "the server is down" sends you looking in the wrong place.
 */

const RAW_BASE = import.meta.env.VITE_API_URL;
const FALLBACK = "http://127.0.0.1:8000/api";

function normaliseBase(raw: string | undefined): string {
  let base = (raw ?? "").trim();

  if (!base) {
    if (import.meta.env.DEV) {
      console.warn(
        `[RetailMind] VITE_API_URL is not set — falling back to ${FALLBACK}. ` +
        "Create frontend/.env with VITE_API_URL=http://127.0.0.1:8000/api and " +
        "restart the dev server. Vite only reads .env files at startup.",
      );
    }
    base = FALLBACK;
  }

  base = base.replace(/\/+$/, "");            // drop trailing slashes
  base = base.replace(/(\/api)+$/, "/api");   // collapse /api/api -> /api
  if (!/\/api$/.test(base)) base += "/api";   // guarantee exactly one /api

  return base;
}

export const API_BASE = normaliseBase(RAW_BASE);

export function buildUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  // Guard the other direction: a caller passing "/api/auth/x" would otherwise
  // produce /api/api/auth/x.
  return API_BASE + suffix.replace(/^\/api(?=\/)/, "");
}

const TOKEN_KEY = "rm.access_token";
const REFRESH_KEY = "rm.refresh_token";

export const tokens = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY),
  /** persist=false keeps the session in sessionStorage, cleared when the tab closes. */
  set: (access: string, refresh?: string, persist = true) => {
    const store = persist ? localStorage : sessionStorage;
    const other = persist ? sessionStorage : localStorage;
    other.removeItem(TOKEN_KEY);
    other.removeItem(REFRESH_KEY);
    store.setItem(TOKEN_KEY, access);
    if (refresh) store.setItem(REFRESH_KEY, refresh);
  },
  clear: () => {
    for (const store of [localStorage, sessionStorage]) {
      store.removeItem(TOKEN_KEY);
      store.removeItem(REFRESH_KEY);
    }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Turns an opaque fetch rejection into something actionable. */
function diagnoseNetworkFailure(url: string, cause: unknown): ApiError {
  const target = new URL(url);
  const pageHost = window.location.hostname;
  const apiHost = target.hostname;
  const hints: string[] = [];

  // The most common cause on Windows: uvicorn binds one IPv4 socket at
  // 127.0.0.1, while the browser resolves "localhost" to ::1 first.
  if (apiHost === "localhost") {
    hints.push(
      "Your API URL uses 'localhost'. Uvicorn binds only 127.0.0.1 by default and " +
      "browsers may try IPv6 (::1) first. Use http://127.0.0.1:8000/api, or start " +
      "the backend with --host 0.0.0.0.",
    );
  }

  if (pageHost !== apiHost && (pageHost === "localhost" || pageHost === "127.0.0.1")) {
    hints.push(
      `The page is served from ${pageHost} but the API is on ${apiHost}. Those are ` +
      `different origins, so CORS_ORIGINS in backend/.env must include ` +
      `http://${pageHost}:${window.location.port}.`,
    );
  }

  hints.push(`Check the backend directly: open ${target.origin}/health in a tab.`);

  if (import.meta.env.DEV) {
    console.error(
      `[RetailMind] Request to ${url} failed before any response arrived.\n` +
      "That means one of: backend not running, wrong host/port, or CORS rejection.\n" +
      hints.map((h) => "  - " + h).join("\n"),
      cause,
    );
  }

  return new ApiError(
    0,
    "Couldn't reach the API.",
    cause instanceof Error ? cause.message : String(cause),
    hints.join(" "),
  );
}

const STATUS_MESSAGE: Record<number, string> = {
  400: "That request wasn't valid.",
  408: "The server took too long to answer.",
  401: "Email or password is incorrect.",
  403: "You don't have access to this.",
  404: "That endpoint doesn't exist on the server.",
  409: "That conflicts with something that already exists.",
  410: "That code has expired.",
  422: "Some details need fixing.",
  429: "Too many attempts. Wait a moment and try again.",
  500: "Something went wrong on the server.",
  502: "The server couldn't reach a service it depends on.",
  503: "A service the server depends on is unavailable.",
  413: "That file is too large.",
};

const STATUS_HINT: Record<number, string> = {
  404: "The path exists in the frontend but not the backend — check the /api prefix.",
  500: "The uvicorn terminal has the full traceback.",
  408: "The request reached the backend — it just hadn't finished. This is not a connection problem.",
  502: "The backend is up but Supabase (database or storage) didn't answer.",
};

/**
 * How long to wait before deciding a request is never going to answer.
 *
 * There was no timeout at all. A request that took ninety seconds and a request
 * to a dead port were indistinguishable to the user — both showed a spinner
 * that never resolved, and any error that did surface said "couldn't reach the
 * API". That is the "API not connected while the backend is running" report:
 * the backend was running, it was just still working.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const SLOW_PATHS: [RegExp, number][] = [
  [/^\/imports\/[^/]+\/(commit|validate)/, 180_000],
  [/^\/imports\/upload/, 120_000],
  [/^\/products\/[^/]+\/image/, 60_000],
  [/^\/alerts\/generate/, 120_000],
  [/^\/(dashboard|replenishment|inventory|transfers\/suggestions)/, 60_000],
];

function timeoutFor(path: string): number {
  for (const [pattern, ms] of SLOW_PATHS) if (pattern.test(path)) return ms;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * In-flight GET de-duplication.
 *
 * React 18 StrictMode mounts every component twice in development, so each
 * screen fired each of its requests twice. On endpoints that took tens of
 * seconds that doubled the load for no benefit. Identical concurrent GETs now
 * share one response.
 */
const inFlight = new Map<string, Promise<any>>();

export interface RequestOptions extends RequestInit {
  /** Caller-supplied abort signal, for cancelling on unmount or re-query. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set false to bypass GET de-duplication (e.g. an explicit Refresh button). */
  dedupe?: boolean;
}

async function performRequest<T>(path: string, init: RequestOptions): Promise<T> {
  const url = buildUrl(path);
  const headers = new Headers(init.headers);

  const token = tokens.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // FormData must set its own multipart boundary; forcing a Content-Type here
  // produces a body the server can't parse.
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const limit = init.timeoutMs ?? timeoutFor(path);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException(
    `Timed out after ${Math.round(limit / 1000)}s`, "TimeoutError")), limit);

  // Honour a caller's signal as well as our own deadline.
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener("abort",
      () => controller.abort(init.signal!.reason), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted) {
      // A cancellation the caller asked for is not a failure worth reporting.
      if (init.signal?.aborted) throw new ApiError(-1, "Request cancelled.");
      throw new ApiError(
        408,
        `The server took longer than ${Math.round(limit / 1000)} seconds to answer.`,
        String((controller.signal as any).reason ?? "timeout"),
        "The backend is reachable but slow. Large imports and first loads on a " +
        "big catalog take longest; try again, or narrow the store filter.",
      );
    }
    throw diagnoseNetworkFailure(url, cause);
  } finally {
    window.clearTimeout(timer);
  }

  // A 401 from sign-in means bad credentials, not an expired session — don't
  // bounce the user to a page they are already on.
  if (response.status === 401 && !path.includes("/auth/sign-in")) {
    const hadToken = Boolean(token);
    tokens.clear();
    if (hadToken && !location.pathname.startsWith("/sign-in")) {
      location.href = "/sign-in?expired=1";
    }
    throw new ApiError(401, "Your session expired. Sign in again.");
  }

  const text = await response.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.ok ? 502 : response.status,
        response.ok
          ? "The server replied with something that isn't JSON."
          : `The server returned ${response.status}, but not JSON.`,
        text.slice(0, 300),
        "Check that VITE_API_URL points at FastAPI and not at the Vite dev server.",
      );
    }
  }

  if (!response.ok) {
    const detail = payload?.detail;
    let message: string;

    if (typeof detail === "string") {
      message = detail;
    } else if (Array.isArray(detail)) {
      message = detail
        .map((d: any) => {
          const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : "";
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .join(" · ");
    } else {
      message = STATUS_MESSAGE[response.status] ?? `Request failed (${response.status}).`;
    }

    if (import.meta.env.DEV) {
      console.error(`[RetailMind] ${response.status} ${init.method ?? "GET"} ${url}`, payload);
    }

    throw new ApiError(
      response.status, message,
      payload?.error ?? payload?.db_detail,
      STATUS_HINT[response.status],
    );
  }

  return payload as T;
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const shouldDedupe = method === "GET" && init.dedupe !== false && !init.signal;

  if (!shouldDedupe) return performRequest<T>(path, init);

  const key = `${method} ${path}`;
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = performRequest<T>(path, init).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise as Promise<T>;
}

/** True when an error is a deliberate cancellation rather than a real failure. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ApiError && error.status === -1;
}

export const api = {
  get: <T,>(path: string, options: RequestOptions = {}) => request<T>(path, options),
  post: <T,>(path: string, body?: unknown, options: RequestOptions = {}) =>
    request<T>(path, {
      ...options, method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T,>(path: string, body: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: "PATCH", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: "PUT", body: JSON.stringify(body) }),
  del: <T,>(path: string, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: "DELETE" }),
  upload: <T,>(path: string, form: FormData, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: "POST", body: form }),
};

/**
 * Download a file endpoint (Excel exports) as an attachment.
 *
 * Uses the same auth header and base URL as every other request, then triggers
 * a browser download from a blob. Errors surface as ApiError with the server's
 * JSON detail instead of a silent blob.
 */
export async function downloadExcel(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  const token = tokens.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  const response = await fetch(buildUrl(path), { headers });
  if (!response.ok) {
    let message = `Export failed (${response.status}).`;
    try {
      const payload = await response.json();
      if (typeof payload.detail === "string") message = payload.detail;
    } catch { /* non-JSON error body */ }
    throw new ApiError(response.status, message);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

if (import.meta.env.DEV) {
  console.info(`[RetailMind] API base resolved to ${API_BASE}`);
}

// ---------------------------------------------------------------- types

export type Role =
  | "super_admin" | "admin" | "inventory_manager" | "store_manager" | "warehouse";

export interface Store {
  id: string;
  code: string;
  name: string;
  location?: string;
  /** Postal delivery address, printed on packing lists and order emails. */
  address?: string | null;
  contact_phone?: string | null;
  status?: "active" | "inactive" | "archived";
  notification_email?: string | null;
}

// ---------------------------------------------------------------- warehouse

/** The warehouse pipeline, in order. Shared by the board and the tracker. */
export const FULFILMENT_STAGES = [
  "pending", "accepted", "picking", "packing", "packed", "shipped", "delivered",
] as const;

export type FulfilmentStatus = typeof FULFILMENT_STAGES[number] | "cancelled";

export const FULFILMENT_LABEL: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  picking: "Picking",
  packing: "Packing",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export interface OrderEvent {
  id: number;
  order_id: string;
  kind: string;
  from_state: string | null;
  to_state: string | null;
  note: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface PackingList {
  id: string;
  order_id: string;
  packing_number: string;
  store_name: string | null;
  store_address: string | null;
  store_manager: string | null;
  packed_by_name: string | null;
  packing_date: string;
  total_lines: number;
  total_units: number;
  notes: string | null;
  created_at: string;
  po_number?: string | null;
  warehouse_name?: string | null;
  purchase_orders?: { po_number: string } | null;
}

export interface PackingListItem {
  id: string;
  sku: string | null;
  product_name: string | null;
  image_url: string | null;
  mrp: number | null;
  quantity: number;
  packed_quantity: number;
}

export interface WarehouseStats {
  stages: Record<string, number>;
  new_orders: number;
  to_pack: number;
  packed: number;
  shipped: number;
  delivered: number;
  total: number;
  shipped_today: number;
}

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  email_verified: boolean;
  stores: Store[];
}

export interface AuthConfig {
  captcha_enabled: boolean;
  google_enabled: boolean;
  oauth_redirect_url: string;
  environment: string;
}

export type StockStatus = "out_of_stock" | "critical" | "low" | "healthy" | "overstock";

export interface InventoryRow {
  /** inventory row id — needed to edit or adjust a specific stock record. */
  inventory_id?: string;
  product_id: string;
  store_id: string;
  store_name?: string | null;
  store_code?: string | null;
  sku: string;
  name: string;
  image_url: string | null;
  mrp: number | null;
  current_stock: number;
  available_stock: number;
  warehouse_stock: number;
  stock_on_route: number;
  stock_on_order: number;
  inventory_value: number | null;
  category_id?: string | null;
  category_name?: string | null;
  avg_daily_demand: number;
  demand_basis: "sku_history" | "store_pattern_derived" | "no_data";
  demand_note: string;
  days_of_stock: number | null;
  lead_time_days: number;
  safety_stock: number;
  safety_method: string;
  reorder_point: number;
  /** Per-product override exposed for display/export (null = derived). */
  low_stock_threshold?: number | null;
  target_stock?: number | null;
  stock_status: StockStatus;
  risk_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  risk_reason: string;
  expected_stockout_date: string | null;
  recommended_qty?: number;
  forecast_demand?: number;
  priority?: "critical" | "high" | "medium" | "low";
  reason?: string;
}

export interface ForecastFactor {
  factor: string;
  impact: "low" | "medium" | "high";
  direction: "positive" | "negative" | "neutral";
  detail: string;
}

export interface Category { id: string; name: string }

export interface Product {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  category_id: string | null;
  subcategory_id: string | null;
  mrp: number | null;
  cost_price: number | null;
  image_url: string | null;
  description?: string | null;
  status: "active" | "inactive" | "archived";
  created_at?: string;
  updated_at?: string;
  categories?: { id: string; name: string } | null;
  subcategories?: { id: string; name: string } | null;
  /** Summed across stores by the products endpoint. */
  available_stock?: number;
  /** Number of stores with a stock record; 0 = "Inventory not added". */
  inventory_records?: number;
  /** Per-product quantity settings (migration 0005). Null = derived. */
  low_stock_threshold?: number | null;
  reorder_point?: number | null;
  safety_stock?: number | null;
  target_stock?: number | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  message?: string;
  truncated?: boolean;
}

export interface StockTransaction {
  id: string;
  product_id: string;
  store_id: string;
  delta: number;
  reason: string;
  note: string | null;
  created_at: string;
  products?: { sku: string; name: string } | null;
  stores?: { code: string; name: string } | null;
}

// ---------------------------------------------------------------- forecast

export interface ForecastPoint {
  date: string;
  predicted_qty: number;
  lower_bound?: number | null;
  upper_bound?: number | null;
}

export interface ForecastResult {
  available: boolean;
  message?: string;
  action?: string;
  method?: string;
  basis?: string;
  basis_label?: string;
  horizon_days?: number;
  avg_daily_demand?: number;
  total_forecast?: number;
  confidence?: number;
  trend_direction?: "up" | "down" | "flat";
  trend_pct?: number;
  history_days?: number;
  history?: { date: string; actual: number }[];
  points?: ForecastPoint[];
  factors?: ForecastFactor[];
  demand_note?: string;
}

// ---------------------------------------------------------------- orders & transfers

export interface OrderItem {
  id: string;
  quantity: number;
  received_quantity: number;
  unit_price: number | null;
  line_total?: number | null;
  products?: { id: string; sku: string; name: string; image_url: string | null; mrp?: number | null } | null;
}

export interface Order {
  id: string;
  po_number: string;
  /** Warehouse pipeline state, independent of `status`. */
  fulfillment_status?: FulfilmentStatus;
  fulfillment_step?: number;
  fulfillment_total_steps?: number;
  order_source?: string;
  delivery_address?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  warehouse_notes?: string | null;
  accepted_at?: string | null;
  packed_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  line_count?: number;
  unit_count?: number;
  events?: OrderEvent[];
  requested_by_profile?: { full_name: string | null; email: string } | null;
  store_id: string;
  supplier_id: string | null;
  status: string;
  priority: string;
  requested_by: string | null;
  requested_date: string;
  expected_date: string | null;
  received_date: string | null;
  notes: string | null;
  total_value: number | null;
  created_at: string;
  stores?: { id?: string; code: string; name: string;
             address?: string | null; location?: string | null;
             contact_phone?: string | null } | null;
  suppliers?: { name: string } | null;
  purchase_order_items?: OrderItem[];
}

export interface TransferItem {
  id: string;
  quantity: number;
  received_quantity: number;
  products?: { id: string; sku: string; name: string; image_url: string | null } | null;
}

export interface Transfer {
  id: string;
  transfer_number: string;
  source_store_id: string;
  dest_store_id: string;
  status: string;
  priority: string;
  reason: string | null;
  created_at: string;
  source?: { code: string; name: string } | null;
  dest?: { code: string; name: string } | null;
  stock_transfer_items?: TransferItem[];
}

export interface TransferSuggestion {
  product_id: string;
  sku: string;
  name: string;
  image_url: string | null;
  source_store_id: string;
  source_store_name: string;
  source_available: number;
  dest_store_id: string;
  dest_store_name: string;
  dest_available: number;
  dest_risk: string;
  quantity: number;
  reason: string;
}

// ---------------------------------------------------------------- site admin

export interface Branding {
  platform_name: string;
  short_name: string;
  website_title: string;
  website_subtitle: string;
  company_name: string;
  support_email: string | null;
  footer_text: string;
  logo_url: string | null;
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  login_logo_url: string | null;
  dashboard_logo_url: string | null;
  login_welcome_title: string;
  login_welcome_subtitle: string;
  login_background_url: string | null;
  login_announcement: string | null;
  dashboard_welcome_title: string | null;
  dashboard_welcome_message: string | null;
  dashboard_banner_url: string | null;
  announcement_banner: string | null;
}

export interface SiteMedia {
  id: string;
  filename: string;
  storage_path: string;
  url: string;
  mime_type: string | null;
  size_bytes: number | null;
  category: string;
  uploaded_by: string | null;
  created_at: string;
  profiles?: { full_name: string | null; email: string } | null;
}

export interface Announcement {
  id: string;
  title: string;
  message: string;
  image_url: string | null;
  priority: string;
  target_roles: string[] | null;
  start_at: string | null;
  end_at: string | null;
  is_published: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardKpis {
  total_products: number;
  active_products: number;
  inactive_products: number;
  total_categories: number;
  products_without_stock: number;
  stock_records: number;
  active_skus: number;
  total_units: number;
  total_value: number;
  stock_on_route: number;
  stock_on_order: number;
  available_products: number;
  low_stock: number;
  out_of_stock: number;
  critical: number;
  overstock: number;
  healthy: number;
  total_stores: number;
  total_orders: number;
  pending_orders: number;
  accepted_orders: number;
  picking_orders: number;
  packing_orders: number;
  packed_orders: number;
  shipped_orders: number;
  delivered_orders: number;
  pending_requests: number;
}
