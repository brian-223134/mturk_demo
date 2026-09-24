"""agent job 의 큐와 worker 스레드. job 은 한 번에 하나씩(FIFO) 돈다.

job 폴더는 <OUTPUT_DIR>/jobs/<job id>/ 다. 업로드는 그 안의 input/ 에, 파이프라인 결과(profile.json, task_spec.json,
hits.csv, template.html, validation.json …)는 폴더에 바로 쓴다. agent 의 각 단계에는 이 절대 경로를 out_dir 로 넘기므로
agent 의 현재 폴더 기준 기본값(output/<원본 이름>/)은 쓰이지 않는다.

상태가 바뀔 때마다 job.json 을 다시 써서 서버를 다시 켜도 목록에 남는다. 다시 켤 때 running 이던 job 은 이어서 돌 수
없으므로 failed 로, queued 이던 job 은 다시 큐에 넣는다.

단계 (agent/cli.py 의 cmd_run 과 같은 순서)
    profile     agent.profile.run_profile(raw, out_dir)
    plan        spec 파일이 있으면 skipped (task_spec.json 은 접수 때 검증해 복사해 두었다).
                없으면 OpenRouterPlanner + agent.planner.base.run_plan (allow_api 와 AGENT_ALLOW_API=1 이 모두 있을 때만 호출)
    preprocess  spec 을 레코드에 대조(validate_against_records)한 뒤 agent.preprocess.run_preprocess
    render      agent.render.run_render
    validate    agent.validate.validate_bundle. ok 가 아니면 job 은 failed (파일 목록은 남긴다)
"""

from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import threading
import traceback
from pathlib import Path
from typing import Callable, TypeVar

from agent import source
from agent.config import ConfigError, load_model_config
from agent.paths import PathError
from agent.planner.base import PlannerError, run_plan
from agent.planner.openrouter import OpenRouterPlanner, resolve_api_key
from agent.profile import run_profile
from agent.source import SourceError
from agent.spec import SpecError, TaskSpec, load_spec, validate_against_records

from app.agent_jobs.models import (INPUT_DIR, JOB_FILE, PROMPT_TEXT_FILE, PROMPT_TEXT_MARKER, STEP_NAMES, Job, Step,
                                   new_job_id, now_iso, order_files, usage_dict)
from app.settings import Settings

log = logging.getLogger("backend")
T = TypeVar("T")

SPEC_FILE = "task_spec.json"
INTERRUPTED = "interrupted: the server restarted while the job was running"


class StepFailure(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(f"{step}: {message}")
        self.step = step
        self.message = message


def describe_error(error: BaseException) -> str:
    """단계가 던진 예외 → 한 줄 메시지. SpecError 는 오류 목록을 이어 붙인다."""
    if isinstance(error, SpecError):
        return "the task spec is not valid: " + "; ".join(error.messages)
    if isinstance(error, (PlannerError, SourceError, PathError, ConfigError, ValueError, OSError)):
        return str(error) or type(error).__name__
    return f"{type(error).__name__}: {error}"


def planner_notes_of(spec: TaskSpec) -> str | None:
    notes = getattr(spec, "planner_notes", None)
    if isinstance(notes, (list, tuple)):
        notes = "; ".join(str(note).strip() for note in notes if str(note).strip())
    text = str(notes).strip() if notes else ""
    return text or None


def validation_summary(report: dict) -> str:
    errors = [str(m) for m in report.get("errors", [])]
    warnings = report.get("warnings", [])
    shown = "; ".join(errors[:3]) + (" …" if len(errors) > 3 else "")
    return f"validation failed: {len(errors)} error(s), {len(warnings)} warning(s): {shown}"


class JobRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.jobs_dir = settings.jobs_dir
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    # ---- 수명 -------------------------------------------------------------------------------

    def start(self) -> None:
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._load_from_disk()
        self._thread = threading.Thread(target=self._worker, name="agent-jobs", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._queue.put(None)

    def _load_from_disk(self) -> None:
        loaded: list[Job] = []
        for job_file in sorted(self.jobs_dir.glob(f"*/{JOB_FILE}")):
            try:
                job = Job.from_dict(json.loads(job_file.read_text(encoding="utf-8")))
            except (OSError, ValueError, KeyError, TypeError) as error:
                log.warning("skipping %s: %s", job_file, error)
                continue
            if job.id != job_file.parent.name:
                log.warning("skipping %s: id %r does not match the folder", job_file, job.id)
                continue
            loaded.append(job)
        for job in sorted(loaded, key=lambda j: (j.created_at, j.id)):
            with self._lock:
                self._jobs[job.id] = job
            if job.status == "running":
                self._fail_interrupted(job)
            elif job.status == "queued":
                job.add_log("requeued after a server restart")
                self._save(job)
                self._queue.put(job.id)
        if loaded:
            log.info("agent jobs: %d found in %s", len(loaded), self.jobs_dir)

    def _fail_interrupted(self, job: Job) -> None:
        with self._lock:
            for step in job.steps:
                if step.status == "running":
                    step.status = "failed"
                    step.finished_at = now_iso()
                    step.error = INTERRUPTED
                elif step.status == "pending":
                    step.status = "skipped"
            job.status = "failed"
            job.error = INTERRUPTED
            job.finished_at = job.finished_at or now_iso()
            job.add_log(INTERRUPTED)
            self._refresh_files(job)
            self._save(job)

    # ---- 폴더와 저장 -------------------------------------------------------------------------

    def job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id

    def allocate(self) -> tuple[str, Path]:
        """새 job id 와 폴더(input/ 포함)를 만든다."""
        with self._lock:
            for _ in range(10):
                job_id = new_job_id()
                directory = self.job_dir(job_id)
                if job_id not in self._jobs and not directory.exists():
                    (directory / INPUT_DIR).mkdir(parents=True)
                    return job_id, directory
        raise RuntimeError("could not allocate a job id")

    def discard(self, job_id: str) -> None:
        """접수에 실패한 job 의 폴더를 지운다 (큐에 들어가기 전에만)."""
        with self._lock:
            if job_id in self._jobs:
                return
            shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def _save(self, job: Job) -> None:
        directory = self.job_dir(job.id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / JOB_FILE
        temporary = directory / f".{JOB_FILE}.tmp"
        temporary.write_text(json.dumps(job.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)

    def _refresh_files(self, job: Job) -> None:
        directory = self.job_dir(job.id)
        names = [p.name for p in directory.iterdir() if p.is_file() and p.name != JOB_FILE and not p.name.startswith(".")]
        job.files = order_files(names)

    # ---- 조회와 접수 ---------------------------------------------------------------------------

    def submit(self, job: Job) -> dict:
        with self._lock:
            self._jobs[job.id] = job
            line = job.add_log(f"queued ({job.planner.mode} planner)")
            self._refresh_files(job)
            self._save(job)
            snapshot = job.to_dict()
        log.info("[%s] %s", job.id, line)
        self._queue.put(job.id)
        return snapshot

    def snapshot(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_dict() if job else None

    def snapshots(self) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: (j.created_at, j.id), reverse=True)
            return [job.to_dict() for job in jobs]

    # ---- worker -----------------------------------------------------------------------------

    def _worker(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                return
            with self._lock:
                job = self._jobs.get(job_id)
            if job is None or job.status != "queued":
                continue
            try:
                self._run(job)
            except Exception:  # noqa: BLE001 - worker 스레드는 어떤 예외에도 죽지 않는다
                log.error("job %s crashed:\n%s", job.id, traceback.format_exc())
                with self._lock:
                    job.status = "failed"
                    job.error = job.error or "internal error (see the server log)"
                    job.finished_at = now_iso()
                    self._save(job)

    def _log(self, job: Job, message: str) -> None:
        with self._lock:
            line = job.add_log(message)
            self._save(job)
        log.info("[%s] %s", job.id, line)

    def _step(self, job: Job, name: str, work: Callable[[], T]) -> T:
        step = job.step(name)
        with self._lock:
            step.status = "running"
            step.started_at = now_iso()
            self._save(job)
        log.info("[%s] %s: started", job.id, name)
        try:
            result = work()
        except Exception as error:  # noqa: BLE001 - 단계의 실패는 모두 job 의 실패로 기록한다
            message = describe_error(error)
            if not isinstance(error, (SpecError, PlannerError, SourceError, PathError, ValueError, OSError)):
                log.error("[%s] %s raised:\n%s", job.id, name, traceback.format_exc())
            with self._lock:
                step.status = "failed"
                step.finished_at = now_iso()
                step.error = message
                self._skip_rest(job, name)
                self._refresh_files(job)
                job.add_log(f"{name}: failed: {message}")
                self._save(job)
            log.info("[%s] %s: failed: %s", job.id, name, message)
            raise StepFailure(name, message) from error
        with self._lock:
            step.status = "succeeded"
            step.finished_at = now_iso()
            self._refresh_files(job)
            self._save(job)
        return result

    def _skip(self, job: Job, name: str, reason: str) -> None:
        with self._lock:
            step = job.step(name)
            step.status = "skipped"
            job.add_log(f"{name}: skipped ({reason})")
            self._save(job)
        log.info("[%s] %s: skipped (%s)", job.id, name, reason)

    @staticmethod
    def _skip_rest(job: Job, failed: str) -> None:
        after = STEP_NAMES.index(failed) + 1
        for name in STEP_NAMES[after:]:
            step = job.step(name)
            if step.status == "pending":
                step.status = "skipped"

    def _run(self, job: Job) -> None:
        directory = self.job_dir(job.id)
        raw_path = directory / INPUT_DIR / job.input.raw
        with self._lock:
            job.status = "running"
            job.started_at = now_iso()
        self._log(job, "started")
        try:
            profile = self._step(job, "profile", lambda: run_profile(raw_path, directory))
            info = profile["source"]
            self._log(job, f"profile: {info['records']} records ({info['format']}) -> profile.json, profile.md")
            _, records = source.load_records(raw_path, info["format"])

            if job.planner.mode == "file":
                self._skip(job, "plan", "task spec file supplied")
                spec = load_spec(directory / SPEC_FILE)
            else:
                spec = self._step(job, "plan", lambda: self._plan(job, profile, records, directory))
                self._log(job, f"plan: task {spec.task.id!r} -> {SPEC_FILE}")
            with self._lock:
                job.planner_notes = planner_notes_of(spec)

            summary = self._step(job, "preprocess", lambda: self._preprocess(job, spec, raw_path, records, directory))
            with self._lock:
                job.summary = summary
            self._log(job, f"preprocess: {summary.get('hits')} HITs, {summary.get('items')} items -> hits.csv, settings.json")

            self._step(job, "render", lambda: self._render(spec, directory))
            self._log(job, "render: template.html")

            report = self._step(job, "validate", lambda: self._validate(directory))
            with self._lock:
                job.validation = report
            if not report.get("ok"):
                message = validation_summary(report)
                with self._lock:
                    step = job.step("validate")
                    step.status = "failed"
                    step.error = message
                raise StepFailure("validate", message)
            self._log(job, f"validate: ok ({len(report.get('warnings', []))} warnings)")
            with self._lock:
                job.status = "succeeded"
        except StepFailure as failure:
            with self._lock:
                job.status = "failed"
                job.error = failure.message if failure.step == "validate" else f"{failure.step}: {failure.message}"
        finally:
            with self._lock:
                job.finished_at = now_iso()
                self._refresh_files(job)
                self._save(job)
            self._log(job, job.status)

    # ---- 단계 ---------------------------------------------------------------------------------

    def _plan(self, job: Job, profile: dict, records: list, directory: Path) -> TaskSpec:
        prompt = self._read_prompt(job, directory)
        config = load_model_config(job.planner.model_config, self.settings.models_dir)
        allowed = bool(job.planner.allow_api) and self.settings.api_allowed  # 접수 때 확인했지만 한 번 더 막는다
        self._log(job, f"plan: model config {config.name} -> {config.api} {config.model}"
                       f" (provider: {config.provider_tag or ('auto' if config.provider is None else 'mapping')})")
        planner = OpenRouterPlanner(config, api_key=resolve_api_key(None, self.settings.env_file),
                                    allow_api=allowed, log_dir=directory)
        try:
            return run_plan(profile, prompt, planner, directory, records)
        finally:
            with self._lock:
                job.usage = usage_dict(planner.total_usage)

    def _read_prompt(self, job: Job, directory: Path) -> str:
        name = PROMPT_TEXT_FILE if job.input.prompt == PROMPT_TEXT_MARKER else job.input.prompt
        if not name:
            raise PlannerError("the prompt is missing")
        text = (directory / INPUT_DIR / name).read_text(encoding="utf-8").strip()
        if not text:
            raise PlannerError("the prompt is empty")
        return text

    def _preprocess(self, job: Job, spec: TaskSpec, raw_path: Path, records: list, directory: Path) -> dict:
        from agent.preprocess import run_preprocess

        errors = validate_against_records(spec, records)
        if errors:
            raise SpecError(errors)
        return run_preprocess(spec, raw_path, directory)

    @staticmethod
    def _render(spec: TaskSpec, directory: Path) -> Path:
        from agent.render import run_render

        return run_render(spec, directory)

    @staticmethod
    def _validate(directory: Path) -> dict:
        from agent.validate import validate_bundle

        return validate_bundle(directory)
