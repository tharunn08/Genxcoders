# FILES_CHANGED.md — round 4 (Excel import/export, user management, OTP, branding, production hardening)

This file lists what changed in this round on top of the previous ZIPs
(round 2: import reliability + performance; round 3: every screen real +
advanced admin panel). Every entry below is a real change in this round.

---

## Supabase migrations — new file

| File | Purpose |
|---|---|
| `supabase/migrations/0005_quantities_orders_storage.sql` | **Run this after 0001–0004.** Per-product quantity settings (`products.low_stock_threshold`, `reorder_point`, `safety_stock`, `target_stock`), `stores.notification_email`, the `orders` import-type enum value, the `order_email_log` table, all three storage buckets with their policies, and export indexes. Additive and idempotent. |

## Backend — new files

| File | Purpose |
|---|---|
| `backend/app/routers/exports.py` | `GET /api/export/inventory`, `/products`, `/orders`, `/forecast` — streams real `.xlsx` files of live data, store-scoped, capped. |
| `backend/app/services/excel_export.py` | openpyxl workbook builders for the four exports plus the single-order email attachment. |
| `backend/app/services/email_service.py` | SMTP sender for order notifications: recipient resolution (store email → admin/inventory-manager profiles → env fallback), HTML body, Excel attachment, graceful failure. |

## Backend — modified files

| File | Change |
|---|---|
| `backend/app/main.py` | Registers the `exports` router; **removed the `demo` router** (demo mode is gone); creates missing storage buckets at startup. **Backend restart required.** |
| `backend/app/core/config.py` | Email settings (`EMAIL_PROVIDER`, `SMTP_*`, `EMAIL_FROM`, `ORDER_NOTIFICATION_EMAILS`), `auth_redirect_url`, and `ensure_storage_buckets()` for the three buckets. |
| `backend/app/routers/auth.py` | `POST /auth/admin/users` now **creates users directly** (name, email, password, role, store, status) via `admin.create_user` with `email_confirm: true` — no invitation email, no acceptance flow. Sign-up passes `email_redirect_to` (the confirmation link lands on the app's callback). |
| `backend/app/routers/catalog.py` | Product quantity settings accepted on create/update; `DELETE /users/{id}` (guarded: no self-delete, no deleting the last active super admin); `POST /users/{id}/reset-password`; `PATCH/DELETE /stores/{id}` (edit + soft deactivate); `DELETE /suppliers/{id}` (soft deactivate). |
| `backend/app/routers/imports.py` | Passes the acting user id into the commit so imported orders record a requester. |
| `backend/app/routers/intelligence.py` | Product embeds now carry the quantity-settings fields so the computation layer sees them. |
| `backend/app/routers/workflow.py` | On submitted orders: builds the Excel attachment and emails the store's manager(s) in a background thread — never blocks or fails the order save; outcome logged to `order_email_log`. |
| `backend/app/services/compute.py` | `build_row` honours per-product `safety_stock` / `reorder_point` / `low_stock_threshold` overrides (null = derive from global settings) and exposes the fields on each computed row, so inventory status, alerts, dashboard, insights and replenishment all react to product-level quantity settings. |
| `backend/app/services/import_engine.py` | New **`orders`** import type (order number, order date, expected date, supplier, store, SKU, quantity, unit price, status, priority, notes) + validation for the new fields. |
| `backend/app/services/import_commit.py` | Orders commit handler: groups file rows by order number into purchase orders + line items, normalises statuses, generates `PO-YYYYMM-NNNN` numbers when missing. |

## Backend — deleted

| File | Reason |
|---|---|
| `backend/app/routers/demo.py` | The hackathon demo dataset/mode is removed from the production system (its router was unregistered in `main.py`; the file is deleted). |

## Frontend — modified files

| File | Change |
|---|---|
| `src/lib/api.ts` | `downloadExcel()` helper, exported `buildUrl`, product quantity-settings fields, store `notification_email`/`status`. |
| `src/pages/app/admin/Users.tsx` | **No invitations.** Add User form (name, email, password, confirm, role, store, status), edit, activate/deactivate, Set/Reset password dialog, delete with confirmation. |
| `src/pages/app/admin/Stores.tsx` | Edit store (incl. notification email), deactivate with confirmation. |
| `src/pages/app/admin/Suppliers.tsx` | Delete (deactivate) with confirmation. |
| `src/pages/app/admin/Branding.tsx` | Rewritten: **every setting edits and saves independently** — per-section Save/Cancel, per-item logo/favicon/image uploads. |
| `src/pages/app/admin/AdminHome.tsx` | Demo dataset section removed; wording updated. |
| `src/components/layout/AppLayout.tsx` | Demo data toggle removed. |
| `src/pages/app/Products.tsx` | Export to Excel button; **Quantity settings** section in the add/edit dialog (low-stock threshold, reorder point, safety stock, target stock). |
| `src/pages/app/ProductDetail.tsx` | Quantity-settings metrics displayed. |
| `src/pages/app/Inventory.tsx` | "Export to Excel" button (backend workbook of the full dataset). |
| `src/pages/app/Orders.tsx` | "Import from Excel" (opens the wizard pre-set to Orders) and "Export to Excel" buttons. |
| `src/pages/app/Forecast.tsx` | "Export forecast to Excel" button. |
| `src/pages/app/ImportCenter.tsx` | Orders import type + `?type=` URL preselect. |
| `src/pages/auth/OAuthCallback.tsx` | Completes **email confirmation/recovery links** (`token_hash`) in addition to Google OAuth — the verification-email link path now works end to end. |

## Documentation

```
README.md                updated quick start + current state, demo references removed
SUPABASE_SETUP.md        migration 0005, all three buckets, OTP template + URL configuration
EMAIL_SETUP.md           NEW — order-notification email + SMTP configuration
IMPORT_EXPORT_GUIDE.md   NEW — supported files, columns, import/export process
PERFORMANCE_IMPROVEMENTS.md  NEW — what was optimised
FIXES_COMPLETED.md       this round's fixes and the reason for each backend change
backend/.env.example     email placeholders + AUTH_REDIRECT_URL (no real secrets)
frontend/.env.example    unchanged values, clearer comments
```

## Not changed

- Backend architecture, authentication system, Supabase credentials/config,
  forecasting / inventory / replenishment maths, RLS model.
- Migration files 0001–0004 are untouched.