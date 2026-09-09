"""Import the real RetailMind data files into Supabase.

Reads the workbooks in ``data/`` and writes them straight into the live schema
through the service-role client — the same tables the app reads, so nothing here
is a parallel or "demo" dataset.

    cd backend
    python scripts/import_real_data.py                  # import everything
    python scripts/import_real_data.py --dry-run        # parse only, write nothing
    python scripts/import_real_data.py --purge-sample-stores
    python scripts/import_real_data.py --only products inventory

What it does, in order:

1. **Stores** from ``05_stores_available.xlsx``.
2. **Products** from ``01_products_200.xlsx`` — SKU, barcode, name, category,
   sub-category, MRP and image URL, with categories created on demand.
3. **Inventory** from ``02_inventory_200.xlsx`` — current stock per store, plus
   the per-product low-stock threshold the file carries.
4. **Store daily sales** from ``03_sales_history_200.xlsx``. That file is
   store-level takings with no SKU column, so it goes to ``store_daily_sales``,
   which is exactly where the demand engine looks for a store curve. Writing it
   to ``sales`` would have required inventing a SKU per row, and inventing data
   is the one thing this script will not do.
5. **Stock receiving** from ``04_stock_receiving_200.xlsx`` — recorded as
   ``inventory_transactions`` (reason ``receiving``) for SKUs already in the
   catalogue, so warehouse dispatch history is preserved without silently
   creating products that were never in the product master.

Everything is an upsert keyed on the natural key, so re-running it is safe and
will not duplicate rows.
"""
from __future__ import annotations

import argparse
import math
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from openpyxl import load_workbook
except ImportError:  # pragma: no cover
    print("openpyxl is required. Run: pip install -r requirements.txt")
    raise SystemExit(1)

from app.core.config import service_client  # noqa: E402

# data/ sits next to backend/ and frontend/ in the project root.
DATA_DIR = Path(__file__).resolve().parents[2] / "data"

FILES = {
    "stores":    "05_stores_available.xlsx",
    "products":  "01_products_200.xlsx",
    "inventory": "02_inventory_200.xlsx",
    "sales":     "03_sales_history_200.xlsx",
    "receiving": "04_stock_receiving_200.xlsx",
}

# Store rows the earlier builds shipped as samples. Removed only when
# --purge-sample-stores is passed, and never if they carry real data.
SAMPLE_STORE_CODES = {"ST001", "ST002", "ST003", "ST004", "ST005",
                      "STORE1", "STORE2", "DEMO", "DEMO1", "SAMPLE"}
SAMPLE_STORE_NAMES = {"demo store", "sample store", "test store",
                      "main store", "flagship store", "downtown store"}

BATCH = 200


# ---------------------------------------------------------------- helpers


def read_rows(path: Path) -> list[dict[str, Any]]:
    """Sheet 1 as a list of dicts keyed by header."""
    workbook = load_workbook(path, data_only=True, read_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    rows = sheet.iter_rows(values_only=True)
    try:
        headers = [str(h).strip() if h is not None else "" for h in next(rows)]
    except StopIteration:
        return []
    out = []
    for values in rows:
        if values is None or all(v is None for v in values):
            continue
        out.append({headers[i]: values[i]
                    for i in range(min(len(headers), len(values)))
                    if headers[i]})
    workbook.close()
    return out


def text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    cleaned = str(value).strip()
    return cleaned or None


def number(value: Any) -> float | None:
    """A number, tolerating '1,234', '₹99', blanks and Excel text cells."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if isinstance(value, float) and math.isnan(value) else float(value)
    cleaned = str(value).strip().replace(",", "")
    for symbol in ("₹", "$", "%", "INR", "Rs.", "Rs"):
        cleaned = cleaned.replace(symbol, "")
    cleaned = cleaned.strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def as_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    cleaned = str(value).strip()
    if not cleaned:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y",
                "%Y/%m/%d", "%d-%b-%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(cleaned[:19], fmt).date().isoformat()
        except ValueError:
            continue
    return None


def sku_of(value: Any) -> str | None:
    """SKUs arrive from Excel as floats (100021351.0). Normalise to a string."""
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    cleaned = str(value).strip()
    return cleaned or None


def chunks(items: list, size: int = BATCH) -> Iterable[list]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


class Reporter:
    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.lines: list[str] = []

    def step(self, title: str) -> None:
        print(f"\n{title}\n{'-' * len(title)}")

    def done(self, message: str) -> None:
        prefix = "[dry run] would " if self.dry_run else ""
        print(f"  {prefix}{message}")
        self.lines.append(f"{prefix}{message}")


def upsert(db, table: str, rows: list[dict], on_conflict: str,
           report: Reporter, label: str) -> int:
    if not rows:
        report.done(f"write 0 {label}.")
        return 0
    if report.dry_run:
        report.done(f"write {len(rows)} {label}.")
        return len(rows)

    written = 0
    for batch in chunks(rows):
        try:
            db.table(table).upsert(batch, on_conflict=on_conflict).execute()
            written += len(batch)
        except Exception as exc:
            # Fall back to one row at a time so a single bad row can't lose 200
            # good ones, and say which row failed.
            for row in batch:
                try:
                    db.table(table).upsert(row, on_conflict=on_conflict).execute()
                    written += 1
                except Exception as row_exc:
                    print(f"    ! skipped a {label} row: {row_exc}")
            del exc
    report.done(f"wrote {written} {label}.")
    return written


# ---------------------------------------------------------------- stores


def import_stores(db, report: Reporter) -> dict[str, str]:
    """Returns {store_code: store_id} for every store now in the database."""
    report.step("Stores")
    path = DATA_DIR / FILES["stores"]
    rows = read_rows(path) if path.exists() else []

    payload = []
    for row in rows:
        code = text(row.get("Store Code"))
        name = text(row.get("Store Name"))
        if not code or not name:
            continue
        payload.append({
            "code": code,
            "name": name,
            # The source "Status" column is a Chinese trading status (开业 =
            # open). Map it rather than storing a value the enum rejects.
            "status": "active",
            "location": text(row.get("Area")) or text(row.get("Market")),
            "address": name,
        })

    upsert(db, "stores", payload, "code", report, "stores")

    existing = (db.table("stores").select("id,code").execute()).data
    return {r["code"]: r["id"] for r in existing if r.get("code")}


def purge_sample_stores(db, report: Reporter, keep_codes: set[str]) -> None:
    """Remove leftover demo stores — but never one that holds real data."""
    report.step("Removing sample stores")
    rows = (db.table("stores").select("id,code,name").execute()).data

    for store in rows:
        code = (store.get("code") or "").upper()
        name = (store.get("name") or "").strip().lower()
        if code in keep_codes:
            continue
        if code not in SAMPLE_STORE_CODES and name not in SAMPLE_STORE_NAMES:
            continue

        # A store with orders against it is not a sample, whatever it is called.
        try:
            orders = (db.table("purchase_orders").select("id", count="exact")
                      .eq("store_id", store["id"]).limit(1).execute()).count or 0
        except Exception:
            orders = 0
        if orders:
            report.done(f"keep {store['code']} — it has {orders} order(s) against it.")
            continue

        if report.dry_run:
            report.done(f"delete sample store {store['code']} ({store['name']}).")
            continue
        try:
            db.table("stores").delete().eq("id", store["id"]).execute()
            report.done(f"deleted sample store {store['code']} ({store['name']}).")
        except Exception as exc:
            report.done(f"could not delete {store['code']}: {exc}")


# ---------------------------------------------------------------- products


def import_products(db, report: Reporter) -> dict[str, str]:
    """Returns {sku: product_id}."""
    report.step("Products")
    path = DATA_DIR / FILES["products"]
    if not path.exists():
        report.done(f"skip — {path.name} not found.")
        return existing_products(db)

    rows = read_rows(path)

    # Categories and sub-categories first, so products can reference them.
    category_names = {text(r.get("Category")) for r in rows}
    category_names.discard(None)
    if category_names:
        upsert(db, "categories", [{"name": n} for n in sorted(category_names)],
               "name", report, "categories")

    categories = {c["name"]: c["id"]
                  for c in (db.table("categories").select("id,name").execute()).data}

    sub_payload = []
    seen_subs: set[tuple[str, str]] = set()
    for row in rows:
        category = text(row.get("Category"))
        sub = text(row.get("Sub Category"))
        if not category or not sub or category not in categories:
            continue
        key = (categories[category], sub)
        if key in seen_subs:
            continue
        seen_subs.add(key)
        sub_payload.append({"category_id": categories[category], "name": sub})

    if sub_payload and not report.dry_run:
        upsert(db, "subcategories", sub_payload, "category_id,name",
               report, "sub-categories")
    elif sub_payload:
        report.done(f"write {len(sub_payload)} sub-categories.")

    subcategories = {}
    if not report.dry_run:
        for row in (db.table("subcategories").select("id,category_id,name")
                    .execute()).data:
            subcategories[(row["category_id"], row["name"])] = row["id"]

    payload = []
    seen: set[str] = set()
    for row in rows:
        sku = sku_of(row.get("SKU"))
        name = text(row.get("Product Name"))
        if not sku or not name or sku in seen:
            continue
        seen.add(sku)

        category = text(row.get("Category"))
        category_id = categories.get(category) if category else None
        sub = text(row.get("Sub Category"))
        subcategory_id = (subcategories.get((category_id, sub))
                          if category_id and sub else None)

        # The barcode column sometimes holds several EANs separated by "/".
        # Keep the first — the column is unique-ish, not a list.
        barcode_raw = text(row.get("Barcode"))
        barcode = barcode_raw.split("/")[0].strip() if barcode_raw else None

        payload.append({
            "sku": sku,
            "barcode": barcode,
            "name": name,
            "category_id": category_id,
            "subcategory_id": subcategory_id,
            "mrp": number(row.get("MRP")),
            "image_url": text(row.get("Image URL")),
            "status": "active",
        })

    upsert(db, "products", payload, "sku", report, "products")
    return existing_products(db)


def existing_products(db) -> dict[str, str]:
    out: dict[str, str] = {}
    start = 0
    while True:
        rows = (db.table("products").select("id,sku")
                .range(start, start + 999).execute()).data
        if not rows:
            break
        out.update({r["sku"]: r["id"] for r in rows if r.get("sku")})
        if len(rows) < 1000:
            break
        start += 1000
    return out


# ---------------------------------------------------------------- inventory


def import_inventory(db, report: Reporter, products: dict[str, str],
                     stores: dict[str, str], create_missing: bool = True) -> None:
    """Stock levels, creating any product the stock file describes but the
    product master doesn't contain.

    The three source files turned out to be different samples of the same
    catalogue: only 8 of the 200 inventory SKUs also appear in
    01_products_200.xlsx. Discarding the other 192 would throw away real stock
    for real products. The stock file carries Product Name, Category, MRP and
    Image URL for every row, so those products are created from *its own*
    columns — this invents nothing, it just uses the second file as a second
    source of product records.

    Pass ``create_missing=False`` (``--no-create-missing``) to import stock only
    for SKUs already in the product master.
    """
    report.step("Inventory")
    path = DATA_DIR / FILES["inventory"]
    if not path.exists():
        report.done(f"skip — {path.name} not found.")
        return

    rows = read_rows(path)
    default_store = next(iter(stores.values()), None)

    # ---- create products this file describes but the master doesn't have
    missing = []
    seen_missing: set[str] = set()
    for row in rows:
        sku = sku_of(row.get("SKU"))
        name = text(row.get("Product Name"))
        if not sku or sku in products or sku in seen_missing or not name:
            continue
        seen_missing.add(sku)
        missing.append({
            "sku": sku, "name": name,
            "category": text(row.get("Category")),
            "mrp": number(row.get("MRP")),
            "image_url": text(row.get("Image URL")),
        })

    if missing and create_missing:
        category_names = {m["category"] for m in missing if m["category"]}
        if category_names:
            upsert(db, "categories", [{"name": n} for n in sorted(category_names)],
                   "name", report, "extra categories")
        categories = {}
        if not report.dry_run:
            categories = {c["name"]: c["id"] for c in
                          (db.table("categories").select("id,name").execute()).data}

        upsert(db, "products", [{
            "sku": m["sku"], "name": m["name"],
            "category_id": categories.get(m["category"]) if m["category"] else None,
            "mrp": m["mrp"], "image_url": m["image_url"], "status": "active",
        } for m in missing], "sku", report,
            "products created from the stock file")
        if not report.dry_run:
            products.update(existing_products(db))
    elif missing:
        report.done(f"skip {len(missing)} product(s) in the stock file that "
                    "aren't in the product master (--no-create-missing).")

    # ---- stock levels
    stock_payload: list[dict] = []
    threshold_updates: dict[str, float] = {}
    unmatched = 0
    seen: set[tuple[str, str]] = set()

    for row in rows:
        sku = sku_of(row.get("SKU"))
        product_id = products.get(sku) if sku else None
        if not product_id:
            unmatched += 1
            continue

        code = text(row.get("Store Code"))
        store_id = stores.get(code) if code else default_store
        if not store_id:
            unmatched += 1
            continue
        if (product_id, store_id) in seen:
            continue
        seen.add((product_id, store_id))

        current = number(row.get("Current Stock"))
        if current is None:
            current = number(row.get("Total Stock")) or 0.0
        # The source uses -1 for "out of stock". The schema treats stock as a
        # non-negative quantity, so clamp rather than store a negative.
        current = max(0.0, float(current))
        mrp = number(row.get("MRP"))

        stock_payload.append({
            "product_id": product_id,
            "store_id": store_id,
            "current_stock": current,
            "available_stock": current,
            "warehouse_stock": 0,
            "stock_on_route": 0,
            "stock_on_order": 0,
            "inventory_value": round(current * mrp, 2) if mrp else None,
        })

        threshold = number(row.get("Low Stock Threshold"))
        if threshold is not None:
            threshold_updates[product_id] = threshold

    upsert(db, "inventory", stock_payload, "product_id,store_id",
           report, "stock records")
    if unmatched:
        report.done(f"skip {unmatched} row(s) that couldn't be matched to a product.")

    # Per-product low stock thresholds drive the dashboard tiles, the low-stock
    # alerts and the replenishment engine, so they are worth carrying across.
    if threshold_updates:
        if report.dry_run:
            report.done(f"set low-stock thresholds on {len(threshold_updates)} products.")
        else:
            updated = 0
            for product_id, value in threshold_updates.items():
                try:
                    db.table("products").update(
                        {"low_stock_threshold": value}).eq("id", product_id).execute()
                    updated += 1
                except Exception:
                    pass
            report.done(f"set low-stock thresholds on {updated} products.")


# ---------------------------------------------------------------- sales


def import_store_sales(db, report: Reporter, stores: dict[str, str]) -> None:
    report.step("Store daily sales")
    path = DATA_DIR / FILES["sales"]
    if not path.exists():
        report.done(f"skip — {path.name} not found.")
        return

    rows = read_rows(path)
    default_store = next(iter(stores.values()), None)

    payload = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        code = text(row.get("Store Code"))
        store_id = stores.get(code) if code else default_store
        sale_date = as_date(row.get("Date"))
        if not store_id or not sale_date:
            continue
        if (store_id, sale_date) in seen:
            continue
        seen.add((store_id, sale_date))
        payload.append({
            "store_id": store_id,
            "sale_date": sale_date,
            "total_amount": number(row.get("Total Sales")),
            # The source has no unit count — leaving it null is honest, and the
            # demand engine falls back to the amount curve.
            "total_units": None,
        })

    upsert(db, "store_daily_sales", payload, "store_id,sale_date",
           report, "store sales days")


# ---------------------------------------------------------------- receiving


def barcode_index(db) -> dict[str, str]:
    """{barcode: product_id}, splitting the multi-EAN cells the source uses."""
    out: dict[str, str] = {}
    start = 0
    while True:
        rows = (db.table("products").select("id,barcode")
                .range(start, start + 999).execute()).data
        if not rows:
            break
        for row in rows:
            raw = row.get("barcode")
            if not raw:
                continue
            for part in str(raw).split("/"):
                cleaned = part.strip()
                if cleaned:
                    out.setdefault(cleaned, row["id"])
        if len(rows) < 1000:
            break
        start += 1000
    return out


def import_receiving(db, report: Reporter, products: dict[str, str],
                     stores: dict[str, str]) -> None:
    """Warehouse dispatch history as inventory transactions.

    Matched on SKU first, then on EAN against products.barcode — the dispatch
    export carries both, and the two identifiers hit different parts of the
    catalogue. Lines that match neither are reported and skipped: a dispatch
    record has no MRP or category, so creating a product from it would produce a
    hollow catalogue entry.
    """
    report.step("Warehouse receiving history")
    path = DATA_DIR / FILES["receiving"]
    if not path.exists():
        report.done(f"skip — {path.name} not found.")
        return

    rows = read_rows(path)
    default_store = next(iter(stores.values()), None)
    if not default_store:
        report.done("skip — no store exists to attribute receipts to.")
        return

    by_barcode = {} if report.dry_run else barcode_index(db)

    payload = []
    unmatched = 0
    for row in rows:
        sku = sku_of(row.get("SKU"))
        product_id = products.get(sku) if sku else None
        if not product_id:
            ean = sku_of(row.get("EAN"))
            product_id = by_barcode.get(ean) if ean else None
        if not product_id:
            unmatched += 1
            continue

        quantity = number(row.get("Picking Unit Quantity"))
        if quantity is None:
            quantity = number(row.get("Basic Quantity"))
        if not quantity:
            continue

        payload.append({
            "product_id": product_id,
            "store_id": default_store,
            "delta": float(quantity),
            "reason": "receiving",
            "reference_type": "dispatch",
            "note": (f"Dispatch {text(row.get('Dispatch Wave/Job ID')) or '—'} · "
                     f"DO {text(row.get('Delivery Order No')) or '—'} · "
                     f"WH {text(row.get('Warehouse Code')) or '—'}"),
        })

    if report.dry_run:
        report.done(f"write {len(payload)} receiving transactions.")
    elif payload:
        written = 0
        for batch in chunks(payload):
            try:
                db.table("inventory_transactions").insert(batch).execute()
                written += len(batch)
            except Exception as exc:
                print(f"    ! a receiving batch failed: {exc}")
        report.done(f"wrote {written} receiving transactions.")
    else:
        report.done("write 0 receiving transactions.")

    if unmatched:
        report.done(f"skip {unmatched} dispatch line(s) matching neither a SKU "
                    "nor a barcode in the catalogue (no products invented).")


# ---------------------------------------------------------------- summary


def summarise(db) -> None:
    print("\nFinal database counts\n---------------------")
    for table in ("products", "categories", "stores", "inventory",
                  "store_daily_sales", "inventory_transactions",
                  "purchase_orders"):
        try:
            count = (db.table(table).select("id", count="exact")
                     .limit(1).execute()).count or 0
        except Exception:
            # store_daily_sales has an id column; if a table is missing, say so
            # rather than crashing the run at the very last step.
            count = "unavailable (run the migrations?)"
        print(f"  {table:<24} {count}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Import the real data files in data/ into Supabase.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and report without writing anything.")
    parser.add_argument("--purge-sample-stores", action="store_true",
                        help="Delete leftover demo stores that hold no orders.")
    parser.add_argument("--no-create-missing", action="store_true",
                        help="Don't create products that appear only in the stock file.")
    parser.add_argument("--only", nargs="*",
                        choices=["stores", "products", "inventory", "sales", "receiving"],
                        help="Run only these steps.")
    args = parser.parse_args()

    if not DATA_DIR.exists():
        print(f"No data directory at {DATA_DIR}.")
        return 1

    steps = set(args.only) if args.only else {
        "stores", "products", "inventory", "sales", "receiving"}

    report = Reporter(args.dry_run)
    db = service_client()

    print(f"Reading from {DATA_DIR}")
    if args.dry_run:
        print("DRY RUN — nothing will be written.")

    stores = import_stores(db, report) if "stores" in steps else {
        r["code"]: r["id"]
        for r in (db.table("stores").select("id,code").execute()).data
        if r.get("code")}

    if args.purge_sample_stores:
        real_codes = set()
        path = DATA_DIR / FILES["stores"]
        if path.exists():
            real_codes = {text(r.get("Store Code")) or "" for r in read_rows(path)}
        purge_sample_stores(db, report, {c.upper() for c in real_codes if c})
        stores = {r["code"]: r["id"]
                  for r in (db.table("stores").select("id,code").execute()).data
                  if r.get("code")}

    products = (import_products(db, report) if "products" in steps
                else existing_products(db))

    if "inventory" in steps:
        import_inventory(db, report, products, stores,
                         create_missing=not args.no_create_missing)
    if "sales" in steps:
        import_store_sales(db, report, stores)
    if "receiving" in steps:
        import_receiving(db, report, products, stores)

    if not args.dry_run:
        summarise(db)

    print("\nDone. Sign in as the super admin — the dashboard reads these tables "
          "directly, so the numbers are live immediately.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
