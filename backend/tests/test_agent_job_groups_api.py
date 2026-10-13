"""후보 job 그룹 (/api/agent/job-groups). 같은 원본과 prompt 로 모델만 바꾼 후보 3개를 한꺼번에 접수하고, 동시에 돌고,
비교한 뒤 하나를 고르는 흐름을 확인한다.

OpenRouter 는 부르지 않는다: 서버 스위치를 켠 앱에서도 JobRunner._plan 을 예시 명세를 복사하는 가짜로 바꾼다 (mock).
가짜 plan 은 후보 3개가 모두 plan 에 들어올 때까지 Barrier 에서 기다리므로, job 이 하나씩 돌면 시간 초과로 실패한다.
"""

from __future__ import annotations

import json
import shutil
import threading

import pytest

from agent.planner.base import PlannerError
from agent.spec import load_spec
from app.agent_jobs.runner import SPEC_FILE, JobRunner
from app.settings import JOB_WORKERS_DEFAULT, Settings
from helpers import EXAMPLE_DIR, example_uploads, wait_for_job

JOBS = "/api/agent/jobs"
GROUPS = "/api/agent/job-groups"
MODELS = ["default", "qwen3-235b", "deepseek-v3.2"]


def group_form(models=MODELS, **extra) -> dict:
    """multipart 의 문자열 필드. model_configs 는 목록이라 후보마다 한 번씩 같은 이름으로 보내진다."""
    return {"name": "groundedness", "prompt_text": "Judge whether each passage supports the statement.", "allow_api": "true",
            "model_configs": list(models), **extra}


def raw_upload() -> dict:
    return {"raw": example_uploads()["raw"]}


@pytest.fixture
def fake_planner(monkeypatch: pytest.MonkeyPatch):
    """LLM 대신 예시 명세를 쓰는 plan. fail_models 에 든 모델 설정의 후보는 plan 에서 실패한다."""
    state = {"barrier": threading.Barrier(len(MODELS), timeout=10), "fail_models": set(), "calls": []}

    def plan(self: JobRunner, job, profile, records, directory):
        state["calls"].append(job.planner.model_config)
        if state["barrier"] is not None:
            state["barrier"].wait()  # 후보가 하나씩 돌면 여기서 BrokenBarrierError 로 실패한다
        if job.planner.model_config in state["fail_models"]:
            raise PlannerError("fake planner: no spec")
        shutil.copyfile(EXAMPLE_DIR / "task_spec.json", directory / SPEC_FILE)
        return load_spec(directory / SPEC_FILE)

    monkeypatch.setattr(JobRunner, "_plan", plan)
    return state


@pytest.fixture
def llm_client(make_client):
    with make_client(api_allowed=True) as client:
        yield client


def submit_group(client, files=None, **extra) -> dict:
    response = client.post(GROUPS, files=raw_upload() if files is None else files, data=group_form(**extra))
    assert response.status_code == 202, response.text
    return response.json()


def test_group_runs_three_candidates_at_once(llm_client, fake_planner, settings) -> None:
    body = submit_group(llm_client)
    group, jobs = body["group"], body["jobs"]
    assert group["id"].startswith("grp-") and group["size"] == 3
    assert [job["group"] for job in jobs] == [{"id": group["id"], "index": i, "size": 3, "chosen_job_id": None} for i in range(3)]
    assert [job["planner"] for job in jobs] == [{"mode": "openrouter", "model_config": m, "allow_api": True} for m in MODELS]
    assert {job["name"] for job in jobs} == {"groundedness"}
    assert len({job["id"] for job in jobs}) == 3

    done = [wait_for_job(llm_client, job["id"]) for job in jobs]
    assert [job["status"] for job in done] == ["succeeded"] * 3, [job["log"] for job in done]
    assert sorted(fake_planner["calls"]) == sorted(MODELS)
    # 원본과 prompt 는 후보마다 따로 저장되지만 내용은 같다
    assert len({job["provenance"]["raw_sha256"] for job in done}) == 1
    assert len({job["provenance"]["prompt_sha256"] for job in done}) == 1
    for job in done:
        assert (settings.jobs_dir / job["id"] / "input" / "raw.json").is_file()
        assert "hits.csv" in job["files"] and "template.html" in job["files"]
    listed = [job for job in llm_client.get(JOBS).json()["jobs"] if job["group"]]
    assert sorted(job["group"]["index"] for job in listed) == [0, 1, 2]
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_choose_a_candidate_and_keep_it_after_restart(make_client, fake_planner) -> None:
    fake_planner["fail_models"] = {"qwen3-235b"}
    with make_client(api_allowed=True) as client:
        body = submit_group(client)
        group_id = body["group"]["id"]
        done = [wait_for_job(client, job["id"]) for job in body["jobs"]]
        assert [job["status"] for job in done] == ["succeeded", "failed", "succeeded"]
        assert "fake planner" in done[1]["error"]

        choice = f"{GROUPS}/{group_id}/choice"
        failed = client.put(choice, json={"job_id": done[1]["id"]})
        assert failed.status_code == 400 and "succeeded" in failed.json()["error"]["message"]

        response = client.put(choice, json={"job_id": done[2]["id"]})
        assert response.status_code == 200, response.text
        members = response.json()["jobs"]
        assert [job["id"] for job in members] == [job["id"] for job in done]
        assert {job["group"]["chosen_job_id"] for job in members} == {done[2]["id"]}

    with make_client(api_allowed=True) as client:
        reloaded = [client.get(f"{JOBS}/{job['id']}").json() for job in done]
        assert {job["group"]["chosen_job_id"] for job in reloaded} == {done[2]["id"]}


@pytest.mark.parametrize("body", [{}, {"job_id": 3}, {"job_id": "job-x", "extra": 1}, [], {"job_id": "job-not-in-group"}])
def test_invalid_choice_is_rejected(llm_client, fake_planner, body) -> None:
    group = submit_group(llm_client)
    for job in group["jobs"]:
        wait_for_job(llm_client, job["id"])
    response = llm_client.put(f"{GROUPS}/{group['group']['id']}/choice", json=body)
    assert response.status_code == 400
    assert {job["group"]["chosen_job_id"] for job in llm_client.get(JOBS).json()["jobs"]} == {None}


def test_unknown_group_is_404(client) -> None:
    response = client.put(f"{GROUPS}/grp-missing/choice", json={"job_id": "job-x"})
    assert response.status_code == 404


def test_group_reuses_raw_from_an_earlier_job(llm_client, fake_planner) -> None:
    first = submit_group(llm_client)
    first_jobs = [wait_for_job(llm_client, job["id"]) for job in first["jobs"]]
    second = submit_group(llm_client, files={}, source_job_id=first_jobs[0]["id"], name="groundedness v2")
    jobs = [wait_for_job(llm_client, job["id"]) for job in second["jobs"]]
    assert [job["status"] for job in jobs] == ["succeeded"] * 3
    assert {job["provenance"]["raw_sha256"] for job in jobs} == {first_jobs[0]["provenance"]["raw_sha256"]}
    assert {job["provenance"]["source_job_id"] for job in jobs} == {first_jobs[0]["id"]}
    assert second["group"]["id"] != first["group"]["id"]


@pytest.mark.parametrize(
    ("models", "extra", "message"),
    [
        ([], {}, "model_configs"),
        (MODELS + ["default"], {}, "model_configs"),
        (["default", "no-such-model"], {}, "model config"),
        (["../default"], {}, "model_config"),
        (MODELS, {"prompt_text": "  "}, "prompt"),
        (MODELS, {"allow_api": "false"}, "allow_api=false"),
    ],
)
def test_group_rejects_bad_requests_without_leaving_folders(llm_client, settings, models, extra, message) -> None:
    response = llm_client.post(GROUPS, files=raw_upload(), data=group_form(models=models, **extra))
    assert response.status_code == 400, response.text
    assert message in response.json()["error"]["message"]
    assert llm_client.get(JOBS).json()["jobs"] == []
    assert not any(settings.jobs_dir.iterdir())


def test_group_does_not_take_a_task_spec(llm_client) -> None:
    files = {**raw_upload(), "spec": example_uploads()["spec"]}
    response = llm_client.post(GROUPS, files=files, data=group_form())
    assert response.status_code == 400
    assert "/api/agent/jobs" in response.json()["error"]["message"]


def test_group_needs_the_server_switch(client, settings) -> None:
    """서버 스위치가 꺼져 있으면 allow_api=true 여도 접수하지 않는다 (OpenRouter 를 부를 길이 없다)."""
    response = client.post(GROUPS, files=raw_upload(), data=group_form())
    assert response.status_code == 400
    assert "AGENT_ALLOW_API=1" in response.json()["error"]["message"]
    assert not any(settings.jobs_dir.iterdir())


def test_job_workers_setting(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "missing.env"))
    assert Settings.from_env().job_workers == JOB_WORKERS_DEFAULT == 3
    for value, expected in (("2", 2), ("0", 1), ("many", JOB_WORKERS_DEFAULT)):
        monkeypatch.setenv("AGENT_JOB_WORKERS", value)
        assert Settings.from_env().job_workers == expected


def test_single_job_keeps_no_group(client) -> None:
    response = client.post(JOBS, files=example_uploads(), data={"name": "single"})
    assert response.status_code == 202
    assert response.json()["job"]["group"] is None
    saved = wait_for_job(client, response.json()["job"]["id"])
    assert saved["group"] is None and json.dumps(saved)
