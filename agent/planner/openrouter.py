"""OpenRouter chat completions로 spec을 받는 planner. 저장소에서 네트워크를 쓰는 곳은 이 모듈뿐이다.

    OpenRouterPlanner(config, api_key, allow_api, dry_run_path=None)
        plan(profile, prompt)                   메시지를 조립해 API를 부르고 응답의 JSON 객체를 돌려준다
        fix(profile, prompt, previous, errors)  검증 오류를 대화에 붙여 다시 묻는다 (run_plan이 max_retries만큼 부른다)
        dry_run(profile, prompt)                요청만 dry_run_path에 저장한다 (API 호출 없음)
    resolve_api_key(explicit, env_file)         인자 → OPENROUTER_KEY 환경변수 → env 파일 순서로 키를 찾는다
    load_env_file(path)                         agent.config 의 것을 다시 내보낸다 (예전 import 경로 유지)

모델, 요청 파라미터, timeout, 재시도 횟수, profile 글자 수는 모두 ModelConfig(agent/config.py, environment/models/*.yaml)
에서 온다. 요청 본문은 {"model": config.model, "messages": …, **config.params} 다.

dry-run 파일(plan_request.json)의 형식:
    {"model_config": {"name", "path", "provider", "model"}, "endpoint": ENDPOINT, "body": {요청 본문}}
헤더와 키는 들어가지 않는다.

안전장치: allow_api가 False면 urlopen을 절대 부르지 않는다. 요청을 dry_run_path에 저장한 뒤
PlannerError를 올린다. 호출은 크레딧을 쓰므로 CLI의 --allow-api 또는 AGENT_ALLOW_API=1로만 켠다.
테스트는 urllib.request.urlopen을 monkeypatch 한다 (그래서 모듈 속성으로 부른다).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from agent.config import ModelConfig, load_env_file
from agent.planner.base import PlannerError
from agent.planner.prompts import build_messages

__all__ = ["ENDPOINT", "KEY_VARIABLE", "ALLOW_VARIABLE", "NOT_ALLOWED", "NO_KEY", "OpenRouterPlanner",
           "load_env_file", "resolve_api_key", "api_allowed_by_env", "strip_code_fences", "content_text",
           "parse_content", "extract_reply"]

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
KEY_VARIABLE = "OPENROUTER_KEY"
ALLOW_VARIABLE = "AGENT_ALLOW_API"
NOT_ALLOWED = "API call not allowed: pass --allow-api or set AGENT_ALLOW_API=1 (this spends OpenRouter credits)"
NO_KEY = f"no OpenRouter API key: set {KEY_VARIABLE} in the environment or in the env file"

FENCE_RE = re.compile(r"```[A-Za-z0-9_-]*[ \t]*\r?\n(.*?)\s*```", re.DOTALL)
TRUE_VALUES = ("1", "true", "yes", "on")


# ----------------------------------------------------------------------------------------------
# 설정: 키, 허용 여부 (env 파일 읽기는 agent.config.load_env_file)
# ----------------------------------------------------------------------------------------------


def resolve_api_key(explicit: str | None, env_file: Path | str | None) -> str | None:
    """API 키를 인자 → OPENROUTER_KEY 환경변수 → env 파일 순서로 찾는다. 없으면 None."""
    if explicit and explicit.strip():
        return explicit.strip()
    from_env = os.environ.get(KEY_VARIABLE, "").strip()
    if from_env:
        return from_env
    from_file = load_env_file(env_file).get(KEY_VARIABLE, "").strip()
    return from_file or None


def api_allowed_by_env() -> bool:
    """AGENT_ALLOW_API 환경변수가 1/true/yes/on 이면 True."""
    return os.environ.get(ALLOW_VARIABLE, "").strip().lower() in TRUE_VALUES


# ----------------------------------------------------------------------------------------------
# 응답 파싱
# ----------------------------------------------------------------------------------------------


def strip_code_fences(text: str) -> str:
    """```json … ``` 같은 코드펜스가 있으면 안쪽만 돌려준다. 없으면 양끝 공백만 지운다."""
    stripped = text.strip()
    match = FENCE_RE.search(stripped)
    if match:
        return match.group(1).strip()
    return stripped


def content_text(content: Any) -> str:
    """message.content를 문자열로. 일부 provider는 [{"type": "text", "text": …}] 목록으로 준다."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    raise PlannerError("the model reply has no text content")


def parse_content(content: Any) -> dict:
    """응답 본문에서 JSON 객체를 뽑는다. 펜스를 벗기고, 그래도 안 되면 첫 '{'부터 마지막 '}'까지를 시도한다."""
    body = strip_code_fences(content_text(content))
    try:
        data = json.loads(body)
    except ValueError:
        start, end = body.find("{"), body.rfind("}")
        if start < 0 or end <= start:
            raise PlannerError(f"the model reply is not a JSON object: {body[:200]!r}") from None
        try:
            data = json.loads(body[start:end + 1])
        except ValueError as error:
            raise PlannerError(f"the model reply is not valid JSON: {error}") from None
    if not isinstance(data, dict):
        raise PlannerError("the model reply is not a JSON object")
    return data


def extract_reply(payload: Any) -> Any:
    """chat completions 응답에서 choices[0].message.content를 꺼낸다. error 필드가 있으면 PlannerError."""
    if not isinstance(payload, dict):
        raise PlannerError("unexpected response from OpenRouter (not a JSON object)")
    error = payload.get("error")
    if error:
        message = error.get("message", error) if isinstance(error, dict) else error
        raise PlannerError(f"OpenRouter error: {message}")
    choices = payload.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        raise PlannerError("OpenRouter response has no choices")
    message = choices[0].get("message") or {}
    content = message.get("content") if isinstance(message, dict) else None
    if content is None:
        raise PlannerError("OpenRouter response has no message content")
    return content


# ----------------------------------------------------------------------------------------------
# planner
# ----------------------------------------------------------------------------------------------


class OpenRouterPlanner:
    """OpenRouter에 spec을 묻는 planner. allow_api가 False면 요청만 저장하고 PlannerError를 올린다."""

    name = "openrouter"

    def __init__(self, config: ModelConfig, api_key: str | None, allow_api: bool, dry_run_path: Path | None = None):
        self.config = config
        self.model = config.model
        self.api_key = api_key
        self.allow_api = bool(allow_api)
        self.dry_run_path = Path(dry_run_path) if dry_run_path is not None else None
        self.timeout = config.timeout_seconds
        self.max_retries = config.spec_fix_retries

    def messages(self, profile: dict, prompt: str, errors: list[str] | None = None,
                 previous: Any = None) -> list[dict]:
        return build_messages(profile, prompt, errors=errors, previous=previous,
                              profile_max_chars=self.config.profile_max_chars)

    def request_body(self, messages: list[dict]) -> dict:
        """chat completions 요청 본문. 설정의 params 가 그대로 펼쳐진다 (model, messages 는 설정에서 막는다)."""
        return {"model": self.config.model, "messages": messages, **self.config.params}

    def request_document(self, body: dict) -> dict:
        """dry-run 파일에 쓰는 내용: 어떤 설정으로 어디에 무엇을 보내는지. 헤더와 키는 없다."""
        return {"model_config": {"name": self.config.name, "path": self.config.display_path(),
                                 "provider": self.config.provider, "model": self.config.model},
                "endpoint": ENDPOINT, "body": body}

    def write_request(self, body: dict, path: Path) -> Path:
        """요청 본문을 request_document 형식의 JSON으로 저장한다."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(self.request_document(body), handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        return path

    def dry_run(self, profile: dict, prompt: str) -> Path:
        """API를 부르지 않고 요청만 dry_run_path에 저장한다."""
        if self.dry_run_path is None:
            raise PlannerError("dry run needs a path for the request file")
        return self.write_request(self.request_body(self.messages(profile, prompt)), self.dry_run_path)

    def plan(self, profile: dict, prompt: str) -> dict:
        return self.complete(self.messages(profile, prompt))

    def fix(self, profile: dict, prompt: str, previous: dict, errors: list[str]) -> dict:
        return self.complete(self.messages(profile, prompt, errors=errors, previous=previous))

    def complete(self, messages: list[dict]) -> dict:
        """안전장치 → 요청 → 응답의 JSON 객체. dry_run_path가 있으면 요청을 먼저 저장한다."""
        body = self.request_body(messages)
        if self.dry_run_path is not None:
            self.write_request(body, self.dry_run_path)
        if not self.allow_api:
            raise PlannerError(NOT_ALLOWED)
        if not self.api_key:
            raise PlannerError(NO_KEY)
        return parse_content(extract_reply(self._post(body)))

    def _post(self, body: dict) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            ENDPOINT, data=data, method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            try:
                detail = error.read().decode("utf-8", "replace")[:500]
            except Exception:  # noqa: BLE001 - 본문을 못 읽어도 상태 코드는 알려 준다
                detail = ""
            raise PlannerError(f"OpenRouter returned HTTP {error.code}: {detail or error.reason}") from None
        except urllib.error.URLError as error:
            raise PlannerError(f"OpenRouter request failed: {error.reason}") from None
        except OSError as error:
            raise PlannerError(f"OpenRouter request failed: {error}") from None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise PlannerError("OpenRouter response is not JSON") from None
