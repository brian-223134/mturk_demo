"""agent job API (/api/agent/…). agent 파이프라인을 업로드로 받아 백그라운드 큐(app/agent_jobs/runner.py)에 넣는다.

    GET  /api/agent/models                 모델 설정 목록, 기본 설정 이름, 서버의 API 허용 여부
    POST /api/agent/jobs                   multipart/form-data → 202 {"job": Job}
    GET  /api/agent/jobs                   {"jobs": [Job, …]} 최신순
    GET  /api/agent/jobs/{id}              Job
    GET  /api/agent/jobs/{id}/files/{name} 결과 파일 (job.files 에 있는 이름만)

POST 의 필드: raw(파일, 필수), prompt(파일) 또는 prompt_text(문자열), spec(파일, task_spec.json), model_config(문자열),
allow_api("true"/"false"), name(문자열). spec 이 있으면 LLM 없이(file planner) 돌고 prompt 는 선택이다. spec 이 없으면
prompt 가 필수이고, 요청의 allow_api=true 와 서버의 AGENT_ALLOW_API=1 이 모두 있어야 한다 (둘 중 무엇이 빠졌는지 400 으로 알린다).
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from agent.config import ConfigError, load_model_config, selected_model_name
from agent.spec import SpecError, load_spec

from app.agent_jobs.models import INPUT_DIR, PROMPT_TEXT_FILE, PROMPT_TEXT_MARKER, Job, JobInput, PlannerInfo
from app.agent_jobs.runner import SPEC_FILE, JobRunner
from app.errors import ApiError, invalid
from app.settings import ALLOW_API_VARIABLE, Settings

log = logging.getLogger("backend")
router = APIRouter(prefix="/agent", tags=["agent"])

TRUE_VALUES = ("true", "1", "yes", "on")
MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MEDIA_TYPES = {
    ".csv": "text/csv",
    ".html": "text/html",
    ".json": "application/json",
    ".md": "text/markdown",
    ".jsonl": "application/x-ndjson",
}
SAFE_NAME_RE = re.compile(r"[^\w.-]", re.UNICODE)


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _runner(request: Request) -> JobRunner:
    return request.app.state.runner


def safe_filename(name: str | None, fallback: str) -> str:
    """업로드 파일 이름에서 경로를 떼고 이상한 글자를 _ 로 바꾼다. 확장자는 남긴다 (agent 가 확장자로 형식을 정한다)."""
    base = Path(name or "").name.strip()
    base = SAFE_NAME_RE.sub("_", base).lstrip(".")
    return base or fallback


def unique_path(directory: Path, name: str) -> Path:
    target = directory / name
    stem, suffix = Path(name).stem, Path(name).suffix
    n = 2
    while target.exists():
        target = directory / f"{stem}-{n}{suffix}"
        n += 1
    return target


def save_upload(upload: UploadFile, directory: Path, fallback: str) -> str:
    target = unique_path(directory, safe_filename(upload.filename, fallback))
    upload.file.seek(0)
    with target.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)
    return target.name


def parse_bool(value: object) -> bool:
    return isinstance(value, str) and value.strip().lower() in TRUE_VALUES


# ---- models ---------------------------------------------------------------------------------


@router.get("/models")
async def list_models(request: Request) -> dict:
    settings = _settings(request)
    models = []
    for path in sorted(settings.models_dir.glob("*.yaml")) if settings.models_dir.is_dir() else []:
        try:
            config = load_model_config(path.stem, settings.models_dir)
        except ConfigError as error:
            log.warning("model config %s skipped: %s", path.name, error)
            continue
        models.append({"name": config.name, "model": config.model, "api": config.api, "provider_tag": config.provider_tag})
    return {"models": models, "default": selected_model_name(settings.env_file), "api_allowed": settings.api_allowed}


# ---- jobs -----------------------------------------------------------------------------------


@router.post("/jobs", status_code=202)
async def create_job(request: Request) -> dict:
    settings = _settings(request)
    runner = _runner(request)
    form = await request.form()

    raw = form.get("raw")
    if not isinstance(raw, UploadFile):
        raise invalid('"raw" must be an uploaded file (multipart/form-data): the raw data as JSON, JSONL or CSV.')
    prompt = form.get("prompt")
    prompt_text = form.get("prompt_text")
    if isinstance(prompt, str):  # prompt 를 문자열 필드로 보냈으면 prompt_text 로 본다
        prompt_text, prompt = prompt, None
    spec = form.get("spec")
    if spec is not None and not isinstance(spec, UploadFile):
        raise invalid('"spec" must be an uploaded file (task_spec.json).')
    allow_api = parse_bool(form.get("allow_api"))
    model_config = form.get("model_config")
    model_config = model_config.strip() if isinstance(model_config, str) else ""
    name = form.get("name")
    name = name.strip() if isinstance(name, str) else ""

    has_prompt = isinstance(prompt, UploadFile) or (isinstance(prompt_text, str) and prompt_text.strip() != "")
    if spec is None:
        if not has_prompt:
            raise invalid('Either "spec" (a task_spec.json file, no LLM call) or "prompt" (a file) / "prompt_text" is required.')
        if not allow_api and not settings.api_allowed:
            raise invalid("Calling OpenRouter is not allowed: the request has allow_api=false and the server was started "
                          f"without {ALLOW_API_VARIABLE}=1 (both are required). Upload a \"spec\" file to run without an LLM.")
        if not allow_api:
            raise invalid("Calling OpenRouter is not allowed: the request has allow_api=false (send allow_api=true; "
                          f"the server has {ALLOW_API_VARIABLE}=1).")
        if not settings.api_allowed:
            raise invalid("Calling OpenRouter is not allowed: the server was started without "
                          f"{ALLOW_API_VARIABLE}=1 (allow_api=true in the request is not enough).")
        model_config = model_config or selected_model_name(settings.env_file)
        if not MODEL_NAME_RE.match(model_config):
            raise invalid(f'"model_config" must be the name of a file in the models folder without .yaml (got {model_config!r}).')
        try:
            load_model_config(model_config, settings.models_dir)
        except ConfigError as error:
            raise invalid(f"model config: {error}") from None
        planner = PlannerInfo(mode="openrouter", model_config=model_config, allow_api=allow_api)
    else:
        planner = PlannerInfo(mode="file", model_config=None, allow_api=allow_api)

    job_id, directory = runner.allocate()
    input_dir = directory / INPUT_DIR
    try:
        raw_name = save_upload(raw, input_dir, "raw.json")
        if (input_dir / raw_name).stat().st_size == 0:
            raise invalid('"raw" is empty.')
        prompt_name: str | None = None
        if isinstance(prompt, UploadFile):
            prompt_name = save_upload(prompt, input_dir, "prompt.md")
        elif isinstance(prompt_text, str) and prompt_text.strip():
            (input_dir / PROMPT_TEXT_FILE).write_text(prompt_text.strip() + "\n", encoding="utf-8")
            prompt_name = PROMPT_TEXT_MARKER
        spec_name: str | None = None
        if isinstance(spec, UploadFile):
            spec_name = save_upload(spec, input_dir, "task_spec.json")
            shutil.copyfile(input_dir / spec_name, directory / SPEC_FILE)
            try:
                load_spec(directory / SPEC_FILE)
            except SpecError as error:
                raise invalid("the task spec is not valid: " + "; ".join(error.messages)) from None
    except ApiError:
        runner.discard(job_id)
        raise
    except Exception:
        runner.discard(job_id)
        raise
    finally:
        for upload in (raw, prompt, spec):
            if isinstance(upload, UploadFile):
                await upload.close()

    job = Job(id=job_id, name=name or (raw.filename or raw_name),
              input=JobInput(raw=raw_name, prompt=prompt_name, spec=spec_name), planner=planner)
    return {"job": runner.submit(job)}


@router.get("/jobs")
async def list_jobs(request: Request) -> dict:
    return {"jobs": _runner(request).snapshots()}


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: str) -> dict:
    job = _runner(request).snapshot(job_id)
    if job is None:
        raise ApiError("NOT_FOUND", f"Job not found: {job_id}")
    return job


@router.get("/jobs/{job_id}/files/{name}")
async def get_job_file(request: Request, job_id: str, name: str) -> FileResponse:
    runner = _runner(request)
    job = runner.snapshot(job_id)
    if job is None:
        raise ApiError("NOT_FOUND", f"Job not found: {job_id}")
    if name not in job["files"]:
        raise ApiError("NOT_FOUND", f"File not found in job {job_id}: {name}")
    directory = runner.job_dir(job_id).resolve()
    path = (directory / name).resolve()
    if path.parent != directory or not path.is_file():
        raise ApiError("NOT_FOUND", f"File not found in job {job_id}: {name}")
    media_type = MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=name, headers={"Cache-Control": "no-store"})
