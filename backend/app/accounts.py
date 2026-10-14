"""계정, 비밀번호, 세션, 초대 코드. HTTP 와 무관한 규칙만 둔다 (쿠키와 권한 검사는 app/auth.py, 경로는 routers/auth.py·admin.py).

    역할      admin(Requester 화면 + 사용자 관리), requester(콘솔), worker(작업 화면). 계정 하나에 하나
    가입      worker 는 Settings.worker_signup 에 따라(open | invite | closed), requester 는 언제나 초대 코드, admin 은 명령으로만
    비밀번호  PBKDF2-HMAC-SHA256, 사용자별 salt. 'pbkdf2_sha256$<반복 횟수>$<salt>$<hash hex>' 로 저장해 반복 횟수를 나중에 늘릴 수 있다
    세션      쿠키에는 무작위 토큰, DB 에는 그 SHA-256. 마지막 요청에서 session_idle_minutes, 로그인에서 session_max_days 가 지나면 끝
    초대 코드 'ABCD-EFGH-JKMN' 모양(헷갈리는 글자 0 O 1 I L 없음). 원문은 만들 때 한 번만 돌려주고 해시만 둔다

사용자 JSON(API 로 내보내는 모양): {id, email, displayName, role, status, workerId, createdAt, lastLoginAt}.
Requester 화면에는 worker 의 이메일과 이름을 보내지 않는다 (worker 는 WorkerId 로만 보인다).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone

from app.db import Store
from app.errors import ApiError, invalid
from app.settings import Settings

ROLES = ("admin", "requester", "worker")
CONSOLE_ROLES = ("admin", "requester")
SIGNUP_ROLES = ("requester", "worker")
STATUSES = ("active", "suspended")

PBKDF2_ITERATIONS = 600_000      # OWASP 권장값. 테스트는 시간을 줄이려고 낮춘다 (저장된 해시는 자기 반복 횟수로 검사한다)
HASH_SCHEME = "pbkdf2_sha256"
EMAIL_MAX = 254
NAME_MAX = 80
PASSWORD_MAX = 256
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_RE = re.compile(r"[^A-Z0-9]")
INVITATION_DAYS = 14
INVITATION_MAX_DAYS = 90
TOUCH_INTERVAL = timedelta(seconds=60)   # 세션의 last_seen_at 은 이 간격보다 자주 고치지 않는다 (요청마다 쓰지 않게)

WRONG_CREDENTIALS = "Incorrect email or password."
SESSION_ENDED = "Your session has ended. Sign in again."


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def unauthorized(message: str = SESSION_ENDED) -> ApiError:
    return ApiError("UNAUTHORIZED", message)


def forbidden(message: str) -> ApiError:
    return ApiError("FORBIDDEN", message)


# ---- 값 검사 -----------------------------------------------------------------------------------


def normalize_email(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise invalid("Email is required.")
    email = value.strip().lower()
    if len(email) > EMAIL_MAX or not EMAIL_RE.match(email):
        raise invalid("Enter a valid email address.")
    return email


def email_domain_allowed(email: str, domains: tuple[str, ...]) -> bool:
    """domains 가 비어 있으면 모두 허용. 하위 도메인(cs.example.ac.kr)도 허용한다."""
    if not domains:
        return True
    host = email.rsplit("@", 1)[1]
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def display_name_of(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise invalid("Name is required.")
    name = " ".join(value.split())
    if len(name) > NAME_MAX:
        raise invalid(f"Name must be at most {NAME_MAX} characters.")
    return name


def check_password(value: object, min_length: int) -> str:
    if not isinstance(value, str) or value == "":
        raise invalid("Password is required.")
    if len(value) < min_length:
        raise invalid(f"Password must be at least {min_length} characters.")
    if len(value) > PASSWORD_MAX:
        raise invalid(f"Password must be at most {PASSWORD_MAX} characters.")
    if value.strip() == "":
        raise invalid("Password cannot be only spaces.")
    return value


# ---- 비밀번호 -----------------------------------------------------------------------------------


def hash_password(password: str, iterations: int | None = None) -> str:
    rounds = iterations or PBKDF2_ITERATIONS
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), rounds)
    return f"{HASH_SCHEME}${rounds}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt, expected = stored.split("$")
        if scheme != HASH_SCHEME:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), int(rounds))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


_dummy_hash: dict[int, str] = {}


def burn_password_check(password: str) -> None:
    """없는 계정에도 같은 시간만큼 해시를 계산해 응답 시간으로 계정이 있는지 드러나지 않게 한다."""
    rounds = PBKDF2_ITERATIONS
    if rounds not in _dummy_hash:
        _dummy_hash[rounds] = hash_password(secrets.token_hex(8), rounds)
    verify_password(password, _dummy_hash[rounds])


# ---- ID 와 토큰 ---------------------------------------------------------------------------------


def new_user_id() -> str:
    return f"u-{secrets.token_hex(6)}"


def new_worker_id(store: Store) -> str:
    """'W' + 12 hex. 이미 쓰인 WorkerId(seed worker 포함)와 겹치지 않는다."""
    for _ in range(20):
        candidate = f"W{secrets.token_hex(6)}"
        if not store.worker_id_in_use(candidate):
            return candidate
    raise RuntimeError("could not allocate a worker id")


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_invitation_code() -> str:
    letters = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    return "-".join(letters[i:i + 4] for i in range(0, 12, 4))


def normalize_code(value: object) -> str:
    """사람이 옮겨 적은 코드: 공백과 하이픈, 대소문자를 무시한다."""
    return CODE_RE.sub("", value.upper()) if isinstance(value, str) else ""


def code_hash(code: str) -> str:
    return token_hash(normalize_code(code))


# ---- 내보내는 모양 ---------------------------------------------------------------------------------


def user_json(row: dict) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "displayName": row["display_name"],
        "role": row["role"],
        "status": row["status"],
        "workerId": row.get("worker_id"),
        "createdAt": iso(row["created_at"]),
        "lastLoginAt": iso(row.get("last_login_at")),
    }


def invitation_status(row: dict, now: datetime) -> str:
    if row["used_at"] is not None:
        return "used"
    return "expired" if row["expires_at"] <= now else "active"


def invitation_json(row: dict, now: datetime) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "email": row["email"],
        "note": row["note"],
        "status": invitation_status(row, now),
        "createdAt": iso(row["created_at"]),
        "expiresAt": iso(row["expires_at"]),
        "createdBy": row.get("created_by_email"),
        "usedAt": iso(row["used_at"]),
        "usedBy": row.get("used_by_email"),
    }


# ---- 계정 만들기 -----------------------------------------------------------------------------------


def create_user(store: Store, *, email: str, password: str, display_name: str, role: str, now: datetime | None = None,
                password_min_length: int = 8) -> dict:
    """검사한 값으로 계정을 만든다 (worker 면 WorkerId 도). 이메일이 이미 있으면 400. 만든 행(get_user 모양)을 돌려준다."""
    if role not in ROLES:
        raise invalid(f"Unknown role: {role}")
    email = normalize_email(email)
    display_name = display_name_of(display_name)
    check_password(password, password_min_length)
    if store.get_user_by_email(email) is not None:
        raise invalid("An account with this email already exists.")
    user_id = new_user_id()
    store.insert_user({"id": user_id, "email": email, "password_hash": hash_password(password), "display_name": display_name,
                       "role": role, "status": "active", "created_at": now or utcnow()})
    if role == "worker":
        store.insert_worker_profile(user_id, new_worker_id(store))
    return store.get_user(user_id)


def signup(store: Store, settings: Settings, body: dict, now: datetime | None = None) -> dict:
    """화면의 회원가입. role 은 worker 또는 requester. 규칙을 어기면 400 (어떤 규칙인지 문구로)."""
    now = now or utcnow()
    role = body.get("role")
    if role not in SIGNUP_ROLES:
        raise invalid('"role" must be "worker" or "requester".')
    email = normalize_email(body.get("email"))
    if not email_domain_allowed(email, settings.signup_email_domains):
        raise invalid("Sign-up is limited to these email domains: " + ", ".join(settings.signup_email_domains) + ".")

    needs_code = role == "requester" or settings.worker_signup == "invite"
    if role == "worker" and settings.worker_signup == "closed":
        raise forbidden("Worker sign-up is closed. Ask the lab for an account.")
    invitation = None
    raw_code = body.get("inviteCode")
    if needs_code or (isinstance(raw_code, str) and raw_code.strip()):
        if not normalize_code(raw_code):
            raise invalid("An invitation code is required to sign up as a requester." if role == "requester"
                          else "An invitation code is required to sign up.")
        invitation = store.get_invitation_by_code(code_hash(raw_code))
        if invitation is None or invitation_status(invitation, now) != "active":
            raise invalid("This invitation code is not valid. It may have expired or already been used.")
        if invitation["role"] != role:
            raise invalid(f"This invitation code is for a {invitation['role']} account.")
        if invitation["email"] and invitation["email"] != email:
            raise invalid("This invitation code is for a different email address.")

    user = create_user(store, email=email, password=body.get("password"), display_name=body.get("displayName"), role=role,
                       now=now, password_min_length=settings.password_min_length)
    if invitation is not None and not store.use_invitation(invitation["id"], user["id"], now):
        raise invalid("This invitation code has just been used.")
    return user


def authenticate(store: Store, email: object, password: object) -> dict:
    """이메일과 비밀번호가 맞는 활성 계정. 틀리면 이메일이 있는지 알려 주지 않는 같은 401 문구."""
    try:
        address = normalize_email(email)
    except ApiError:
        address = None
    secret = password if isinstance(password, str) else ""
    user = store.get_user_by_email(address) if address else None
    if user is None:
        burn_password_check(secret)
        raise unauthorized(WRONG_CREDENTIALS)
    if not verify_password(secret, user["password_hash"]):
        raise unauthorized(WRONG_CREDENTIALS)
    if user["status"] != "active":
        raise forbidden("This account is suspended. Ask the lab administrator.")
    return user


# ---- 세션 ---------------------------------------------------------------------------------------


def start_session(store: Store, settings: Settings, user: dict, user_agent: str | None = None, now: datetime | None = None) -> str:
    """세션을 만들고 쿠키에 넣을 토큰 원문을 돌려준다. 로그인 시각도 적는다. 오래된 세션은 이참에 지운다."""
    now = now or utcnow()
    store.delete_stale_sessions(now, now - timedelta(minutes=settings.session_idle_minutes))
    token = new_token()
    store.insert_session(token_hash(token), user["id"], now, now + timedelta(days=settings.session_max_days),
                         (user_agent or "")[:300] or None)
    store.record_login(user["id"], now)
    return token


def session_state(session: dict | None, settings: Settings, now: datetime | None = None) -> str:
    """get_session 의 결과 → 'active' | 'ended' | 'missing'. ended 는 절대 만료, 유휴 만료, 정지되었거나 지워진 계정이다."""
    if session is None:
        return "missing"
    now = now or utcnow()
    user = session.get("user")
    idle_limit = session["last_seen_at"] + timedelta(minutes=settings.session_idle_minutes)
    if user is None or user["status"] != "active" or session["expires_at"] <= now or idle_limit <= now:
        return "ended"
    return "active"


def should_touch(session: dict, now: datetime | None = None) -> bool:
    """last_seen_at 을 고칠 때가 됐는지 (요청마다 쓰지 않도록 TOUCH_INTERVAL 마다 한 번)."""
    return (now or utcnow()) - session["last_seen_at"] >= TOUCH_INTERVAL


# ---- 초대 코드 -------------------------------------------------------------------------------------


def create_invitation(store: Store, *, role: object, email: object = None, note: object = "", days: object = None,
                      created_by: str | None = None, now: datetime | None = None) -> tuple[dict, str]:
    """초대 코드를 만든다. (invitation 행, 코드 원문). 원문은 여기서만 볼 수 있다."""
    now = now or utcnow()
    if role not in SIGNUP_ROLES:
        raise invalid('"role" must be "worker" or "requester".')
    address = normalize_email(email) if isinstance(email, str) and email.strip() else None
    if days is None or days == "":
        days = INVITATION_DAYS
    if isinstance(days, bool) or not isinstance(days, (int, float)) or not 1 <= days <= INVITATION_MAX_DAYS:
        raise invalid(f"Expiry must be between 1 and {INVITATION_MAX_DAYS} days.")
    if note is not None and not isinstance(note, str):
        raise invalid('"note" must be a string.')
    code = new_invitation_code()
    invitation_id = f"inv-{secrets.token_hex(6)}"
    store.insert_invitation({"id": invitation_id, "code_hash": code_hash(code), "role": role, "email": address,
                             "note": (note or "").strip()[:200], "created_by": created_by, "created_at": now,
                             "expires_at": now + timedelta(days=float(days))})
    return store.get_invitation(invitation_id), code
