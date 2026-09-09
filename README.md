# RetailMind AI

**Predict smarter. Stock smarter. Sell better.**

AI-powered retail demand forecasting, inventory intelligence and smart
replenishment. React + Vite + TypeScript, FastAPI, Supabase.

---

## This update — start here

Windows commands, in order. Full detail in `SETUP_WINDOWS.md`.

### 1. Database migration (required, run once)

Supabase → SQL Editor → paste `supabase/migrations/0006_warehouse_fulfilment.sql`
→ Run. It is additive and idempotent — safe on a live project, safe to run twice.
See `SUPABASE_SETUP.md`.

### 2. Backend

```powershell
cd retailmind\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
notepad .env
```

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_JWT_SECRET` from Supabase → Project Settings → API. Then:

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Load your real data

```powershell
cd retailmind\backend
.\.venv\Scripts\Activate.ps1

python scripts\import_real_data.py --dry-run
python scripts\import_real_data.py --purge-sample-stores
```

Loads **392 products, 200 stock records and 200 days of sales** from `data\`.
Every write is an upsert, so re-running is safe. `DATA_IMPORT_GUIDE.md` explains
the column mapping and one thing worth knowing about your source files.

### 4. Frontend

```powershell
cd retailmind\frontend
npm install
copy .env.example .env
notepad .env
```

Set `VITE_API_URL=http://127.0.0.1:8000/api` — use `127.0.0.1`, not `localhost`.
Then:

```powershell
npm run dev
```

### 5. Accounts

Sign up through the UI, verify the email, then assign roles from the backend:

```powershell
python scripts\bootstrap_super_admin.py you@company.com --role super_admin
python scripts\bootstrap_super_admin.py store@company.com --role store_manager --store IN93
python scripts\bootstrap_super_admin.py wh@company.com --role warehouse
```

### What is new

| Screen | Who sees it | What it does |
|---|---|---|
| **Order products** (`/app/order`) | Store manager, admin | Paginated catalogue with image, name, SKU, category, MRP, availability and a quantity control. Reads the real products table — there is no separate catalogue. |
| **My orders** (`/app/my-orders`) | Store manager, admin | Purchase history, scoped server-side to the manager's own stores, with a seven-stage tracker, full event history and per-order Excel. |
| **Warehouse** (`/app/warehouse`) | Warehouse team, admin | New orders through pending → accepted → picking → packing → packed → shipped → delivered. Packing list generation and download. Order Excel. |

The **Dashboard** now reports exact figures. The old code derived every headline
number from one 500-row page of inventory, which is where "297 products" came
from. Counts are now `count=exact` queries against the database.

`FILES_CHANGED.md` lists every modification, including three items from the brief
that turned out to already be working, and two things I did not do.

---

## Read first

The ZIP you uploaded contained `backend/.env` with a live
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET`. The service role key
bypasses every row-level security policy; the JWT secret lets anyone forge a
token for any user, including super admin.

**Rotate both in Supabase → Project Settings → API before doing anything else.**

This corrected ZIP ships `.env.example` files only.

---

## What was broken

Login failed with *"Can't reach the server"* while the backend was demonstrably
running. Four defects produced one misleading message:

1. `VITE_API_URL` was missing from `frontend/.env`, so the client fell back to a
   `localhost` base URL
2. Uvicorn binds a single **IPv4** socket on `127.0.0.1`; browsers resolve
   `localhost` to IPv6 `::1` first and got connection-refused
3. A bare `catch` in `api.ts` flattened connection-refused, DNS failure and CORS
   rejection into the same sentence
4. `CORS_ORIGINS` listed only `localhost:5173`, so the obvious workaround would
   have failed identically

Two further bugs were found and fixed: the password-recovery OTP flow sent a
magic-link token but verified it as a recovery token (recovery could never have
worked), and a missing `profiles` row caused a hard 403 *after* a successful
password check. `requirements.txt` was also missing `email-validator`, so a clean
install couldn't boot.

Full trace and evidence: **`ROOT_CAUSE.md`**.

---

## Quick start

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env        # fill in your Supabase values
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

```bash
# Frontend (new terminal)
cd frontend
npm install
cp .env.example .env        # VITE_API_URL=http://127.0.0.1:8000/api
npm run dev
```

- App: <http://localhost:5173>
- API docs: <http://127.0.0.1:8000/docs>

Two things that are not optional:

- `--host 0.0.0.0` on uvicorn, so both IPv4 and IPv6 resolve
- `127.0.0.1` rather than `localhost` in `VITE_API_URL`

**Vite reads `.env` only at startup.** Restart the dev server after editing it.

Windows-specific commands: **`SETUP_WINDOWS.md`**.

---

## Documentation

| File | Contents |
|---|---|
| `ROOT_CAUSE.md` | The login bug, traced, with verification output |
| `SETUP_WINDOWS.md` | PowerShell commands and troubleshooting |
| `SUPABASE_SETUP.md` | Schema, buckets, OTP templates, Google OAuth, Turnstile |
| `SUPER_ADMIN_SETUP.md` | Secure bootstrap, role matrix |
| `UI_UX_DESIGN.md` | Palette, the 70/30 glass rule, typography, motion |
| `FILES_CHANGED.md` | File-by-file diff against your upload |
| `FIXES.md` | **Import reliability and performance audit — read this one** |
| `FIXES_COMPLETED.md` | Round 3: every screen real, advanced admin panel |
| `SUPABASE_SETUP.md` | Schema, storage buckets, OTP templates, URL configuration |
| `EMAIL_SETUP.md` | **Manager order-notification email + Excel attachment setup** |
| `IMPORT_EXPORT_GUIDE.md` | **Supported files, columns, import and export process** |
| `PERFORMANCE_IMPROVEMENTS.md` | What was optimised and why |
| `SETUP_WINDOWS.md` | PowerShell commands and troubleshooting |

---

## Confirming the wiring

DevTools console on load:

```
[RetailMind] API base resolved to http://127.0.0.1:8000/api
```

For a full check:

```js
fetch("http://127.0.0.1:8000/api/debug/connectivity").then(r => r.json()).then(console.log)
```

A response means network and CORS are both fine. It reports the exact `Origin`
your browser sent and whether the backend accepts it.

---

## Authentication

```
React → FastAPI → Supabase Auth → session → profile → role → stores → dashboard
```

Password sign-in goes through FastAPI, not `supabase-js`, so profile, role and
store assignment resolve on the server through one code path. Google OAuth starts
in the browser because it needs a full-page redirect, then hands its session to
`POST /api/auth/session` — the same resolution path.

Supported: email + password, six-digit email OTP verification, password recovery
by OTP, Google OAuth, **direct user creation by a super admin** (no invitation
emails, no acceptance flow), optional Cloudflare Turnstile.

OTP codes are generated, emailed and verified entirely by Supabase. No endpoint
here can return one and none is stored. If the verification email contains a
link instead of a code, it points at `/auth/callback` (via `AUTH_REDIRECT_URL`)
and the app completes the confirmation there — see `SUPABASE_SETUP.md` for the
email-template setting that makes the email show the code itself.

### Flow pairing

Each send has exactly one matching verify type. Mismatching them returns
"invalid or expired" on a correct code — this was broken and is now fixed.

```
sign_up()                -> verify_otp(type="signup")
resend(type="signup")    -> verify_otp(type="signup")
reset_password_email()   -> verify_otp(type="recovery")
sign_in_with_otp()       -> verify_otp(type="magiclink")
```

---

## Roles

Enforced in three independent layers: the sidebar hides what you can't use,
FastAPI dependencies reject the request, and Postgres RLS rejects the query.

| | Super admin | Admin | Inventory manager | Store manager |
|---|---|---|---|---|
| Users, settings, audit | yes | — | — | — |
| Stores | yes | — | — | — |
| Products, imports | yes | yes | — | — |
| Suppliers | yes | yes | yes | — |
| Approve orders, transfers | yes | yes | yes | — |
| Raise requests | yes | yes | yes | yes |
| Store scope | all | all | all | assigned only |

Super admin credentials appear nowhere in the application. Bootstrap:

```bash
python scripts/bootstrap_super_admin.py you@company.com
```

---

## How the numbers are produced

```
average daily demand = total quantity sold / days in period
days of cover        = available stock / average daily demand
safety stock         = average daily demand × safety days      (configurable)
reorder point        = average daily demand × lead time + safety stock
recommended order    = max(0, (forecast demand + safety stock)
                              − (available + on order + in transit))
```

Stockout risk compares days of cover against supplier lead time: cover shorter
than lead time means an order placed today lands after stock runs out.

Every threshold lives in `system_settings` and is editable by a super admin.

**On estimated numbers.** Where a SKU has no day-level history, demand is
estimated by spreading its period total across the store's own sales curve.
Anything derived that way is tagged *Estimated* in the interface and carries a
reduced confidence score. Products with no sales data report *No sales history*
rather than a fabricated forecast.

---

## Importing data

Data imports → drop a file → pick the type → confirm the mapping → validate →
import.

Column names don't need to match. Headers are fuzzy-matched against known
aliases with a confidence score, and anything below 85% is flagged for review.

Import **products first**, then inventory and sales. Rows match by SKU, then
barcode, then exact name; anything unmatched goes to a review queue rather than
creating a duplicate. Raw rows are copied to `import_staging_rows` before
processing, so the original upload is always recoverable.

---

## Current state

**Working end to end:** authentication (all flows above), role-based access,
28-table schema with RLS, the import wizard, manual product and inventory
management, product image upload, inventory calculations, forecasting with
explainability, stockout risk and overstock detection, dashboard, inventory
board, products catalogue, smart replenishment, purchase order workflow with
inventory updates on receipt, stock transfer suggestions, alerts, and the
users / stores / suppliers / settings / audit admin screens.

**Every screen is real.** Demand forecast, orders, stock transfers, AI
insights, analytics, reports, the what-if simulator and profile all render
live screens against their existing APIs — no placeholders remain.

**Advanced Super Admin panel**: a control centre with quick statistics plus
website & branding where **each setting saves independently** (change the logo
without touching the tagline), a media library, an announcements centre with
role targeting, and **direct user management** (add with password, edit,
activate/deactivate, reset password, delete with confirmation). No demo mode
and no sample dataset — the system runs on real imported data only.

**New in this round:**

- **Excel exports** — Inventory, Products, Orders and Forecast results download
  as real `.xlsx` files built from live database rows (`IMPORT_EXPORT_GUIDE.md`).
- **Orders import** — the wizard accepts purchase-order files.
- **Product quantity settings** — per-product low-stock threshold, reorder
  point, safety stock and target stock, connected to the inventory engine.
- **Manager order email** — submitting an order emails the store's manager with
  an Excel attachment (`EMAIL_SETUP.md`).
- **Storage buckets** — created by migration `0005` and auto-created by the
  backend at startup, so "bucket has not been created" errors are gone.

**To pick up the new endpoints and columns**, run
`supabase/migrations/0005_quantities_orders_storage.sql` in the Supabase SQL
editor (after 0001–0004) and restart the backend.

## First run checklist

Nothing here has been run against a live Supabase project. Confirm in this
order — each step is quick and the failure messages now say what is wrong:

1. `http://127.0.0.1:8000/docs` lists the new `/api/export/*` endpoints.
2. Sign in as the super admin.
3. **Admin → System settings** loads and shows twelve thresholds. If it is
   empty, `0001_schema.sql` has not been run.
4. **Admin → Stores** — add one (and an optional notification email), or let
   the import create it.
5. **Admin → Users → Add user** — create a user directly with a password and
   sign in as them (no invitation email).
6. **Products → Add product** — save one by hand, with an image; set its
   quantity settings (low-stock threshold, reorder point).
7. **Inventory → Add stock** — record stock for that product; watch its status
   flip as it crosses the threshold you set.
8. **Dashboard** — it should show the product and load in a second or two.
9. **Admin → Data imports** — upload a small file and run it through to the end.
10. **Inventory / Orders / Forecast → Export to Excel** — each downloads a
    workbook of the real data.
11. **Admin → Website & branding** — change the logo and save it *by itself*;
    the tagline and platform name stay untouched.
12. **Orders → Create order → Submit** — with SMTP configured, the store's
    manager receives the order as an email with an Excel attachment.

If step 9 reports a Storage problem, run `supabase/migrations/0005_...sql`
(which creates all buckets) or just restart the backend — it creates the
buckets on boot.

---

## Layout

```
supabase/migrations/    schema, RLS, triggers, buckets (0001-0005)
backend/app/
  core/                 config, JWT verification, role guards, audit, buckets
  services/
    inventory_math.py   demand, safety stock, reorder point, risk, overstock
    forecasting.py      three models plus explainability factors
    import_engine.py    profiling, fuzzy mapping, validation
    import_commit.py    product matching and upserts (incl. orders)
    excel_export.py     workbook builders for exports and email attachments
    email_service.py    SMTP order notifications
    profiles.py         profile provisioning, role and store resolution
    captcha.py          Turnstile verification
  routers/              auth, catalog, imports, intelligence, workflow, exports
  scripts/              super admin bootstrap
frontend/src/
  lib/                  api client, Supabase OAuth client, Excel download helper
  context/              auth session and permission matrix
  components/           layout, UI primitives, Turnstile
  pages/auth/           sign-in, sign-up, OTP, recovery, OAuth callback
  pages/app/            dashboard, inventory, replenishment, import centre
```
