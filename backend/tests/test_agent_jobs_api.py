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


def test_server_switch_reads_the_env_file(tmp_path, monkeypatch) -> None:
    """서버 스위치: AGENT_ALLOW_API 환경변수가 비어 있으면 ENV_FILE(environment/.env)의 같은 이름을 따른다. 셸 값이 앞선다."""
    env_file = tmp_path / "server.env"
    env_file.write_text("AGENT_ALLOW_API=1\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_file))
    assert Settings.from_env().api_allowed is True
    monkeypatch.setenv("AGENT_ALLOW_API", "")
    assert Settings.from_env().api_allowed is True
    monkeypatch.setenv("AGENT_ALLOW_API", "0")
    assert Settings.from_env().api_allowed is False
    monkeypatch.delenv("AGENT_ALLOW_API")
    env_file.write_text("AGENT_ALLOW_API=0\n", encoding="utf-8")
    assert Settings.from_env().api_allowed is False


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
    assert job["files"] == [name for name in KNOWN_FILES if name not in ("hits.csv", "items.jsonl")]  # 두 이름은 옛 job 의 파일이다
    assert job["validation"]["ok"] is True and job["validation"]["errors"] == []
    assert job["summary"]["records"]["used"] == 6 and job["summary"]["records"]["total"] == 6
    assert job["summary"]["hits"] == 6
    assert job["summary"]["items"] == 24
    assert job["usage"] is None  # OpenRouter 를 부르지 않았다
    assert isinstance(job["planner_notes"], str) and job["planner_notes"]
    assert job["started_at"] and job["finished_at"]
    assert any(line.endswith("plan: skipped (task spec file supplied)") for line in job["log"])

    # 디스크의 job 폴더: 업로드는 input/ 에, 상태는 DB 에만 (job.json 은 쓰지 않는다)
    directory = settings.jobs_dir / job["id"]
    assert sorted(p.name for p in (directory / "input").iterdir()) == ["prompt.md", "raw.json", "task_spec.json"]
    assert not (directory / "job.json").exists()
    saved = client.app.state.db.get_job(job["id"])
    assert saved["status"] == "succeeded" and saved["files"] == job["files"]
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_csv_raw_fails_with_the_reason(client: TestClient) -> None:
    """원본은 JSON 파일만 받는다. CSV 를 올리면 job 이 실패하고 이유를 알린다."""
    response = client.post(JOBS, files={**example_uploads(), "raw": ("raw.csv", b"id,text\n1,a\n", "text/csv")})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["job"]["id"])
    assert job["status"] == "failed"
    assert "must be a JSON file" in job["error"]
    assert not {"hits.json", "template.html"} & set(job["files"])


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

    hits = client.get(f"{base}/hits.json")
    assert hits.status_code == 200 and hits.headers["content-type"].startswith("application/json")
    assert list(hits.json()[0])[0] == "hit_id"
    assert client.get(f"{base}/summary.json").headers["content-type"].startswith("application/json")
    assert client.get(f"{base}/items.json").headers["content-type"].startswith("application/json")
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
    assert not {"hits.json", "template.html", "validation.json"} & set(job["files"])
    assert job["summary"] is None and job["validation"] is None


def test_jobs_persist_across_restart(make_client) -> None:
    """job 상태가 DB 에 있으므로 서버를 다시 켜도 job 이 같은 상태와 파일로 보인다."""
    with make_client() as client:
        job = wait_for_job(client, submit_example(client, name="kept")["id"])
        assert job["status"] == "succeeded"

    with make_client() as client:
        again = client.get(f"{JOBS}/{job['id']}")
        assert again.status_code == 200
        assert again.json()["status"] == "succeeded"
        assert again.json()["files"] == job["files"]
        assert again.json()["steps"] == job["steps"]
        assert again.json()["name"] == "kept"
        assert [j["id"] for j in client.get(JOBS).json()["jobs"]] == [job["id"]]
        assert client.get(f"{JOBS}/{job['id']}/files/template.html").status_code == 200


def test_legacy_job_files_are_imported_once(make_client, make_database, make_settings) -> None:
    """예전처럼 job 폴더에 job.json 만 있는 job 은 켤 때 DB 로 가져온다. 이미 DB 에 있는 job 의 job.json 은 읽지 않는다."""
    with make_client() as client:
        job = wait_for_job(client, submit_example(client, name="old")["id"])
    folder = make_settings().jobs_dir / job["id"]
    (folder / "job.json").write_text(json.dumps(job), encoding="utf-8")
    probe = make_database()
    probe.open()
    with probe.connect() as connection:
        connection.execute("DELETE FROM agent_jobs")

    with make_client() as client:
        listed = client.get(JOBS).json()["jobs"]
        assert [(j["id"], j["name"], j["status"]) for j in listed] == [(job["id"], "old", "succeeded")]
        assert "job.json" not in listed[0]["files"]
    assert probe.get_job(job["id"])["name"] == "old"

    stale = dict(job, name="stale file")
    (folder / "job.json").write_text(json.dumps(stale), encoding="utf-8")
    with make_client() as client:
        assert client.get(f"{JOBS}/{job['id']}").json()["name"] == "old"   # DB 가 기준


BINDING_BODY = {
    "design": {"id": "item-list", "rows": [{"slots": ["data", "item-choice"]}]},
    "task_type": "text",
    "prompt": "Check which facts each chunk supports.",
    "data": {"hit_count": 1, "columns": [{"name": "chunks", "shape": "list[3] of str", "samples": []}]},
    "allow_api": True,
}


def test_binding_needs_both_permissions(client: TestClient, settings: Settings) -> None:
    """요청과 서버가 모두 허용해야 하며, 막히면 OpenRouter 를 부르지 않는다."""
    assert settings.api_allowed is False
    response = client.post("/api/agent/bindings", json=BINDING_BODY)
    assert response.status_code == 400 and "Calling OpenRouter is not allowed" in response.json()["error"]["message"]
    response = client.post("/api/agent/bindings", json={**BINDING_BODY, "allow_api": False})
    assert response.status_code == 400
    assert not (settings.output_dir / "bindings").exists()


def test_binding_rejects_bad_requests(client: TestClient) -> None:
    for change, message in [
        ({"design": "item-list"}, '"design"'),
        ({"task_type": "audio"}, '"task_type"'),
        ({"prompt": "  "}, '"prompt"'),
        ({"data": {"rows": []}}, '"data"'),
        ({"errors": "no"}, '"errors"'),
        ({"previous": []}, '"previous"'),
        ({"current": []}, '"current"'),
        ({"earlier_requests": "no"}, '"earlier_requests"'),
        ({"earlier_requests": [1]}, '"earlier_requests"'),
        ({"data": {"columns": [{"name": "x" * 300_000}]}}, "too large"),
    ]:
        response = client.post("/api/agent/bindings", json={**BINDING_BODY, **change})
        assert response.status_code == 400, change
        assert message in response.json()["error"]["message"], change


def test_binding_returns_the_model_reply(make_client, monkeypatch) -> None:
    """서버와 요청이 모두 허용하면 모델 설정대로 부르고, 답과 사용량, 모델 정보를 돌려준다. 네트워크는 쓰지 않는다."""
    seen = {}

    def fake_write(config, api_key, allow_api, request, log_dir):
        seen.update(model=config.model, allow_api=allow_api, request=request, log_dir=log_dir)
        return {"binding": {"design": "item-list", "task_type": "text", "slots": {}}, "usage": {"calls": 1, "cost": 0.002}, "provider": "Parasail"}

    monkeypatch.setattr("app.routers.agent_jobs.write_binding", fake_write)
    with make_client(api_allowed=True) as client:
        response = client.post("/api/agent/bindings", json={**BINDING_BODY, "errors": ["bad path"], "previous": {"design": "x"}})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["binding"]["design"] == "item-list"
    assert body["usage"]["cost"] == 0.002
    assert body["model"] == {"name": "deepseek-v4.1-flash", "model": "deepseek/deepseek-v4.1-flash-1017", "provider_tag": None, "served_by": "Parasail"}
    assert "provider" not in body
    assert seen["allow_api"] is True
    assert seen["request"]["errors"] == ["bad path"] and seen["request"]["previous"] == {"design": "x"}
    assert "allow_api" not in seen["request"], "허용 여부는 모델에 보내지 않는다"
    assert seen["log_dir"].is_dir() and seen["log_dir"].parent.name == "bindings"


def test_binding_revision_reaches_the_agent_and_cannot_comes_back(make_client, monkeypatch) -> None:
    """수정 요청은 current 와 earlier_requests 를 agent 로 넘기고, 할 수 없다는 답은 binding 없이 돌아온다."""
    seen = {}

    def fake_write(config, api_key, allow_api, request, log_dir):
        seen.update(request=request)
        return {"binding": None, "cannot": "layout", "message": "Use the buttons.", "usage": {"calls": 1}}

    monkeypatch.setattr("app.routers.agent_jobs.write_binding", fake_write)
    with make_client(api_allowed=True) as client:
        response = client.post("/api/agent/bindings", json={**BINDING_BODY, "current": {"design": "item-list"}, "earlier_requests": ["Use Yes and No."]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["binding"] is None and body["cannot"] == "layout" and body["message"] == "Use the buttons."
    assert seen["request"]["current"] == {"design": "item-list"}
    assert seen["request"]["earlier_requests"] == ["Use Yes and No."]


def test_binding_reports_a_failed_call(make_client, monkeypatch) -> None:
    from agent.planner.openrouter import PlannerError

    def fail(*args):
        raise PlannerError("provider is down")

    monkeypatch.setattr("app.routers.agent_jobs.write_binding", fail)
    with make_client(api_allowed=True) as client:
        response = client.post("/api/agent/bindings", json=BINDING_BODY)
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "The model call failed: provider is down"


def test_models_names_the_binding_model(client: TestClient) -> None:
    assert client.get("/api/agent/models").json()["binding_model"] == "deepseek-v4.1-flash"
