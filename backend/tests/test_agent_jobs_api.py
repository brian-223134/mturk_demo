"""agent job API (/api/agent/…). 예시(agent/examples/groundedness/)로 job 을 접수해 LLM 없이 succeeded 까지 가는지,
결과 파일 내려받기, 400 조건들, spec 이 데이터와 맞지 않을 때의 failed, 서버를 다시 켠 뒤의 목록을 확인한다.

OpenRouter 는 절대 부르지 않는다: 서버는 api_allowed=False 로 만들고, allow_api=true 를 보내는 경우도 접수 단계에서
400 으로 끝나야 한다 (plan_request.json 이 어디에도 생기지 않는 것으로 확인).
"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from app.agent_jobs.models import KNOWN_FILES
from app.settings import Settings
from helpers import MODELS_DIR, example_uploads, step_statuses, upload, wait_for_job

JOBS = "/api/agent/jobs"
MISMATCHED_RAW = json.dumps([{"id": "x1", "text": "hello"}, {"id": "x2", "text": "world"}]).encode("utf-8")


def submit_example(client: TestClient, **fields: str) -> dict:
    response = client.post(JOBS, files=example_uploads(), data=fields)
    assert response.status_code == 202, response.text
    return response.json()["job"]


def test_models_lists_configs(client: TestClient) -> None:
    """environment/models 의 yaml 마다 하나씩, 기본 이름은 env 파일의 AGENT_MODEL, API 는 불허."""
    response = client.get("/api/agent/models")
    assert response.status_code == 200
    body = response.json()
    names = [m["name"] for m in body["models"]]
    assert names == sorted(path.stem for path in MODELS_DIR.glob("*.yaml"))
    assert {"default", "deepseek-v3.2", "qwen3-235b"} <= set(names)
    for model in body["models"]:
        assert set(model) == {"name", "model", "api", "provider_tag"}
        assert model["api"] == "openrouter"
        assert model["model"]
    assert body["default"] == "default"
    assert body["api_allowed"] is False


def test_job_with_spec_succeeds(client: TestClient, settings: Settings) -> None:
    """raw + prompt + spec → 202, plan 은 skipped, 나머지 단계는 succeeded, 결과 파일 9개, 검증 통과."""
    job = submit_example(client, name="example")
    assert job["id"].startswith("job-")
    assert job["name"] == "example"
    assert job["status"] == "queued"
    assert job["input"] == {"raw": "raw.json", "prompt": "prompt.md", "spec": "task_spec.json"}
    assert job["planner"] == {"mode": "file", "model_config": None, "allow_api": False}
    assert step_statuses(job) == {name: "pending" for name in ("profile", "plan", "preprocess", "render", "validate")}

    job = wait_for_job(client, job["id"])
    assert job["status"] == "succeeded", job["log"]
    assert job["error"] is None
    assert step_statuses(job) == {"profile": "succeeded", "plan": "skipped", "preprocess": "succeeded",
                                  "render": "succeeded", "validate": "succeeded"}
    assert job["files"] == list(KNOWN_FILES)
    assert job["validation"]["ok"] is True and job["validation"]["errors"] == []
    assert job["summary"]["records"]["used"] == 6 and job["summary"]["records"]["total"] == 6
    assert job["summary"]["hits"] == 6
    assert job["summary"]["items"] == 24
    assert job["usage"] is None  # OpenRouter 를 부르지 않았다
    assert isinstance(job["planner_notes"], str) and job["planner_notes"]
    assert job["started_at"] and job["finished_at"]
    assert any(line.endswith("plan: skipped (task spec file supplied)") for line in job["log"])

    # 디스크의 job 폴더: 업로드는 input/ 에, job.json 은 같은 상태
    directory = settings.jobs_dir / job["id"]
    assert sorted(p.name for p in (directory / "input").iterdir()) == ["prompt.md", "raw.json", "task_spec.json"]
    saved = json.loads((directory / "job.json").read_text(encoding="utf-8"))
    assert saved["status"] == "succeeded" and saved["files"] == job["files"]
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_job_files_download(client: TestClient) -> None:
    job = wait_for_job(client, submit_example(client)["id"])
    assert job["status"] == "succeeded"
    base = f"{JOBS}/{job['id']}/files"

    template = client.get(f"{base}/template.html")
    assert template.status_code == 200
    assert template.headers["content-type"].startswith("text/html")
    disposition = template.headers["content-disposition"]
    assert disposition.startswith("attachment") and 'filename="template.html"' in disposition
    assert "<crowd-form>" in template.text
    assert template.headers["cache-control"] == "no-store"

    hits = client.get(f"{base}/hits.csv")
    assert hits.status_code == 200 and hits.headers["content-type"].startswith("text/csv")
    assert hits.text.splitlines()[0].startswith("hit_id,")
    assert client.get(f"{base}/summary.json").headers["content-type"].startswith("application/json")
    assert client.get(f"{base}/items.jsonl").headers["content-type"].startswith("application/x-ndjson")
    assert client.get(f"{base}/profile.md").headers["content-type"].startswith("text/markdown")

    # job.files 에 없는 이름과 폴더 밖으로 나가는 이름은 404
    for name in ("job.json", "..%2Fjob.json", "input", "input%2Fraw.json", "nope.html"):
        response = client.get(f"{base}/{name}")
        assert response.status_code == 404, name
        assert response.json()["error"]["code"] == "NOT_FOUND", name

    unknown = client.get(f"{JOBS}/job-00000000-000000-0000")
    assert unknown.status_code == 404
    assert unknown.json() == {"error": {"code": "NOT_FOUND", "message": "Job not found: job-00000000-000000-0000"}}
    assert client.get(f"{JOBS}/job-00000000-000000-0000/files/template.html").status_code == 404


def test_job_list_newest_first(client: TestClient) -> None:
    first = submit_example(client, name="first")
    time.sleep(0.01)  # created_at 은 밀리초 단위다
    second = submit_example(client, name="second")
    wait_for_job(client, second["id"])
    jobs = client.get(JOBS).json()["jobs"]
    assert [j["id"] for j in jobs] == [second["id"], first["id"]]
    assert [j["name"] for j in jobs] == ["second", "first"]
    assert all(j["status"] == "succeeded" for j in jobs)


def test_prompt_text_instead_of_file(client: TestClient, settings: Settings) -> None:
    uploads = example_uploads()
    del uploads["prompt"]
    response = client.post(JOBS, files=uploads, data={"prompt_text": "Judge whether each statement is supported."})
    assert response.status_code == 202, response.text
    job = response.json()["job"]
    assert job["input"] == {"raw": "raw.json", "prompt": "prompt_text", "spec": "task_spec.json"}
    assert job["name"] == "raw.json"  # name 을 주지 않으면 원본 파일 이름
    prompt_file = settings.jobs_dir / job["id"] / "input" / "prompt_text.md"
    assert prompt_file.read_text(encoding="utf-8") == "Judge whether each statement is supported.\n"
    assert wait_for_job(client, job["id"])["status"] == "succeeded"


def assert_no_job_left(settings: Settings) -> None:
    """접수에 실패한 job 은 폴더째 지워지고, OpenRouter 요청 파일은 어디에도 없다."""
    assert not settings.jobs_dir.exists() or list(settings.jobs_dir.iterdir()) == []
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_rejects_missing_raw(client: TestClient, settings: Settings) -> None:
    uploads = example_uploads()
    del uploads["raw"]
    response = client.post(JOBS, files=uploads)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert '"raw"' in response.json()["error"]["message"]
    assert_no_job_left(settings)


def test_rejects_without_spec_or_prompt(client: TestClient, settings: Settings) -> None:
    response = client.post(JOBS, files={"raw": example_uploads()["raw"]})
    assert response.status_code == 400
    message = response.json()["error"]["message"]
    assert '"spec"' in message and '"prompt"' in message
    assert_no_job_left(settings)
    assert client.get(JOBS).json()["jobs"] == []


def test_rejects_llm_call_when_request_disallows(client: TestClient, settings: Settings) -> None:
    """spec 없이 prompt 만: allow_api=false 면 400. 메시지에 요청과 서버 양쪽 조건이 적혀 있다."""
    uploads = example_uploads()
    del uploads["spec"]
    for data in ({}, {"allow_api": "false"}):
        response = client.post(JOBS, files=uploads, data=data)
        assert response.status_code == 400, data
        message = response.json()["error"]["message"]
        assert "allow_api=false" in message and "AGENT_ALLOW_API=1" in message
    assert_no_job_left(settings)


def test_rejects_llm_call_when_server_disallows(client: TestClient, settings: Settings) -> None:
    """allow_api=true 라도 서버가 AGENT_ALLOW_API=1 없이 떴으면 400 이고 네트워크는 쓰지 않는다."""
    uploads = example_uploads()
    del uploads["spec"]
    response = client.post(JOBS, files=uploads, data={"allow_api": "true", "model_config": "default"})
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "AGENT_ALLOW_API=1" in body["error"]["message"]
    assert "allow_api=true in the request is not enough" in body["error"]["message"]
    assert_no_job_left(settings)
    assert client.get(JOBS).json()["jobs"] == []


def test_rejects_invalid_spec(client: TestClient, settings: Settings) -> None:
    """spec 파일은 접수할 때 검사한다: 형식이 틀리면 400 에 spec 오류가 적힌다."""
    uploads = example_uploads()
    uploads["spec"] = upload("task_spec.json", b'{"spec_version": 1}', "application/json")
    response = client.post(JOBS, files=uploads)
    assert response.status_code == 400
    assert response.json()["error"]["message"].startswith("the task spec is not valid: ")

    uploads["spec"] = upload("task_spec.json", b"not json", "application/json")
    response = client.post(JOBS, files=uploads)
    assert response.status_code == 400
    assert "invalid JSON" in response.json()["error"]["message"]
    assert_no_job_left(settings)


def test_mismatched_spec_fails_at_preprocess(client: TestClient) -> None:
    """spec 은 유효하지만 원본과 맞지 않으면 preprocess 에서 failed 가 되고 뒤 단계는 skipped 다."""
    uploads = example_uploads()
    uploads["raw"] = upload("other.json", MISMATCHED_RAW, "application/json")
    response = client.post(JOBS, files=uploads, data={"name": "mismatch"})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["job"]["id"])
    assert job["status"] == "failed"
    assert step_statuses(job) == {"profile": "succeeded", "plan": "skipped", "preprocess": "failed",
                                  "render": "skipped", "validate": "skipped"}
    failed = next(step for step in job["steps"] if step["name"] == "preprocess")
    assert failed["error"].startswith("the task spec is not valid: ")
    assert job["error"] == f"preprocess: {failed['error']}"
    assert {"profile.json", "profile.md", "task_spec.json"} <= set(job["files"])
    assert not {"hits.csv", "template.html", "validation.json"} & set(job["files"])
    assert job["summary"] is None and job["validation"] is None


def test_jobs_persist_across_restart(make_client, make_settings) -> None:
    """job.json 덕분에 서버를 다시 켜도 (다른 앱이 같은 output_dir 를 열어도) job 이 같은 상태와 파일로 보인다."""
    with make_client() as client:
        job = wait_for_job(client, submit_example(client, name="kept")["id"])
        assert job["status"] == "succeeded"

    reopened = make_settings(db_path=make_settings().db_path.with_name("second.sqlite"))  # output_dir 는 같다
    with make_client(db_path=reopened.db_path) as client:
        again = client.get(f"{JOBS}/{job['id']}")
        assert again.status_code == 200
        assert again.json()["status"] == "succeeded"
        assert again.json()["files"] == job["files"]
        assert again.json()["steps"] == job["steps"]
        assert again.json()["name"] == "kept"
        assert [j["id"] for j in client.get(JOBS).json()["jobs"]] == [job["id"]]
        assert client.get(f"{JOBS}/{job['id']}/files/template.html").status_code == 200
