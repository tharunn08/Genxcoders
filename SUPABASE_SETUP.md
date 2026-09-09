# SUPABASE_SETUP.md

Everything RetailMind AI needs on the Supabase side.

---

## 1. Database schema

SQL Editor → run in order:

1. `supabase/migrations/0001_schema.sql` — core tables, enums, indexes
2. `supabase/migrations/0002_rls.sql` — row-level security, helper functions, triggers
3. `supabase/migrations/0003_fixes.sql` — `imports` bucket, `products.description`, indexes
4. `supabase/migrations/0004_site_admin.sql` — branding, media library, announcements
5. `supabase/migrations/0005_quantities_orders_storage.sql` — **product quantity
   settings, `stores.notification_email`, the `orders` import type, all storage
   buckets + policies, and the order-email log**

All five are additive and safe to run twice. Confirm `roles` holds four rows
and that `products` has the `low_stock_threshold`, `reorder_point`,
`safety_stock` and `target_stock` columns after 0005.

---

## 2. Storage buckets

There is **nothing to create manually**. The buckets and their policies are
created by `0005_...sql`, and the backend also creates any missing bucket on
startup (service role can create buckets). If you ever see *"bucket has not
been created"*, restart the backend once — or run 0005.

| Bucket | Public | Purpose | Policies |
|---|---|---|---|
| `product-images` | Yes | Product photos (uploaded by the backend) | public read; admin write |
| `imports` | **No** | Raw uploaded Excel/CSV/JSON files | admin only, both directions |
| `website-media` | Yes | Branding assets, login images, banners | public read; super-admin write |

The public buckets are read-public so images render for everyone; the private
`imports` bucket is admin-only and is reached with the service-role key from
the backend. No service-role key ever reaches the browser.

If Storage is unavailable the import wizard still completes end to end from a
local server cache — it just tells you the archive copy didn't happen.

---

## 3. Email OTP & verification — the step that is most often wrong

Authentication → Providers → Email:

- **Confirm email**: ON
- **Email OTP Expiration**: `600` (seconds)

### URL configuration

Authentication → URL Configuration:

- **Site URL**: `http://localhost:5173` in local development (your real domain
  in production — never ship a localhost Site URL to a live deployment)
- **Redirect URLs** — add both:
  ```
  http://localhost:5173/auth/callback
  http://127.0.0.1:5173/auth/callback
  ```

Set `AUTH_REDIRECT_URL` in `backend/.env` to the same callback URL
(`http://localhost:5173/auth/callback` locally, `https://your-domain.com/auth/callback`
in production). The sign-up backend passes it as the confirmation-link target,
so a user who clicks the link in the email completes verification inside the
app instead of landing on a bare Site URL. **Localhost URLs are only correct
for local development** — in production the Site URL, Redirect URLs and
`AUTH_REDIRECT_URL` must all point at the real domain.

### Email templates: show the code, not just a link

The app verifies a **six-digit code**. Supabase's stock templates send only a
*link* (`{{ .ConfirmationURL }}`). With the stock template the user's email
contains a link to `localhost` (or your Site URL) instead of the expected OTP
— that is the "the email points at localhost" symptom. Fix it by editing these
two templates so the body contains `{{ .Token }}`:

**Confirm signup**

```html
<h2>Confirm your RetailMind AI account</h2>
<p>Your verification code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600">{{ .Token }}</p>
<p>It expires in 10 minutes.</p>
```

**Reset password**

```html
<h2>Reset your RetailMind AI password</h2>
<p>Your recovery code is:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:600">{{ .Token }}</p>
<p>It expires in 10 minutes. If you didn't request this, ignore this email.</p>
```

Keeping `{{ .ConfirmationURL }}` in the template is fine too — the app now
handles that link as well (see below). The code is what the Verify screen
expects.

### Both verification paths now work

1. **Typed code**: user enters the six digits on `/verify` → the backend calls
   `verify_otp(type="signup")`. (Needs the template above.)
2. **Email link**: the confirmation URL points at `/auth/callback` (via
   `AUTH_REDIRECT_URL`) → `OAuthCallback` exchanges the `token_hash` and signs
the user in. No hardcoded OTPs anywhere — Supabase issues and validates every
code.

### Which flow sends which

Getting this pairing wrong produces "Token has expired or is invalid" on a
perfectly correct code.

| App action | Supabase call | Verify type |
|---|---|---|
| Sign up | `sign_up()` | `signup` |
| Resend code | `resend(type="signup")` | `signup` |
| Forgot password | `reset_password_email()` | `recovery` |

---

## 4. SMTP (needed for verification emails)

Supabase's built-in mailer is rate-limited to a handful of messages per hour and
will silently throttle you.

Project Settings → Authentication → SMTP Settings. Any provider works — Resend,
SendGrid, Postmark, Gmail SMTP. Set the sender name to `RetailMind AI`.

This is the mailer for **auth emails** (OTP, recovery). The **order
notification** emails with Excel attachments are sent by the backend's own SMTP
configuration — see `EMAIL_SETUP.md`.

---

## 5. Google OAuth

**In Google Cloud Console:**

1. APIs & Services → Credentials → Create OAuth client ID → Web application
2. Authorised redirect URI — copy this exactly from Supabase:
   ```
   https://YOUR-PROJECT.supabase.co/auth/v1/callback
   ```
3. Copy the Client ID and Client Secret

**In Supabase:**

1. Authentication → Providers → Google → Enable
2. Paste the Client ID and Secret
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:5173`
   - Redirect URLs — add both:
     ```
     http://localhost:5173/auth/callback
     http://127.0.0.1:5173/auth/callback
     ```

Miss the redirect URL and Google returns to the app without a session. The
callback screen says exactly that rather than failing silently.

**How it works here:** `supabase-js` completes the PKCE exchange in the browser,
then hands the access token to `POST /api/auth/session`. The backend resolves
profile, role and store assignments through the same code path as password
sign-in, so a first-time Google user gets a profile provisioned at
`store_manager` instead of hitting a dead end.

Password sign-in deliberately does *not* go through `supabase-js` — it goes to
FastAPI, keeping one server-side path for role resolution.

---

## 6. Cloudflare Turnstile (optional)

Leave both keys blank and the widget doesn't render, the backend skips
verification, and nothing pretends otherwise. There is no fake checkbox.

To enable:

1. Cloudflare dashboard → Turnstile → Add site
2. `frontend/.env`: `VITE_TURNSTILE_SITE_KEY=0x4...` (site key is public)
3. `backend/.env`: `TURNSTILE_SECRET_KEY=0x4...` (**secret — backend only**)
4. Restart both servers

The backend verifies every token against Cloudflare's siteverify endpoint.
Applied to sign-up, sign-in and forgot-password.

Never put the secret key in a `VITE_` variable — anything prefixed `VITE_` is
compiled into the browser bundle and is readable by anyone.

---

## 7. Verifying RLS

Row-level security is enforced independently of the API, so a missed check in
application code still can't leak data.

Quick test in the SQL Editor:

```sql
-- Should list four roles
select id, name from roles order by id;

-- Should list your policies
select tablename, policyname from pg_policies
where schemaname = 'public' order by tablename;
```

Store managers are constrained by `has_store_access()`, which returns true only
for stores in their `user_store_assignments`. Every other role sees all stores.

---

## 8. If a user exists but login fails

Previously a missing `profiles` row caused a 403 *after* a successful password
check. The backend now provisions the row automatically at least privilege.

To inspect the chain manually:

```sql
select u.id, u.email, u.email_confirmed_at,
       p.id as profile_id, r.name as role,
       count(a.store_id) as stores
from auth.users u
left join profiles p on p.id = u.id
left join roles r on r.id = p.role_id
left join user_store_assignments a on a.user_id = u.id
group by u.id, u.email, u.email_confirmed_at, p.id, r.name
order by u.created_at desc;
```

A null `profile_id` means the trigger didn't fire — re-run `0002_rls.sql`, which
recreates `on_auth_user_created`.

A store manager with `stores = 0` signs in successfully but sees an empty
dashboard. That is correct behaviour, not a bug: assign a store.

---

## 9. Creating users without invitations

There is no invitation flow. A super admin goes to **Admin → Users → Add user**
and enters name, email, password, role, store and status. The backend calls
`supabase.auth.admin.create_user` with `email_confirm: true`, so the account is
confirmed immediately and the user signs in with email + password right away.
Passwords are hashed by Supabase Auth — they are never stored or shown by this
application.

Deleting a user removes the Supabase auth account (profiles and store
assignments cascade). The API refuses to delete your own account or the last
active super admin; orders and imports that referenced the user keep their
history via `ON DELETE SET NULL` columns.

---

## 10. Re-run everything safely

All migrations are idempotent (`if not exists`, `on conflict do nothing`). To
bring a fresh project to the current state, run 0001 → 0005 in order. To
upgrade a running project, run 0003 → 0005 (0001/0002 were already applied).


---

# Update: migration 0006 (warehouse & fulfilment)

**Run this before starting the app for the first time after this update.**

Supabase → SQL Editor → paste `supabase/migrations/0006_warehouse_fulfilment.sql`
→ Run. Or, with the CLI: `supabase db push`.

It is **additive and idempotent**: it adds one role, nullable columns, three
tables and their policies. It drops nothing, changes no existing policy, and is
safe to run twice and safe to run on a live project.

## What it adds

| Object | Why |
|---|---|
| Role `warehouse` (id 5) | An account that is not store-scoped but has no catalogue, settings or user access. `has_store_access()` already returns true for any non-`store_manager` role, so the warehouse team sees every store's orders without that function being touched. |
| `purchase_orders.fulfillment_status` + timestamps, tracking, notes | The warehouse pipeline. Kept **separate** from `purchase_orders.status` so nothing that already reads `status` changes meaning. |
| `stores.address`, `stores.contact_phone` | Somewhere to deliver to, printed on the packing list and the order email. |
| `order_events` | One row per status change, so the store manager's tracker is a real history, not a single current value. |
| `packing_lists`, `packing_list_items` | A saved snapshot of what was packed — name, SKU, MRP and image copied at generation time, so re-downloading months later reproduces the original even if the catalogue has changed. |
| `warehouse.notification_email` etc. in `system_settings` | Configurable warehouse recipients, editable from System settings without a redeploy. |
| `store_sales` on the `import_type` enum | Store-level daily takings with no SKU column. |

## Backfill

Existing orders predate the fulfilment axis, so the migration ends by setting a
sensible starting state: `received` → `delivered`, `in_transit` /
`partially_received` → `shipped`, `cancelled` / `rejected` → `cancelled`, and
everything else stays `pending`.

## Creating a warehouse account

Sign the person up through the normal UI, verify the email, then:

```powershell
cd backend
python scripts\bootstrap_super_admin.py warehouse@yourcompany.com --role warehouse
```

They will see only the Warehouse board — no catalogue, no inventory, no settings.
That is enforced by `require_warehouse` in the backend and by row-level security,
not by hiding buttons.
