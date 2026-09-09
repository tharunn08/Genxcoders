# Data import guide

Two ways to get data in. Both write to the same tables — there is no separate
"demo" dataset anywhere in this project.

1. **Automated seed** (`backend/scripts/import_real_data.py`) — reads the
   workbooks in `data/` and writes them straight to Supabase. Use this once, for
   the initial load.
2. **Import Center** (in the app: *Data imports*, or the **Import Excel** button
   on Products, Inventory, Demand forecast and Smart replenishment) — a
   five-step wizard with column mapping, validation and a preview. Use this for
   everything afterwards.

---

## 1. Automated seed

```bat
cd backend
python scripts\import_real_data.py --dry-run
python scripts\import_real_data.py --purge-sample-stores
```

`--dry-run` parses everything and reports what it *would* write without touching
the database. Always worth running first.

| Flag | What it does |
|---|---|
| `--dry-run` | Parse and report only. Writes nothing. |
| `--purge-sample-stores` | Deletes leftover demo stores. Never deletes a store that has orders against it, and never one listed in `05_stores_available.xlsx`. |
| `--only products inventory` | Run just those steps. Choices: `stores products inventory sales receiving`. |
| `--no-create-missing` | Import stock only for SKUs already in the product master (see the note below). |

Every write is an upsert on the natural key, so re-running the script is safe and
will not duplicate rows.

### What it loads from your files

| File | Goes to | Rows |
|---|---|---|
| `05_stores_available.xlsx` | `stores` | 1 |
| `01_products_200.xlsx` | `products`, `categories`, `subcategories` | 200 products, 11 categories, 73 sub-categories |
| `02_inventory_200.xlsx` | `inventory` + `products` | 200 stock records, **192 additional products** |
| `03_sales_history_200.xlsx` | `store_daily_sales` | 200 days |
| `04_stock_receiving_200.xlsx` | `inventory_transactions` | ~15 matched dispatch lines |

**Total after seeding: 392 products, 200 stock records, 200 days of sales.**

### One thing you should know about your files

Your three data files are different 200-row samples of the same catalogue. They
do not describe the same products:

- Only **8** of the 200 SKUs in `02_inventory_200.xlsx` also appear in
  `01_products_200.xlsx`.
- Only **12** of the SKUs (and 11 of the EANs) in `04_stock_receiving_200.xlsx`
  match the product master.

Discarding the 192 unmatched stock rows would have thrown away real stock for
real products. The stock file carries `Product Name`, `Category`, `MRP` and
`Image URL` on every row, so the script **creates those products from that
file's own columns**. Nothing is invented — the second file is simply treated as
a second source of product records. Pass `--no-create-missing` if you would
rather import stock only for SKUs already in the master.

The dispatch file is different: it has no MRP and no category, so a product
created from it would be a hollow catalogue entry. Those lines are matched on
SKU, then on EAN against `products.barcode`, and any line matching neither is
reported and skipped.

`03_sales_history_200.xlsx` is store-level daily takings with **no SKU column**.
It loads into `store_daily_sales`, which is exactly where the demand engine looks
for a store curve. Forcing it through the SKU-level `sales` importer would have
required inventing a SKU per row.

---

## 2. Import Center — column reference

Headers are matched by fuzzy search, so `Product Code`, `Item Code`, `SKU` and
`Article Code` all resolve to the same field. You can always override the
suggestion on the mapping step. **Required** columns must map to something before
validation will pass.

### Products (`type=products`)

| Field | Required | Header aliases accepted |
|---|---|---|
| SKU | **Yes** | sku, product code, item code, material code, article code, product id, style code, item no |
| Product Name | **Yes** | product name, name, item name, description, title |
| Barcode / EAN | No | barcode, ean, ean13, upc, gtin |
| Category | No | category, cat, product category, department, class |
| Subcategory | No | subcategory, sub category, subclass, segment |
| MRP | No | mrp, price, retail price, selling price, unit price, rate |
| Cost Price | No | cost, cost price, purchase price, landed cost |
| Image URL | No | image, image url, image link, photo, picture, img, thumbnail |

Your `01_products_200.xlsx` maps cleanly with no manual overrides.

### Inventory (`type=inventory`)

| Field | Required | Header aliases accepted |
|---|---|---|
| SKU | **Yes** | sku, product code, item code, article code |
| Current Stock | **Yes** | current stock, stock, qty, quantity, on hand, closing stock, total stock |
| Store | No | store, store code, store name, branch, outlet, location |
| Product Name | No | product name, name, description |
| Category | No | category, product category, department |
| MRP | No | mrp, price, retail price, unit price |
| Image URL | No | image, image url, photo, picture |
| Available Stock | No | available stock, available, store stock, sellable stock |
| Warehouse Stock | No | warehouse stock, warehouse, dc stock, backroom |
| Stock on Route | No | stock on route, on route, in transit |
| Stock on Order | No | stock on order, on order, ordered qty, po qty |
| Inventory Value | No | inventory value, stock value, value, amount |

If the file has no store column, pick a default store on the commit step.

Note: your file uses `-1` to mean out of stock. Stock is a non-negative quantity
in the schema, so negatives are clamped to `0` — which is what "out of stock"
means everywhere else in the app.

### Sales history, per SKU (`type=sales`)

| Field | Required | Header aliases accepted |
|---|---|---|
| SKU | **Yes** | sku, product code, item code |
| Date | **Yes** | date, sale date, transaction date, bill date, posting date |
| Quantity Sold | **Yes** | quantity sold, qty sold, units, sales qty, quantity, sold |
| Store | No | store, store code, branch, outlet |
| Sales Amount | No | sales amount, amount, revenue, net sales, sales value |

### Store daily sales, no SKU (`type=store_sales`)

Use this for DSR-style exports — daily takings per store.

| Field | Required | Header aliases accepted |
|---|---|---|
| Date | **Yes** | date, sale date, business date, day, transaction date |
| Total Sales Amount | **Yes** | total sales, total amount, net sales, sales, revenue, gross sales |
| Store | No | store, store code, store name, branch, outlet |
| Total Units | No | total units, units, quantity, bills, transactions |

This is the type for your `03_sales_history_200.xlsx`.

### Orders, suppliers, replenishment

Also supported — `orders` (po number, order date, SKU, quantity, status),
`suppliers` (supplier name, lead time, email) and `replenishment` (SKU,
replenishment quantity). Same wizard, same mapping step.

---

## 3. Exports

Every export is generated from live database rows.

| Screen | Button | Endpoint |
|---|---|---|
| Inventory | Export to Excel | `GET /api/export/inventory` |
| Products | Export to Excel | `GET /api/export/products` |
| Orders | Export to Excel | `GET /api/export/orders` |
| Demand forecast | Export forecast to Excel | `GET /api/export/forecast` |
| Smart replenishment | Export to Excel | `GET /api/export/inventory` |
| My orders / Warehouse | Excel (per order) | `GET /api/warehouse/orders/{id}/export` |
| Warehouse | Download packing list | `GET /api/warehouse/packing-lists/{id}/export` |

The per-order workbook is byte-for-byte the same file that is attached to the
warehouse notification email, so what the warehouse receives by mail and what
anyone downloads from the UI are the same document.

---

## 4. Forecasting with your data

The forecast engine needs history. With your files loaded it has 200 days of
store-level sales but no SKU-level sales, so it derives per-SKU demand by
spreading each SKU's total across the store's own sales curve. The Demand
forecast screen labels this honestly as `store_pattern_derived` rather than
presenting it as SKU history.

If a product genuinely has no usable history, the screen says
**"Insufficient data for forecasting."** It does not generate a number to fill
the space. To get true SKU-level forecasts, import a per-SKU sales file using
the `sales` type above.
