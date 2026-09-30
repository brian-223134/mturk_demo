"""attention 의 기대 답 컬럼 방식과 자유 서술 답 (app/domain/attention.py, app/domain/answer_kinds.py).

agent 의 새 출력(한 탭에 문항 여럿, attention 탭도 general_ 이름)을 흉내 낸 작은 seed 폴더를 만들어, seed 의 판정부터 Review,
Results, export, worker 지표까지 attention 답과 자유 서술 답이 어디에서 빠지고 어디에 남는지 확인한다.
worker 제출 경로가 없으므로 응답은 seed 파일로만 넣는다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.domain.agreement import fleiss_kappa
from app.domain.answer_kinds import AnswerKinds, answer_kinds, reads_hit_input
from app.domain.attention import expected_attention_answers, judge_attention
from app.domain.reference import agreement_with_reference, map_reference_to_answers
from app.domain.worker_stats import WorkerStatsRecord, compute_worker_stats
from helpers import SETTINGS, list_query

COLUMN_RULE = {"column": "attention_expected", "minCorrectRatio": 1}


def answers(values: dict) -> list[dict]:
    return [{"name": name, "value": value} for name, value in values.items()]


# ---- judge_attention (컬럼 방식) -------------------------------------------------------------------


def test_expected_attention_answers_reads_the_cell_like_a_reference_cell() -> None:
    cell = {"attention_expected": '{"general_1_1_support": "not_supported", "general_1_likert": 2}'}
    assert expected_attention_answers(COLUMN_RULE, cell) == {"general_1_1_support": "not_supported", "general_1_likert": "2"}
    assert expected_attention_answers(COLUMN_RULE, {"attention_expected": "{'general_0_q': 'Yes'}"}) == {"general_0_q": "Yes"}
    assert expected_attention_answers(COLUMN_RULE, {"attention_expected": "{'a': ['x']}"}) == {"a": None}   # 비교할 수 없는 값
    assert expected_attention_answers(COLUMN_RULE, {"attention_expected": ""}) == {}
    assert expected_attention_answers(COLUMN_RULE, {"attention_expected": '["x"]'}) == {}
    assert expected_attention_answers(COLUMN_RULE, None) == {}
    assert expected_attention_answers({"namePrefix": "attention_", "expectedValue": "x"}, cell) is None
    assert expected_attention_answers(None, cell) is None


def test_judge_attention_with_the_expected_answers_column() -> None:
    hit_input = {"attention_expected": '{"general_1_1_support": "not_supported", "general_1_2_support": "supported"}'}
    both = answers({"general_0_1_support": "supported", "general_1_1_support": "not_supported", "general_1_2_support": "supported"})
    assert judge_attention(both, COLUMN_RULE, hit_input) == {"total": 2, "correct": 2, "passed": True}
    # 값은 정확히 같아야 한다 (대소문자도). 답이 없으면 틀림
    wrong_case = answers({"general_1_1_support": "Not_supported", "general_1_2_support": "supported"})
    assert judge_attention(wrong_case, COLUMN_RULE, hit_input) == {"total": 2, "correct": 1, "passed": False}
    missing = answers({"general_1_2_support": "supported"})
    assert judge_attention(missing, COLUMN_RULE, hit_input) == {"total": 2, "correct": 1, "passed": False}
    assert judge_attention(missing, {**COLUMN_RULE, "minCorrectRatio": 0.5}, hit_input)["passed"] is True
    # 이름이 attention_ 로 시작해도 셀의 키가 아니면 attention 이 아니다
    assert judge_attention(answers({"attention_1": "x"}), COLUMN_RULE, {"attention_expected": "{}"}) is None
    assert judge_attention(both, COLUMN_RULE, {"attention_expected": ""}) is None
    assert judge_attention(both, COLUMN_RULE) is None
    # 접두어 방식은 hit_input 을 보지 않는다
    rule = {"namePrefix": "attention_", "expectedValue": "x", "minCorrectRatio": 1}
    assert judge_attention(answers({"attention_1": "x"}), rule, hit_input) == {"total": 1, "correct": 1, "passed": True}


# ---- answer_kinds ---------------------------------------------------------------------------------


def test_answer_kinds_prefix_rule_null_rule_and_free_text() -> None:
    legacy = answer_kinds({"attentionRule": {"namePrefix": "check_", "expectedValue": "no"}, "freeTextSuffixes": ["_comment"]})
    assert legacy.is_attention("check_1") and not legacy.is_attention("attention_1")
    assert legacy.expected_value("check_1") == "no" and legacy.expected_value("general_1") is None
    assert legacy.is_free_text("general_0_comment") and not legacy.is_free_text("check_0_comment")   # attention 이 먼저다
    assert [legacy.is_excluded(n) for n in ("general_1", "check_1", "general_0_comment")] == [False, True, True]
    assert reads_hit_input({"attentionRule": {"namePrefix": "check_", "expectedValue": "no"}}) is False

    none = answer_kinds({"attentionRule": None})   # 규칙이 없으면 기본 접두어로 빼기만 하고 기대 값은 없다
    assert none.is_attention("attention_1") and none.expected_value("attention_1") is None and not none.is_free_text("x_comment")
    assert answer_kinds(None) == AnswerKinds()


def test_answer_kinds_column_rule_is_per_hit() -> None:
    batch = {"attentionRule": COLUMN_RULE, "freeTextSuffixes": ["_missing_info"]}
    assert reads_hit_input(batch) is True
    kinds = answer_kinds(batch, {"attention_expected": '{"general_1_1_support": "not_supported", "general_1_missing_info": "x"}'})
    assert kinds.is_attention("general_1_1_support") and not kinds.is_attention("attention_1")
    assert kinds.expected_value("general_1_1_support") == "not_supported" and kinds.expected_value("general_0_1_support") is None
    assert kinds.is_free_text("general_2_missing_info") and not kinds.is_free_text("general_1_missing_info")
    other_hit = answer_kinds(batch, {"attention_expected": ""})
    assert not other_hit.is_attention("general_1_1_support") and not other_hit.is_attention("attention_1")


def test_reference_and_worker_stats_take_a_predicate() -> None:
    kinds = answer_kinds({"attentionRule": COLUMN_RULE, "freeTextSuffixes": ["_note"]}, {"attention_expected": '{"general_1_q": "b"}'})
    given = answers({"general_0_q": "a", "general_0_note": "text", "general_1_q": "b"})
    # 위치로 대응: 라벨 답(general_0_q) 하나와 같은 길이면 그 답에
    assert map_reference_to_answers(["a"], given, kinds.is_excluded) == {"general_0_q": "a"}
    assert map_reference_to_answers("a", given, kinds.is_excluded) == {"general_0_q": "a"}
    assert agreement_with_reference(given, {"general_0_q": "A", "general_0_note": "other", "general_1_q": "x"}, kinds.is_excluded) == 1

    def record(worker: str, values: dict) -> WorkerStatsRecord:
        assignment = {"AssignmentId": worker, "HITId": "H0", "WorkerId": worker, "AssignmentStatus": "Approved",
                      "SubmitTime": "2025-10-09T11:05:00Z", "answers": answers(values), "workTimeInSeconds": 60}
        return WorkerStatsRecord(assignment, "b1", 0, kinds.is_excluded)

    stats = compute_worker_stats([record("W1", {"general_1_q": "b", "general_0_note": "same"}), record("W2", {"general_1_q": "b", "general_0_note": "same"})])
    assert stats["W1"]["majorityAgreement"] is None   # attention 과 자유 서술만 같았다


# ---- seed 폴더로 끝까지 ------------------------------------------------------------------------------

COLUMN_BATCH = "batch-2000001"
PREFIX_BATCH = "batch-2000002"
TEMPLATE = "<html><head></head><body>${passage}<script>window.TASK_ANSWER_SCHEMA = [];</script></body></html>"

# HIT 0: 탭 0 과 2 는 일반, 탭 1 이 attention. HIT 1: 탭 0 이 attention (같은 이름 general_0_1_support 가 HIT 0 에서는 라벨이다)
HIT_INPUTS = [
    {"hit_id": "h0", "passage": "p0",
     "llm_label": json.dumps({"general_0_1_support": "supported", "general_0_2_support": "not_supported", "general_2_covered": "No",
                              "general_2_missing_info": "The year."}),
     "attention_expected": json.dumps({"general_1_1_support": "not_supported"})},
    {"hit_id": "h1", "passage": "p1",
     "llm_label": json.dumps({"general_1_1_support": "supported"}),
     "attention_expected": json.dumps({"general_0_1_support": "supported", "general_0_2_support": "not_supported"})},
]
ANSWERS = {   # (worker, row) → 답
    ("W1", 0): {"general_0_1_support": "supported", "general_0_2_support": "not_supported", "general_1_1_support": "not_supported",
                "general_2_covered": "No", "general_2_missing_info": "The year is missing."},
    ("W2", 0): {"general_0_1_support": "supported", "general_0_2_support": "supported", "general_1_1_support": "not_supported",
                "general_2_covered": "No", "general_2_missing_info": "Missing the year"},
    ("W3", 0): {"general_0_1_support": "not_supported", "general_0_2_support": "not_supported", "general_1_1_support": "not_supported",
                "general_2_covered": "Yes"},
    ("W1", 1): {"general_0_1_support": "supported", "general_0_2_support": "not_supported", "general_1_1_support": "supported"},
    ("W2", 1): {"general_0_1_support": "supported", "general_0_2_support": "supported", "general_1_1_support": "supported"},
    ("W3", 1): {"general_0_1_support": "not_supported", "general_0_2_support": "not_supported", "general_1_1_support": "not_supported"},
}


def _batch(id: str, columns: list[str], **extra) -> dict:
    return {"id": id, "name": id, "env": "mock", "templateId": "tpl-x", "inputColumns": columns, "settings": SETTINGS,
            "requiredPoolIds": [], "excludedPoolIds": [], "createdAt": "2026-09-30T00:00:00Z", **extra}


def _hit(batch_id: str, row: int, cells: dict) -> dict:
    return {"HITId": f"{batch_id}-H{row}", "HITStatus": "Reviewable", "MaxAssignments": 3, "NumberOfAssignmentsPending": 0,
            "NumberOfAssignmentsAvailable": 0, "NumberOfAssignmentsCompleted": 3, "CreationTime": "2026-09-30T00:00:00Z",
            "Expiration": "2026-10-30T00:00:00Z", "batchId": batch_id, "rowIndex": row, "input": cells, "initialMaxAssignments": 3}


def _assignment(batch_id: str, worker: str, row: int, values: dict) -> dict:
    return {"AssignmentId": f"{batch_id}-{worker}-{row}", "HITId": f"{batch_id}-H{row}", "WorkerId": worker, "AssignmentStatus": "Approved",
            "AcceptTime": "2026-09-30T01:00:00Z", "SubmitTime": "2026-09-30T01:05:00Z", "AutoApprovalTime": "2026-10-30T01:05:00Z",
            "ApprovalTime": "2026-09-30T02:00:00Z", "answers": answers(values), "workTimeInSeconds": 300}


def _write_batch(root: Path, batch: dict, hits: list[dict], assignments: list[dict]) -> None:
    folder = root / "batches" / batch["id"]
    folder.mkdir(parents=True)
    (folder / "batch.json").write_text(json.dumps(batch), encoding="utf-8")
    (folder / "template.html").write_text(TEMPLATE, encoding="utf-8")
    (folder / "hits.json").write_text(json.dumps(hits), encoding="utf-8")
    (folder / "assignments.json").write_text(json.dumps(assignments), encoding="utf-8")


@pytest.fixture
def seeded(tmp_path: Path, make_client):
    """새 계약 모양의 batch(컬럼 방식, 자유 서술 _missing_info, 대조 기준 llm_label)와 접두어 방식 + 자유 서술 batch 하나."""
    root = tmp_path / "data"
    (root / "templates").mkdir(parents=True)
    (root / "templates" / "index.json").write_text("[]", encoding="utf-8")
    columns = ["hit_id", "passage", "llm_label", "attention_expected"]
    _write_batch(root, _batch(COLUMN_BATCH, columns, attentionRule=COLUMN_RULE, freeTextSuffixes=["_missing_info"],
                              reference={"source": "column", "column": "llm_label"}),
                 [_hit(COLUMN_BATCH, row, cells) for row, cells in enumerate(HIT_INPUTS)],
                 [_assignment(COLUMN_BATCH, worker, row, values) for (worker, row), values in ANSWERS.items()])
    prefix_answers = {"W1": {"general_0_1": "a", "attention_1_1": "x", "general_0_comment": "Same text."},
                      "W2": {"general_0_1": "a", "attention_1_1": "y", "general_0_comment": "Same text."},
                      "W3": {"general_0_1": "b", "attention_1_1": "x", "general_0_comment": "Same text."}}
    _write_batch(root, _batch(PREFIX_BATCH, ["passage"], attentionRule={"namePrefix": "attention_", "expectedValue": "x", "minCorrectRatio": 1},
                              freeTextSuffixes=["_comment"], reference={"source": "majority"}),
                 [_hit(PREFIX_BATCH, 0, {"passage": "p"})],
                 [_assignment(PREFIX_BATCH, worker, 0, values) for worker, values in prefix_answers.items()])
    with make_client(data_dir=root) as client:
        yield client


def _assignments(client: TestClient, batch_id: str) -> dict[tuple[str, int], dict]:
    items = client.get(f"/api/batches/{batch_id}/assignments", params=list_query(page_size=100)).json()["items"]
    return {(a["WorkerId"], a["rowIndex"]): a for a in items}


def test_seed_judges_attention_from_the_hit_input(seeded: TestClient) -> None:
    by_key = _assignments(seeded, COLUMN_BATCH)
    judged = {key: a["attention"] for key, a in by_key.items()}
    assert judged == {
        ("W1", 0): {"total": 1, "correct": 1, "passed": True}, ("W2", 0): {"total": 1, "correct": 1, "passed": True},
        ("W3", 0): {"total": 1, "correct": 1, "passed": True}, ("W1", 1): {"total": 2, "correct": 2, "passed": True},
        ("W2", 1): {"total": 2, "correct": 1, "passed": False}, ("W3", 1): {"total": 2, "correct": 1, "passed": False},
    }
    failed = seeded.get(f"/api/batches/{COLUMN_BATCH}/assignments", params=list_query(filters={"attention": "fail"})).json()
    assert sorted(a["WorkerId"] for a in failed["items"]) == ["W2", "W3"]


def test_list_assignments_flags_reference_and_agreement(seeded: TestClient) -> None:
    """attentionNames 와 freeTextNames 는 HIT 마다 다르다. 자유 서술 답에는 대조 기준이 없고, attention 답의 기준은 셀의 기대 값이다."""
    by_key = _assignments(seeded, COLUMN_BATCH)
    w1 = by_key[("W1", 0)]
    assert w1["attentionNames"] == ["general_1_1_support"] and w1["freeTextNames"] == ["general_2_missing_info"]
    assert w1["reference"] == {"general_0_1_support": "supported", "general_0_2_support": "not_supported", "general_2_covered": "No",
                               "general_1_1_support": "not_supported"}
    assert w1["agreement"] == 1
    assert by_key[("W3", 0)]["freeTextNames"] == [] and by_key[("W3", 0)]["agreement"] == pytest.approx(1 / 3)
    w2 = by_key[("W2", 1)]
    assert w2["attentionNames"] == ["general_0_1_support", "general_0_2_support"] and w2["freeTextNames"] == []
    assert w2["reference"] == {"general_1_1_support": "supported", "general_0_1_support": "supported", "general_0_2_support": "not_supported"}
    assert w2["agreement"] == 1   # attention 답(general_0_2_support 오답)은 일치율에 들어가지 않는다
    assert by_key[("W1", 1)]["answers"] == answers(ANSWERS[("W1", 1)])   # 답은 그대로 보인다

    prefix = _assignments(seeded, PREFIX_BATCH)
    w3 = prefix[("W3", 0)]
    assert w3["attentionNames"] == ["attention_1_1"] and w3["freeTextNames"] == ["general_0_comment"]
    assert w3["reference"] == {"general_0_1": "a", "attention_1_1": "x"}   # majority 기준에도 자유 서술은 없다 (모두 같은 글이어도)
    assert w3["agreement"] == 0
    assert prefix[("W1", 0)]["reference"] == {"attention_1_1": "x"} and prefix[("W1", 0)]["agreement"] is None   # general_0_1 은 동률


def test_results_kappa_and_labels_json_use_labels_only(seeded: TestClient) -> None:
    results = seeded.get(f"/api/batches/{COLUMN_BATCH}/results").json()
    assert [item["key"] for item in results["items"]] == [
        "0:general_0_1_support", "0:general_0_2_support", "0:general_2_covered", "1:general_1_1_support"]
    assert results["labelDistribution"] == {"supported": 5, "not_supported": 4, "No": 2, "Yes": 1}
    votes = [item["votes"] for item in results["items"]]
    assert results["kappaItemCount"] == 4 and results["fleissKappa"] == fleiss_kappa(votes)
    labels = json.loads(seeded.get(f"/api/batches/{COLUMN_BATCH}/export", params={"format": "labels-json"}).json()["content"])
    assert list(labels) == [item["key"] for item in results["items"]]

    prefix = seeded.get(f"/api/batches/{PREFIX_BATCH}/results").json()
    assert [item["answerName"] for item in prefix["items"]] == ["general_0_1"] and prefix["labelDistribution"] == {"a": 2, "b": 1}


def test_mturk_csv_keeps_attention_and_free_text_answers(seeded: TestClient) -> None:
    content = seeded.get(f"/api/batches/{COLUMN_BATCH}/export", params={"format": "mturk-csv"}).json()["content"]
    assert "general_2_missing_info" in content and "The year is missing." in content and "general_1_1_support" in content
    assert "Input.attention_expected" in content.split("\r\n")[0]


def test_worker_majority_agreement_skips_attention_and_free_text(seeded: TestClient) -> None:
    """W1 의 라벨은 다른 두 worker 의 표가 모두 동률이라 비교할 문항이 없다. attention(모두 not_supported, 모두 x)이나
    자유 서술(모두 "Same text.")을 셌다면 값이 생긴다. W3 은 비교된 라벨 4개가 모두 다수와 다르다."""
    workers = {w["WorkerId"]: w["stats"] for w in seeded.get("/api/workers", params=list_query(page_size=100)).json()["items"]}
    assert workers["W1"]["majorityAgreement"] is None
    assert workers["W2"]["majorityAgreement"] == 0 and workers["W3"]["majorityAgreement"] == 0
    assert workers["W1"]["attentionFailRate"] == 0
    assert workers["W2"]["attentionFailRate"] == pytest.approx(2 / 3) and workers["W3"]["attentionFailRate"] == pytest.approx(1 / 3)
