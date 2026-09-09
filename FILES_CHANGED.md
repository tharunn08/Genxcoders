# Files changed in this update

Scope was deliberately narrow: fix what was reported, add what was missing,
change nothing else. The existing architecture, authentication, Supabase
integration, import engine and every working screen are untouched.
(The previous update's changelog is preserved as `FILES_CHANGED_PREVIOUS.md`.)

Verified before shipping: `npx tsc --noEmit` clean, `npx vite build` succeeds,
FastAPI imports and registers 81 routes, both Excel workbook builders produce
valid files, and the seed script was run against your real workbooks.

---

## Already working — inspected, not changed

Worth stating plainly, because three items on the brief were already done:

| Brief | Finding |
|---|---|
| §12 Independent branding saves | Already correct. `Branding.tsx` has per-section Edit/Save/Cancel, and `PUT /site/branding` only writes the keys sent. Changing just the logo already changed only the logo. |
| §15 Remove demo mode | Already removed. The only trace was a dead `DemoStatus` interface, now deleted. |
| §2/§3/§17 Product & inventory CRUD | Add / edit / delete / image upload / stock adjust / confirm-before-delete all present and working. |

---

## New files

| File | Purpose |
|---|---|
| `supabase/migrations/0006_warehouse_fulfilment.sql` | Warehouse role, order fulfilment columns, `order_events`, `packing_lists`, `packing_list_items`, store address, configurable warehouse email, RLS, `store_sales` import type, backfill. Additive and idempotent. |
| `backend/app/routers/warehouse.py` | The whole fulfilment pipeline: board, stats, status transitions, packing lists, order Excel, resend email, store-manager order history. |
| `backend/scripts/import_real_data.py` | Reads `data/*.xlsx` and writes to Supabase. Supports `--dry-run`, `--purge-sample-stores`, `--only`, `--no-create-missing`. |
| `frontend/src/pages/app/OrderCatalog.tsx` | §7 Store manager ordering catalogue. |
| `frontend/src/pages/app/MyOrders.tsx` | §8 Purchase history with a seven-stage tracker. |
| `frontend/src/pages/app/warehouse/WarehouseBoard.tsx` | §9/§10 Warehouse board and packing lists. |
| `data/*.xlsx` | Your five workbooks, bundled so the seed script has something to read. |
| `DATA_IMPORT_GUIDE.md` | Column reference for every import type. |

---

## Modified — backend

**`app/routers/intelligence.py`** — the dashboard was rewritten (§1).

This was the "297 products" bug. The old code did:

```python
rows = query.limit(500).execute().data   # every KPI came from this page
```

so `total_products` was really *distinct products among the first 500 inventory
rows*. Now catalogue and order figures are `count="exact"` queries, and unit /
value / low / out-of-stock totals come from a full scan of just the numeric
columns. The expensive demand maths still runs over a bounded slice, but no
headline number depends on it. New keys: `total_categories`, `total_stores`,
`available_products`, `products_without_stock`, `stock_on_route`,
`stock_on_order`, and the seven fulfilment stage counts. `recent_orders` added.

**`app/routers/workflow.py`** — order creation now sets `fulfillment_status`,
records the opening `order_events` row, defaults unit price to the product MRP
(so a store order carries a real value), resolves a delivery address from the
store, and routes the notification to the warehouse recipients with the previous
approver list still copied.

**`app/core/security.py`** — `warehouse` added to `ROLE_RANK` (rank 1: not
store-scoped, but no catalogue or settings access either), plus
`CurrentUser.is_warehouse` and the `require_warehouse` guard.

**`app/services/email_service.py`** — new `warehouse_recipients()`. Resolution
order: `system_settings['warehouse.notification_email']` -> active profiles with
the warehouse role -> the store's `notification_email` -> `ORDER_NOTIFICATION_EMAILS`.
No hard-coded address anywhere; no credential reaches the frontend. Deduplication
was factored into `_unique()`.

**`app/services/excel_export.py`** — new `packing_list_workbook()`. The order
attachment now carries store address, MRP, image URL, warehouse status and unit
totals.

**`app/services/import_engine.py` / `import_commit.py`** — new `store_sales`
import type writing `store_daily_sales`, with `natural_key` handling a type that
has no SKU at all.

**`app/main.py`** — registers the warehouse router.
**`app/services/profiles.py`** — role id 5 mapping; store address in the join.
**`backend/scripts/bootstrap_super_admin.py`** — `--role warehouse`.
**`backend/.env.example`** — warehouse email variables documented.

---

## Modified — frontend

| File | Change |
|---|---|
| `lib/api.ts` | `warehouse` in `Role`; `FULFILMENT_STAGES`/`FULFILMENT_LABEL`; `OrderEvent`, `PackingList`, `PackingListItem`, `WarehouseStats`, `DashboardKpis` types; fulfilment fields on `Order`; `address` on `Store`; dead `DemoStatus` removed. |
| `context/AuthContext.tsx` | `order_products` and `fulfil_orders` permissions; warehouse role in the matrix and `ROLE_LABEL`; `can()` no longer throws on an unknown role. |
| `App.tsx` | Routes `/app/order`, `/app/my-orders`, `/app/warehouse`, each permission-gated and lazy-loaded. |
| `components/layout/AppLayout.tsx` | New "Ordering" nav section; `hideFor` so the warehouse team doesn't see catalogue and analytics screens it has no permission for. |
| `pages/app/Dashboard.tsx` | Catalogue / Inventory / Warehouse operations KPI groups and a Recent orders panel. |
| `pages/app/Products.tsx`, `Inventory.tsx` | **Import Excel** button (§4). |
| `pages/app/Forecast.tsx` | **Import sales history** button, wired to the new `store_sales` type (§5). |
| `pages/app/Replenishment.tsx` | **Import Excel** and **Export to Excel** buttons (§6). |
| `pages/app/ImportCenter.tsx` | `store_sales` added to the type list. |

---

## Not done, and why

**PDF packing lists.** §10 asked for Excel with PDF "optionally, if the existing
project supports it". It doesn't — there is no PDF library in
`requirements.txt`, and adding one to satisfy an optional item would have meant a
new dependency in a build you need to run today. Excel is implemented and
downloads correctly. If you want PDF later it is one `reportlab` dependency and
one function alongside `packing_list_workbook`.

**Automatic email delivery is configured but not proven.** The full backend path
is implemented and the attachment builder is tested, but I have no SMTP
credentials, so I could not send a real message. `EMAIL_SETUP.md` documents
exactly what to set. The order saves regardless — that is enforced by running
delivery on a background thread after the write has already committed.
