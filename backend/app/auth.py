"""요청 단위의 로그인 처리: 세션 쿠키를 읽고 쓰고, 경로마다 역할을 검사한다. 규칙 자체는 app/accounts.py 에 있다.

    APIRouter(dependencies=[require_roles(*CONSOLE_ROLES)])   콘솔 REST 와 agent job API 는 admin, requester 만
    current_user(request)                                     핸들러 안에서 로그인한 계정 (Store.get_user 모양)

쿠키는 HttpOnly, SameSite=Lax 다. 화면(frontend)은 /api 를 같은 주소로 프록시하므로 쿠키가 그대로 오가고, 다른 사이트에서 보낸
POST 에는 쿠키가 실리지 않는다. 세션 확인은 읽기 트랜잭션으로 하고, 끝난 세션을 지우거나 last_seen_at 을 고칠 때만 쓴다.
"""

from __future__ import annotations

from fastapi import Depends, Request, Response

from app import accounts
from app.accounts import forbidden, unauthorized
from app.settings import Settings

SESSION_COOKIE = "mturk_session"


def settings_of(request: Request) -> Settings:
    return request.app.state.settings


def load_user(request: Request) -> dict:
    """세션 쿠키 → 활성 계정. 없거나 끝났으면 401 (끝난 세션은 지운다). 한 요청 안에서는 한 번만 찾는다."""
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise unauthorized("Sign in to continue.")
    db = request.app.state.db
    hashed = accounts.token_hash(token)
    now = accounts.utcnow()
    session = db.get_session(hashed)
    state = accounts.session_state(session, settings_of(request), now)
    if state != "active":
        if session is not None:
            db.delete_session(hashed)
        raise unauthorized()
    if accounts.should_touch(session, now):
        db.touch_session(hashed, now)
    request.state.user = session["user"]
    return session["user"]


def current_user(request: Request) -> dict:
    return load_user(request)


def require_roles(*roles: str):
    """이 역할의 계정만 들어오게 하는 FastAPI 의존성. 로그인하지 않았으면 401, 다른 역할이면 403."""

    def dependency(request: Request) -> None:
        user = load_user(request)
        if user["role"] not in roles:
            raise forbidden(f"This is only for {' or '.join(roles)} accounts (you are signed in as a {user['role']}).")

    return Depends(dependency)


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=settings.session_max_days * 24 * 3600, path="/", httponly=True,
                        samesite="lax", secure=settings.session_cookie_secure)


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=settings.session_cookie_secure)
