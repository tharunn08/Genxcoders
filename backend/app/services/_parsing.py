"""File parsing for the import wizard.

Split out of ``import_engine`` because the parsing was the part that actually
broke, and it broke in ways worth naming:

* **Profiling and loading used different code paths.** ``profile_file`` read
  every sheet with ``sheet_name=None``; ``load_rows`` read ``sheet_name or 0``.
  A workbook whose first sheet wasn't the one the user picked, or a sheet name
  that round-tripped through JSON with different whitespace, silently imported
  the wrong tab. Both now go through ``read_frames``, so the names the wizard
  offers are exactly the names it later resolves.

* **Values weren't JSON-safe.** ``numpy.int64`` is not a Python ``int``, so the
  old type check stringified whole numeric columns; ``float('inf')`` serialises
  as bare ``Infinity``, which is not valid JSON and makes the browser's
  ``JSON.parse`` throw — surfacing in the UI as a connection error rather than a
  data error. Every scalar is now coerced explicitly.

* **Real spreadsheets have a title row.** Retail exports very often carry a
  merged title or a blank line above the real header, which pandas reads as
  ``Unnamed: 0, Unnamed: 1, …``. Mapping then had nothing to match and every
  column came back unmapped. ``_recover_header`` promotes the first row that
  looks like a header when that happens.

* **Encoding.** CSVs exported from Excel on Windows are frequently cp1252, not
  UTF-8. A hard ``utf-8`` decode raised ``UnicodeDecodeError``, which the router
  reported as "this file couldn't be read".
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

import pandas as pd

EXCEL_SUFFIXES = (".xlsx", ".xls", ".xlsm", ".xlsb")
TEXT_SUFFIXES = (".csv", ".tsv", ".txt")

MAX_ROWS = 100_000  # a guard rail, not a product limit


class FileUnreadable(ValueError):
    """Raised with a sentence the user can act on."""


# ---------------------------------------------------------------- scalars


def json_safe(value: Any) -> Any:
    """Coerce any cell value into something ``json.dumps`` accepts.

    Order matters: ``bool`` is checked before ``int`` because ``bool`` is a
    subclass of ``int``, and pandas/numpy scalars are unwrapped before the
    generic fallbacks.
    """
    if value is None:
        return None

    # numpy scalars expose .item(); this covers int64/float64/bool_/datetime64.
    item = getattr(value, "item", None)
    if item is not None and type(value).__module__ == "numpy":
        try:
            value = item()
        except Exception:
            return str(value)

    if value is None or value is pd.NaT:
        return None

    if isinstance(value, bool):
        return value

    if isinstance(value, (int,)):
        return int(value)

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)

    if isinstance(value, Decimal):
        as_float = float(value)
        return None if math.isnan(as_float) or math.isinf(as_float) else as_float

    if isinstance(value, (pd.Timestamp, datetime)):
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
        return value.isoformat()[:19]

    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, time):
        return value.isoformat()

    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")

    if isinstance(value, str):
        text = value.strip()
        return text or None

    if isinstance(value, (list, tuple, dict)):
        try:
            return json.dumps(value, default=str)
        except Exception:
            return str(value)

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    return str(value)


def clean_records(df: pd.DataFrame, limit: int | None = None) -> list[dict]:
    """DataFrame -> list of JSON-safe dicts, with duplicate headers disambiguated."""
    if df is None or df.empty:
        return []

    frame = df.head(limit) if limit else df
    columns = _unique_headers([str(c) for c in frame.columns])

    out: list[dict] = []
    for values in frame.itertuples(index=False, name=None):
        row: dict[str, Any] = {}
        for name, value in zip(columns, values):
            row[name] = json_safe(value)
        out.append(row)
    return out


def _unique_headers(headers: list[str]) -> list[str]:
    """Excel allows two columns called 'Qty'. dict keys don't."""
    seen: dict[str, int] = {}
    result: list[str] = []
    for raw in headers:
        name = (raw or "").strip() or "Column"
        if name in seen:
            seen[name] += 1
            name = f"{name} ({seen[name]})"
        else:
            seen[name] = 0
        result.append(name)
    return result


# ---------------------------------------------------------------- header recovery


def _looks_like_placeholder(name: Any) -> bool:
    text = str(name or "").strip().lower()
    return (not text) or text.startswith("unnamed:") or text.startswith("column")


def _recover_header(df: pd.DataFrame) -> pd.DataFrame:
    """Promote a real header row hiding under a title or blank line.

    Only fires when most columns are placeholders *and* a candidate row within
    the first few is mostly non-empty text — so a genuinely headerless file
    isn't mangled.
    """
    if df.empty:
        return df

    placeholders = sum(1 for c in df.columns if _looks_like_placeholder(c))
    if placeholders < max(2, len(df.columns) * 0.6):
        return df

    for index in range(min(6, len(df))):
        candidate = df.iloc[index]
        values = [json_safe(v) for v in candidate.tolist()]
        filled = [v for v in values if v not in (None, "")]
        texty = [v for v in filled if isinstance(v, str)]
        if len(filled) >= max(2, len(values) * 0.6) and len(texty) >= len(filled) * 0.6:
            promoted = df.iloc[index + 1:].reset_index(drop=True)
            promoted.columns = _unique_headers(
                [str(v) if v not in (None, "") else f"Column {i + 1}"
                 for i, v in enumerate(values)]
            )
            return promoted

    return df


def _tidy(df: pd.DataFrame) -> pd.DataFrame:
    """Drop entirely empty rows and columns, then recover the header if needed."""
    if df is None or df.empty:
        return pd.DataFrame()

    df = df.dropna(axis=1, how="all")
    df = df.dropna(axis=0, how="all")
    if df.empty:
        return df

    df = _recover_header(df)
    df = df.dropna(axis=0, how="all")
    df.columns = _unique_headers([str(c) for c in df.columns])

    if len(df) > MAX_ROWS:
        df = df.head(MAX_ROWS)
    return df.reset_index(drop=True)


# ---------------------------------------------------------------- decoding


def _decode(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", "replace")


def _sniff_separator(sample: str, filename: str) -> str:
    if filename.lower().endswith(".tsv"):
        return "\t"
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except Exception:
        # Fall back to whichever candidate appears most on the header line.
        first = sample.splitlines()[0] if sample.splitlines() else ""
        counts = {sep: first.count(sep) for sep in (",", ";", "\t", "|")}
        best = max(counts, key=lambda k: counts[k])
        return best if counts[best] else ","


def _flatten_json(payload: Any) -> pd.DataFrame:
    """Handles a bare array, or an object wrapping the array under a common key."""
    if isinstance(payload, list):
        return pd.json_normalize(payload)
    if isinstance(payload, dict):
        for key in ("data", "products", "items", "records", "rows", "result", "results",
                    "inventory", "stock"):
            if isinstance(payload.get(key), list):
                return pd.json_normalize(payload[key])
        for value in payload.values():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return pd.json_normalize(value)
        return pd.json_normalize([payload])
    raise FileUnreadable(
        "This JSON file doesn't contain a list of records. Expected either an "
        "array of objects, or an object with an array under a key like "
        '"data" or "items".'
    )


# ---------------------------------------------------------------- public reader


def read_frames(content: bytes, filename: str) -> tuple[str, dict[str, pd.DataFrame]]:
    """(file_type, {sheet_name: frame}) for every supported format.

    One reader for the whole wizard, so the sheet names offered at step 2 are
    exactly the keys resolvable at steps 3-5.
    """
    lower = (filename or "").lower().strip()

    if not content:
        raise FileUnreadable("That file is empty.")

    if lower.endswith(".json"):
        try:
            payload = json.loads(_decode(content))
        except json.JSONDecodeError as exc:
            raise FileUnreadable(
                f"That JSON couldn't be parsed (line {exc.lineno}, column {exc.colno}): "
                f"{exc.msg}."
            ) from exc
        return "json", {"records": _tidy(_flatten_json(payload))}

    if lower.endswith(TEXT_SUFFIXES):
        text = _decode(content)
        separator = _sniff_separator(text[:8192], lower)
        try:
            df = pd.read_csv(
                io.StringIO(text),
                sep=separator,
                engine="python",
                dtype=object,
                skip_blank_lines=True,
                on_bad_lines="skip",
            )
        except Exception as exc:
            raise FileUnreadable(
                f"That delimited file couldn't be parsed: {exc}. Check that every "
                "row has the same number of columns."
            ) from exc
        return "csv", {"data": _tidy(df)}

    if lower.endswith(EXCEL_SUFFIXES):
        try:
            book = pd.read_excel(io.BytesIO(content), sheet_name=None, dtype=object)
        except ImportError as exc:
            raise FileUnreadable(
                "The Excel reader isn't installed. Run "
                "`pip install -r requirements.txt` in the backend folder."
            ) from exc
        except Exception as exc:
            raise FileUnreadable(
                f"That workbook couldn't be opened: {exc}. If it's an old .xls "
                "file, re-save it as .xlsx."
            ) from exc

        sheets = {str(name): _tidy(df) for name, df in book.items()}
        usable = {name: df for name, df in sheets.items() if not df.empty}
        if not usable:
            raise FileUnreadable(
                "Every sheet in that workbook is empty once blank rows and "
                "columns are removed."
            )
        return "xlsx", usable

    raise FileUnreadable(
        "Supported formats are .xlsx, .xls, .xlsm, .csv, .tsv and .json. "
        f"'{filename}' isn't one of them."
    )


def resolve_sheet(sheets: dict[str, pd.DataFrame], wanted: str | None) -> tuple[str, pd.DataFrame]:
    """Pick a sheet by name, tolerating whitespace and case, never silently wrong.

    Falls back to the first sheet only when no name was asked for.
    """
    if not sheets:
        raise FileUnreadable("That file has no readable sheets.")

    if not wanted:
        name = next(iter(sheets))
        return name, sheets[name]

    if wanted in sheets:
        return wanted, sheets[wanted]

    normalised = {str(k).strip().lower(): k for k in sheets}
    key = str(wanted).strip().lower()
    if key in normalised:
        actual = normalised[key]
        return actual, sheets[actual]

    raise FileUnreadable(
        f"This file has no sheet named '{wanted}'. Available: "
        f"{', '.join(sheets)}."
    )
