# EMAIL_SETUP.md

The manager order-notification workflow and how to configure it.

---

## What happens when a store manager submits an order

```
Store Manager submits order
        │
        ▼
Order saved to the database (this NEVER fails because of email)
        │
        ▼
Backend builds an Excel file of the order (openpyxl)
        │
        ▼
Backend emails the manager(s) for that store with the Excel attached
        │
        ▼
Outcome recorded in the order_email_log table; failures are logged, never fatal
```

The email contains:

- Order ID (PO number)
- Store
- Store Manager
- Order Date
- Status, priority, supplier, expected date, total value
- Product details and quantities (also attached as `order-<PO>.xlsx`)

The Excel attachment contains Order ID, Store, Store Manager, Product, SKU,
Quantity, Date and Order Status.

Email is sent from the **backend only** — no SMTP credentials or API keys ever
reach the frontend. If email is not configured or the send fails, the order is
kept, the failure is logged, and a row is written to `order_email_log`.

---

## Who receives the email

Recipients are resolved in this order (first match wins, then de-duplicated):

1. The **store's notification email** — set on the store under
   **Admin → Stores → Edit store → Notification email**.
2. **Admin and inventory-manager profiles** (role_id 2 and 3) with active accounts.
3. The `ORDER_NOTIFICATION_EMAILS` fallback from `backend/.env`
   (comma-separated).

No personal address is hard-coded anywhere — everything is configuration or a
database relationship.

---

## Configuration (backend/.env)

```bash
# Leave SMTP_HOST blank to disable email entirely (orders still save).
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USERNAME=your-username
SMTP_PASSWORD=your-password
SMTP_USE_TLS=true
EMAIL_FROM=RetailMind AI <no-reply@your-domain.com>

# Fallback recipients when no store email or admin profile can be found.
ORDER_NOTIFICATION_EMAILS=manager1@example.com,manager2@example.com
```

- `EMAIL_PROVIDER`: currently only `smtp` is used (the value exists so other
  providers can be added without breaking the config).
- `SMTP_PORT`: `587` with `SMTP_USE_TLS=true`, or `465` for implicit TLS, or
  `25` for unauthenticated local relay.
- `SMTP_USERNAME`/`SMTP_PASSWORD`: your SMTP login. For Gmail use an app
  password, not your account password.
- `EMAIL_FROM`: shown as the sender. Use your own domain.

`.env.example` contains placeholders only — never commit real credentials.

### Quick local test without a real mailbox

Use a service like Mailtrap (or any SMTP sandbox):

```bash
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USERNAME=your-mt-user
SMTP_PASSWORD=your-mt-password
SMTP_USE_TLS=true
EMAIL_FROM=RetailMind AI <no-reply@retailmind.local>
ORDER_NOTIFICATION_EMAILS=you@example.com
```

Submit an order as a store manager and the email arrives in the sandbox inbox,
Excel attachment included.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Order saves but no email arrives | SMTP not configured (`SMTP_HOST` blank) — the log line says `email skipped (SMTP not configured)`. Configure SMTP and resubmit. |
| `order_email_log` shows `sent=false` with an error | SMTP refused the login or relay. Check `SMTP_USERNAME`/`SMTP_PASSWORD` and that the provider allows your sender address. |
| Email arrives without the Excel file | The attachment build failed (logged as `Couldn't build the order Excel attachment`); the HTML body is still sent. Check the backend log. |
| Recipients look wrong | Set the store's notification email under Admin → Stores → Edit, or add `ORDER_NOTIFICATION_EMAILS`. |

---

## Environment variable reference

| Variable | Meaning | Example |
|---|---|---|
| `EMAIL_PROVIDER` | Mailer to use | `smtp` |
| `SMTP_HOST` | SMTP server host | `smtp.your-provider.com` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USERNAME` | SMTP login | `api` or your username |
| `SMTP_PASSWORD` | SMTP password/app password | — |
| `SMTP_USE_TLS` | STARTTLS on connect | `true` |
| `EMAIL_FROM` | Sender line | `RetailMind AI <no-reply@your-domain.com>` |
| `ORDER_NOTIFICATION_EMAILS` | Fallback recipients, comma-separated | `a@x.com,b@y.com` |

---

# Update: warehouse order routing

When a store manager submits an order, the order is **saved first**, then the
notification is sent on a background thread. A failed or unconfigured email can
never lose an order — that is the whole reason the two are decoupled.

## Where the address comes from

No personal address is hard-coded anywhere. `warehouse_recipients()` in
`app/services/email_service.py` resolves recipients in this order and combines
them:

1. `system_settings['warehouse.notification_email']` — **the recommended place.**
   Set it in the app under *System settings*; comma-separate several addresses.
   Changing it needs no redeploy and no `.env` edit.
2. Every active profile with the `warehouse` role.
3. The store's own `stores.notification_email`, if set.
4. `ORDER_NOTIFICATION_EMAILS` in `backend/.env`.

Admin and inventory-manager approvers are still copied, so nothing that used to
be notified stops being notified.

## Required environment variables

All server-side, in `backend/.env`. None of these ever reaches the browser.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-account@yourcompany.com
SMTP_PASSWORD=your-app-password
SMTP_USE_TLS=true
EMAIL_FROM=RetailMind AI <no-reply@yourcompany.com>
ORDER_NOTIFICATION_EMAILS=warehouse@yourcompany.com
```

**Leave `SMTP_HOST` blank to disable email entirely.** Orders still save, the
warehouse board still receives them, and the Excel file is still downloadable
from the UI — only the email is skipped, and the reason is written to
`order_email_log`.

For Gmail you need an **App Password** (Google Account → Security → 2-Step
Verification → App passwords), not your normal password.

## What is attached

An `.xlsx` containing Order ID, Store, Store Code, Store Address, Store Manager,
Order Date, Expected Date, Status, Warehouse Status, Priority, Notes, and one row
per line with Product Name, SKU, MRP, Quantity, Unit Price, Line Total and Image
URL — plus unit and value totals.

This is the same workbook `GET /api/warehouse/orders/{id}/export` returns, so the
emailed file and the downloaded file are identical.

## Checking and retrying

Every attempt is written to `order_email_log` with the recipients, whether it
sent, and the error if not. To retry a specific order, the warehouse team can
call `POST /api/warehouse/orders/{id}/resend-email`.
