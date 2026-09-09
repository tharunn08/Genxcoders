"""Import engine: profile a file, suggest column mappings, validate, then commit.

Built on the assumption that no two retail exports share column names. Nothing
here hard-codes a header — mappings are suggested by fuzzy matching and are
always overridable by the admin before anything is written.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from dateutil import parser as date_parser
from rapidfuzz import fuzz

from ._parsing import (FileUnreadable, clean_records, json_safe, read_frames,
                       resolve_sheet)

# ---------------------------------------------------------------- target fields

# label: what the admin sees. aliases: seeds for fuzzy matching against real headers.
FIELD_SPECS: dict[str, dict[str, dict]] = {
    "products": {
        "sku": {"label": "SKU / Product Code", "required": True,
                "aliases": ["sku", "product code", "item code", "material code",
                            "article code", "product id", "style code", "item no"]},
        "barcode": {"label": "Barcode / EAN", "required": False,
                    "aliases": ["barcode", "ean", "ean13", "upc", "gtin", "bar code"]},
        "name": {"label": "Product Name", "required": True,
                 "aliases": ["product name", "name", "item name", "description",
                             "product description", "title"]},
        "category": {"label": "Category", "required": False,
                     "aliases": ["category", "cat", "product category", "department",
                                 "class", "main category"]},
        "subcategory": {"label": "Subcategory", "required": False,
                        "aliases": ["subcategory", "sub category", "sub-category",
                                    "subclass", "sub department", "segment"]},
        "mrp": {"label": "MRP / Retail Price", "required": False,
                "aliases": ["mrp", "price", "retail price", "selling price", "unit price",
                            "list price", "rate"]},
        "cost_price": {"label": "Cost Price", "required": False,
                       "aliases": ["cost", "cost price", "purchase price", "landed cost"]},
        "image_url": {"label": "Image URL", "required": False,
                      "aliases": ["image", "image url", "image link", "photo", "picture",
                                  "img", "thumbnail"]},
    },
    "inventory": {
        "sku": {"label": "SKU / Product Code", "required": True,
                "aliases": ["sku", "product code", "item code", "material code", "article code"]},
        "barcode": {"label": "Barcode", "required": False,
                    "aliases": ["barcode", "ean", "upc"]},
        # Real stock exports usually carry the product description alongside the
        # quantity. Capturing it here means one file can populate the catalog and
        # the stock levels together, instead of forcing two separate imports
        # before any numbers appear on screen.
        "name": {"label": "Product Name (optional)", "required": False,
                 "aliases": ["product name", "name", "item name", "description",
                             "product description", "title"]},
        "category": {"label": "Category (optional)", "required": False,
                     "aliases": ["category", "product category", "department",
                                 "class", "main category"]},
        "mrp": {"label": "MRP (optional)", "required": False,
                "aliases": ["mrp", "price", "retail price", "selling price",
                            "unit price", "list price", "rate"]},
        "image_url": {"label": "Image URL (optional)", "required": False,
                      "aliases": ["image", "image url", "image link", "photo",
                                  "picture", "img", "thumbnail"]},
        "store_code": {"label": "Store", "required": False,
                       "aliases": ["store", "store code", "store name", "shop", "branch",
                                   "location", "outlet"]},
        "current_stock": {"label": "Current Stock", "required": True,
                          "aliases": ["current stock", "stock", "qty", "quantity",
                                      "on hand", "closing stock", "total stock"]},
        "available_stock": {"label": "Available Stock", "required": False,
                            "aliases": ["available stock", "available", "store stock",
                                        "sellable stock", "shop stock", "available qty"]},
        "warehouse_stock": {"label": "Warehouse Stock", "required": False,
                            "aliases": ["warehouse stock", "warehouse", "dc stock",
                                        "wh stock", "backroom"]},
        "stock_on_route": {"label": "Stock on Route", "required": False,
                           "aliases": ["stock on route", "on route", "in transit",
                                       "transit stock", "on the way"]},
        "stock_on_order": {"label": "Stock on Order", "required": False,
                           "aliases": ["stock on order", "on order", "ordered qty",
                                       "open order", "po qty"]},
        "inventory_value": {"label": "Inventory Value", "required": False,
                            "aliases": ["inventory value", "stock value", "value",
                                        "total value", "amount"]},
    },
    "sales": {
        "sku": {"label": "SKU / Product Code", "required": True,
                "aliases": ["sku", "product code", "item code", "article code"]},
        "store_code": {"label": "Store", "required": False,
                       "aliases": ["store", "store code", "branch", "outlet", "shop"]},
        "sale_date": {"label": "Date", "required": True,
                      "aliases": ["date", "sale date", "transaction date", "bill date",
                                  "day", "posting date"]},
        "quantity_sold": {"label": "Quantity Sold", "required": True,
                          "aliases": ["quantity sold", "qty sold", "units", "sales qty",
                                      "quantity", "qty", "sold"]},
        "sales_amount": {"label": "Sales Amount", "required": False,
                         "aliases": ["sales amount", "amount", "revenue", "net sales",
                                     "total", "value", "sales value"]},
    },
    # Store-level daily takings. Real DSR exports are per store per day with no
    # SKU column at all, so forcing them through `sales` (which requires a SKU)
    # sent every row to the unmatched queue. This type writes store_daily_sales,
    # which the demand engine already uses as its fallback curve.
    "store_sales": {
        "store_code": {"label": "Store", "required": False,
                       "aliases": ["store", "store code", "store name", "branch",
                                   "outlet", "shop", "location"]},
        "sale_date": {"label": "Date", "required": True,
                      "aliases": ["date", "sale date", "business date", "day",
                                  "transaction date", "posting date"]},
        "total_amount": {"label": "Total Sales Amount", "required": True,
                         "aliases": ["total sales", "total amount", "net sales",
                                     "sales", "revenue", "amount", "gross sales",
                                     "total"]},
        "total_units": {"label": "Total Units (optional)", "required": False,
                        "aliases": ["total units", "units", "quantity", "qty",
                                    "bills", "transactions", "footfall"]},
    },
    "suppliers": {
        "supplier_code": {"label": "Supplier ID", "required": False,
                          "aliases": ["supplier id", "supplier code", "vendor id",
                                      "vendor code"]},
        "supplier_name": {"label": "Supplier Name", "required": True,
                          "aliases": ["supplier", "supplier name", "vendor", "vendor name"]},
        "sku": {"label": "Product SKU", "required": False,
                "aliases": ["sku", "product code", "item code"]},
        "lead_time_days": {"label": "Lead Time (days)", "required": False,
                           "aliases": ["lead time", "lead time days", "delivery days",
                                       "lead days", "supply days"]},
        "contact_email": {"label": "Contact Email", "required": False,
                          "aliases": ["email", "contact email", "e-mail"]},
    },
    "replenishment": {
        "sku": {"label": "SKU / Product Code", "required": True,
                "aliases": ["sku", "product code", "item code", "article code"]},
        "barcode": {"label": "Barcode", "required": False, "aliases": ["barcode", "ean"]},
        "name": {"label": "Product Name", "required": False,
                 "aliases": ["product name", "name", "description"]},
        "store_code": {"label": "Store", "required": False,
                       "aliases": ["store", "store code", "branch", "outlet"]},
        "current_stock": {"label": "Current Stock", "required": False,
                          "aliases": ["current stock", "stock", "on hand"]},
        "required_qty": {"label": "Required Quantity", "required": False,
                         "aliases": ["required quantity", "required qty", "requirement",
                                     "demand qty", "need"]},
        "replenishment_qty": {"label": "Replenishment Quantity", "required": True,
                              "aliases": ["replenishment quantity", "replenishment qty",
                                          "replen qty", "suggested qty", "order qty",
                                          "refill qty", "to order"]},
    },
    "orders": {
        "po_number": {"label": "Order Number", "required": False,
                      "aliases": ["order number", "po number", "po no", "order id",
                                  "po", "reference", "order ref"]},
        "order_date": {"label": "Order Date", "required": True,
                       "aliases": ["order date", "date", "created date", "requested date",
                                   "po date", "order created"]},
        "expected_date": {"label": "Expected Date", "required": False,
                          "aliases": ["expected date", "due date", "delivery date",
                                      "arrival date", "eta"]},
        "supplier": {"label": "Supplier", "required": False,
                     "aliases": ["supplier", "supplier name", "vendor", "vendor name"]},
        "store_code": {"label": "Store", "required": False,
                       "aliases": ["store", "store code", "store name", "branch",
                                   "outlet", "location", "shop"]},
        "sku": {"label": "SKU / Product Code", "required": True,
                "aliases": ["sku", "product code", "item code", "article code"]},
        "quantity": {"label": "Quantity", "required": True,
                     "aliases": ["quantity", "qty", "order qty", "units", "ordered qty",
                                 "quantity ordered"]},
        "unit_price": {"label": "Unit Price", "required": False,
                       "aliases": ["unit price", "price", "cost", "rate", "po price"]},
        "status": {"label": "Order Status", "required": False,
                   "aliases": ["order status", "status", "po status"]},
        "priority": {"label": "Priority", "required": False,
                     "aliases": ["priority", "urgency", "importance"]},
        "notes": {"label": "Notes", "required": False,
                  "aliases": ["notes", "remark", "comments", "note", "remarks"]},
    },
}


def normalise(header: Any) -> str:
    text = str(header or "").strip().lower()
    text = re.sub(r"[_\-./\\]+", " ", text)
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------- profiling


@dataclass
class SheetProfile:
    name: str
    headers: list[str]
    row_count: int
    sample_rows: list[dict]


@dataclass
class FileProfile:
    file_type: str
    sheets: list[SheetProfile] = field(default_factory=list)


def profile_file(content: bytes, filename: str, sample_size: int = 8) -> FileProfile:
    """Read every sheet once and describe what's in it."""
    file_type, sheets = read_frames(content, filename)
    profiles = [
        SheetProfile(
            name=name,
            headers=[str(c) for c in df.columns],
            row_count=int(len(df)),
            sample_rows=clean_records(df, sample_size),
        )
        for name, df in sheets.items()
    ]
    return FileProfile(file_type, profiles)


def load_rows(content: bytes, filename: str, sheet_name: str | None = None) -> list[dict]:
    """Every row of one sheet, JSON-safe.

    Shares ``read_frames`` with ``profile_file`` so the sheet the user picked in
    the wizard is provably the sheet that gets imported.
    """
    _, sheets = read_frames(content, filename)
    _, frame = resolve_sheet(sheets, sheet_name)
    return clean_records(frame)


# ---------------------------------------------------------------- mapping


def suggest_mapping(headers: list[str], import_type: str) -> dict[str, dict]:
    """Best-guess source column for each target field, with a confidence score.

    Returns {field: {"source": header|None, "confidence": 0-100, "label": ..., "required": ...}}
    """
    specs = FIELD_SPECS.get(import_type, {})
    normalised = {h: normalise(h) for h in headers}
    taken: set[str] = set()
    result: dict[str, dict] = {}

    scored: list[tuple[float, str, str]] = []
    for field_name, spec in specs.items():
        for header, norm in normalised.items():
            if not norm:
                continue
            best = max(
                (max(fuzz.ratio(norm, alias), fuzz.token_set_ratio(norm, alias))
                 for alias in spec["aliases"]),
                default=0,
            )
            if norm == normalise(field_name):
                best = 100
            if best >= 62:
                scored.append((best, field_name, header))

    # Greedy assignment, highest confidence first, one source column per field.
    for score, field_name, header in sorted(scored, key=lambda x: -x[0]):
        if field_name in result or header in taken:
            continue
        result[field_name] = {"source": header, "confidence": round(score, 1)}
        taken.add(header)

    for field_name, spec in specs.items():
        entry = result.get(field_name, {"source": None, "confidence": 0.0})
        entry["label"] = spec["label"]
        entry["required"] = spec["required"]
        result[field_name] = entry

    return result


# ---------------------------------------------------------------- coercion


def to_number(value: Any) -> float | None:
    """Parse a spreadsheet cell into a number, or None if it isn't one.

    Retail exports are messy in predictable ways, and each of these used to
    produce a spurious "isn't a number" validation error:

    * ``TRUE``/``FALSE`` in a flag-style quantity column -> 1 / 0
    * ``"₹1,234.50"`` / ``"1,234 units"`` -> currency and unit suffixes stripped
    * ``"(120)"`` -> accounting notation for -120
    * ``"1.234,56"`` -> European separators, detected by which mark comes last
    * ``"12%"`` -> 12
    """
    value = json_safe(value)

    if value is None or value == "":
        return None

    if isinstance(value, bool):
        return 1.0 if value else 0.0

    if isinstance(value, (int, float)):
        number = float(value)
        return None if math.isnan(number) or math.isinf(number) else number

    text = str(value).strip()
    if not text:
        return None

    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip()

    # Which of , and . is the decimal mark? Whichever appears last.
    last_comma = text.rfind(",")
    last_dot = text.rfind(".")
    if last_comma > -1 and last_dot > -1:
        if last_comma > last_dot:
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif last_comma > -1:
        # A lone comma is a thousands separator unless it looks like "12,5".
        digits_after = len(text) - last_comma - 1
        text = text.replace(",", "." if digits_after in (1, 2) and text.count(",") == 1
                            else "")

    text = re.sub(r"[^0-9.\-]", "", text)
    # A stray minus anywhere other than the front is noise, not a sign.
    text = ("-" if text.startswith("-") else "") + text.replace("-", "")
    if text.count(".") > 1:  # e.g. "1.234.567" once separators are stripped
        head, _, tail = text.rpartition(".")
        text = head.replace(".", "") + "." + tail

    if text in ("", "-", ".", "-."):
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return -number if negative else number


def to_date(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, (datetime, date)):
        return str(value)[:10]

    # Excel stores dates as days since 1899-12-30. A column read as numbers
    # (which happens whenever one cell in it is text) arrives here as 45678.0
    # and used to fail outright.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        serial = float(value)
        if 20000 <= serial <= 60000:
            try:
                from datetime import timedelta
                epoch = date(1899, 12, 30)
                return (epoch + timedelta(days=int(serial))).isoformat()
            except (OverflowError, ValueError):
                return None
        return None

    text = str(value).strip()
    if not text:
        return None
    try:
        return date_parser.parse(text, dayfirst=True).date().isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


def to_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def clean_sku(value: Any) -> str | None:
    text = to_text(value)
    if not text:
        return None
    # Excel turns numeric codes into floats: 1234567.0 -> 1234567
    if re.fullmatch(r"\d+\.0+", text):
        text = text.split(".")[0]
    return text.upper()


def is_image_url(value: Any) -> bool:
    text = to_text(value)
    return bool(text and re.match(r"^https?://", text, re.I))


def natural_key(mapped: dict, import_type: str) -> str | None:
    """The identity of a row for its import type.

    Used in two places that previously disagreed. Validation counted duplicates
    with one rule; the commit didn't dedupe at all and handed the repeats
    straight to ``upsert``. PostgreSQL rejects that outright — *ON CONFLICT DO
    UPDATE command cannot affect row a second time* — so a single repeated SKU
    failed the entire 500-row batch, not just its own row.
    """
    if import_type == "store_sales":
        # No SKU at all: identity is the store and the day.
        if not mapped.get("sale_date"):
            return None
        return f"{mapped.get('store_code') or ''}|{mapped.get('sale_date')}"

    sku = mapped.get("sku")
    if not sku:
        return None
    if import_type in ("products", "replenishment"):
        return str(sku)
    if import_type == "inventory":
        return f"{sku}|{mapped.get('store_code') or ''}"
    if import_type == "sales":
        return f"{sku}|{mapped.get('store_code') or ''}|{mapped.get('sale_date')}"
    if import_type == "orders":
        return f"{mapped.get('po_number') or ''}|{sku}"
    return str(sku)


# ---------------------------------------------------------------- validation


@dataclass
class RowError:
    row_number: int
    column_name: str | None
    error_code: str
    message: str


@dataclass
class ValidationReport:
    total_rows: int = 0
    valid_rows: int = 0
    invalid_rows: int = 0
    duplicate_rows: int = 0
    errors: list[RowError] = field(default_factory=list)
    preview: list[dict] = field(default_factory=list)


def apply_mapping(row: dict, mapping: dict[str, dict]) -> dict:
    out = {}
    for field_name, entry in mapping.items():
        source = entry.get("source")
        out[field_name] = row.get(source) if source else None
    return out


def validate_rows(rows: list[dict], mapping: dict[str, dict],
                  import_type: str, preview_size: int = 25) -> ValidationReport:
    specs = FIELD_SPECS.get(import_type, {})
    report = ValidationReport(total_rows=len(rows))
    seen_keys: set[str] = set()

    for index, raw in enumerate(rows, start=1):
        mapped = apply_mapping(raw, mapping)
        row_errors: list[RowError] = []

        for field_name, spec in specs.items():
            if spec["required"] and not to_text(mapped.get(field_name)):
                row_errors.append(RowError(
                    index, spec["label"], "missing_required",
                    f"{spec['label']} is empty.",
                ))

        if "sku" in specs:
            mapped["sku"] = clean_sku(mapped.get("sku"))

        for numeric in ("mrp", "cost_price", "current_stock", "available_stock",
                        "warehouse_stock", "stock_on_route", "stock_on_order",
                        "inventory_value", "quantity_sold", "sales_amount",
                        "lead_time_days", "required_qty", "replenishment_qty",
                        "quantity", "unit_price"):
            if numeric in mapped and mapped[numeric] is not None:
                number = to_number(mapped[numeric])
                if number is None:
                    row_errors.append(RowError(
                        index, numeric, "invalid_number",
                        f"'{mapped[numeric]}' isn't a number.",
                    ))
                elif number < 0 and numeric not in ("inventory_value", "sales_amount"):
                    row_errors.append(RowError(
                        index, numeric, "negative_value",
                        f"{numeric.replace('_', ' ')} can't be negative.",
                    ))
                mapped[numeric] = number

        for date_field in ("sale_date", "order_date", "expected_date"):
            if date_field in specs and mapped.get(date_field) is not None:
                parsed = to_date(mapped[date_field])
                if parsed is None:
                    row_errors.append(RowError(
                        index, date_field, "invalid_date",
                        f"'{mapped[date_field]}' isn't a recognisable date.",
                    ))
                else:
                    mapped[date_field] = parsed

        if mapped.get("image_url") and not is_image_url(mapped["image_url"]):
            mapped["image_url"] = None

        # Duplicate detection on the natural key for this import type.
        key = natural_key(mapped, import_type)

        is_duplicate = bool(key and key in seen_keys)
        if key:
            seen_keys.add(key)
        if is_duplicate:
            report.duplicate_rows += 1

        if row_errors:
            report.invalid_rows += 1
            report.errors.extend(row_errors[:3])
        else:
            report.valid_rows += 1

        if len(report.preview) < preview_size:
            report.preview.append({
                "row_number": index,
                "data": mapped,
                "status": "error" if row_errors else "duplicate" if is_duplicate else "valid",
                "messages": [e.message for e in row_errors],
            })

    report.errors = report.errors[:500]
    return report
