"""계정 API (app/routes.py 의 ACCOUNT_ROUTES). 규칙은 app/accounts.py, 쿠키와 역할 검사는 app/auth.py 에 있다.

    GET  /api/auth/options                 가입 화면이 쓰는 설정 {workerSignup, emailDomains, passwordMinLength}
    POST /api/auth/signup                  {email, password, displayName, role, inviteCode?} → 201 {user} + 세션 쿠키
    POST /api/auth/login                   {email, password} → {user} + 세션 쿠키
    POST /api/auth/logout                  세션을 지우고 쿠키를 비운다 (204)
    GET  /api/auth/me                      {user}. 로그인하지 않았으면 401
    GET  /api/admin/users                  {users}
    POST /api/admin/users/{id}/suspend     정지하고 그 계정의 세션을 모두 지운다 (자기 자신은 안 된다)
    POST /api/admin/users/{id}/activate
    GET  /api/admin/invitations            {invitations} (코드 원문은 없다)
    POST /api/admin/invitations            {role, email?, note?, expiresInDays?} → {invitation, code} (코드 원문은 이때 한 번만)
    DELETE /api/admin/invitations/{id}     쓰지 않은 코드를 지운다 (204)

비밀번호 해시는 CPU 를 쓰므로 가입과 로그인은 스레드에서 처리한다 (이벤트 루프를 막지 않게).
"""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from app import accounts
from app.accounts import invitation_json, user_json
from app.auth import SESSION_COOKIE, clear_session_cookie, current_user, load_user, require_roles, set_session_cookie, settings_of
from app.errors import invalid, not_found
from app.routers.common import db_of, no_content, object_body, read_body
from app.routes import ACCOUNT_ROUTES, fastapi_path


async def get_signup_options(request: Request) -> dict:
    settings = settings_of(request)
    return {"workerSignup": settings.worker_signup, "emailDomains": list(settings.signup_email_domains),
            "passwordMinLength": settings.password_min_length}


async def signup(request: Request, response: Response) -> dict:
    body = object_body(await read_body(request), "sign-up form")
    db, settings = db_of(request), settings_of(request)
    user_agent = request.headers.get("user-agent")

    def work() -> tuple[dict, str]:
        with db.transaction(write=True) as store:
            user = accounts.signup(store, settings, body)
            token = accounts.start_session(store, settings, user, user_agent)
            return store.get_user(user["id"]), token

    user, token = await run_in_threadpool(work)
    set_session_cookie(response, settings, token)
    response.status_code = 201
    return {"user": user_json(user)}


async def login(request: Request, response: Response) -> dict:
    body = object_body(await read_body(request), "sign-in form")
    db, settings = db_of(request), settings_of(request)
    user_agent = request.headers.get("user-agent")

    def work() -> tuple[dict, str]:
        with db.transaction() as store:
            user = accounts.authenticate(store, body.get("email"), body.get("password"))
        with db.transaction(write=True) as store:
            token = accounts.start_session(store, settings, user, user_agent)
            return store.get_user(user["id"]), token

    user, token = await run_in_threadpool(work)
    set_session_cookie(response, settings, token)
    return {"user": user_json(user)}


async def logout(request: Request) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db_of(request).delete_session(accounts.token_hash(token))
    response = no_content()
    clear_session_cookie(response, settings_of(request))
    return response


async def get_me(request: Request) -> dict:
    return {"user": user_json(await run_in_threadpool(load_user, request))}


# ---- admin ---------------------------------------------------------------------------------------


async def list_users(request: Request) -> dict:
    return {"users": [user_json(row) for row in db_of(request).list_users()]}


def _set_status(request: Request, id: str, status: str) -> dict:
    if id == current_user(request)["id"] and status != "active":
        raise invalid("You cannot suspend your own account.")
    with db_of(request).transaction(write=True) as store:
        if store.get_user(id) is None:
            raise not_found("User", id)
        store.set_user_status(id, status)
        if status != "active":
            store.delete_sessions_of(id)
        return user_json(store.get_user(id))


async def suspend_user(request: Request, id: str) -> dict:
    return _set_status(request, id, "suspended")


async def activate_user(request: Request, id: str) -> dict:
    return _set_status(request, id, "active")


async def list_invitations(request: Request) -> dict:
    now = accounts.utcnow()
    return {"invitations": [invitation_json(row, now) for row in db_of(request).list_invitations()]}


async def create_invitation(request: Request) -> dict:
    body = object_body(await read_body(request), "invitation")
    now = accounts.utcnow()
    with db_of(request).transaction(write=True) as store:
        invitation, code = accounts.create_invitation(store, role=body.get("role"), email=body.get("email"), note=body.get("note"),
                                                      days=body.get("expiresInDays"), created_by=current_user(request)["id"], now=now)
    return {"invitation": invitation_json(invitation, now), "code": code}


async def delete_invitation(request: Request, id: str) -> Response:
    with db_of(request).transaction(write=True) as store:
        if not store.delete_invitation(id):
            if store.get_invitation(id) is None:
                raise not_found("Invitation", id)
            raise invalid("This invitation has already been used.")
    return no_content()


HANDLERS: dict[str, Callable] = {
    "getSignupOptions": get_signup_options,
    "signup": signup,
    "login": login,
    "logout": logout,
    "getMe": get_me,
    "listUsers": list_users,
    "suspendUser": suspend_user,
    "activateUser": activate_user,
    "listInvitations": list_invitations,
    "createInvitation": create_invitation,
    "deleteInvitation": delete_invitation,
}


def build_account_router() -> APIRouter:
    """/auth/* 는 누구나, /admin/* 는 admin 만."""
    router = APIRouter()
    for name, route in ACCOUNT_ROUTES.items():
        dependencies = [require_roles("admin")] if route.path.startswith("/admin/") else []
        router.add_api_route(fastapi_path(route.path), HANDLERS[name], methods=[route.method], name=name, operation_id=name,
                             dependencies=dependencies)
    return router
