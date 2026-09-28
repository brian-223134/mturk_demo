"""입력 재사용과 평가 저장. 임시 폴더의 합성 예시만 쓰며 LLM은 호출하지 않는다."""
import hashlib
import json

import pytest

from helpers import example_uploads, wait_for_job

JOBS = "/api/agent/jobs"


def example(client):
    response = client.post(JOBS, files=example_uploads(), data={"name": "baseline"})
    assert response.status_code == 202, response.text
    return wait_for_job(client, response.json()["job"]["id"])


def test_reuse_copies_raw_and_explicit_spec_with_a_new_prompt(client, settings):
    first = example(client)
    inputs = client.get(f"{JOBS}/{first['id']}/inputs").json()
    assert inputs["raw_name"] == "raw.json" and inputs["has_spec"]
    assert "Annotation goal" in inputs["prompt_text"]
    changed = "Compare this revised instruction."
    response = client.post(JOBS, data={"source_job_id": first["id"], "reuse_spec": "true", "prompt_text": changed})
    assert response.status_code == 202, response.text
    second = wait_for_job(client, response.json()["job"]["id"])
    assert second["status"] == "succeeded"
    assert second["planner"]["mode"] == "file"
    assert second["provenance"]["raw_sha256"] == first["provenance"]["raw_sha256"]
    assert second["provenance"]["prompt_sha256"] == hashlib.sha256(changed.encode()).hexdigest()
    assert second["provenance"]["prompt_sha256"] != first["provenance"]["prompt_sha256"]
    assert second["provenance"]["source_job_id"] == first["id"]
    assert client.get(f"{JOBS}/{first['id']}/inputs").json() == inputs
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_reuse_does_not_implicitly_reuse_spec_or_enable_api(client, settings):
    first = example(client)
    response = client.post(JOBS, data={"source_job_id": first["id"], "prompt_text": "New candidate"})
    assert response.status_code == 400
    assert "not allowed" in response.json()["error"]["message"]
    assert len(client.get(JOBS).json()["jobs"]) == 1
    assert not list(settings.output_dir.rglob("plan_request*.json"))


def test_missing_source_and_saved_raw(client, settings):
    assert client.post(JOBS, data={"source_job_id": "missing"}).status_code == 404
    first = example(client)
    (settings.jobs_dir / first["id"] / "input" / "raw.json").unlink()
    assert client.get(f"{JOBS}/{first['id']}/inputs").status_code == 404
    assert client.post(JOBS, data={"source_job_id": first["id"], "reuse_spec": "true"}).status_code == 404


def test_prompt_filename_collision_does_not_overwrite_raw(client):
    uploads = example_uploads()
    raw = uploads["raw"]
    uploads["raw"] = ("prompt_text.md", raw[1], raw[2])
    del uploads["prompt"]
    response = client.post(JOBS, files=uploads, data={"prompt_text": "A separate prompt"})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["job"]["id"])
    assert job["status"] == "succeeded"
    assert client.get(f"{JOBS}/{job['id']}/inputs").json()["prompt_text"] == "A separate prompt"


def test_review_and_provenance_survive_restart(make_client):
    with make_client() as client:
        first = example(client)
        url = f"{JOBS}/{first['id']}/review"
        review = {"decision": "shortlisted", "notes": "Check borderline cases.", "checks": {"data": "pass", "attention": "fail"}}
        response = client.put(url, json=review)
        assert response.status_code == 200
        saved = response.json()
        assert saved["status"] == "succeeded"
        assert saved["review"]["checks"]["instructions"] == "unchecked"
        assert saved["review"]["updated_at"]
    with make_client() as client:
        loaded = client.get(f"{JOBS}/{first['id']}").json()
        assert loaded["review"] == saved["review"]
        assert loaded["provenance"] == first["provenance"]
        assert client.get(f"{JOBS}/{first['id']}/inputs").status_code == 200


@pytest.mark.parametrize("review", [[], {"decision": "approved"}, {"notes": "x" * 10001},
                                    {"checks": {"data": "yes"}}, {"checks": {"other": "pass"}}, {"status": "failed"}])
def test_invalid_review_leaves_job_unchanged(client, review):
    first = example(client)
    assert client.put(f"{JOBS}/{first['id']}/review", json=review).status_code == 400
    assert client.get(f"{JOBS}/{first['id']}").json()["review"] == {}


def test_legacy_job_and_input_path_escape(make_client, make_settings):
    with make_client() as client:
        first = example(client)
    path = make_settings().jobs_dir / first["id"] / "job.json"
    saved = json.loads(path.read_text())
    saved.pop("provenance"); saved.pop("review")
    saved["input"]["raw"] = "../task_spec.json"
    path.write_text(json.dumps(saved))
    with make_client() as client:
        loaded = client.get(f"{JOBS}/{first['id']}").json()
        assert loaded["review"] == {} and loaded["provenance"] == {}
        assert client.get(f"{JOBS}/{first['id']}/inputs").status_code == 404
