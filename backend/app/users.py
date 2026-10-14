"""계정 관리 명령. 첫 admin 은 화면이 아니라 이 명령으로 만든다 (potato 의 관리자 키를 자동으로 만드는 것과 같은 자리).

    docker compose exec backend python -m app.users create-admin --email lab@example.com --name "Lab Admin"
    docker compose exec backend python -m app.users invite --role requester [--email someone@example.com] [--days 14] [--note "…"]
    docker compose exec backend python -m app.users list
    docker compose exec backend python -m app.users set-password --email someone@example.com

비밀번호는 물어서 받는다 (두 번 입력). 스크립트에서 쓸 때는 --password-stdin 으로 표준 입력의 첫 줄을 쓴다.
create-admin 은 DB 를 준비(스키마 이전, 비어 있으면 data/ seed)한 뒤 계정을 만든다. 계정이 하나도 없을 때 만든 첫 admin 은
주인 없는 데이터(seed 와 계정 이전에 만든 Project, batch, pool, agent job, worker 메모와 차단)의 주인이 된다.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

from app import accounts
from app.db import Database
from app.errors import ApiError
from app.settings import DATABASE_URL_DEFAULT, REPO_ROOT


def read_password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Password: ")
    if getpass.getpass("Repeat the password: ") != first:
        raise ApiError("INVALID_REQUEST", "The two passwords do not match.")
    return first


def open_database(args: argparse.Namespace) -> Database:
    db = Database(args.database_url, Path(os.environ.get("DATA_DIR", "").strip() or REPO_ROOT / "data"))
    db.initialize()
    return db


def create_admin(db: Database, email: str, name: str, password: str, min_length: int = 8) -> tuple[dict, dict[str, int] | None]:
    """admin 을 만든다. 첫 계정이면 주인 없는 데이터를 넘겨받는다. (계정, 넘겨받은 수 또는 None)."""
    with db.transaction(write=True) as store:
        first = store.user_count() == 0
        user = accounts.create_user(store, email=email, password=password, display_name=name, role="admin",
                                    password_min_length=min_length)
        claimed = store.claim_unowned(user["id"]) if first else None
    return user, claimed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.users", description="Manage console accounts.")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", "").strip() or DATABASE_URL_DEFAULT)
    commands = parser.add_subparsers(dest="command", required=True)

    admin = commands.add_parser("create-admin", help="create an admin account")
    admin.add_argument("--email", required=True)
    admin.add_argument("--name", required=True)
    admin.add_argument("--password-stdin", action="store_true")

    invite = commands.add_parser("invite", help="create a sign-up invitation code")
    invite.add_argument("--role", choices=accounts.SIGNUP_ROLES, required=True)
    invite.add_argument("--email", help="only this address can use the code")
    invite.add_argument("--days", type=int, default=accounts.INVITATION_DAYS)
    invite.add_argument("--note", default="")

    commands.add_parser("list", help="list accounts")

    password = commands.add_parser("set-password", help="set a new password for an account")
    password.add_argument("--email", required=True)
    password.add_argument("--password-stdin", action="store_true")

    args = parser.parse_args(argv)
    min_length = int(os.environ.get("PASSWORD_MIN_LENGTH", "").strip() or 8)
    db = open_database(args)
    try:
        if args.command == "create-admin":
            user, claimed = create_admin(db, args.email, args.name, read_password(args), min_length)
            print(f"created admin {user['email']} ({user['id']})")
            if claimed is not None:
                print("took over the existing data: " + ", ".join(f"{n} {name}" for name, n in claimed.items()))
        elif args.command == "invite":
            with db.transaction(write=True) as store:
                invitation, code = accounts.create_invitation(store, role=args.role, email=args.email, note=args.note, days=args.days)
            limit = f" for {invitation['email']}" if invitation["email"] else ""
            print(f"{code}  ({invitation['role']}{limit}, expires {accounts.iso(invitation['expires_at'])})")
        elif args.command == "list":
            for row in db.list_users():
                worker = f"  {row['worker_id']}" if row["worker_id"] else ""
                print(f"{row['role']:<9} {row['status']:<9} {row['email']}  {row['display_name']}{worker}")
        elif args.command == "set-password":
            with db.transaction(write=True) as store:
                user = store.get_user_by_email(accounts.normalize_email(args.email))
                if user is None:
                    raise ApiError("NOT_FOUND", f"No account for {args.email}")
                secret = accounts.check_password(read_password(args), min_length)
                store.set_user_password(user["id"], accounts.hash_password(secret))
                store.delete_sessions_of(user["id"])
            print(f"set a new password for {user['email']} (signed out everywhere)")
    except ApiError as error:
        print(f"error: {error.message}", file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
