"""agent job API (/api/agent/…). agent 파이프라인을 업로드로 받아 백그라운드 큐(app/agent_jobs/runner.py)에 넣는다.

    GET  /api/agent/models                 모델 설정 목록, 기본 설정 이름, 서버의 API 허용 여부
    POST /api/agent/jobs                   multipart/form-data → 202 {"job": Job}
    GET  /api/agent/jobs                   {"jobs": [Job, …]} 최신순
    GET  /api/agent/jobs/{id}/inputs       이전 raw 참조와 prompt 본문
    PUT  /api/agent/jobs/{id}/review       품질 평가 저장
    GET  /api/agent/jobs/{id}              Job
    GET  /api/agent/jobs/{id}/files/{name} 결과 파일 (job.files 에 있는 이름만)
    POST /api/agent/job-groups             multipart/form-data → 202 {"group": {"id", "size"}, "jobs": [Job, …]}
    PUT  /api/agent/job-groups/{id}/choice {"job_id"} → {"jobs": [Job, …]} 비교한 뒤 고른 후보를 기록

POST 의 필드: raw(파일, source_job_id로 재사용 가능), prompt(파일) 또는 prompt_text(문자열), spec(파일, task_spec.json), model_config(문자열),
allow_api("true"/"false"), name(문자열). spec 이 있으면 LLM 없이(file planner) 돌고 prompt 는 선택이다. spec 이 없으면
prompt 가 필수이고, 요청의 allow_api=true 와 서버의 AGENT_ALLOW_API=1 이 모두 있어야 한다 (둘 중 무엇이 빠졌는지 400 으로 알린다).

job-groups 는 같은 필드에서 model_config 대신 model_configs 를 1~3번 보내 후보마다 job 하나씩을 만든다 (같은 모델을 여러 번 써도
된다). 후보는 LLM 이 쓴 명세를 비교하려는 것이라 spec 과 reuse_spec 은 받지 않는다. job 들은 이름이 같고 group 으로 묶이며,
runner 가 동시에 돌린다.
"""

from __future__ import annotations

import hashlib
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from agent.config import ConfigError, load_model_config, selected_model_name
from agent.spec import SpecError, load_spec
from agent.prompt_variants import EXAMPLE_RAW, prompt_candidates

from app.agent_jobs.models import (INPUT_DIR, PROMPT_TEXT_FILE, PROMPT_TEXT_MARKER, Job, JobInput, PlannerInfo, group_info,
                                   new_group_id, now_iso)
from app.agent_jobs.runner import SPEC_FILE, JobRunner
from app.auth import current_user
from app.errors import ApiError, invalid
from app.settings import ALLOW_API_VARIABLE, Settings

log = logging.getLogger("backend")
router = APIRouter(prefix="/agent", tags=["agent"])

TRUE_VALUES = ("true", "1", "yes", "on")
MAX_GROUP_SIZE = 3
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


def saved_input(runner: JobRunner, job: dict, kind: str) -> Path:
    """저장된 input 메타데이터로만 파일을 찾으며 경로 이탈과 symlink를 막는다."""
    name = job["input"].get(kind)
    if kind == "prompt" and name == PROMPT_TEXT_MARKER:
        name = PROMPT_TEXT_FILE
    directory = runner.job_dir(job["id"]) / INPUT_DIR
    path = directory / (name or "")
    if not name or path.is_symlink() or path.resolve().parent != directory.resolve() or not path.is_file():
        raise ApiError("NOT_FOUND", f"Saved {kind} input is unavailable for this job.")
    return path


def file_hash(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def copy_input(path: Path, directory: Path) -> str:
    target = unique_path(directory, safe_filename(path.name, "input.json"))
    shutil.copyfile(path, target)
    return target.name


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
    return {"models": models, "default": selected_model_name(settings.env_file), "api_allowed": settings.api_allowed,
            "prompt_candidates": prompt_candidates()}


@router.get("/example/raw.json")
async def example_raw() -> FileResponse:
    """공개된 합성 입력만 제공한다. 파일 경로는 요청에서 받지 않는다."""
    return FileResponse(EXAMPLE_RAW, media_type="application/json", filename="raw.json")


# ---- jobs -----------------------------------------------------------------------------------


@dataclass
class JobForm:
    """POST /jobs 와 /job-groups 가 함께 쓰는 multipart 필드. 업로드는 아직 job 폴더에 저장하기 전이다."""

    source_id: str | None
    raw: UploadFile | None
    raw_source: Path | None          # raw 를 올리지 않았을 때 source job 에 저장된 원본
    prompt: UploadFile | None
    prompt_text: str | None
    spec: UploadFile | None
    spec_source: Path | None         # reuse_spec 일 때 source job 에 저장된 명세
    allow_api: bool
    name: str

    @property
    def has_prompt(self) -> bool:
        return self.prompt is not None or (isinstance(self.prompt_text, str) and self.prompt_text.strip() != "")

    @property
    def has_spec(self) -> bool:
        return self.spec is not None or self.spec_source is not None

    async def close(self) -> None:
        for upload in (self.raw, self.prompt, self.spec):
            if upload is not None:
                await upload.close()


def read_job_form(form, runner: JobRunner) -> JobForm:
    source_id = form.get("source_job_id")
    source_job = None
    if source_id:
        if not isinstance(source_id, str):
            raise invalid('"source_job_id" must be a job id.')
        source_job = runner.snapshot(source_id)
        if source_job is None:
            raise ApiError("NOT_FOUND", "Source job not found.")
    raw = form.get("raw")
    if not isinstance(raw, UploadFile) and (raw is not None or source_job is None):
        raise invalid('"raw" must be an uploaded file (multipart/form-data): the raw data as JSON, JSONL or CSV.')
    raw_source = saved_input(runner, source_job, "raw") if raw is None else None
    prompt = form.get("prompt")
    prompt_text = form.get("prompt_text")
    if isinstance(prompt, str):  # prompt 를 문자열 필드로 보냈으면 prompt_text 로 본다
        prompt_text, prompt = prompt, None
    spec = form.get("spec")
    if spec is not None and not isinstance(spec, UploadFile):
        raise invalid('"spec" must be an uploaded file (task_spec.json).')
    spec_source = None
    if parse_bool(form.get("reuse_spec")):
        if source_job is None or spec is not None:
            raise invalid('"reuse_spec" requires a source job and no uploaded spec.')
        spec_source = saved_input(runner, source_job, "spec")
    name = form.get("name")
    return JobForm(source_id=source_id or None, raw=raw, raw_source=raw_source, prompt=prompt,
                   prompt_text=prompt_text if isinstance(prompt_text, str) else None, spec=spec, spec_source=spec_source,
                   allow_api=parse_bool(form.get("allow_api")), name=name.strip() if isinstance(name, str) else "")


def check_llm_allowed(fields: JobForm, settings: Settings) -> None:
    """spec 없이 LLM 이 명세를 쓰는 job 의 조건: prompt 가 있고, 요청과 서버가 모두 호출을 허용한다."""
    if not fields.has_prompt:
        raise invalid('Either "spec" (a task_spec.json file, no LLM call) or "prompt" (a file) / "prompt_text" is required.')
    if not fields.allow_api and not settings.api_allowed:
        raise invalid("Calling OpenRouter is not allowed: the request has allow_api=false and the server was started "
                      f"without {ALLOW_API_VARIABLE}=1 in environment/.env or the shell (both are required). Upload a \"spec\" file to run without an LLM.")
    if not fields.allow_api:
        raise invalid("Calling OpenRouter is not allowed: the request has allow_api=false (send allow_api=true; "
                      f"the server has {ALLOW_API_VARIABLE}=1).")
    if not settings.api_allowed:
        raise invalid("Calling OpenRouter is not allowed: the server was started without "
                      f"{ALLOW_API_VARIABLE}=1 in environment/.env or the shell (allow_api=true in the request is not enough).")


def openrouter_planner(model_config: str, fields: JobForm, settings: Settings) -> PlannerInfo:
    model_config = model_config or selected_model_name(settings.env_file)
    if not MODEL_NAME_RE.match(model_config):
        raise invalid(f'"model_config" must be the name of a file in the models folder without .yaml (got {model_config!r}).')
    try:
        load_model_config(model_config, settings.models_dir)
    except ConfigError as error:
        raise invalid(f"model config: {error}") from None
    return PlannerInfo(mode="openrouter", model_config=model_config, allow_api=fields.allow_api)


def build_job(runner: JobRunner, fields: JobForm, planner: PlannerInfo, group: dict | None = None) -> Job:
    """job 폴더를 만들고 입력을 저장한 Job (아직 큐에 넣지 않았다). 실패하면 폴더를 지운다."""
    raw, prompt, spec = fields.raw, fields.prompt, fields.spec
    job_id, directory = runner.allocate()
    input_dir = directory / INPUT_DIR
    try:
        raw_name = save_upload(raw, input_dir, "raw.json") if raw is not None else copy_input(fields.raw_source, input_dir)
        if (input_dir / raw_name).stat().st_size == 0:
            raise invalid('"raw" is empty.')
        prompt_name: str | None = None
        if prompt is not None:
            prompt_name = save_upload(prompt, input_dir, "prompt.md")
        elif isinstance(fields.prompt_text, str) and fields.prompt_text.strip():
            prompt_path = unique_path(input_dir, PROMPT_TEXT_FILE)
            prompt_path.write_text(fields.prompt_text.strip() + "\n", encoding="utf-8")
            prompt_name = PROMPT_TEXT_MARKER if prompt_path.name == PROMPT_TEXT_FILE else prompt_path.name
        spec_name: str | None = None
        if fields.has_spec:
            spec_name = save_upload(spec, input_dir, "task_spec.json") if spec is not None else copy_input(fields.spec_source, input_dir)
            shutil.copyfile(input_dir / spec_name, directory / SPEC_FILE)
            try:
                load_spec(directory / SPEC_FILE)
            except SpecError as error:
                raise invalid("the task spec is not valid: " + "; ".join(error.messages)) from None
        prompt_path = input_dir / (PROMPT_TEXT_FILE if prompt_name == PROMPT_TEXT_MARKER else prompt_name or "")
        try:
            text = prompt_path.read_text(encoding="utf-8").strip() if prompt_name else ""
        except UnicodeError:
            raise invalid("The prompt must be UTF-8 text.") from None
        if planner.mode == "openrouter" and not text:
            raise invalid("The prompt is empty.")
        provenance = {"raw_sha256": file_hash(input_dir / raw_name),
                      "prompt_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                      "source_job_id": fields.source_id}
    except Exception:
        runner.discard(job_id)
        raise
    return Job(id=job_id, name=fields.name or (raw.filename if raw is not None else None) or raw_name,
               input=JobInput(raw=raw_name, prompt=prompt_name, spec=spec_name), planner=planner,
               provenance=provenance, group=group)


@router.post("/jobs", status_code=202)
async def create_job(request: Request) -> dict:
    settings = _settings(request)
    runner = _runner(request)
    form = await request.form()
    fields = read_job_form(form, runner)
    try:
        if fields.has_spec:
            planner = PlannerInfo(mode="file", model_config=None, allow_api=fields.allow_api)
        else:
            check_llm_allowed(fields, settings)
            model_config = form.get("model_config")
            planner = openrouter_planner(model_config.strip() if isinstance(model_config, str) else "", fields, settings)
        job = build_job(runner, fields, planner)
    finally:
        await fields.close()
    return {"job": runner.submit(job, current_user(request)["id"])}


@router.post("/job-groups", status_code=202)
async def create_job_group(request: Request) -> dict:
    """같은 원본과 prompt 로 모델만 바꾼 후보 job 을 model_configs 수만큼 만들어 한꺼번에 큐에 넣는다."""
    settings = _settings(request)
    runner = _runner(request)
    form = await request.form()
    fields = read_job_form(form, runner)
    jobs: list[Job] = []
    try:
        if fields.has_spec:
            raise invalid("A job group compares the task specs the LLM writes, so it does not take \"spec\" or \"reuse_spec\". "
                          "Use POST /api/agent/jobs to run a task spec without an LLM.")
        model_configs = [value.strip() if isinstance(value, str) else "" for value in form.getlist("model_configs")]
        if not 1 <= len(model_configs) <= MAX_GROUP_SIZE:
            raise invalid(f'Send "model_configs" 1 to {MAX_GROUP_SIZE} times, once per candidate (got {len(model_configs)}).')
        check_llm_allowed(fields, settings)
        planners = [openrouter_planner(name, fields, settings) for name in model_configs]
        group_id = new_group_id()
        for index, planner in enumerate(planners):
            jobs.append(build_job(runner, fields, planner, group_info(group_id, index, len(planners))))
    except Exception:
        for job in jobs:
            runner.discard(job.id)
        raise
    finally:
        await fields.close()
    owner_id = current_user(request)["id"]
    return {"group": {"id": group_id, "size": len(jobs)}, "jobs": [runner.submit(job, owner_id) for job in jobs]}


@router.put("/job-groups/{group_id}/choice")
async def choose_group_candidate(request: Request, group_id: str) -> dict:
    runner = _runner(request)
    members = runner.group_snapshots(group_id)
    if not members:
        raise ApiError("NOT_FOUND", f"Job group not found: {group_id}")
    try:
        body = await request.json()
    except ValueError:
        raise invalid("The choice must be a JSON object.") from None
    if not isinstance(body, dict) or set(body) != {"job_id"} or not isinstance(body["job_id"], str):
        raise invalid('The choice must be {"job_id": "<id of a job in the group>"}.')
    chosen = next((job for job in members if job["id"] == body["job_id"]), None)
    if chosen is None:
        raise invalid(f"Job {body['job_id']} is not in group {group_id}.")
    if chosen["status"] != "succeeded":
        raise invalid(f"Only a succeeded candidate can be chosen ({chosen['id']} is {chosen['status']}).")
    return {"jobs": runner.choose(group_id, chosen["id"])}


@router.get("/jobs")
async def list_jobs(request: Request) -> dict:
    return {"jobs": _runner(request).snapshots()}


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: str) -> dict:
    job = _runner(request).snapshot(job_id)
    if job is None:
        raise ApiError("NOT_FOUND", f"Job not found: {job_id}")
    return job


@router.get("/jobs/{job_id}/inputs")
async def get_job_inputs(request: Request, job_id: str) -> dict:
    runner = _runner(request)
    job = await get_job(request, job_id)
    raw = saved_input(runner, job, "raw")
    prompt = saved_input(runner, job, "prompt") if job["input"].get("prompt") else None
    try:
        text = prompt.read_text(encoding="utf-8").strip() if prompt else ""
    except UnicodeError:
        raise invalid("The saved prompt is not UTF-8 text.") from None
    return {"source_job_id": job_id, "name": job["name"], "raw_name": raw.name,
            "prompt_text": text, "model_config": job["planner"].get("model_config"),
            "has_spec": bool(job["input"].get("spec"))}


@router.put("/jobs/{job_id}/review")
async def review_job(request: Request, job_id: str) -> dict:
    await get_job(request, job_id)
    try:
        body = await request.json()
    except ValueError:
        raise invalid("Review must be a JSON object.") from None
    if not isinstance(body, dict) or set(body) - {"decision", "notes", "checks"}:
        raise invalid("Review accepts decision, notes and checks only.")
    decision, notes, checks = body.get("decision", "unreviewed"), body.get("notes", ""), body.get("checks", {})
    if decision not in ("unreviewed", "shortlisted", "rejected"):
        raise invalid("Unknown review decision.")
    if not isinstance(notes, str) or len(notes) > 10000:
        raise invalid("Review notes must be text of at most 10000 characters.")
    if not isinstance(checks, dict) or set(checks) - {"data", "instructions", "attention"}:
        raise invalid("Unknown review check.")
    if any(value not in ("unchecked", "pass", "fail") for value in checks.values()):
        raise invalid("Review checks must be unchecked, pass or fail.")
    review = {"decision": decision, "notes": notes,
              "checks": {name: checks.get(name, "unchecked") for name in ("data", "instructions", "attention")},
              "updated_at": now_iso()}
    return _runner(request).update_review(job_id, review)


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
