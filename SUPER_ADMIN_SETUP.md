# SUPER_ADMIN_SETUP.md

## The rule

Super admin credentials appear **nowhere** in the running application:

- not on the login page
- not in a demo-accounts list
- not in frontend source
- not seeded into the database
- not in any `VITE_` variable

Anything in the frontend bundle is readable by anyone who opens DevTools. A
"hidden" admin login in JavaScript is not hidden.

Promotion happens on the server, once, by someone with filesystem access to
`backend/.env`.

---

## Bootstrap

**1. Create the account normally.**

Go to <http://localhost:5173/sign-up>, sign up with the address that should own
the system, and enter the emailed six-digit code. At this point the account
exists as a `store_manager` — least privilege, the default for every new user.

**2. Promote it from the backend.**

```bash
cd backend
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1

python scripts/bootstrap_super_admin.py you@company.com
```

Output:

```
you@company.com is now super_admin.
```

**3. Sign out and back in.** Role is resolved at sign-in, so the existing session
still carries the old role until refreshed.

The Administration section now appears in the sidebar: Users, Stores, Suppliers,
Data imports, System settings, Audit logs.

---

## The same script assigns other roles

```bash
# Admin
python scripts/bootstrap_super_admin.py ops@company.com --role admin

# Inventory manager
python scripts/bootstrap_super_admin.py stock@company.com --role inventory_manager

# Store manager scoped to specific stores
python scripts/bootstrap_super_admin.py manager@company.com \
    --role store_manager --store BLR-01 --store BLR-02
```

Roles: `super_admin`, `admin`, `inventory_manager`, `store_manager`.

Every promotion writes an `audit_logs` row, so role changes are traceable
afterwards.

---

## After the first super admin

Use the app, not the script. Administration → Users → invite. That calls
`POST /api/auth/admin/users`, which is guarded by `require_super`, sends a real
Supabase invitation email, and lets the invitee set their own password. You never
handle anyone else's credentials.

---

## Fallback: promote directly in SQL

If the script can't run:

```sql
update profiles set role_id = 1, is_active = true
where email = 'you@company.com';
```

Role IDs: `1` super_admin, `2` admin, `3` inventory_manager, `4` store_manager.

Verify:

```sql
select p.email, r.name as role, p.is_active, p.email_verified
from profiles p join roles r on r.id = p.role_id
where p.email = 'you@company.com';
```

---

## What each role can reach

Enforced in three independent places: the sidebar hides what you can't use,
FastAPI dependencies (`require_super`, `require_admin`, `require_staff`) reject
the request, and Postgres RLS policies reject the query. A gap in one layer does
not open the data.

| | Super admin | Admin | Inventory manager | Store manager |
|---|---|---|---|---|
| Manage users and roles | yes | — | — | — |
| System settings, audit logs | yes | — | — | — |
| Manage stores | yes | — | — | — |
| Products, data imports | yes | yes | — | — |
| Suppliers | yes | yes | yes | — |
| Approve orders and transfers | yes | yes | yes | — |
| Update inventory | yes | yes | yes | — |
| Raise replenishment requests | yes | yes | yes | yes |
| Store scope | all | all | all | assigned only |

A store manager with no assignment signs in successfully and sees an empty
dashboard with an explanation. That is intended — assign a store to fix it.
