"""Outbound email for the order-notification workflow.

A store manager submits an order -> the backend saves it -> this service builds
an Excel file of the order and emails it to the manager(s) for that store.

Rules that matter:

* The frontend never sees SMTP configuration or credentials — everything comes
  from backend/.env and stays server-side.
* If email is not configured or the send fails, the order is NOT lost: the
  caller already saved it. We log the failure and move on.
* Recipients come from, in order: the store's ``notification_email`` column,
  admin/inventory-manager profiles for that store, then the
  ``ORDER_NOTIFICATION_EMAILS`` fallback from the environment.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate

from ..core.config import get_settings, service_client
from ..services.excel_export import order_attachment_workbook

log = logging.getLogger("retailmind.email")


def warehouse_recipients(store_id: str | None = None) -> list[str]:
    """Addresses that receive a new store order.

    Resolution order, first non-empty wins at each step (all are combined):

    1. ``system_settings['warehouse.notification_email']`` — the configurable
       warehouse team address a super admin sets from System settings.
    2. Every active profile with the ``warehouse`` role (role_id 5).
    3. The store's own ``notification_email`` column, if one is set.
    4. ``ORDER_NOTIFICATION_EMAILS`` from backend/.env.

    Nothing here is ever hard-coded to a personal address, and no credential or
    address is exposed to the frontend.
    """
    settings = get_settings()
    svc = service_client()
    emails: list[str] = []

    try:
        rows = (svc.table("system_settings").select("value")
                .eq("key", "warehouse.notification_email").limit(1).execute()).data
        raw = rows[0].get("value") if rows else None
        if isinstance(raw, str):
            emails.extend(part for part in raw.replace(";", ",").split(","))
    except Exception:
        pass

    try:
        rows = (svc.table("profiles").select("email")
                .eq("role_id", 5).eq("is_active", True).execute()).data
        emails.extend(r["email"] for r in rows if r.get("email"))
    except Exception:
        pass

    if store_id:
        try:
            rows = (svc.table("stores").select("notification_email")
                    .eq("id", store_id).limit(1).execute()).data
            if rows and rows[0].get("notification_email"):
                emails.append(rows[0]["notification_email"])
        except Exception:
            pass

    emails.extend(settings.order_notification_list)
    return _unique(emails)


def _unique(emails: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for email in emails:
        clean = (email or "").strip().lower()
        if clean and "@" in clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
    return out


def manager_emails_for_store(store_id: str | None) -> list[str]:
    """Manager/admin addresses that should see orders for a store.

    Prefers an explicit store notification_email, then admin + inventory
    manager profiles for that store, then the env fallback.
    """
    settings = get_settings()
    emails: list[str] = []
    svc = service_client()

    if store_id:
        try:
            rows = (svc.table("stores").select("notification_email")
                    .eq("id", store_id).limit(1).execute()).data
            if rows and rows[0].get("notification_email"):
                emails.append(rows[0]["notification_email"])
        except Exception:
            pass

    try:
        # Roles 2 (admin) and 3 (inventory_manager) are the approvers. Only
        # those assigned to the store are store-scoped; admin profiles are not
        # store-scoped, so fetch by role and (for store managers) skip.
        rows = (svc.table("profiles")
                .select("email,role_id")
                .in_("role_id", [2, 3])
                .eq("is_active", True)
                .execute()).data
        for row in rows:
            if row.get("email"):
                emails.append(row["email"])
    except Exception:
        pass

    emails.extend(settings.order_notification_list)

    return _unique(emails)


def send_order_notification(order: dict, items: list[dict],
                           recipients: list[str]) -> tuple[bool, str | None]:
    """Email the order details with an Excel attachment.

    Returns (sent, error). Never raises — callers must not let email failures
    affect the order that was already saved.
    """
    settings = get_settings()
    if not settings.email_enabled or not recipients:
        if not settings.email_enabled:
            log.info("Order %s saved; email skipped (SMTP not configured).",
                     order.get("po_number"))
        return False, "Email not configured or no recipients."

    store = order.get("stores") or {}
    requester = order.get("requested_by_profile") or {}
    manager_name = requester.get("full_name") or requester.get("email") or "Store manager"

    subject = f"New order {order.get('po_number')} — {store.get('name') or 'store'}"
    html = f"""\
<html><body style="font-family:Arial,sans-serif;color:#2b2b2b;font-size:14px">
  <p>Hi,</p>
  <p><strong>{manager_name}</strong> has submitted a new order.</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <tr><td style="color:#777">Order ID</td><td><strong>{order.get('po_number')}</strong></td></tr>
    <tr><td style="color:#777">Store</td><td>{store.get('name')}</td></tr>
    <tr><td style="color:#777">Store Manager</td><td>{manager_name}</td></tr>
    <tr><td style="color:#777">Order Date</td><td>{order.get('requested_date') or order.get('created_at')}</td></tr>
    <tr><td style="color:#777">Expected Date</td><td>{order.get('expected_date') or '—'}</td></tr>
    <tr><td style="color:#777">Status</td><td>{order.get('status')}</td></tr>
    <tr><td style="color:#777">Priority</td><td>{order.get('priority')}</td></tr>
    <tr><td style="color:#777">Total Value</td><td>{order.get('total_value') or '—'}</td></tr>
  </table>
  <p><strong>Items ({len(items)}):</strong></p>
  <ul>
    {''.join(f"<li>{p.get('name') or 'Product'} ({p.get('sku') or '—'}) — "
             f"{i.get('quantity')} units</li>"
             for i in items for p in [i.get('products') or {}])}
  </ul>
  <p>The full order, including quantities, is attached as an Excel file.</p>
  <p style="color:#999;font-size:12px">Sent by RetailMind AI.</p>
</body></html>"""

    message = MIMEMultipart()
    message["Subject"] = subject
    message["From"] = settings.email_from
    message["To"] = ", ".join(recipients)
    message["Date"] = formatdate(localtime=True)
    message.attach(MIMEText(html, "html"))

    try:
        attachment = order_attachment_workbook(order, items)
        part = MIMEApplication(attachment, _subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        part.add_header(
            "Content-Disposition",
            "attachment",
            filename=f"order-{order.get('po_number')}.xlsx",
        )
        message.attach(part)
    except Exception as exc:
        # The email body alone is still useful; the attachment must not block it.
        log.warning("Couldn't build the order Excel attachment: %s", exc)

    try:
        if settings.smtp_use_tls:
            context = ssl.create_default_context()
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
                server.starttls(context=context)
                if settings.smtp_username:
                    server.login(settings.smtp_username, settings.smtp_password)
                server.sendmail(settings.email_from, recipients, message.as_string())
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
                if settings.smtp_username:
                    server.login(settings.smtp_username, settings.smtp_password)
                server.sendmail(settings.email_from, recipients, message.as_string())
    except Exception as exc:
        log.warning("Order email for %s failed: %s", order.get("po_number"), exc)
        return False, str(exc)

    log.info("Order email for %s sent to %s.", order.get("po_number"),
             ", ".join(recipients))
    return True, None