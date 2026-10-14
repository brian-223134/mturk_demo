"""계정과 로그인 (app/accounts.py, app/auth.py, routers/accounts.py, app/users.py).

비밀번호와 초대 코드의 규칙, 가입(역할별 조건, WORKER_SIGNUP, 이메일 도메인), 로그인과 로그아웃, 세션 만료, 역할별 접근(로그인 안 함 401,
worker 403), admin 의 사용자·초대 코드 관리, 만든 사람 기록, Requester 별 차단, 첫 admin 이 주인 없는 데이터를 넘겨받는 것을 본다.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.auth import SESSION_COOKIE
from app.users import create_admin, main as users_main
from conftest import TEST_PASSWORD, sign_in, use_token
from helpers import example_uploads, sample_batch_request, wait_for_job

PASSWORD = "a long enough password"


def signup(client: TestClient, **fields) -> object:
    body = {"email": "new@example.com", "password": PASSWORD, "displayName": "New Person", "role": "worker", **fields}
    return client.post("/api/auth/signup", json=body)


def error_of(response) -> tuple[int, str, str]:
    body = response.json()
    return response.status_code, body["error"]["code"], body["error"]["message"]


def invite(client: TestClient, **body) -> str:
    """admin 으로 초대 코드를 만든다 (client 의 로그인을 admin 으로 바꾼다)."""
    sign_in(client, "admin")
    response = client.post("/api/admin/invitations", json={"role": "requester", **body})
    assert response.status_code == 200, response.text
    client.cookies.clear()
    return response.json()["code"]


# ---- 규칙 ---------------------------------------------------------------------------------------


def test_password_hash_format_and_verify() -> None:
    stored = accounts.hash_password("secret value", iterations=1234)
    scheme, rounds, salt, digest = stored.split("$")
    assert (scheme, rounds, len(salt), len(digest)) == ("pbkdf2_sha256", "1234", 32, 64)
    assert accounts.verify_password("secret value", stored)
    assert not accounts.verify_password("secret valuE", stored)
    assert accounts.hash_password("secret value", iterations=1234) != stored   # salt 가 다르다
    assert not accounts.verify_password("x", "md5$1$a$b") and not accounts.verify_password("x", "broken")


def test_email_and_code_rules() -> None:
    assert accounts.normalize_email("  Kim@Example.AC.kr ") == "kim@example.ac.kr"
    for bad in ("", "no-at-sign", "a@b", "a b@c.d", None, 3):
        with pytest.raises(accounts.ApiError):
            accounts.normalize_email(bad)
    assert accounts.email_domain_allowed("a@cs.example.ac.kr", ("example.ac.kr",))
    assert not accounts.email_domain_allowed("a@example.com", ("example.ac.kr",))
    assert accounts.email_domain_allowed("a@example.com", ())
    code = accounts.new_invitation_code()
    assert len(code) == 14 and code.count("-") == 2 and not set(code) & set("01OIL")
    assert accounts.code_hash(f" {code.lower().replace('-', ' ')} ") == accounts.code_hash(code)


# ---- 가입 ---------------------------------------------------------------------------------------


def test_worker_signup_open_by_default(make_client) -> None:
    with make_client(sign_in_as=None) as client:
        assert client.get("/api/auth/options").json() == {"workerSignup": "open", "emailDomains": [], "passwordMinLength": 8}
        response = signup(client, email="  Worker.One@Example.com ")
        assert response.status_code == 201, response.text
        user = response.json()["user"]
        assert user["email"] == "worker.one@example.com" and user["role"] == "worker" and user["status"] == "active"
        assert user["workerId"].startswith("W") and len(user["workerId"]) == 13
        assert SESSION_COOKIE in response.cookies
        assert "httponly" in response.headers["set-cookie"].lower() and "samesite=lax" in response.headers["set-cookie"].lower()
        assert client.get("/api/auth/me").json()["user"]["id"] == user["id"]

        assert error_of(signup(client, email="worker.one@example.com"))[2] == "An account with this email already exists."
        assert error_of(signup(client, email="x@example.com", password="short"))[2] == "Password must be at least 8 characters."
        assert error_of(signup(client, email="x@example.com", displayName=" "))[2] == "Name is required."
        assert error_of(signup(client, email="x@example.com", role="admin"))[2] == '"role" must be "worker" or "requester".'


def test_requester_signup_needs_an_invitation(make_client) -> None:
    with make_client(sign_in_as=None) as client:
        assert error_of(signup(client, role="requester")) == (
            400, "INVALID_REQUEST", "An invitation code is required to sign up as a requester.")
        assert error_of(signup(client, role="requester", inviteCode="AAAA-BBBB-CCCC"))[2].startswith("This invitation code is not valid")

        code = invite(client, email="lab.member@example.com")
        assert error_of(signup(client, role="requester", inviteCode=code))[2] == "This invitation code is for a different email address."
        assert error_of(signup(client, role="worker", email="lab.member@example.com", inviteCode=code))[2] == (
            "This invitation code is for a requester account.")
        response = signup(client, role="requester", email="Lab.Member@example.com", inviteCode=code.lower())
        assert response.status_code == 201, response.text
        assert response.json()["user"]["role"] == "requester" and response.json()["user"]["workerId"] is None
        assert client.get("/api/batches").status_code == 200   # 바로 콘솔을 쓸 수 있다

        client.cookies.clear()
        again = signup(client, role="requester", email="other@example.com", inviteCode=code)
        assert error_of(again)[2].startswith("This invitation code is not valid")


@pytest.mark.parametrize("mode, with_code, expected", [
    ("invite", False, (400, "An invitation code is required to sign up.")),
    ("invite", True, (201, None)),
    ("closed", False, (403, "Worker sign-up is closed. Ask the lab for an account.")),
])
def test_worker_signup_modes(make_client, mode, with_code, expected) -> None:
    with make_client(sign_in_as=None, worker_signup=mode) as client:
        assert client.get("/api/auth/options").json()["workerSignup"] == mode
        code = invite(client, role="worker") if with_code else None
        response = signup(client, inviteCode=code)
        assert response.status_code == expected[0], response.text
        if expected[1]:
            assert response.json()["error"]["message"] == expected[1]


def test_signup_email_domains(make_client) -> None:
    with make_client(sign_in_as=None, signup_email_domains=("example.ac.kr",)) as client:
        assert error_of(signup(client, email="a@gmail.com"))[2] == "Sign-up is limited to these email domains: example.ac.kr."
        assert signup(client, email="a@cs.example.ac.kr").status_code == 201


def test_new_worker_ids_do_not_reuse_seed_ids(client: TestClient, monkeypatch) -> None:
    """seed worker 의 ID 가 나오면 건너뛰고 다른 ID 를 고른다."""
    seed_id = client.get("/api/workers").json()["items"][0]["WorkerId"]
    candidates = iter([seed_id[1:], "abcdef012345"])
    monkeypatch.setattr(accounts.secrets, "token_hex", lambda n: next(candidates))
    with client.app.state.db.transaction(write=True) as store:
        assert accounts.new_worker_id(store) == "Wabcdef012345"


# ---- 로그인과 세션 --------------------------------------------------------------------------------


def test_login_logout_and_wrong_credentials(make_client) -> None:
    with make_client(sign_in_as=None) as client:
        signup(client, email="w@example.com")
        client.cookies.clear()
        wrong = client.post("/api/auth/login", json={"email": "w@example.com", "password": "not it at all"})
        unknown = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": PASSWORD})
        assert error_of(wrong) == error_of(unknown) == (401, "UNAUTHORIZED", "Incorrect email or password.")

        response = client.post("/api/auth/login", json={"email": "W@Example.com", "password": PASSWORD})
        assert response.status_code == 200 and response.json()["user"]["lastLoginAt"]
        token = response.cookies[SESSION_COOKIE]
        assert client.get("/api/auth/me").status_code == 200

        assert client.post("/api/auth/logout").status_code == 204
        assert error_of(client.get("/api/auth/me"))[:2] == (401, "UNAUTHORIZED")
        use_token(client, token)   # 지운 세션의 토큰을 다시 보내도 안 된다
        assert client.get("/api/auth/me").status_code == 401


def test_session_idle_and_absolute_expiry(client: TestClient) -> None:
    db = client.app.state.db
    assert client.get("/api/auth/me").status_code == 200
    with db.transaction(write=True) as store:
        store.connection.execute("UPDATE sessions SET last_seen_at = last_seen_at - interval '481 minutes'")
    assert error_of(client.get("/api/auth/me")) == (401, "UNAUTHORIZED", "Your session has ended. Sign in again.")
    with db.transaction() as store:
        assert store.connection.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"] == 0   # 끝난 세션은 지운다

    sign_in(client)
    with db.transaction(write=True) as store:
        store.connection.execute("UPDATE sessions SET expires_at = now() - interval '1 second'")
    assert client.get("/api/batches").status_code == 401


def test_session_touch_is_throttled(client: TestClient) -> None:
    db = client.app.state.db
    with db.transaction(write=True) as store:
        store.connection.execute("UPDATE sessions SET last_seen_at = last_seen_at - interval '30 seconds'")
        before = store.connection.execute("SELECT last_seen_at FROM sessions").fetchone()["last_seen_at"]
    client.get("/api/auth/me")
    with db.transaction() as store:
        assert store.connection.execute("SELECT last_seen_at FROM sessions").fetchone()["last_seen_at"] == before
    with db.transaction(write=True) as store:
        store.connection.execute("UPDATE sessions SET last_seen_at = last_seen_at - interval '2 minutes'")
    client.get("/api/auth/me")
    with db.transaction() as store:
        assert store.connection.execute("SELECT last_seen_at FROM sessions").fetchone()["last_seen_at"] > before


# ---- 역할별 접근 -----------------------------------------------------------------------------------


def test_console_needs_a_requester_or_admin(make_client) -> None:
    with make_client(sign_in_as=None) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/auth/options").status_code == 200
        for path in ("/api/batches", "/api/templates", "/api/workers", "/api/account", "/api/agent/jobs", "/api/agent/models"):
            assert error_of(client.get(path)) == (401, "UNAUTHORIZED", "Sign in to continue."), path
        assert client.post("/api/templates", json={"name": "x", "html": "<p></p>"}).status_code == 401

        sign_in(client, "worker")
        status, code, message = error_of(client.get("/api/batches"))
        assert (status, code) == (403, "FORBIDDEN") and "signed in as a worker" in message
        assert client.get("/api/agent/jobs").status_code == 403
        assert client.get("/api/admin/users").status_code == 403

        sign_in(client, "requester")
        assert client.get("/api/batches").status_code == 200
        assert client.get("/api/admin/users").status_code == 403
        sign_in(client, "admin")
        assert client.get("/api/batches").status_code == 200 and client.get("/api/admin/users").status_code == 200


# ---- admin -------------------------------------------------------------------------------------


def test_admin_manages_users_and_invitations(client: TestClient) -> None:
    worker = sign_in(client, "worker")
    worker_token = client.cookies[SESSION_COOKIE]
    admin = sign_in(client, "admin")

    users = client.get("/api/admin/users").json()["users"]
    assert {u["role"] for u in users} == {"requester", "worker", "admin"}
    assert "password_hash" not in users[0] and "passwordHash" not in users[0]

    suspended = client.post(f"/api/admin/users/{worker['id']}/suspend").json()
    assert suspended["status"] == "suspended"
    admin_token = client.cookies[SESSION_COOKIE]
    use_token(client, worker_token)
    assert client.get("/api/auth/me").status_code == 401     # 세션이 지워졌다
    login = client.post("/api/auth/login", json={"email": "worker@example.com", "password": TEST_PASSWORD})
    assert error_of(login) == (403, "FORBIDDEN", "This account is suspended. Ask the lab administrator.")
    use_token(client, admin_token)
    assert client.post(f"/api/admin/users/{worker['id']}/activate").json()["status"] == "active"
    assert error_of(client.post(f"/api/admin/users/{admin['id']}/suspend"))[2] == "You cannot suspend your own account."
    assert client.post("/api/admin/users/u-nope/suspend").status_code == 404

    created = client.post("/api/admin/invitations", json={"role": "worker", "email": "Pilot@Example.com", "note": "pilot",
                                                          "expiresInDays": 3}).json()
    invitation = created["invitation"]
    assert invitation["email"] == "pilot@example.com" and invitation["status"] == "active" and invitation["createdBy"] == "admin@example.com"
    assert error_of(client.post("/api/admin/invitations", json={"role": "admin"}))[0] == 400
    assert error_of(client.post("/api/admin/invitations", json={"role": "worker", "expiresInDays": 365}))[2] == (
        "Expiry must be between 1 and 90 days.")
    listed = client.get("/api/admin/invitations").json()["invitations"]
    assert [i["id"] for i in listed] == [invitation["id"]] and "code" not in listed[0]

    client.cookies.clear()
    assert signup(client, email="pilot@example.com", inviteCode=created["code"]).status_code == 201
    use_token(client, admin_token)
    used = client.get("/api/admin/invitations").json()["invitations"][0]
    assert used["status"] == "used" and used["usedBy"] == "pilot@example.com"
    assert error_of(client.delete(f"/api/admin/invitations/{invitation['id']}"))[2] == "This invitation has already been used."

    spare = client.post("/api/admin/invitations", json={"role": "requester"}).json()["invitation"]
    assert client.delete(f"/api/admin/invitations/{spare['id']}").status_code == 204
    assert client.delete(f"/api/admin/invitations/{spare['id']}").status_code == 404


# ---- 만든 사람과 Requester 별 차단 --------------------------------------------------------------------


def test_owner_is_recorded(client: TestClient) -> None:
    requester = sign_in(client, "requester")
    request = sample_batch_request(client)
    batch = client.post("/api/batches", json=request).json()
    assert batch["id"], batch
    pool = client.post("/api/pools", json={"name": "Owned"}).json()
    job = client.post("/api/agent/jobs", files=example_uploads()).json()["job"]
    wait_for_job(client, job["id"])
    with client.app.state.db.transaction() as store:
        owners = {table: store.connection.execute(f"SELECT owner_id FROM {table} WHERE id = %s", (id,)).fetchone()["owner_id"]
                  for table, id in (("templates", request["templateId"]), ("batches", batch["id"]),
                                    ("pools", pool["id"]), ("agent_jobs", job["id"]))}
        seeded = store.connection.execute("SELECT owner_id FROM batches WHERE id = 'batch-1000001'").fetchone()["owner_id"]
    assert owners == dict.fromkeys(owners, requester["id"])
    assert seeded is None
    assert "owner_id" not in client.get(f"/api/agent/jobs/{job['id']}").json()   # API 의 모양은 그대로


def test_blocks_and_notes_are_per_requester(client: TestClient) -> None:
    worker_id = client.get("/api/workers").json()["items"][0]["WorkerId"]
    sign_in(client, "requester", email="a@example.com")
    assert client.post("/api/workers/block", json={"ids": [worker_id], "reason": "spam"}).status_code == 204
    client.put(f"/api/workers/{worker_id}/note", json={"note": "from A"})
    mine = client.get(f"/api/workers/{worker_id}").json()
    assert (mine["blocked"], mine["blockReason"], mine["note"]) == (True, "spam", "from A")

    sign_in(client, "requester", email="b@example.com")
    theirs = client.get(f"/api/workers/{worker_id}").json()
    assert (theirs["blocked"], theirs["note"], "blockReason" in theirs) == (False, "", False)
    listed = client.get("/api/workers", params={"page": 1, "pageSize": 100}).json()["items"]
    assert not any(w["blocked"] for w in listed)

    with client.app.state.db.transaction() as store:
        rows = store.connection.execute("SELECT worker_id, blocked FROM requester_workers").fetchall()
    assert rows == [{"worker_id": worker_id, "blocked": True}]
    assert client.get("/api/health").json()["counts"]["workers"] == 60


# ---- 첫 admin 과 명령줄 ------------------------------------------------------------------------------


def test_first_admin_takes_over_unowned_data(make_database, capsys) -> None:
    db = make_database()
    db.initialize()
    with db.transaction(write=True) as store:
        store.set_worker_meta("W-old", {"blocked": True, "blockReason": "before accounts", "note": ""})
        store.save_job({"id": "job-old", "created_at": "2026-10-01T00:00:00.000Z", "status": "succeeded", "group": None})

    admin, claimed = create_admin(db, "lab@example.com", "Lab Admin", PASSWORD)
    assert claimed == {"templates": 2, "batches": 3, "pools": 2, "agent_jobs": 1, "workers": 1}
    assert db.all_worker_meta(None) == {} and db.all_worker_meta(admin["id"])["W-old"]["blocked"] is True
    assert db.owner_of_batch("batch-1000002") == admin["id"] and db.owner_of_job("job-old") == admin["id"]

    second, claimed_again = create_admin(db, "second@example.com", "Second", PASSWORD)
    assert claimed_again is None and db.owner_of_batch("batch-1000002") == admin["id"]


def test_users_command(database_url: str, monkeypatch, capsys) -> None:
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(PASSWORD + "\n"))
    assert users_main(["--database-url", database_url, "create-admin", "--email", "Lab@Example.com", "--name", "Lab",
                       "--password-stdin"]) == 0
    out = capsys.readouterr().out
    assert "created admin lab@example.com" in out and "took over the existing data: 2 templates, 3 batches" in out

    assert users_main(["--database-url", database_url, "invite", "--role", "requester", "--email", "r@example.com"]) == 0
    code = capsys.readouterr().out.split()[0]
    assert len(code) == 14

    assert users_main(["--database-url", database_url, "list"]) == 0
    assert "admin" in capsys.readouterr().out

    assert users_main(["--database-url", database_url, "invite", "--role", "worker", "--days", "0"]) == 1
    assert "Expiry must be between" in capsys.readouterr().err
