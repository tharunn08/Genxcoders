# ROOT_CAUSE.md

## The symptom

Backend running. `http://127.0.0.1:8000/docs` responds. Frontend running at
`http://localhost:5173`. Login shows:

> Can't reach the server. Check that the backend is running.

The backend was fine. Three separate defects combined to produce one misleading
message.

---

## Defect 1 — `VITE_API_URL` was missing from `frontend/.env`

The uploaded `frontend/.env` contained exactly two lines:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

`VITE_API_URL` was absent, even though `.env.example` listed it. So this line in
`src/lib/api.ts` fell through to its fallback:

```ts
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000/api";
```

The base URL became `http://localhost:8000/api` — note **localhost**, not
127.0.0.1. That matters for the next defect.

---

## Defect 2 — uvicorn binds IPv4 only, `localhost` may resolve to IPv6 first

Verified directly:

```
$ python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
Uvicorn running on http://127.0.0.1:8000
```

That is **one socket, on one address family**. Nothing is listening on `[::1]:8000`.

On Windows, `localhost` resolves to `::1` (IPv6) ahead of `127.0.0.1`, and
Chrome and Edge honour that order. The browser therefore connected to
`[::1]:8000`, got `ECONNREFUSED`, and never reached the backend that was
demonstrably running on `127.0.0.1:8000`.

This is why `/docs` worked while the app did not: you opened `/docs` by clicking
a `127.0.0.1` link, and the frontend used `localhost`.

---

## Defect 3 — the error handler discarded the real cause

```ts
try {
  response = await fetch(`${BASE}${path}`, { ...init, headers });
} catch {
  throw new ApiError(0, "Can't reach the server. Check that the backend is running.");
}
```

A bare `catch` with no binding. `fetch` rejects with an opaque `TypeError` for
*all* of these:

- connection refused
- DNS failure
- CORS preflight rejection
- mixed content blocked

Every one became the same sentence, which pointed at the one thing that was not
actually wrong. This defect is what turned a two-minute fix into an unfindable
bug.

---

## Defect 4 (latent) — CORS would have failed next

`backend/.env` had:

```
CORS_ORIGINS=http://localhost:5173
```

`127.0.0.1:5173` was not listed. So the obvious workaround — opening the app at
`http://127.0.0.1:5173` — would have failed preflight and produced the
**identical** message, because a CORS rejection also surfaces as a fetch
`TypeError`. Two different faults, one indistinguishable symptom.

---

## Defect 5 (latent) — backend could not start from a clean install

`requirements.txt` was missing `email-validator`. `pydantic.EmailStr` raises at
import time without it:

```
ImportError: email-validator is not installed, run `pip install 'pydantic[email]'`
```

Your machine had it via a transitive install. A fresh `pip install -r
requirements.txt` would not have started at all. Found by booting the backend in
a clean environment.

---

## Fixes applied

| # | Fix | File |
|---|-----|------|
| 1 | `VITE_API_URL` defaults to `127.0.0.1`, never `localhost`; base URL normalised for trailing slashes, missing `/api`, and duplicated `/api/api` | `frontend/src/lib/api.ts` |
| 2 | `.env.example` documents why `127.0.0.1` is required; run commands use `--host 0.0.0.0` so both address families work | `frontend/.env.example`, `SETUP_WINDOWS.md` |
| 3 | Network failures are diagnosed, not flattened: the error names the likely cause (IPv6 vs IPv4, origin mismatch, backend down) and prints remediation steps to the console in dev | `frontend/src/lib/api.ts` |
| 4 | CORS always includes both `localhost` and `127.0.0.1` on ports 5173 and 4173 in development, unioned with `.env` so a hand-edited file can't lock you out | `backend/app/core/config.py` |
| 5 | `email-validator` added; also `python-multipart` and `httpx` confirmed present | `backend/requirements.txt` |
| 6 | `/api/debug/connectivity` reports the Origin the browser actually sent and whether CORS accepts it | `backend/app/main.py` |

---

## Separately found and fixed: the OTP flow was mismatched

Not the cause of the login failure, but it would have broken password recovery.

`forgot-password` sent the mail with `sign_in_with_otp()`, which issues a
**magiclink** token. The verify step then called `verify_otp(type="recovery")`.
Supabase rejects that pairing with "Token has expired or is invalid" even when
the user types the correct digits.

Each send now has exactly one matching verify type:

```
sign_up()                -> verify_otp(type="signup")
resend(type="signup")    -> verify_otp(type="signup")
reset_password_email()   -> verify_otp(type="recovery")   <- corrected
sign_in_with_otp()       -> verify_otp(type="magiclink")
```

---

## Separately found and fixed: missing profile stranded valid logins

`current_user` raised a hard 403 when `profiles` had no row for an authenticated
user:

```python
if not rows:
    raise HTTPException(403, "No profile exists for this account.")
```

The Supabase login had already succeeded at that point, so the user saw a
correct password followed by a permission error. This happens for accounts
created in the Supabase dashboard, accounts predating the trigger, or a signup
that raced it.

`app/services/profiles.py` now provisions the missing row at least privilege
(`store_manager`) and backfills blank fields, and reports `profile_created` in
the sign-in response so the condition stays visible rather than silent.

---

## Verification performed

```
GET  /health                                    -> 200
GET  /api/health                                -> 200
OPTIONS /api/auth/sign-in  Origin 127.0.0.1:5173 -> 200, allow-origin echoed
OPTIONS /api/auth/sign-in  Origin localhost:5173 -> 200, allow-origin echoed
OPTIONS /api/products      GET/POST/PATCH/PUT/DELETE -> 200 each
POST /api/auth/sign-in  bad credentials         -> 401 "Email or password is incorrect."
POST /api/auth/sign-in  malformed email         -> 422 field-level detail
GET  /api/auth/me       no token                -> 401 "Sign in to continue."
GET  /api/auth/me       forged token            -> 401 "Signature verification failed."
GET  /api/does-not-exist                        -> 404
```

URL normalisation was unit-tested against nine malformed base values (missing,
empty, trailing slash, absent `/api`, duplicated `/api`, whitespace-padded, and
a caller passing `/api/...` itself). All nine resolve to
`http://127.0.0.1:8000/api/auth/sign-in`.

Frontend: `npm install` and `npm run build` both clean, no TypeScript errors.
