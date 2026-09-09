# FIXES.md — import reliability and performance audit

This round addressed four reported symptoms: inventory data not saving, file
imports failing unpredictably, "API not connected" while the backend was
running, and slow section loading. They turned out to be six root causes plus a
set of missing screens.

Nothing in the authentication flow, the Supabase schema, the role model or the
visual design was redesigned. Migration `0003_fixes.sql` is additive only.

---

## 1. "API not connected" and slow sections

### The measurement

`services/compute.py` replaces the per-row computation that used to live inside
`routers/intelligence.py`.

`build_row()` needed three things for each inventory line — the SKU's daily
sales series, the store's own sales curve as a fallback, and the supplier lead
time — and fetched each with its own Supabase query, inside a loop:

```python
for row in rows:            # /dashboard passed 500 rows
    build_row(row, cfg)     # demand_for()    -> 1-3 queries
                            # lead_time_for() -> 1 query
```

| Endpoint | Rows | Queries before | Queries after |
|---|---|---|---|
| `GET /api/dashboard` | 500 | ~1,000–2,000 | ~8–15 |
| `GET /api/replenishment` | 400 | ~800–1,600 | ~8–15 |
| `GET /api/inventory` | 50–600 | ~100–1,800 | ~8–15 |
| `GET /api/transfers/suggestions` | 600 | ~1,200–2,400 | ~8–15 |
| `POST /api/alerts/generate` | 500 | ~1,000–2,000 | ~8–15 |

At a realistic 40–80 ms per round trip, the dashboard alone was 40 seconds to
two and a half minutes of purely serial network waiting. `ComputeContext` now
bulk-loads everything the page needs up front, chunking product ids so no
PostgREST URL grows unreasonably long and paging each query to exhaustion
rather than trusting a default row cap. The arithmetic itself is unchanged.

**This is also where "API not connected" came from.** The backend was running
and working; the browser gave up before it finished. See §4.

### Authentication overhead

`core/security.py`. Every authenticated request performed three blocking network
round trips *before the endpoint body ran*: `auth.get_user(token)` against
Supabase Auth, a `profiles` select, and a `user_store_assignments` select. They
ran from an `async def` dependency using a synchronous client, so they blocked
the event loop instead of yielding it — concurrent requests queued behind each
other rather than overlapping.

- HS256 tokens are now verified locally against `SUPABASE_JWT_SECRET`, a setting
  that already existed in the config and was unused. Asymmetric tokens
  (ES256/RS256) still fall back to the Auth API. Invalid and expired tokens are
  rejected either way.
- Resolved identities are cached per token for 60 seconds, bounded in size and
  never past the token's own expiry. `PATCH /api/users/{id}` clears the entry, so
  a role change or deactivation applies immediately.
- The dependency is now `def`, so Starlette runs it in a worker thread.
- `user_store_assignments` is only queried for store managers — nobody else is
  scoped by it.

### Other

- `system_settings` was read on every computed request; now cached for 30
  seconds and invalidated when a super admin saves a setting.
- Gzip on responses over 1 KB.
- An `X-Response-Time-Ms` header and a warning log on anything over 3 seconds,
  so slowness is visible rather than inferred.
- Route-level code splitting in the frontend: the 394 KB charting library is no
  longer downloaded and parsed before the sign-in form appears.

---

## 2. File imports

### The `imports` bucket did not exist

`0002_rls.sql` creates `product-images`. The `imports` bucket was a manual step
in `SUPABASE_SETUP.md`. When it was missed — which is easy — `POST
/api/imports/upload` inserted its `data_imports` row, then threw on the storage
write and returned a 500, leaving an orphaned record. Whether an import worked
depended on setup state nobody had written down, which is exactly what
"unreliable, sometimes fails" describes.

Three changes: the bucket is created on demand by the service-role client;
`0003_fixes.sql` creates it explicitly with admin-only policies; and
`services/import_store.py` keeps a local copy so steps 2–5 no longer depend on
Storage at all. Storage is now the durable archive it was meant to be. If it is
unavailable the wizard still completes and the response says the archive copy
didn't happen.

### `"now()"` is not a valid timestamp literal

PostgreSQL accepts `'now'` as a special datetime input. `'now()'` is a function
call, which is not valid in a value position. The string appeared in seven
places. The worst was `routers/imports.py`:

```python
svc.table("data_imports").update({
    "status": "completed",
    "completed_at": "now()",     # ran AFTER the rows were written
}).eq("id", import_id).execute()
```

A successful import reported itself as a failure. All seven now use a real ISO
timestamp from `core/db.utcnow_iso()`.

### Inventory rows were discarded

Two independent causes, both producing "the import succeeded and wrote nothing":

1. A row whose SKU wasn't already in `products` went to the unmatched queue.
   Importing a stock file before a product master meant every row was unmatched.
2. `RefIndex.store()` returned `None` when the file had no store column and no
   default store was chosen — so every row was unmatched again.

Now: `create_missing_products` (on by default, with a toggle in the wizard)
creates catalog entries from the stock file, and a default store is resolved —
the one you picked, else the only existing store, else a created `MAIN / Main
Store`. The inventory field spec also accepts optional Product Name, Category,
MRP and Image URL columns, so one combined export populates catalog and stock
together.

Verified against the reported failure — stock file, empty catalog, no store
column: **before 0 rows written; after 2 products created, 1 store created, 2
stock rows written, 1 duplicate collapsed.**

### Duplicate SKUs failed whole batches

Validation counted duplicates; the commit passed them straight to `upsert`.
PostgreSQL rejects that outright — *ON CONFLICT DO UPDATE command cannot affect
row a second time* — so one repeated SKU failed all 500 rows in its batch.
Repeated SKUs are completely normal in retail exports (one line per size, per
colour, per warehouse).

Batches are now de-duplicated on the conflict target, last occurrence winning.
A batch that still fails is retried row by row, so one bad row costs one row and
reports why, instead of taking 499 good ones with it.

### Parsing

`services/_parsing.py` is new; `profile_file` and `load_rows` now share it.

- They previously used different code paths — `sheet_name=None` versus
  `sheet_name or 0` — so a workbook whose first sheet wasn't the one the user
  picked silently imported the wrong tab. An unknown sheet name now names the
  sheets that do exist.
- `numpy.int64` is not a Python `int`, so the old type check stringified whole
  numeric columns. `float('inf')` serialises as bare `Infinity`, which is not
  valid JSON and makes the browser's `JSON.parse` throw — surfacing as a
  *connection* error over a *data* problem. Every scalar is coerced explicitly.
- Title rows and merged headers, which pandas reads as `Unnamed: 0, Unnamed: 1`,
  are recovered by promoting the first row that looks like a header.
- CSVs exported from Excel on Windows are usually cp1252; a hard UTF-8 decode
  raised `UnicodeDecodeError`. Encoding and delimiter are both detected.
- `to_number` handles `₹1,234`, `(150)` for -150, `1.234,56`, `12%` and booleans.
  `to_date` handles Excel serial numbers.

Tested against all of the above; see the tables in §5.

---

## 3. Manual product and inventory management

There were **no write endpoints for inventory at all** — the only ways stock
could enter the system were a spreadsheet import or receiving a purchase order.
So when an import failed there was no way forward. Added:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/inventory` | Create or replace a stock record |
| `PATCH` | `/api/inventory/{id}` | Edit levels |
| `POST` | `/api/inventory/{id}/adjust` | Relative change, writes the ledger |
| `DELETE` | `/api/inventory/{id}` | Remove a record |
| `GET` | `/api/inventory/transactions` | Movement history |
| `DELETE` | `/api/products/{id}` | Archive, or `?hard=true` for super admin |
| `DELETE` | `/api/products/{id}/image` | Clear the photo |
| `POST` | `/api/categories` | Create inline from the product form |
| `DELETE` | `/api/imports/{id}` | Remove an import record |

Product image upload had three problems: the object key was built from the raw
filename, so an ordinary name like `Front view (2).jpg` produced a key Supabase
mangles or rejects; nothing checked the content type, so a PDF renamed `.jpg`
would be stored and then fail to render forever; and a storage failure surfaced
as a bare 500. Keys are now sanitised and versioned, type and size are validated
on both sides, and a missing bucket says so.

Every write goes through the existing role guards. `0002_rls.sql` already grants
inventory writes to `is_staff()` with store access — no permission change was
needed.

---

## 4. Error handling

`main.py` translated every failure into one generic 500. supabase-py raises
`postgrest.APIError` carrying a Postgres SQLSTATE, and discarding it threw away
the only information that explained the failure. A 500 on any single panel also
made the whole UI look disconnected.

`core/db.py` maps SQLSTATEs to sensible statuses and sentences: `23505` → 409
"that already exists", `42703`/`PGRST204` → 400 "run the migrations", `42501` →
403 "row-level security refused this write".

On the client, `lib/api.ts`:

- **There was no timeout at all.** A 90-second request and a dead port were
  indistinguishable — both showed a spinner that never resolved, and any error
  that surfaced said "couldn't reach the API". Timeouts are now per endpoint
  (30 s default, 180 s for an import commit) and a timeout reports itself as a
  timeout, with the hint that this is *not* a connection problem.
- Identical concurrent GETs are de-duplicated, so React 18 StrictMode's double
  mount no longer doubles the load.
- Screens pass an `AbortSignal` and cancel superseded requests, which also fixes
  the out-of-order search bug where a slow early response overwrote a fast later
  one.
- The dashboard uses `Promise.allSettled`: a failed sales-trend panel leaves a
  note in its own card and a retry button instead of blanking the page.
- Inventory and product search are debounced at 350 ms. Every keystroke used to
  fire a request, and each of those requests was expensive.

---

## 5. Screens that were placeholders

`/app/products` and `/app/products/:id` rendered "the screen is next up in the
build" — while the Dashboard and the Inventory board both linked into them, so
every product row in the app was a dead end.

Built: **Products** (search, category filter, archived toggle, paging, add /
edit / archive, image upload), **Product detail** (stock by store, movement
history), **Alerts**, **Users**, **Stores**, **Suppliers**, **System settings**,
**Audit logs**.

The Inventory board's search and status filter were applied by the backend
*after* pagination, so they only ever matched within the 50 rows already
fetched — searching for a SKU on page three returned nothing. Filtering now
happens before paging.

Still placeholders, unchanged: forecast, orders, transfers, analytics, reports,
AI insights, what-if simulator, profile. Their APIs are live; the screens were
out of scope for this round.

---

## 6. Verification performed

Backend, with dummy credentials so no live project was touched:

- All 55 routes register; `/openapi.json` and `/docs` generate; `/api/health`
  responds; unauthenticated requests return 401.
- `python -m compileall` clean across `app/` and `scripts/`.

Import engine, against deliberately awkward files:

| Case | Result |
|---|---|
| Excel with title row + blank row + blank column | Header recovered, 5 data rows |
| Multi-sheet workbook, sheet picked by name | Correct sheet; unknown name lists the real ones |
| cp1252 CSV, semicolon delimited, accented text | Parsed (was `UnicodeDecodeError`) |
| JSON wrapped in `{"data": [...]}` | Parsed; malformed JSON reports line and column |
| `₹2,450` / `(150)` / `1.234,56` / `12%` / `TRUE` | 2450 / -150 / 1234.56 / 12 / 1 |
| Excel serial `45731`, `15/03/2025` | Both → `2025-03-15` |
| `.pdf` upload | Rejected with a sentence naming the supported formats |
| Negative MRP | Flagged as invalid rather than imported |

Commit layer, against a fake database that enforces the real `ON CONFLICT`
constraint:

| Case | Before | After |
|---|---|---|
| Stock file, empty catalog, no store column | 0 written, all unmatched | 2 products + 1 store + 2 stock rows |
| Products file with a repeated SKU | Batch rejected | 2 created, 1 collapsed, no error |
| `create_missing_products=False` | — | 3 unmatched, with an explanatory message |

Frontend: `tsc -b` clean, `npm run build` succeeds, 2,271 modules, no warnings.

**Not verified:** nothing here has been run against a live Supabase project.
The database interactions are exercised against a stand-in, not the real
PostgREST. The checklist in `README.md` covers what to confirm on first run.
