# SETUP_WINDOWS.md

Exact commands for Windows. PowerShell throughout.

---

## 1. Backend

`.venv\`, `node_modules\` and any `.env` files are excluded from this ZIP
(they are in `.gitignore` and must never ship). Create the environment and the
config file:

```powershell
cd retailmind\backend

python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt

copy .env.example .env
notepad .env
```

Fill in your Supabase values (Project Settings → API):

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=your-jwt-secret
```

Plus, for local development:

```
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
OAUTH_REDIRECT_URL=http://localhost:5173/auth/callback
AUTH_REDIRECT_URL=http://localhost:5173/auth/callback
```

Email placeholders (for the manager order notifications) live in the same
file — see `EMAIL_SETUP.md`. Leave `SMTP_HOST` blank to disable email.

If activation is blocked:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Then start it — **note the `--host` flag**:

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` is not optional on Windows. Without it uvicorn binds a single
IPv4 socket on `127.0.0.1`, and browsers that resolve `localhost` to IPv6
(`::1`) first get connection-refused against a server that is plainly running.
That was the original bug. See `ROOT_CAUSE.md`.

Confirm:

- <http://127.0.0.1:8000/health> → `{"status":"ok", ...}`
- <http://127.0.0.1:8000/docs> → interactive API docs, including the `/api/export/*` endpoints

## 1b. Run the migrations

In the Supabase SQL editor, run `supabase\migrations\0001_schema.sql` through
`0005_quantities_orders_storage.sql` **in order**. All are additive and safe to
re-run.

- `0001` schema, `0002` RLS + triggers
- `0003` `imports` bucket, product description, indexes
- `0004` branding / media / announcements
- `0005` **product quantity settings, store notification email, the `orders`
  import type, all three storage buckets with policies, the order-email log**

`0005` also creates the storage buckets (`product-images`, `imports`,
`website-media`), and the backend creates any missing bucket automatically on
startup — so "bucket has not been created" errors cannot happen anymore.

---

## 2. Frontend

New terminal:

```powershell
cd retailmind\frontend

npm install

copy .env.example .env
notepad .env
```

`.env` must contain at minimum:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_API_URL=http://127.0.0.1:8000/api
```

Use `127.0.0.1`, not `localhost`, for the same IPv6 reason.

```powershell
npm run dev
```

Open <http://localhost:5173>.

**Vite reads `.env` only at startup.** After any edit, stop the dev server with
Ctrl+C and start it again. A hot reload will not pick it up — this is the single
most common reason a corrected `.env` appears to have no effect.

---

## 3. Confirm the wiring

Open DevTools (F12) → Console. On load you should see:

```
[RetailMind] API base resolved to http://127.0.0.1:8000/api
```

If you instead see a warning that `VITE_API_URL` is not set, the `.env` is in the
wrong folder (it belongs in `frontend/`, beside `package.json`) or the dev server
wasn't restarted.

For a full check, paste into the Console:

```js
fetch("http://127.0.0.1:8000/api/debug/connectivity").then(r => r.json()).then(console.log)
```

A response means network and CORS are both fine. It reports the exact `Origin`
your browser sent and whether the backend accepts it.

---

## 4. First account

1. Go to <http://localhost:5173/sign-up>
2. Sign up, then enter the six-digit code from your inbox
3. Promote yourself to super admin — see `SUPER_ADMIN_SETUP.md`

---

## Troubleshooting

**"Couldn't reach the API"** — the message now names the likely cause and prints
remediation steps to the Console. Read them; they are specific to what failed.

**Port 8000 already in use:**

```powershell
netstat -ano | findstr :8000
taskkill /PID <pid> /F
```

**`ImportError: email-validator is not installed`** — you're on the old
`requirements.txt`. This ZIP adds it. Re-run `pip install -r requirements.txt`.

**Login returns 403 "Verify your email"** — the account exists but is
unconfirmed. Check the inbox, or confirm it in Supabase → Authentication → Users.

**Code says invalid even though it's correct** — your Supabase email template is
sending a link instead of a token. See `SUPABASE_SETUP.md`, step 3.

**CORS error in the Console** — you opened the app on an origin the backend
doesn't list. In development both `localhost` and `127.0.0.1` on ports 5173 and
4173 are always allowed, so this should only appear if you changed the port. Add
that origin to `CORS_ORIGINS` in `backend/.env`.

---

## Production build

```powershell
cd frontend
npm run build      # outputs to dist/
npm run preview    # serves it on http://localhost:4173
```
