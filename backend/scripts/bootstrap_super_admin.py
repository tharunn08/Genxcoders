"""Promote an account to super admin.

Run from the backend directory, on the machine that holds backend/.env:

    python scripts/bootstrap_super_admin.py you@company.com

Deliberately a server-side script. Super admin credentials must never be
hardcoded in frontend code, seeded into the database, or displayed anywhere in
the running application — anyone who can read the bundle could then read them.

Sign up through the normal UI first, verify the email, then run this once.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import service_client  # noqa: E402

ROLES = {"super_admin": 1, "admin": 2, "inventory_manager": 3, "store_manager": 4,
         "warehouse": 5}


def main() -> int:
    parser = argparse.ArgumentParser(description="Assign a role to an existing account.")
    parser.add_argument("email")
    parser.add_argument("--role", default="super_admin", choices=sorted(ROLES))
    parser.add_argument("--store", action="append", default=[],
                        help="Store code to assign (repeatable).")
    args = parser.parse_args()

    db = service_client()
    rows = (db.table("profiles").select("id,email,full_name,role_id")
            .eq("email", args.email.lower()).limit(1).execute()).data

    if not rows:
        print(f"No profile found for {args.email}.")
        print("Sign up through the app and verify the email first, then re-run this.")
        return 1

    profile = rows[0]
    db.table("profiles").update({
        "role_id": ROLES[args.role],
        "is_active": True,
    }).eq("id", profile["id"]).execute()

    for code in args.store:
        store = (db.table("stores").select("id").eq("code", code).limit(1).execute()).data
        if not store:
            print(f"  ! No store with code {code} — skipped.")
            continue
        db.table("user_store_assignments").upsert(
            {"user_id": profile["id"], "store_id": store[0]["id"]}).execute()
        print(f"  + assigned to store {code}")

    db.table("audit_logs").insert({
        "user_id": profile["id"], "user_email": profile["email"],
        "action": "role.bootstrap", "entity_type": "profile",
        "entity_id": profile["id"], "detail": {"role": args.role, "via": "cli"},
    }).execute()

    print(f"{profile['email']} is now {args.role}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
