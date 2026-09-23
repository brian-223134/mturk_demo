"""모델 설정: environment/models/<이름>.yaml 을 읽어 ModelConfig 로 만든다. 표준 라이브러리만 쓰되 yaml 만 늦게 import 한다.

    ModelConfig                                   api, model, 요청 파라미터, provider 라우팅, timeout, planner 값 (frozen dataclass)
    resolve_model_config_path(value, models_dir)  이름 → <models_dir>/<이름>.yaml, .yaml/.yml 이나 경로 구분자가 있으면 경로 그대로
    load_model_config(value, models_dir)          yaml 을 읽고 검사해 ModelConfig 를 돌려준다 (문제가 있으면 ConfigError)
    selected_model_name(env_file)                 AGENT_MODEL 환경변수 → env 파일 → "default"
    load_env_file(path)                           KEY=value 줄을 읽는다 (따옴표, 주석, export 처리. 파일이 없으면 빈 dict)

PyYAML 은 컨테이너 안에만 설치된다 (agent/requirements.txt). 호스트에 없으면 load_model_config 가 ConfigError 로
안내하고, --spec 만 쓰는 실행은 이 모듈의 yaml 부분을 건드리지 않으므로 그대로 돈다.
설정 파일의 키:
    api               호출하는 API. 지금은 openrouter 뿐이다 (필수)
    model             그 API 의 모델 id (필수)
    params            chat completions 요청 본문에 그대로 펼쳐지는 파라미터. 값은 중첩된 매핑이어도 된다
                      (response_format: {type: json_object}, reasoning: {effort: medium} 처럼 API 가 받는 형태 그대로)
    provider          OpenRouter 의 provider 라우팅 설정 (선택). OpenRouter 에서 "provider" 는 OpenRouter 자신이 아니라
                      그 모델을 실제로 서비스하는 업체(DeepInfra, GMICloud 같은)다. 세 가지 형태를 받는다:
                        없음(null)        OpenRouter 가 고른다. 요청 본문에 provider 키가 없다 (기본)
                        태그 문자열        "<slug>" 또는 "<slug>/<quantization>" (gmicloud/fp8 처럼). 그 업체로만 보내고
                                          fallback 은 없다: {"order": [slug], "allow_fallbacks": False, "quantizations": [q]}
                                          로 풀린다. 태그는 `python3 -m agent providers <모델 id>` 가 보여 주는 tag 열이다
                        매핑              OpenRouter 의 provider routing 필드(order, allow_fallbacks, quantizations, ignore,
                                          sort, require_parameters, data_collection …)를 요청 본문에 그대로 넣는다
    timeout_seconds   요청 하나를 기다리는 최대 시간
    planner           spec_fix_retries, profile_max_chars
예전 형식의 `provider: openrouter` (문자열) 는 api 가 있든 없든 api 로 이름을 바꾸라는 ConfigError 를 낸다.

비밀(API 키)은 설정 파일이 아니라 environment/.env 에만 둔다. params 는 요청 본문에 그대로 펼쳐지므로 model, messages,
provider 를 덮어쓰지 못하게 막는다 (provider 라우팅은 최상위 provider 키에 적는다).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.profile import PROMPT_MAX_CHARS_DEFAULT

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = Path("environment/models")
DEFAULT_MODEL_NAME = "default"
MODEL_VARIABLE = "AGENT_MODEL"
SUPPORTED_APIS = ("openrouter",)
CONFIG_SUFFIXES = (".yaml", ".yml")
RESERVED_PARAMS = ("model", "messages", "provider")
PROVIDER_ROUTING_HINT = "the OpenRouter provider routing preferences (order, allow_fallbacks, quantizations, ...)"
# provider 태그: "<slug>" 또는 "<slug>/<quantization>". slug 는 OpenRouter 의 업체 슬러그(소문자), quantization 은
# OpenRouter 가 provider.quantizations 에 받는 값이다 (2026-09 기준 문서의 목록).
PROVIDER_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
QUANTIZATIONS = ("int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown")
PROVIDERS_COMMAND = "python3 -m agent providers <model>"
PROVIDER_TAG_HINT = (f"a provider tag is '<slug>' or '<slug>/<quantization>' (e.g. gmicloud/fp8): the slug is lower-case "
                     f"letters, digits and '-', the quantization is one of {', '.join(QUANTIZATIONS)}; "
                     f"list the tags of a model with '{PROVIDERS_COMMAND}'")

# 설정 파일에 값이 없을 때의 기본값. environment/models/default.yaml 은 같은 값을 명시적으로 적어 둔다.
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_SPEC_FIX_RETRIES = 1
# 프롬프트에 넣는 profile 의 최대 글자 수. profile_for_prompt 의 기본값과 같은 값을 쓴다 (agent/profile.py 가 원본).
DEFAULT_PROFILE_MAX_CHARS = PROMPT_MAX_CHARS_DEFAULT

NO_PYYAML = ("PyYAML is not installed. Run inside Docker (docker compose run --rm agent ...) "
             "or install it in a virtual environment.")


class ConfigError(ValueError):
    """모델 설정을 읽거나 검사하는 데 실패했을 때 (PyYAML 없음, 파일 없음, 형식 오류)."""


@dataclass(frozen=True)
class ModelConfig:
    """모델 설정 파일 하나의 내용. name 은 파일 이름(확장자 없음), path 는 읽은 파일이다.

    api 는 호출하는 API(openrouter), provider 는 OpenRouter 의 provider 라우팅 매핑이거나 None(OpenRouter 가 고른다).
    설정 파일에 태그("gmicloud/fp8")를 적었으면 provider 는 그 태그를 푼 매핑이고 provider_tag 에 태그가 남는다
    (매핑을 직접 적었거나 없으면 None).
    """

    name: str
    path: Path
    api: str
    model: str
    params: dict
    provider: dict | None
    timeout_seconds: int
    spec_fix_retries: int
    profile_max_chars: int
    provider_tag: str | None = None

    def display_path(self) -> str:
        """로그와 dry-run 파일에 쓰는 경로. 저장소 안이면 저장소 루트 기준 상대 경로, 아니면 그대로."""
        return display_path(self.path)


# ----------------------------------------------------------------------------------------------
# env 파일
# ----------------------------------------------------------------------------------------------


def load_env_file(path: Path | str | None) -> dict[str, str]:
    """KEY=value 줄로 된 env 파일을 읽는다. 빈 줄과 # 주석은 건너뛰고, 앞의 export 와 값의 따옴표를 벗긴다."""
    values: dict[str, str] = {}
    if path is None:
        return values
    path = Path(path)
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            comment = value.find(" #")
            if comment >= 0:
                value = value[:comment].rstrip()
        values[key] = value
    return values


def selected_model_name(env_file: Path | str | None) -> str:
    """쓸 모델 설정의 이름(또는 경로). AGENT_MODEL 환경변수 → env 파일의 AGENT_MODEL → "default" 순서."""
    from_env = os.environ.get(MODEL_VARIABLE, "").strip()
    if from_env:
        return from_env
    from_file = load_env_file(env_file).get(MODEL_VARIABLE, "").strip()
    return from_file or DEFAULT_MODEL_NAME


# ----------------------------------------------------------------------------------------------
# 경로
# ----------------------------------------------------------------------------------------------


def display_path(path: Path | str) -> str:
    """저장소 안의 경로는 저장소 루트 기준 상대 경로로, 밖이면 받은 그대로 문자열로."""
    try:
        return Path(path).resolve().relative_to(REPO_ROOT).as_posix()
    except (ValueError, OSError):
        return str(path)


def resolve_model_config_path(value: str | None, models_dir: Path | str | None = None) -> Path:
    """설정 이름 또는 경로 → 파일 경로. 비어 있으면 "default". .yaml/.yml 로 끝나거나 경로 구분자가 있으면 경로다."""
    name = (value or "").strip() or DEFAULT_MODEL_NAME
    looks_like_path = name.lower().endswith(CONFIG_SUFFIXES) or "/" in name or os.sep in name or "\\" in name
    if looks_like_path:
        return Path(name)
    base = Path(models_dir) if models_dir is not None else DEFAULT_MODELS_DIR
    return base / f"{name}.yaml"


# ----------------------------------------------------------------------------------------------
# 읽기와 검사
# ----------------------------------------------------------------------------------------------


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _non_negative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_provider_tag(tag: str) -> tuple[str, dict]:
    """provider 태그 → (소문자로 정규화한 태그, provider 라우팅 매핑). 형식이 틀리면 ConfigError (파일 경로는 없다).

    "gmicloud/fp8" → ("gmicloud/fp8", {"order": ["gmicloud"], "allow_fallbacks": False, "quantizations": ["fp8"]}),
    "deepinfra" → ("deepinfra", {"order": ["deepinfra"], "allow_fallbacks": False}). 그 업체로만 보내고 fallback 은 없다.
    """
    text = tag.strip().lower()
    slug, separator, quantization = text.partition("/")
    if not PROVIDER_SLUG_RE.match(slug):
        raise ConfigError(f"provider {tag!r} is not a provider tag: {PROVIDER_TAG_HINT}")
    if separator and quantization not in QUANTIZATIONS:
        raise ConfigError(f"provider {tag!r} has an unknown quantization {quantization!r}: {PROVIDER_TAG_HINT}")
    routing: dict = {"order": [slug], "allow_fallbacks": False}
    if separator:
        routing["quantizations"] = [quantization]
    return text, routing


def parse_model_config(data: Any, name: str, path: Path) -> ModelConfig:
    """yaml 에서 읽은 값을 검사해 ModelConfig 로. 문제가 있으면 ConfigError (메시지에 파일 경로를 넣는다)."""
    where = display_path(path)
    if not isinstance(data, dict):
        raise ConfigError(f"{where}: the model config must be a mapping (key: value lines)")

    api = data.get("api")
    supported = ", ".join(SUPPORTED_APIS)
    provider = data.get("provider")
    if isinstance(provider, str) and provider.strip().lower() in SUPPORTED_APIS:
        # 예전 형식: provider: openrouter. 지금 provider 는 업체 태그나 라우팅 매핑이므로 이름을 바꾸라고 알려 준다.
        raise ConfigError(f"{where}: 'provider: {provider}' is the old name of this key: rename it to "
                          f"'api: {provider.strip().lower()}' (provider is now the optional hosting company: a tag such "
                          f"as gmicloud/fp8 or a mapping with {PROVIDER_ROUTING_HINT})")
    if api not in SUPPORTED_APIS:
        raise ConfigError(f"{where}: api must be one of {supported} (got {api!r})")

    model = data.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ConfigError(f"{where}: model must be a non-empty string (the model id at the api)")

    params = data.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ConfigError(f"{where}: params must be a mapping of request parameters")
    if "provider" in params:
        raise ConfigError(f"{where}: params must not contain provider (put {PROVIDER_ROUTING_HINT} "
                          f"in the top-level provider key)")
    reserved = [key for key in RESERVED_PARAMS if key in params]
    if reserved:
        raise ConfigError(f"{where}: params must not contain {', '.join(reserved)} (they are set by the planner)")

    provider_tag = None
    if isinstance(provider, str):
        try:
            provider_tag, provider = parse_provider_tag(provider)
        except ConfigError as error:
            raise ConfigError(f"{where}: {error}") from None
    elif provider is not None and not isinstance(provider, dict):
        raise ConfigError(f"{where}: provider must be omitted (OpenRouter chooses), a provider tag such as gmicloud/fp8, "
                          f"or a mapping with {PROVIDER_ROUTING_HINT} (got {provider!r}); the API is chosen with "
                          f"'api: {supported}'")

    timeout = data.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if not _positive_int(timeout):
        raise ConfigError(f"{where}: timeout_seconds must be a positive integer (got {timeout!r})")

    planner = data.get("planner")
    if planner is None:
        planner = {}
    if not isinstance(planner, dict):
        raise ConfigError(f"{where}: planner must be a mapping")
    retries = planner.get("spec_fix_retries", DEFAULT_SPEC_FIX_RETRIES)
    if not _non_negative_int(retries):
        raise ConfigError(f"{where}: planner.spec_fix_retries must be a non-negative integer (got {retries!r})")
    max_chars = planner.get("profile_max_chars", DEFAULT_PROFILE_MAX_CHARS)
    if not _non_negative_int(max_chars):
        raise ConfigError(f"{where}: planner.profile_max_chars must be a non-negative integer (got {max_chars!r})")

    return ModelConfig(name=name, path=path, api=api, model=model.strip(), params=dict(params),
                       provider=dict(provider) if provider is not None else None,
                       timeout_seconds=timeout, spec_fix_retries=retries, profile_max_chars=max_chars,
                       provider_tag=provider_tag)


def load_model_config(value: str | None, models_dir: Path | str | None = None) -> ModelConfig:
    """이름 또는 경로로 모델 설정 파일을 읽어 ModelConfig 를 돌려준다. yaml 은 여기서만 import 한다."""
    path = resolve_model_config_path(value, models_dir)
    if not path.is_file():
        raise ConfigError(f"model config file not found: {display_path(path)}")
    try:
        import yaml
    except ImportError:
        raise ConfigError(NO_PYYAML) from None
    try:
        with path.open(encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except OSError as error:
        raise ConfigError(f"cannot read model config {display_path(path)}: {error.strerror or error}") from None
    except yaml.YAMLError as error:
        raise ConfigError(f"{display_path(path)}: invalid YAML: {error}") from None
    return parse_model_config(data, path.stem, path)
