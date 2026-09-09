"""Commits validated rows into the database.

Matching order is SKU, then barcode, then exact name. A row that matches nothing
goes to the unmatched queue rather than silently creating a near-duplicate product.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from supabase import Client

from ..core.db import utcnow_iso
from .import_engine import apply_mapping, clean_sku, to_date, to_number, to_text


@dataclass
class CommitResult:
    created: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    unmatched: int = 0
    messages: list[str] = field(default_factory=list)


class ProductIndex:
    """In-memory index of the catalog, so a 10k-row import doesn't make 10k queries."""

    def __init__(self, db: Client):
        self.db = db
        self.by_sku: dict[str, str] = {}
        self.by_barcode: dict[str, str] = {}
        self.by_name: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        page, size = 0, 1000
        while True:
            rows = (self.db.table("products").select("id,sku,barcode,name")
                    .range(page * size, page * size + size - 1).execute()).data
            if not rows:
                break
            for row in rows:
                if row.get("sku"):
                    self.by_sku[row["sku"].upper()] = row["id"]
                if row.get("barcode"):
                    self.by_barcode[str(row["barcode"]).strip()] = row["id"]
                if row.get("name"):
                    self.by_name[row["name"].strip().lower()] = row["id"]
            if len(rows) < size:
                break
            page += 1

    def match(self, sku: str | None, barcode: str | None, name: str | None) -> tuple[str | None, str]:
        if sku and sku.upper() in self.by_sku:
            return self.by_sku[sku.upper()], "sku"
        if barcode and str(barcode).strip() in self.by_barcode:
            return self.by_barcode[str(barcode).strip()], "barcode"
        if name and name.strip().lower() in self.by_name:
            return self.by_name[name.strip().lower()], "name"
        return None, "none"

    def register(self, product_id: str, sku: str | None,
                 barcode: str | None, name: str | None) -> None:
        if sku:
            self.by_sku[sku.upper()] = product_id
        if barcode:
            self.by_barcode[str(barcode).strip()] = product_id
        if name:
            self.by_name[name.strip().lower()] = product_id


class RefIndex:
    """Lazily created categories, subcategories, stores and suppliers."""

    def __init__(self, db: Client):
        self.db = db
        self.categories = {r["name"].lower(): r["id"]
                           for r in db.table("categories").select("id,name").execute().data}
        self.subcategories = {
            f'{r["category_id"]}|{r["name"].lower()}': r["id"]
            for r in db.table("subcategories").select("id,name,category_id").execute().data
        }
        stores = db.table("stores").select("id,code,name").execute().data
        self.stores = {}
        for row in stores:
            self.stores[row["code"].lower()] = row["id"]
            self.stores[row["name"].lower()] = row["id"]
        self.suppliers = {r["name"].lower(): r["id"]
                          for r in db.table("suppliers").select("id,name").execute().data}

    def category(self, name: str | None) -> str | None:
        name = to_text(name)
        if not name:
            return None
        key = name.lower()
        if key not in self.categories:
            row = self.db.table("categories").insert({"name": name}).execute().data[0]
            self.categories[key] = row["id"]
        return self.categories[key]

    def subcategory(self, category_id: str | None, name: str | None) -> str | None:
        name = to_text(name)
        if not name or not category_id:
            return None
        key = f"{category_id}|{name.lower()}"
        if key not in self.subcategories:
            row = self.db.table("subcategories").insert(
                {"category_id": category_id, "name": name}).execute().data[0]
            self.subcategories[key] = row["id"]
        return self.subcategories[key]

    def store(self, value: str | None, fallback: str | None) -> str | None:
        value = to_text(value)
        if value and value.lower() in self.stores:
            return self.stores[value.lower()]
        if value:
            code = re.sub(r"[^A-Z0-9\-]+", "-", value.upper().replace(" ", "-")).strip("-")[:28]
            code = code or "STORE"
            # stores.code is unique; a second store whose name normalises to the
            # same code used to abort the whole import with a 23505.
            candidate, suffix = code, 1
            while candidate.lower() in self.stores:
                suffix += 1
                candidate = f"{code[:26]}-{suffix}"
            try:
                row = self.db.table("stores").insert(
                    {"code": candidate, "name": value, "location": None}).execute().data[0]
            except Exception:
                # Lost a race, or the code exists from an earlier run. Re-read.
                found = (self.db.table("stores").select("id,code,name")
                         .or_(f"code.eq.{candidate},name.eq.{value}")
                         .limit(1).execute()).data
                if not found:
                    return fallback
                row = found[0]
            self.stores[value.lower()] = row["id"]
            self.stores[str(row.get("code", candidate)).lower()] = row["id"]
            return row["id"]
        return fallback

    def default_store(self) -> str | None:
        """A store to fall back on when the file has no store column.

        Previously ``None`` here meant every inventory row went to the unmatched
        queue, so the import reported success while writing nothing.
        """
        if self.stores:
            # dict preserves insertion order; the first entry is the first store.
            return next(iter(self.stores.values()))
        try:
            row = self.db.table("stores").insert(
                {"code": "MAIN", "name": "Main Store", "location": None}
            ).execute().data[0]
        except Exception:
            existing = self.db.table("stores").select("id").limit(1).execute().data
            return existing[0]["id"] if existing else None
        self.stores["main"] = row["id"]
        self.stores["main store"] = row["id"]
        return row["id"]

    def supplier(self, name: str | None) -> str | None:
        name = to_text(name)
        if not name:
            return None
        key = name.lower()
        if key not in self.suppliers:
            row = self.db.table("suppliers").insert({"name": name}).execute().data[0]
            self.suppliers[key] = row["id"]
        return self.suppliers[key]


def _chunks(items: list, size: int = 500):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _dedupe(payloads: list[dict], keys: tuple[str, ...]) -> tuple[list[dict], int]:
    """Collapse rows that share a conflict target. Last occurrence wins.

    Without this, a file containing the same SKU twice made PostgreSQL reject
    the whole batch with *ON CONFLICT DO UPDATE command cannot affect row a
    second time*. One duplicate row therefore failed 500 good ones, and the
    error surfaced as a bare 500. Repeated SKUs are completely normal in retail
    exports (one line per size, per colour, per warehouse), so this was hit
    constantly.
    """
    collapsed: dict[tuple, dict] = {}
    duplicates = 0
    for payload in payloads:
        identity = tuple(str(payload.get(k)) for k in keys)
        if identity in collapsed:
            duplicates += 1
        collapsed[identity] = payload
    return list(collapsed.values()), duplicates


def _write_batch(db: Client, table: str, batch: list[dict], *,
                 on_conflict: str | None, result: CommitResult) -> int:
    """Upsert a batch, degrading to row-by-row if the batch as a whole fails.

    A batch write is all-or-nothing. One malformed row used to take 499 valid
    ones down with it and report a single opaque message. Retrying individually
    costs a round trip per bad row but only in the failure case, and it turns
    "import failed" into "497 imported, 3 rows rejected, here's why".
    """
    try:
        query = db.table(table)
        if on_conflict:
            response = query.upsert(batch, on_conflict=on_conflict).execute()
        else:
            response = query.insert(batch).execute()
        return len(response.data or batch)
    except Exception as batch_error:
        written = 0
        for row in batch:
            try:
                query = db.table(table)
                if on_conflict:
                    query.upsert(row, on_conflict=on_conflict).execute()
                else:
                    query.insert(row).execute()
                written += 1
            except Exception as row_error:
                result.failed += 1
                message = _short(row_error)
                if message not in result.messages and len(result.messages) < 12:
                    result.messages.append(message)
        if written == 0 and not result.messages:
            result.messages.append(_short(batch_error))
        return written


def _short(exc: Exception) -> str:
    message = getattr(exc, "message", None) or str(exc)
    details = getattr(exc, "details", None)
    text = f"{message} {details}".strip() if details else message
    return " ".join(text.split())[:200]


ORDER_STATUSES = {
    "draft", "pending_approval", "approved", "rejected", "ordered",
    "in_transit", "partially_received", "received", "cancelled",
}


def _normalise_order_status(value: str | None) -> str:
    """Map the messy statuses real exports use onto the order_status enum."""
    text = (value or "").strip().lower().replace("_", " ")
    if not text:
        return "draft"
    if text in ORDER_STATUSES:
        return text
    if "received" in text or "complete" in text or "delivered" in text:
        return "received"
    if "transit" in text or "ship" in text:
        return "in_transit"
    if "part" in text:
        return "partially_received"
    if "approve" in text:
        return "approved"
    if "pend" in text or "submit" in text or "new" in text:
        return "pending_approval"
    if "cancel" in text or "void" in text:
        return "cancelled"
    if "reject" in text:
        return "rejected"
    if "order" in text:
        return "ordered"
    return "draft"


_NORMAL_PRIORITY = {"low", "medium", "high", "critical"}


def _next_po_number(db: Client) -> str:
    """PO-YYYYMM-NNNN, continuing the numbering used by the order screen."""
    from datetime import date as _date
    from ..routers.workflow import next_number
    return next_number("PO", "purchase_orders", "po_number") or \
        f"PO-{_date.today():%Y%m}-0001"


def commit_import(
    db: Client,
    *,
    import_id: str,
    rows: list[dict],
    mapping: dict,
    import_type: str,
    mode: str = "upsert",              # upsert | create_only | update_only | skip_duplicates
    default_store_id: str | None = None,
    create_missing_products: bool = True,
    actor_id: str | None = None,
) -> CommitResult:
    result = CommitResult()
    products = ProductIndex(db)
    refs = RefIndex(db)
    unmatched_batch: list[dict] = []

    def queue_unmatched(row_number: int, raw: dict, reason: str) -> None:
        unmatched_batch.append({
            "import_id": import_id,
            "row_number": row_number,
            "import_type": import_type,
            "raw": raw,
        })
        result.unmatched += 1
        if reason not in result.messages and len(result.messages) < 12:
            result.messages.append(reason)

    # A stock file with no store column and no store chosen used to send every
    # single row to the unmatched queue — the import "succeeded" with zero rows
    # written, which reads exactly like a broken importer. Resolve a sensible
    # default up front instead.
    if (import_type in ("inventory", "sales", "replenishment", "store_sales")
            and not default_store_id):
        default_store_id = refs.default_store()

    # ------------------------------------------------------------ products
    if import_type == "products":
        to_create, to_update, images = [], [], []
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            sku = clean_sku(m.get("sku"))
            name = to_text(m.get("name"))
            if not sku or not name:
                result.failed += 1
                continue

            barcode = to_text(m.get("barcode"))
            product_id, _ = products.match(sku, barcode, name)

            category_id = refs.category(m.get("category"))
            payload = {
                "sku": sku,
                "barcode": barcode,
                "name": name,
                "category_id": category_id,
                "subcategory_id": refs.subcategory(category_id, m.get("subcategory")),
                "mrp": to_number(m.get("mrp")),
                "cost_price": to_number(m.get("cost_price")),
                "image_url": to_text(m.get("image_url")),
            }
            payload = {k: v for k, v in payload.items() if v is not None or k in ("sku", "name")}

            if product_id:
                if mode in ("create_only", "skip_duplicates"):
                    result.skipped += 1
                    continue
                to_update.append((product_id, payload))
            else:
                if mode == "update_only":
                    result.skipped += 1
                    continue
                to_create.append(payload)

        to_create, collapsed = _dedupe(to_create, ("sku",))
        result.skipped += collapsed

        for batch in _chunks(to_create):
            before = result.failed
            written = _write_batch(db, "products", batch, on_conflict="sku", result=result)
            result.created += written
            if written and before == result.failed:
                # Re-read what landed so new ids join the index for later rows.
                skus = [row["sku"] for row in batch]
                for chunk in _chunks(skus, 200):
                    try:
                        fresh = (db.table("products").select("id,sku,barcode,name,image_url")
                                 .in_("sku", chunk).execute()).data
                    except Exception:
                        continue
                    for row in fresh:
                        products.register(row["id"], row.get("sku"),
                                          row.get("barcode"), row.get("name"))
                        if row.get("image_url"):
                            images.append({"product_id": row["id"], "url": row["image_url"],
                                           "is_primary": True, "source": "import"})

        for product_id, payload in to_update:
            try:
                payload.pop("sku", None)
                db.table("products").update(payload).eq("id", product_id).execute()
                result.updated += 1
                if payload.get("image_url"):
                    images.append({"product_id": product_id, "url": payload["image_url"],
                                   "is_primary": True, "source": "import"})
            except Exception as exc:
                result.failed += 1
                message = _short(exc)
                if message not in result.messages and len(result.messages) < 12:
                    result.messages.append(message)

        for batch in _chunks(images):
            try:
                db.table("product_images").insert(batch).execute()
            except Exception:
                pass  # decorative; never fail an import over a thumbnail row

    # ------------------------------------------------------------ inventory
    elif import_type == "inventory":
        payloads = []
        new_products: list[dict] = []

        # Pass 1: work out which SKUs the catalog is missing.
        if create_missing_products:
            pending: dict[str, dict] = {}
            for raw in rows:
                m = apply_mapping(raw, mapping)
                sku = clean_sku(m.get("sku"))
                if not sku:
                    continue
                if products.match(sku, to_text(m.get("barcode")), None)[0]:
                    continue
                if sku in pending:
                    continue
                # A combined product+stock export carries these; a bare stock
                # file doesn't, and then the SKU stands in for the name.
                category_id = refs.category(m.get("category"))
                pending[sku] = {
                    "sku": sku,
                    "name": to_text(m.get("name")) or sku,
                    "barcode": to_text(m.get("barcode")),
                    "mrp": to_number(m.get("mrp")),
                    "category_id": category_id,
                    "image_url": to_text(m.get("image_url")),
                }
            new_products = [
                {k: v for k, v in row.items() if v is not None}
                for row in pending.values()
            ]
            for batch in _chunks(new_products):
                _write_batch(db, "products", batch, on_conflict="sku", result=result)
            if new_products:
                result.created += len(new_products)
                result.messages.append(
                    f"Created {len(new_products)} product(s) that the stock file "
                    "referenced but the catalog didn't have yet."
                )
                # Refresh so pass 2 can match them.
                for chunk in _chunks([p["sku"] for p in new_products], 200):
                    try:
                        fresh = (db.table("products").select("id,sku,barcode,name")
                                 .in_("sku", chunk).execute()).data
                    except Exception:
                        continue
                    for row in fresh:
                        products.register(row["id"], row.get("sku"),
                                          row.get("barcode"), row.get("name"))

        # Pass 2: build the stock rows.
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            sku = clean_sku(m.get("sku"))
            product_id, _ = products.match(sku, to_text(m.get("barcode")), None)
            store_id = refs.store(m.get("store_code"), default_store_id)

            if not product_id:
                queue_unmatched(
                    index, raw,
                    "Some rows reference a SKU that isn't in the catalog. Import the "
                    "product master first, or tick 'create missing products'.")
                continue
            if not store_id:
                queue_unmatched(
                    index, raw,
                    "Some rows had no store. Map a store column, or pick a default "
                    "store before importing.")
                continue

            current = to_number(m.get("current_stock")) or 0.0
            available = to_number(m.get("available_stock"))
            payloads.append({
                "product_id": product_id,
                "store_id": store_id,
                "current_stock": current,
                "available_stock": available if available is not None else current,
                "warehouse_stock": to_number(m.get("warehouse_stock")) or 0.0,
                "stock_on_route": to_number(m.get("stock_on_route")) or 0.0,
                "stock_on_order": to_number(m.get("stock_on_order")) or 0.0,
                "inventory_value": to_number(m.get("inventory_value")),
                "updated_at": utcnow_iso(),
            })

        payloads, collapsed = _dedupe(payloads, ("product_id", "store_id"))
        result.skipped += collapsed

        for batch in _chunks(payloads):
            result.updated += _write_batch(
                db, "inventory", batch, on_conflict="product_id,store_id", result=result)

    # ------------------------------------------------------------ sales
    elif import_type == "sales":
        payloads = []
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            sku = clean_sku(m.get("sku"))
            product_id, _ = products.match(sku, None, None)
            store_id = refs.store(m.get("store_code"), default_store_id)
            sale_date = to_date(m.get("sale_date"))

            if not product_id:
                queue_unmatched(index, raw,
                                "Some sales rows reference a SKU that isn't in the catalog.")
                continue
            if not store_id:
                queue_unmatched(index, raw,
                                "Some sales rows had no store. Pick a default store.")
                continue
            if not sale_date:
                queue_unmatched(index, raw,
                                "Some sales rows had an unreadable date.")
                continue

            payloads.append({
                "product_id": product_id,
                "store_id": store_id,
                "sale_date": sale_date,
                "quantity_sold": to_number(m.get("quantity_sold")) or 0.0,
                "sales_amount": to_number(m.get("sales_amount")),
            })

        payloads, collapsed = _dedupe(payloads, ("product_id", "store_id", "sale_date"))
        result.skipped += collapsed

        for batch in _chunks(payloads):
            result.created += _write_batch(
                db, "sales", batch,
                on_conflict="product_id,store_id,sale_date", result=result)

    # ------------------------------------------------------------ store sales
    elif import_type == "store_sales":
        payloads = []
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            store_id = refs.store(m.get("store_code"), default_store_id)
            sale_date = to_date(m.get("sale_date"))

            if not store_id:
                queue_unmatched(index, raw,
                                "Some rows had no store. Pick a default store.")
                continue
            if not sale_date:
                queue_unmatched(index, raw, "Some rows had an unreadable date.")
                continue

            payloads.append({
                "store_id": store_id,
                "sale_date": sale_date,
                "total_amount": to_number(m.get("total_amount")),
                "total_units": to_number(m.get("total_units")),
            })

        payloads, collapsed = _dedupe(payloads, ("store_id", "sale_date"))
        result.skipped += collapsed

        for batch in _chunks(payloads):
            result.created += _write_batch(
                db, "store_daily_sales", batch,
                on_conflict="store_id,sale_date", result=result)

    # ------------------------------------------------------------ suppliers
    elif import_type == "suppliers":
        links = []
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            supplier_name = to_text(m.get("supplier_name"))
            if not supplier_name:
                result.failed += 1
                continue

            supplier_id = refs.supplier(supplier_name)
            lead_time = to_number(m.get("lead_time_days"))

            update = {}
            if lead_time is not None:
                update["avg_lead_time_days"] = lead_time
            if to_text(m.get("contact_email")):
                update["contact_email"] = to_text(m.get("contact_email"))
            if to_text(m.get("supplier_code")):
                update["code"] = to_text(m.get("supplier_code"))
            if update:
                try:
                    db.table("suppliers").update(update).eq("id", supplier_id).execute()
                except Exception:
                    pass

            sku = clean_sku(m.get("sku"))
            if sku:
                product_id, _ = products.match(sku, None, None)
                if product_id:
                    links.append({"product_id": product_id, "supplier_id": supplier_id,
                                  "lead_time_days": lead_time, "is_primary": True})
                else:
                    queue_unmatched(index, raw,
                                    "Some supplier rows reference an unknown SKU.")
            result.updated += 1

        links, _collapsed = _dedupe(links, ("product_id", "supplier_id"))
        for batch in _chunks(links):
            _write_batch(db, "product_suppliers", batch,
                         on_conflict="product_id,supplier_id", result=result)

    # ------------------------------------------------------------ replenishment
    elif import_type == "replenishment":
        payloads = []
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            sku = clean_sku(m.get("sku"))
            product_id, _ = products.match(sku, to_text(m.get("barcode")), to_text(m.get("name")))
            store_id = refs.store(m.get("store_code"), default_store_id)
            qty = to_number(m.get("replenishment_qty"))

            if not product_id or not store_id or qty is None:
                queue_unmatched(
                    index, raw,
                    "Some rows couldn't be matched to a product, a store, or a quantity.")
                continue

            current = to_number(m.get("current_stock")) or 0.0
            required = to_number(m.get("required_qty")) or qty
            payloads.append({
                "product_id": product_id,
                "store_id": store_id,
                "current_stock": current,
                "avg_daily_demand": 0,
                "forecast_demand": required,
                "safety_stock": 0,
                "lead_time_days": 7,
                "reorder_point": required,
                "recommended_qty": qty,
                "priority": "high" if current <= 0 else "medium",
                "reason": "Imported replenishment requirement.",
                "status": "open",
            })

        for batch in _chunks(payloads):
            result.created += _write_batch(
                db, "replenishment_recommendations", batch,
                on_conflict=None, result=result)

    # ------------------------------------------------------------ orders
    elif import_type == "orders":
        # Lines are grouped by (order number, store) so a multi-line order in
        # the file becomes one purchase_order with several items.
        groups: dict[str, dict] = {}
        for index, raw in enumerate(rows, start=1):
            m = apply_mapping(raw, mapping)
            sku = clean_sku(m.get("sku"))
            product_id, _ = products.match(sku, None, None)
            store_id = refs.store(m.get("store_code"), default_store_id)
            qty = to_number(m.get("quantity"))
            if not product_id:
                queue_unmatched(
                    index, raw,
                    "Some order rows reference a SKU that isn't in the catalog.")
                continue
            if not store_id:
                queue_unmatched(
                    index, raw,
                    "Some order rows had no store. Map a store column, or pick a "
                    "default store before importing.")
                continue
            if qty is None or qty <= 0:
                result.failed += 1
                result.messages.append(
                    "Some order rows had a missing or zero quantity and were skipped.")
                continue

            po = to_text(m.get("po_number")) or ""
            key = f"{po.strip().upper()}|{store_id}" if po.strip() else f"__new_{index}|{store_id}"
            entry = groups.setdefault(key, {
                "po_number": po.strip() if po.strip() else None,
                "store_id": store_id,
                "supplier_name": to_text(m.get("supplier")),
                "order_date": to_date(m.get("order_date")),
                "expected_date": to_date(m.get("expected_date")),
                "status": _normalise_order_status(m.get("status")),
                "priority": (to_text(m.get("priority")) or "medium").lower(),
                "notes": to_text(m.get("notes")),
                "lines": [],
                "seen_skus": set(),
            })
            if entry["priority"] not in _NORMAL_PRIORITY:
                entry["priority"] = "medium"
            if sku in entry["seen_skus"]:
                result.skipped += 1
                continue
            entry["seen_skus"].add(sku)
            unit_price = to_number(m.get("unit_price"))
            entry["lines"].append({
                "product_id": product_id, "sku": sku,
                "quantity": qty, "unit_price": unit_price,
                "line_total": round(qty * (unit_price or 0), 2) if unit_price else None,
            })

        for entry in groups.values():
            supplier_id = refs.supplier(entry["supplier_name"])
            total = round(sum((l["line_total"] or 0) for l in entry["lines"]), 2) or None

            # Existing PO number: update status only, never duplicate it.
            if entry["po_number"]:
                existing = (db.table("purchase_orders")
                            .select("id,status")
                            .eq("po_number", entry["po_number"])
                            .limit(1).execute()).data
                if existing:
                    if entry["status"] != "draft" and existing[0]["status"] != entry["status"]:
                        try:
                            db.table("purchase_orders").update(
                                {"status": entry["status"]}).eq(
                                "id", existing[0]["id"]).execute()
                            result.updated += 1
                        except Exception:
                            pass
                    else:
                        result.skipped += 1
                    continue

            order = {
                "po_number": entry["po_number"] or _next_po_number(db),
                "store_id": entry["store_id"],
                "supplier_id": supplier_id,
                "status": entry["status"],
                "priority": entry["priority"],
                "requested_by": actor_id,
                "requested_date": entry["order_date"] or date.today().isoformat(),
                "expected_date": entry["expected_date"],
                "notes": entry["notes"],
                "total_value": total,
            }
            try:
                created_order = db.table("purchase_orders").insert(order).execute().data[0]
            except Exception as exc:
                result.failed += 1
                message = _short(exc)
                if message not in result.messages and len(result.messages) < 12:
                    result.messages.append(f"Order {order['po_number']}: {message}")
                continue
            result.created += 1

            try:
                db.table("purchase_order_items").insert([{
                    "purchase_order_id": created_order["id"],
                    "product_id": line["product_id"],
                    "quantity": line["quantity"],
                    "unit_price": line["unit_price"],
                    "line_total": line["line_total"],
                } for line in entry["lines"]]).execute()
            except Exception as exc:
                result.failed += 1
                message = _short(exc)
                if message not in result.messages and len(result.messages) < 12:
                    result.messages.append(f"Order {order['po_number']}: {message}")

    else:
        result.messages.append(f"No commit handler for import type '{import_type}'.")

    for batch in _chunks(unmatched_batch):
        try:
            db.table("unmatched_records").insert(batch).execute()
        except Exception:
            pass

    return result
