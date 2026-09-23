"""OpenRouter chat completions로 spec을 받는 planner. 저장소에서 네트워크를 쓰는 곳은 이 모듈뿐이다.

    OpenRouterPlanner(config, api_key, allow_api, log_dir=None)
        plan(profile, prompt)                   메시지를 조립해 API를 부르고 응답의 JSON 객체를 돌려준다
        fix(profile, prompt, previous, errors)  검증 오류를 대화에 붙여 다시 묻는다 (run_plan이 max_retries만큼 부른다)
        dry_run(profile, prompt)                요청만 log_dir/plan_request.json 에 저장한다 (API 호출 없음)
        last_usage                              마지막 성공 응답의 usage (dict) 또는 None
        total_usage                             이 planner 로 부른 성공 호출들의 usage 합계 (calls, prompt_tokens, …, cost) 또는 None
    resolve_api_key(explicit, env_file)         인자 → OPENROUTER_KEY 환경변수 → env 파일 순서로 키를 찾는다
    load_env_file(path)                         agent.config 의 것을 다시 내보낸다 (예전 import 경로 유지)
    fetch_endpoints(model, timeout)             OpenRouter 의 공개 endpoint 목록 (그 모델을 서비스하는 업체들). 키 없음
    format_endpoints(payload)                   그 목록을 tag, quantization, context, 값, uptime, status 표로

모델, 요청 파라미터, provider 라우팅, timeout, 재시도 횟수, profile 글자 수는 모두 ModelConfig(agent/config.py,
environment/models/*.yaml)에서 온다. 요청 본문은 {"model": config.model, "messages": …, **config.params} 이고,
설정에 provider 라우팅 매핑이 있으면 "provider": {…} 로 그대로 붙는다 (없으면 키 자체가 없다). 설정 파일의 태그
("gmicloud/fp8")는 config.py 가 이미 매핑으로 풀어 두었으므로 여기서는 매핑만 본다.

endpoint 목록: GET ENDPOINTS_URL (models/<author>/<slug>/endpoints) 은 공개라 키도 크레딧도 필요 없다. 응답은
{"data": {"id", "name", "endpoints": [{"tag", "provider_name", "quantization", "context_length", "pricing": {"prompt",
"completion" (토큰당 USD, 문자열)}, "uptime_last_30m", "status", …}]}} 이고, tag 가 설정 파일의 provider 에 적는 값이다.

로그 파일 (log_dir 이 있을 때 쓴다. 디버깅용이며 헤더와 키는 어디에도 쓰지 않는다):
    plan_request.json    {"model_config": {"name", "path", "api", "model", "provider": 매핑 또는 null,
                          "provider_tag": 태그 또는 null}, "endpoint": ENDPOINT, "body": {요청 본문}}
                         complete() 마다 안전장치보다 먼저 쓴다. dry_run() 은 이 파일만 쓴다.
    plan_response.json   성공: {"model_config": …, **응답 payload} (usage 가 있으면 payload 에 그대로 들어 있다. 모델 설정의
                         params 에 usage: {include: true} 가 있으면 OpenRouter 가 usage.cost 에 실제 청구액(USD)을 넣어 준다)
                         HTTP 오류: {"model_config": …, "http_status": 코드, "http_reason": 문구, **오류 본문}
                         (본문이 JSON 객체가 아니면 "body": 문자열). 응답이 JSON 이 아닐 때도 "body" 에 원문을 남긴다.
    같은 planner 로 두 번째 부르면(검증 실패 뒤 재시도) plan_request_2.json / plan_response_2.json, 세 번째는 _3 … 이다.
    첫 파일을 쓰기 전에 log_dir 의 이전 plan_request*.json / plan_response*.json 을 지워 옛 파일이 섞이지 않게 한다.

안전장치: allow_api가 False면 urlopen을 절대 부르지 않는다. 요청을 저장한 뒤 PlannerError를 올린다.
호출은 크레딧을 쓰므로 CLI의 --allow-api 또는 AGENT_ALLOW_API=1로만 켠다.
테스트는 urllib.request.urlopen을 monkeypatch 한다 (그래서 모듈 속성으로 부른다).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from agent.config import ModelConfig, load_env_file
from agent.planner.base import PlannerError
from agent.planner.prompts import build_messages

__all__ = ["ENDPOINT", "ENDPOINTS_URL", "KEY_VARIABLE", "ALLOW_VARIABLE", "NOT_ALLOWED", "NO_KEY", "REQUEST_FILE",
           "RESPONSE_FILE", "OpenRouterPlanner", "load_env_file", "resolve_api_key", "api_allowed_by_env",
           "strip_code_fences", "content_text", "parse_content", "extract_reply", "log_file_name", "clear_logs",
           "fetch_endpoints", "format_endpoints"]

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/{model}/endpoints"
ENDPOINTS_TIMEOUT = 30
ENDPOINTS_ERROR_CHARS = 300
ENDPOINT_COLUMNS = ("tag", "quantization", "context", "$in/M", "$out/M", "uptime30m", "status")
MISSING = "-"
KEY_VARIABLE = "OPENROUTER_KEY"
ALLOW_VARIABLE = "AGENT_ALLOW_API"
NOT_ALLOWED = "API call not allowed: pass --allow-api or set AGENT_ALLOW_API=1 (this spends OpenRouter credits)"
NO_KEY = f"no OpenRouter API key: set {KEY_VARIABLE} in the environment or in the env file"

REQUEST_FILE = "plan_request.json"
RESPONSE_FILE = "plan_response.json"
LOG_FILE_RE = re.compile(r"^plan_(request|response)(_\d+)?\.json$")
ERROR_BODY_CHARS = 500
# total_usage 에 더하는 usage 키. cost 는 OpenRouter 가 usage: {include: true} 일 때 주는 실제 청구액(USD, 실수)이다
USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens", "cost")

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
# 로그 파일
# ----------------------------------------------------------------------------------------------


def log_file_name(kind: str, call: int) -> str:
    """kind 는 request 또는 response. 첫 호출은 plan_<kind>.json, 두 번째부터 plan_<kind>_2.json, _3 … 이다."""
    suffix = "" if call <= 1 else f"_{call}"
    return f"plan_{kind}{suffix}.json"


def clear_logs(directory: Path) -> list[Path]:
    """directory 의 plan_request*.json / plan_response*.json 을 지우고 지운 경로를 돌려준다. 폴더가 없으면 아무것도 안 한다."""
    directory = Path(directory)
    if not directory.is_dir():
        return []
    removed = []
    for path in directory.iterdir():
        if path.is_file() and LOG_FILE_RE.match(path.name):
            path.unlink()
            removed.append(path)
    return removed


def write_json(document: Any, path: Path) -> Path:
    """보기 좋은 JSON 으로 저장한다 (indent=2, ensure_ascii=False). 부모 폴더가 없으면 만든다."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return path


def parse_json_or_text(text: str) -> Any:
    """오류 본문처럼 JSON 일 수도 아닐 수도 있는 문자열. JSON 이면 파싱한 값, 아니면 문자열 그대로."""
    try:
        return json.loads(text)
    except ValueError:
        return text


def _usage_value(usage: dict, key: str) -> int | float | None:
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


# ----------------------------------------------------------------------------------------------
# endpoint 목록 (공개 API: 키 없음, 크레딧 없음)
# ----------------------------------------------------------------------------------------------


def fetch_endpoints(model: str, timeout: int = ENDPOINTS_TIMEOUT) -> dict:
    """OpenRouter 의 공개 endpoint 목록을 받아 응답 payload({"data": {…}})를 돌려준다. 키를 보내지 않는다.

    model 은 OpenRouter 의 모델 id(author/slug)다. HTTP 오류·연결 실패·JSON 아님·모양이 다름은 모두 PlannerError.
    """
    model = model.strip()
    if "/" not in model.strip("/"):
        raise PlannerError(f"model id must look like author/slug (got {model!r})")
    url = ENDPOINTS_URL.format(model=urllib.parse.quote(model, safe="/:@"))
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        try:
            text = error.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - 본문을 못 읽어도 상태 코드는 알려 준다
            text = ""
        detail = text[:ENDPOINTS_ERROR_CHARS].strip() or str(error.reason)
        raise PlannerError(f"OpenRouter returned HTTP {error.code} for {url}: {detail}") from None
    except urllib.error.URLError as error:
        raise PlannerError(f"OpenRouter request failed: {error.reason}") from None
    except OSError as error:
        raise PlannerError(f"OpenRouter request failed: {error}") from None
    text = raw.decode("utf-8", "replace")
    try:
        payload = json.loads(text)
    except ValueError:
        raise PlannerError(f"OpenRouter response is not JSON: {text[:ENDPOINTS_ERROR_CHARS].strip()!r}") from None
    if not isinstance(payload, dict):
        raise PlannerError("unexpected response from OpenRouter (not a JSON object)")
    error = payload.get("error")
    if error:
        message = error.get("message", error) if isinstance(error, dict) else error
        raise PlannerError(f"OpenRouter error: {message}")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("endpoints"), list):
        raise PlannerError("unexpected response from OpenRouter (no data.endpoints list)")
    return payload


def _number(value: Any) -> float | None:
    """숫자 또는 숫자 문자열 → float. 아니면 None (pricing 은 문자열, uptime 은 숫자로 온다)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _price_per_million(pricing: Any, key: str) -> float | None:
    """pricing 의 토큰당 USD(문자열) → 백만 토큰당 USD. 없으면 None."""
    if not isinstance(pricing, dict):
        return None
    value = _number(pricing.get(key))
    return None if value is None else value * 1_000_000


def _money(value: float | None) -> str:
    """백만 토큰당 값을 소수 2~4 자리로 (0.15, 0.0875, 2.00). 없으면 '-'."""
    if value is None:
        return MISSING
    text = f"{value:.4f}"
    whole, fraction = text.split(".")
    fraction = fraction.rstrip("0")
    return f"{whole}.{fraction.ljust(2, '0')}"


def _endpoint_row(endpoint: dict) -> tuple[str, ...]:
    tag = endpoint.get("tag") or endpoint.get("provider_name") or MISSING
    context = _number(endpoint.get("context_length"))
    uptime = _number(endpoint.get("uptime_last_30m"))
    status = endpoint.get("status")
    return (str(tag), str(endpoint.get("quantization") or MISSING),
            MISSING if context is None else str(int(context)),
            _money(_price_per_million(endpoint.get("pricing"), "prompt")),
            _money(_price_per_million(endpoint.get("pricing"), "completion")),
            MISSING if uptime is None else f"{uptime:.1f}",
            MISSING if status is None else str(status))


def _price_key(endpoint: dict) -> tuple[float, float]:
    """정렬 키: 입력 값, 출력 값 순. 값이 없으면 맨 뒤."""
    pricing = endpoint.get("pricing")
    prompt = _price_per_million(pricing, "prompt")
    completion = _price_per_million(pricing, "completion")
    return (float("inf") if prompt is None else prompt, float("inf") if completion is None else completion)


def format_endpoints(payload: dict) -> str:
    """fetch_endpoints 의 payload → 표 (헤더, 값이 싼 순서의 endpoint 행들, 마지막 줄 "N endpoints for <model>")."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("endpoints"), list):
        raise PlannerError("unexpected endpoint listing (no data.endpoints list)")
    endpoints = [endpoint for endpoint in data["endpoints"] if isinstance(endpoint, dict)]
    rows = [_endpoint_row(endpoint) for endpoint in sorted(endpoints, key=_price_key)]
    widths = [max(len(text) for text in column) for column in zip(ENDPOINT_COLUMNS, *rows)]
    numeric = {2, 3, 4, 5}  # context, $in/M, $out/M, uptime30m 은 오른쪽 정렬

    def line(cells: tuple[str, ...]) -> str:
        parts = [cell.rjust(width) if index in numeric else cell.ljust(width)
                 for index, (cell, width) in enumerate(zip(cells, widths))]
        return "  ".join(parts).rstrip()

    model = data.get("id") or data.get("name") or "the model"
    return "\n".join([line(ENDPOINT_COLUMNS), *(line(row) for row in rows),
                      f"{len(rows)} endpoints for {model}"])


# ----------------------------------------------------------------------------------------------
# planner
# ----------------------------------------------------------------------------------------------


class OpenRouterPlanner:
    """OpenRouter에 spec을 묻는 planner. allow_api가 False면 요청만 저장하고 PlannerError를 올린다."""

    name = "openrouter"

    def __init__(self, config: ModelConfig, api_key: str | None, allow_api: bool, log_dir: Path | None = None):
        self.config = config
        self.model = config.model
        self.api_key = api_key
        self.allow_api = bool(allow_api)
        self.log_dir = Path(log_dir) if log_dir is not None else None
        self.timeout = config.timeout_seconds
        self.max_retries = config.spec_fix_retries
        self.calls = 0                          # complete() 를 부른 횟수. 로그 파일 번호로 쓴다
        self.last_usage: dict | None = None     # 마지막 성공 응답의 usage
        self.total_usage: dict | None = None    # 성공 호출들의 usage 합계 ({"calls": n, "prompt_tokens": …, "cost": …})
        self._logs_cleared = False              # 이 planner 가 log_dir 의 옛 로그를 이미 지웠는지

    # ---- 요청 조립 ---------------------------------------------------------------------------

    def messages(self, profile: dict, prompt: str, errors: list[str] | None = None,
                 previous: Any = None) -> list[dict]:
        return build_messages(profile, prompt, errors=errors, previous=previous,
                              profile_max_chars=self.config.profile_max_chars)

    def request_body(self, messages: list[dict]) -> dict:
        """chat completions 요청 본문. 설정의 params 가 그대로 펼쳐지고 (model, messages, provider 는 설정에서 막는다),
        provider 라우팅 매핑이 있으면 "provider" 로 붙는다."""
        body = {"model": self.config.model, "messages": messages, **self.config.params}
        if self.config.provider is not None:
            body["provider"] = dict(self.config.provider)
        return body

    # ---- 로그 문서 ---------------------------------------------------------------------------

    def config_summary(self) -> dict:
        """로그 파일에 적는 설정 요약. 키나 헤더는 없다. provider 는 라우팅 매핑이거나 null, provider_tag 는 설정 파일에
        적힌 태그이거나 null 이다."""
        return {"name": self.config.name, "path": self.config.display_path(), "api": self.config.api,
                "model": self.config.model, "provider": self.config.provider, "provider_tag": self.config.provider_tag}

    def request_document(self, body: dict) -> dict:
        """plan_request.json 의 내용: 어떤 설정으로 어디에 무엇을 보내는지."""
        return {"model_config": self.config_summary(), "endpoint": ENDPOINT, "body": body}

    def response_document(self, payload: Any, status: int | None = None, reason: str | None = None) -> dict:
        """plan_response.json 의 내용: 설정 요약 + 응답 payload. HTTP 오류면 상태 코드와 문구를 앞에 붙인다."""
        document: dict = {"model_config": self.config_summary()}
        if status is not None:
            document["http_status"] = status
            document["http_reason"] = reason
        if isinstance(payload, dict):
            document.update(payload)
        else:
            document["body"] = payload
        return document

    def write_request(self, body: dict, path: Path) -> Path:
        """요청 본문을 request_document 형식의 JSON으로 path 에 저장한다."""
        return write_json(self.request_document(body), path)

    def write_response(self, payload: Any, path: Path, status: int | None = None, reason: str | None = None) -> Path:
        """응답을 response_document 형식의 JSON으로 path 에 저장한다."""
        return write_json(self.response_document(payload, status, reason), path)

    def _log(self, kind: str, document: dict, call: int) -> Path | None:
        """log_dir 이 있으면 번호가 붙은 로그 파일을 쓴다. 이 planner 의 첫 로그 전에 옛 로그를 지운다."""
        if self.log_dir is None:
            return None
        if not self._logs_cleared:
            clear_logs(self.log_dir)
            self._logs_cleared = True
        return write_json(document, self.log_dir / log_file_name(kind, call))

    # ---- 호출 --------------------------------------------------------------------------------

    def dry_run(self, profile: dict, prompt: str) -> Path:
        """API를 부르지 않고 요청만 log_dir/plan_request.json 에 저장한다. 호출 횟수에는 넣지 않는다."""
        if self.log_dir is None:
            raise PlannerError("dry run needs a log directory for the request file")
        body = self.request_body(self.messages(profile, prompt))
        return self._log("request", self.request_document(body), 1)  # type: ignore[return-value]  # log_dir 이 있다

    def plan(self, profile: dict, prompt: str) -> dict:
        return self.complete(self.messages(profile, prompt))

    def fix(self, profile: dict, prompt: str, previous: dict, errors: list[str]) -> dict:
        return self.complete(self.messages(profile, prompt, errors=errors, previous=previous))

    def complete(self, messages: list[dict]) -> dict:
        """요청 저장 → 안전장치 → 호출 → 응답 저장 → 응답의 JSON 객체. 부를 때마다 로그 파일 번호가 하나 늘어난다."""
        body = self.request_body(messages)
        self.calls += 1
        call = self.calls
        self.last_usage = None
        self._log("request", self.request_document(body), call)
        if not self.allow_api:
            raise PlannerError(NOT_ALLOWED)
        if not self.api_key:
            raise PlannerError(NO_KEY)
        payload = self._post(body, call)
        self._record_usage(payload)
        return parse_content(extract_reply(payload))

    def _record_usage(self, payload: Any) -> None:
        usage = payload.get("usage") if isinstance(payload, dict) else None
        if not isinstance(usage, dict):
            return
        self.last_usage = usage
        total = dict(self.total_usage or {"calls": 0})
        total["calls"] += 1
        for key in USAGE_KEYS:
            value = _usage_value(usage, key)
            if value is not None:
                total[key] = total.get(key, 0) + value
        self.total_usage = total

    def _post(self, body: dict, call: int) -> Any:
        """요청을 보내고 응답 payload 를 돌려준다. 성공·HTTP 오류·JSON 아님 모두 log_dir 에 응답 파일을 남긴다."""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            ENDPOINT, data=data, method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            try:
                text = error.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - 본문을 못 읽어도 상태 코드는 알려 준다
                text = ""
            self._log("response", self.response_document(parse_json_or_text(text), error.code, str(error.reason)), call)
            detail = text[:ERROR_BODY_CHARS].strip() or str(error.reason)
            raise PlannerError(f"OpenRouter returned HTTP {error.code}: {detail}") from None
        except urllib.error.URLError as error:
            raise PlannerError(f"OpenRouter request failed: {error.reason}") from None
        except OSError as error:
            raise PlannerError(f"OpenRouter request failed: {error}") from None
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            self._log("response", self.response_document(text), call)
            raise PlannerError(f"OpenRouter response is not JSON: {text[:ERROR_BODY_CHARS].strip()!r}") from None
        self._log("response", self.response_document(payload), call)
        return payload
