# PERFORMANCE_IMPROVEMENTS.md

What makes RetailMind AI fast, and what was optimised.

---

## Where the slowness came from

Two distinct problems produced "the site is slow" and "the API isn't
connected":

1. **A quadratic backend.** The dashboard, replenishment, transfer suggestions
   and alerts each computed rows one at a time, issuing 1–3 Supabase queries
   *per inventory row*. A 500-row dashboard was ~1,000–2,000 sequential HTTPS
   round trips — 40 seconds to minutes of pure serialisation.
2. **An all-or-nothing frontend bundle.** Every screen (including the 440 KB
   charting library) shipped in one chunk, so even the sign-in page paid for
   the dashboard's charts.

---

## Backend

### Batched computation (the big one)

`services/compute.py` loads everything a page needs in a fixed, small number of
queries — sales history, store fallback curves and supplier lead times are
fetched once per page in bulk (`ComputeContext`), then the per-row maths runs
in memory. A 500-row dashboard went from ~1,500 queries to ~8–15. All list
endpoints use it: dashboard, inventory board, replenishment, transfer
suggestions, alerts generation and the what-if baseline.

### Indexes (migration 0003 and 0005)

- `sales (product_id, store_id, sale_date desc)` — the batched demand query
- `product_suppliers (product_id)` — batched lead-time lookup
- `inventory (store_id, available_stock)` — inventory board ordering
- `store_daily_sales (store_id, sale_date)` — fallback curves
- `products (status, name)` — catalog listing with archived excluded
- `inventory (product_id)` and `(store_id, product_id)` — export joins

### Authentication without network calls

`core/security.py` verifies HS256 Supabase JWTs locally against the project
secret (a signature check, not an HTTPS round trip), caches resolved identity
for 60 s, and runs the dependency off the event loop. A dashboard burst that
used to cost several serialised auth calls per request now costs one.

### Cached settings

`load_settings()` caches `system_settings` for 30 s and is invalidated on edit,
so screens stop paying four identical selects each.

### Scoped queries & pagination

- Search on the inventory board resolves matching product ids **in Postgres**
  before paging, instead of filtering the visible page.
- Products and inventory are paginated server-side; dashboard caps at 500 rows.
- Gzip middleware compresses the (much smaller) dashboard payload.
- Exports are capped and streamed.

---

## Frontend

### Route-level code splitting (already in place)

Every screen is `React.lazy`-loaded, so each route pays only for its own code.
`index` bundle ≈ 70 KB; the 440 KB charting library loads only with Dashboard /
Forecast / Analytics / Reports.

### Request de-duplication & timeouts

- Identical concurrent GETs share one in-flight promise (StrictMode double-fires
  no longer double the load).
- Every request has a real timeout with a message that distinguishes "backend
  is still working" from "backend is unreachable".

### Debounced, cancellable search

Products, inventory, orders and the global search debounce input (250–350 ms)
and abort superseded requests so a slow earlier response can't clobber a fast
later one.

### Image handling

Product thumbnails (`Thumb`) are `loading="lazy"`, sized containers, and swap
to a placeholder on error instead of breaking layout.

### New in this round

- **Excel exports** are streamed from the backend as files — no JSON through
  the render tree, no client-side row generation for 10,000 rows.
- The dashboard/insights pages keep using batched endpoints; nothing new
  introduced a per-row query.

---

## Measuring it

The backend logs any request over 3 s with `X-Response-Time-Ms` on every
response. To see the difference yourself on a large catalog, compare the
`X-Response-Time-Ms` header on `/api/dashboard` before and after importing a
few thousand stock records — the response stays in the hundreds of
milliseconds because the query count is fixed, not proportional to row count.

## Rules that keep it fast

- Never compute per row inside a loop — use `build_rows`/`ComputeContext`.
- Always pass a `limit`; the API caps it.
- Never load "everything" into the browser — export files are the bulk path.
- Search goes to the database, not a client-side filter of a loaded page.