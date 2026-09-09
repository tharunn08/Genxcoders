# IMPORT_EXPORT_GUIDE.md

Excel import and export for RetailMind AI — what's supported, what the columns
mean, and how the flows work.

---

## Supported files

**Imports** (Admin → Data imports, or the Import button on the Orders page):

- Excel: `.xlsx`, `.xls`, `.xlsm`
- CSV / TSV / text: `.csv`, `.tsv`, `.txt`
- JSON: `.json`
- Up to 50 MB per file

Column **names don't need to match** — the wizard fuzzy-matches your headers to
the fields below (confidence ≥ 85% is trusted; lower scores are flagged for
review) and lets you remap anything before a single row is written.

**Exports** — real `.xlsx` files built from the current database:

| Screen | Button | Endpoint |
|---|---|---|
| Inventory | Export to Excel | `GET /api/export/inventory` |
| Products | Export to Excel | `GET /api/export/products` |
| Orders | Export to Excel | `GET /api/export/orders` |
| Demand forecast | Export forecast to Excel | `GET /api/export/forecast` |

Exports respect your current store filter where applicable and are capped at
10,000 rows (forecast at 250 product/store pairs) so a huge catalog can't
freeze the browser.

---

## Import types and their columns

Required fields are marked ★. Everything else is optional and fuzzy-matched.

### Products (product master)

| Field | Notes |
|---|---|
| SKU ★ | Product code. Duplicate SKUs are detected and reported. |
| Product Name ★ | |
| Barcode / EAN | Used as a secondary match key |
| Category / Subcategory | Created automatically if missing |
| MRP / Cost Price | |
| Image URL | `http(s)://…` links only |

### Inventory & stock

| Field | Notes |
|---|---|
| SKU ★ | Matched to the catalog by SKU, then barcode, then exact name |
| Current Stock ★ | |
| Available Stock | Defaults to current stock when blank |
| Warehouse Stock / Stock on Route / Stock on Order | |
| Inventory Value | |
| Store | Store code or name. Missing rows use the default store chosen in the wizard (or the first store / a new `Main Store`). |
| Product Name / Category / MRP / Image URL | Optional — used to *create* the product when the catalog doesn't have the SKU (tick "create missing products"). |

### Sales history (feeds forecasting)

| Field | Notes |
|---|---|
| SKU ★ | |
| Date ★ | Dates in almost any format; Excel serial numbers are handled |
| Quantity Sold ★ | |
| Sales Amount | |
| Store | Optional; defaults to the chosen store |

### Orders

| Field | Notes |
|---|---|
| SKU ★ | Must exist in the catalog |
| Quantity ★ | |
| Order Date ★ | |
| Order Number | Rows sharing one number become one multi-line order. Missing numbers generate `PO-YYYYMM-NNNN`. |
| Expected Date / Supplier / Unit Price / Priority / Notes / Status | Status text is normalised (`received`, `complete`, `in transit`, `pending`… map onto the order lifecycle). |

### Suppliers

| Field | Notes |
|---|---|
| Supplier Name ★ | |
| Supplier ID / Code / Contact Email | |
| Product SKU | Links the supplier to a product with a lead time |
| Lead Time (days) | |

### Replenishment

| Field | Notes |
|---|---|
| SKU ★ | |
| Replenishment Quantity ★ | |
| Store / Current Stock / Required Quantity | |

---

## Import process (step by step)

1. **Upload** — drop the file. It is parsed first; unreadable files cost
   nothing and return a specific error ("This file couldn't be read…").
2. **Type & sheet** — pick what the data is and which sheet to use.
3. **Map columns** — the wizard shows its best guess for every field with a
   confidence score. Change anything; required fields must be mapped before
   continuing.
4. **Validate** — every row is checked and you get counts:
   `Total rows / Ready to import / Duplicates / With errors`, a preview of the
   first rows, and the first 10 problems with row numbers. Errors are specific:
   "SKU is empty", "'abc' isn't a number", "'31/02/2025' isn't a recognisable
   date", "Duplicate SKU"…
5. **Import** — choose how existing records are handled:
   - **upsert** — create new, update existing (default)
   - **create_only** — only new records
   - **update_only** — only existing records
   - **skip_duplicates** — skip anything already present
6. **Summary** — `Created / Updated / Skipped / Failed / Unmatched` with the
   reasons for anything skipped, plus a "created N products the catalog didn't
   have" note where relevant.

Raw rows are always copied to `import_staging_rows` before processing, so the
original upload is recoverable. Unmatched rows go to the review queue instead
of creating duplicates.

---

## Export contents

### Inventory (`inventory-YYYY-MM-DD.xlsx`)

Product Image URL, Product Name, SKU, Category, Store, Current Stock, Available
Stock, MRP, Inventory Value, Stock Status, Low Stock Threshold, Reorder Point,
Safety Stock, Demand/Day, Days of Cover, Risk Level.

### Products (`products-YYYY-MM-DD.xlsx`)

SKU, Barcode, Name, Category, Subcategory, MRP, Cost Price, Image URL, Status,
Current Quantity (summed across stores), Low Stock Threshold, Reorder Point,
Safety Stock, Target Stock, Inventory Records.

### Orders (`orders-YYYY-MM-DD.xlsx`)

One row per order line: Order ID, Product, SKU, Quantity, Supplier, Store,
Order Status, Order Date, Expected Date, Received Date, Priority, Total Value,
Created By.

### Forecast (`forecast-YYYY-MM-DD.xlsx`)

Product, SKU, Store, Forecast Period, Historical Demand Summary, Historical
Avg/Day, Forecasted Demand, Trend, Trend %, Recommended Action, Recommendation
Priority, Basis, Confidence.

**No fake data.** Every value is computed from imported sales history and live
stock using the same engine as the screens. Products with no sales history are
excluded; if nothing can be forecast the workbook says so explicitly instead
of inventing numbers.

---

## After importing

- Products appear on **Products** (with images if the file carried URLs).
- Stock appears on **Inventory**, and statuses (out of stock / critical / low /
  healthy / overstock) are computed against the thresholds — including any
  per-product quantity settings you set on the product.
- Sales history powers **Demand forecast**, **AI insights**, **What-if** and
  **Smart replenishment**.
- Orders appear on **Orders** and move through the normal lifecycle
  (receiving them adds real stock).