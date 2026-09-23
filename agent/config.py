"""모델 설정: environment/models/<이름>.yaml 을 읽어 ModelConfig 로 만든다. 표준 라이브러리만 쓰되 yaml 만 늦게 import 한다.

    ModelConfig                                   provider, model, 요청 파라미터, timeout, planner 값 (frozen dataclass)
    resolve_model_config_path(value, models_dir)  이름 → <models_dir>/<이름>.yaml, .yaml/.yml 이나 경로 구분자가 있으면 경로 그대로
    load_model_config(value, models_dir)          yaml 을 읽고 검사해 ModelConfig 를 돌려준다 (문제가 있으면 ConfigError)
    selected_model_name(env_file)                 AGENT_MODEL 환경변수 → env 파일 → "default"
    load_env_file(path)                           KEY=value 줄을 읽는다 (따옴표, 주석, export 처리. 파일이 없으면 빈 dict)

PyYAML 은 컨테이너 안에만 설치된다 (agent/requirements.txt). 호스트에 없으면 load_model_config 가 ConfigError 로
안내하고, --spec 만 쓰는 실행은 이 모듈의 yaml 부분을 건드리지 않으므로 그대로 돈다.
비밀(API 키)은 설정 파일이 아니라 environment/.env 에만 둔다. 설정 파일의 params 는 요청 본문에 그대로 펼쳐지므로
model 과 messages 를 덮어쓰지 못하게 막는다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = Path("environment/models")
DEFAULT_MODEL_NAME = "default"
MODEL_VARIABLE = "AGENT_MODEL"
SUPPORTED_PROVIDERS = ("openrouter",)
CONFIG_SUFFIXES = (".yaml", ".yml")
RESERVED_PARAMS = ("model", "messages")

DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_SPEC_FIX_RETRIES = 1
DEFAULT_PROFILE_MAX_CHARS = 12000

NO_PYYAML = ("PyYAML is not installed. Run inside Docker (docker compose run --rm agent ...) "
             "or install it in a virtual environment.")


class ConfigError(ValueError):
    """모델 설정을 읽거나 검사하는 데 실패했을 때 (PyYAML 없음, 파일 없음, 형식 오류)."""


@dataclass(frozen=True)
class ModelConfig:
    """모델 설정 파일 하나의 내용. name 은 파일 이름(확장자 없음), path 는 읽은 파일이다."""

    name: str
    path: Path
    provider: str
    model: str
    params: dict
    timeout_seconds: int
    spec_fix_retries: int
    profile_max_chars: int

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


def parse_model_config(data: Any, name: str, path: Path) -> ModelConfig:
    """yaml 에서 읽은 값을 검사해 ModelConfig 로. 문제가 있으면 ConfigError (메시지에 파일 경로를 넣는다)."""
    where = display_path(path)
    if not isinstance(data, dict):
        raise ConfigError(f"{where}: the model config must be a mapping (key: value lines)")

    provider = data.get("provider")
    if provider not in SUPPORTED_PROVIDERS:
        supported = ", ".join(SUPPORTED_PROVIDERS)
        raise ConfigError(f"{where}: provider must be one of {supported} (got {provider!r})")

    model = data.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ConfigError(f"{where}: model must be a non-empty string (the provider's model id)")

    params = data.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ConfigError(f"{where}: params must be a mapping of request parameters")
    reserved = [key for key in RESERVED_PARAMS if key in params]
    if reserved:
        raise ConfigError(f"{where}: params must not contain {', '.join(reserved)} (they are set by the planner)")

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

    return ModelConfig(name=name, path=path, provider=provider, model=model.strip(), params=dict(params),
                       timeout_seconds=timeout, spec_fix_retries=retries, profile_max_chars=max_chars)


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
