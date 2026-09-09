# FIXES_COMPLETED.md — round 4 (Excel import/export, direct user management, OTP verification, independent branding, production hardening)

This round's goal: full Excel import/export for inventory, orders and
forecasting, a real manual-add fallback everywhere, per-product quantity
settings wired into the engine, invitation-free user management, a working
sign-up verification experience, independent branding edits, and a live-data
system with no demo mode. The backend architecture, auth system, Supabase
setup and the forecasting/inventory maths were left in place; every backend
change is additive and documented below with its reason.

---

## 1. Excel export — Inventory, Products, Orders, Forecast

New `GET /api/export/*` endpoints stream real `.xlsx` files (openpyxl, already
a dependency) built from the same live tables the screens read:

| Export | Contents |
|---|---|
| Inventory | Product Image URL, Product Name, SKU, Category, Store, Current Stock, Available Stock, MRP, Inventory Value, Stock Status, Low Stock Threshold, Reorder Point, Safety Stock, Demand/Day, Days of Cover, Risk Level |
| Products | SKU, Barcode, Name, Category, Subcategory, MRP, Cost Price, Image URL, Status, Current Quantity, thresholds, target stock |
| Orders | One row per line: Order ID, Product, SKU, Quantity, Supplier, Store, Order Status, Order Date, Expected Date, Received Date, Priority, Total Value, Created By |
| Forecast | Product, SKU, Store, Forecast Period, Historical Demand Summary, Forecasted Demand, Trend, Recommended Action, Priority, Basis, Confidence |

- Store managers are scoped to their stores; exports respect the active store
  filter.
- **No fake data**: forecast export only includes product/store pairs with real
  sales history, and when nothing can be forecast the workbook says so instead
  of inventing numbers.
- Frontend buttons: **Inventory → Export to Excel**, **Products → Export to
  Excel**, **Orders → Export to Excel**, **Demand forecast → Export forecast to
  Excel**. Downloads go through the authenticated API client.

## 2. Excel import — Orders added, everything else preserved

The wizard already handled products, inventory, sales, suppliers and
replenishment with fuzzy column mapping, per-row validation, preview and an
import summary. This round added the **Orders** import type:

- Required: SKU, Quantity, Order Date. Optional: Order Number, Expected Date,
  Supplier, Store, Unit Price, Status, Priority, Notes.
- Rows sharing one order number become one multi-line purchase order; missing
  numbers get `PO-YYYYMM-NNNN`.
- Status text is normalised (`received`, `complete`, `in transit`, `pending`…
  → the order lifecycle) so real-world exports map cleanly.
- Orders appear on the Orders screen with an **Import from Excel** button that
  opens the wizard pre-set to Orders.

## 3. Manual add/edit/delete everywhere (the fallback path)

Excel is never the only way in:

- **Products** — add/edit/archive/delete, plus quantity settings (below).
- **Inventory** — add stock, edit record, adjust with reason + ledger, delete
  record (endpoint already existed).
- **Orders** — create manually (multi-line), view detail, status workflow,
  cancel; import and export alongside.
- **Suppliers** — add, edit, and now **deactivate** (soft delete) with
  confirmation; deactivated suppliers keep history.
- **Stores** — add, **edit** (including notification email), **deactivate**
  with confirmation.
- **Users** — add with password, edit, activate/deactivate, reset password,
  delete with confirmation (below).
- **Forecast input/history** — forecasting is computed from imported sales
  history, which is manually importable and viewable; there is no separate
  forecast input table to maintain, so none was invented.

All destructive actions use the shared `ConfirmDialog` with a clear message
and success/error notifications.

## 4. Product quantity settings connected to the inventory engine

Migration 0005 adds per-product `low_stock_threshold`, `reorder_point`,
`safety_stock` and `target_stock` (all nullable). `compute.py` now:

- uses `safety_stock` and `reorder_point` as **overrides** when set, otherwise
  derives them from global settings exactly as before;
- flags a product **low** the moment available stock reaches its
  `low_stock_threshold` (unless already critical/out of stock).

Because inventory status, alerts, the dashboard KPIs, AI insights,
replenishment recommendations and the what-if baseline are all computed from
these values, updating a product's quantity (e.g. 170 → 10) propagates through
the whole system on the next load. The Products form and product detail page
expose the four fields; exports include them.

## 5. Users — invitation system removed

- `POST /api/auth/admin/users` no longer sends an invitation. It creates the
  user directly through Supabase Auth (`admin.create_user`, `email_confirm:
  true`) with the password the super admin typed. **No plain-text passwords are
  ever stored or returned** — Supabase hashes them.
- The user signs in immediately with email + password; there is no invite link
  and no acceptance flow.
- Roles continue to use the existing architecture (super admin, admin,
  inventory manager, store manager), and the existing RLS and role guards are
  untouched.

## 6. User management — edit, activate/deactivate, reset password, delete

- **Add user**: name, email, password, confirm password, role, store, status.
- **Edit**: name, role, store assignments, status.
- **Activate / Deactivate**: one click, reflected immediately (the identity
  cache is invalidated server-side).
- **Set/Reset password**: a dedicated dialog that applies a new password via
  Supabase Auth — existing passwords are never shown.
- **Delete**: confirmation dialog; the API refuses to delete your own account
  or the last active super admin, and related history is preserved via
  `ON DELETE SET NULL`/CASCADE.

## 7. Sign-up OTP / email verification fixed

Root cause traced: the sign-up backend called `sign_up()` and Supabase's stock
**Confirm signup** email template sends `{{ .ConfirmationURL }}` — a *link*
pointing at the configured Site URL (`http://localhost:5173` in dev) — while
the app's Verify screen expects a six-digit code. Two fixes plus documentation:

1. **Email now shows the code** (dashboard-side setting): the Confirm signup
   and Reset password templates must include `{{ .Token }}`. Documented with
   copy-paste HTML in `SUPABASE_SETUP.md` §3.
2. **The link path now works too**: the backend passes `email_redirect_to` (=
   `AUTH_REDIRECT_URL`) so the confirmation link lands on `/auth/callback`,
   and `OAuthCallback` exchanges the `token_hash` to complete verification —
   so even an unmodified Supabase template results in a working, real
   verification (no hardcoded or fake OTPs).
3. **URL configuration documented**: Site URL / Redirect URLs for local
   development (`localhost:5173`) vs production (real domain), and the
   `AUTH_REDIRECT_URL` environment variable. Localhost URLs are never baked
   into production emails.

Flow now: Name/Email/Password → Create account → code email (or link) → enter
code on the website (or click the link) → account verified → sign in.

## 8. Website & branding — independent editing

The Branding page was rewritten so every setting has its own **Save / Cancel**:

- **Logo** (main/light/dark/dashboard) — each image has its own preview,
  Change, Remove and a single Save for the logo group.
- **Favicon** — own section.
- **Platform name**, **Tagline & website text**, **Login page**, **Login page
  image**, **Dashboard content**, **Dashboard banner image** — each a separate
  card that only sends its own keys to `PUT /api/site/branding`.

Changing the logo saves the logo and nothing else; you are never forced to
fill unrelated fields. Changes publish globally (sidebar, login page, browser
tab) after refresh, exactly as before.

## 9. Demo mode removed

- The `demo` router is unregistered and `demo.py` deleted; the demo dataset
  UI in the admin panel and the "Demo data" header toggle are gone.
- No demo data is loaded or displayed anywhere. The system runs on imported
  real data; screens show honest "insufficient data" empty states when there
  is nothing to compute from.

## 10. Storage buckets — no more "bucket has not been created"

- Migration 0005 creates **all three buckets** (`product-images`, `imports`,
  `website-media`) with the right policies, idempotently.
- The backend also creates any missing bucket **at startup**
  (`ensure_storage_buckets` in `core/config.py`), so even a fresh project that
  hasn't run the migration works on first boot.
- Buckets are not made wholesale public: `imports` stays private (admin-only,
  service-role access from the backend); the two image buckets are public-read
  with role-restricted writes. No service-role key reaches the frontend.

## 11. Order → manager email with Excel attachment

`services/email_service.py` + a hook in `create_order`:

- When a store manager submits an order, the order is saved first, then a
  background thread builds an Excel file of the order and emails the
  manager(s).
- Recipients: the store's `notification_email` → active admin/inventory-
  manager profiles → `ORDER_NOTIFICATION_EMAILS` env fallback. No personal
  addresses are hard-coded.
- SMTP configuration lives entirely in `backend/.env` (`EMAIL_SETUP.md`); the
  frontend never sees it.
- **Failures never lose the order**: a failed send is logged and recorded in
  `order_email_log` (new table) without affecting the saved order.

## 12. Performance

- New export endpoints stream files instead of round-tripping 10k rows through
  the render tree.
- Batched `ComputeContext` computation (round 2), server-side pagination,
  debounced search, GET de-duplication, local JWT verification, cached
  settings and route-level code splitting remain in place; migration 0005 adds
  the last two indexes for export joins. Details in `PERFORMANCE_IMPROVEMENTS.md`.

## 13. Minimal backend changes — and why each one was required

| Change | Why |
|---|---|
| `supabase/migrations/0005_...sql` (new) | Product quantity columns, store notification email, `orders` enum value, email log table, buckets + policies, indexes. Additive, idempotent. |
| `app/routers/exports.py` + `services/excel_export.py` (new) | Real Excel export needs a server-side workbook builder; openpyxl was already installed. |
| `app/services/email_service.py` (new) | SMTP email with attachment must run server-side (never expose credentials to the frontend). |
| `app/routers/auth.py` (`/admin/users`) | Direct creation is the requested replacement for invitations; `admin.create_user` is the existing secure path. |
| `app/routers/auth.py` (`sign_up`) | Pass `email_redirect_to` so confirmation links land in the app. |
| `app/routers/catalog.py` | User delete/reset-password, store/supplier soft delete, product quantity fields — all additive endpoints. |
| `app/routers/workflow.py` | Order notification hook after the order is saved; background thread so email can never slow the save. |
| `app/services/compute.py` | Read the new product overrides; everything else flows from existing maths. |
| `app/services/import_engine.py` + `import_commit.py` | The orders import type (additive handler alongside products/inventory/sales/…). |
| `app/main.py` | Register exports router, drop demo router, create buckets on boot. |
| Frontend pages listed in `FILES_CHANGED.md` | Buttons, forms and dialogs for the features above, using the existing design system. |

## 14. Verification performed

- `npm run build` (tsc + vite production build) passes cleanly.
- Backend imports: `python -m py_compile` on every changed module, and the app
  boots with all routers registered (70 routes, `/api/export/*`, `/api/users/*`
  present; `/api/demo/*` absent).
- No destructive command was run; no live database was touched. The migration
  is written to be applied in the Supabase SQL editor (0001 → 0005 in order).