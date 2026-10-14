"""worker 가 HIT 를 받아 푸는 규칙: assignment 상태, 받을 수 있는 batch, worker 에게 보낼 입력 컬럼.

assignment 상태
    Accepted   worker 가 받아 푸는 중. 받은 시각 + AssignmentDurationInSeconds(Deadline)까지 제출해야 한다
    Submitted  제출했다 (검수 대기)
    Approved, Rejected   Requester 가 검수했다
    Returned   worker 가 반납했다. Abandoned  제한 시간이 지났다. 둘 다 자리를 다시 열고, 같은 worker 가 다시 받을 수 있다
Requester 화면(검수, 결과, worker 지표, 내보내기)에는 REVIEWABLE_STATUSES 만 보인다. Accepted 는 진행률에서 "in progress" 로 센다.

worker 에게 보낼 입력 컬럼(worker_columns): 템플릿에 ${컬럼} placeholder 가 있으면 그 컬럼만 보낸다. 없으면(window.TASK_DATA 로
행 전체를 읽는 템플릿) 정답이 든 컬럼을 뺀 나머지를 보낸다. 정답이 든 컬럼은 attention 규칙의 기대 답 컬럼과 대조 기준 컬럼이다.
Requester 미리보기는 행 전체를 쓰지만, worker 의 작업 화면은 이 컬럼만 받는다.
"""

from __future__ import annotations

from app.domain.attention import attention_column_of
from app.domain.template import extract_placeholders

REVIEWABLE_STATUSES = ("Submitted", "Approved", "Rejected")
ACCEPTED = "Accepted"
RELEASED_STATUSES = ("Returned", "Abandoned")
ALL_STATUSES = (ACCEPTED, *REVIEWABLE_STATUSES, *RELEASED_STATUSES)

MAX_ANSWERS = 2000
MAX_ANSWER_CHARS = 20_000


def hidden_columns(batch: dict) -> list[str]:
    """정답이 든 입력 컬럼: attention 규칙의 기대 답 컬럼, 대조 기준 컬럼(reference.source == 'column')."""
    hidden = []
    column = attention_column_of(batch.get("attentionRule"))
    if column:
        hidden.append(column)
    reference = batch.get("reference") or {}
    if reference.get("source") == "column" and isinstance(reference.get("column"), str) and reference["column"]:
        hidden.append(reference["column"])
    return hidden


def worker_columns(batch: dict) -> list[str]:
    """worker 의 작업 화면에 보낼 입력 컬럼 (inputColumns 순서)."""
    columns = [c for c in batch.get("inputColumns", []) if isinstance(c, str)]
    placeholders = set(extract_placeholders(batch.get("templateHtml") or ""))
    if placeholders:
        return [c for c in columns if c in placeholders]
    hidden = set(hidden_columns(batch))
    return [c for c in columns if c not in hidden]


def visible_row(batch: dict, hit_input: dict | None) -> dict:
    """HIT 입력에서 worker 에게 보낼 칸만."""
    source = hit_input or {}
    return {column: source.get(column, "") for column in worker_columns(batch)}


def ineligible_reason(batch: dict, worker_id: str, pools: dict[str, dict], blocked: bool) -> str | None:
    """이 worker 가 batch 의 HIT 를 받을 수 없는 이유, 받을 수 있으면 None.
    blocked 는 batch 를 만든 Requester 가 이 worker 를 차단했는지다 (Requester 별 차단)."""
    if blocked:
        return "The requester of this batch does not accept your work."
    for pool_id in batch.get("requiredPoolIds") or []:
        if worker_id not in (pools.get(pool_id) or {}).get("workerIds", []):
            return "This batch is only for workers in a qualified group."
    for pool_id in batch.get("excludedPoolIds") or []:
        if worker_id in (pools.get(pool_id) or {}).get("workerIds", []):
            return "This batch is not open to you."
    return None


def check_answers(value: object) -> list[dict]:
    """제출된 답: [{name, value}] (문자열). 이름이 빈 답이나 같은 이름의 답은 그대로 둔다 (체크박스는 같은 이름이 여럿일 수 있다)."""
    if not isinstance(value, list) or not value:
        raise ValueError("No answers were submitted.")
    if len(value) > MAX_ANSWERS:
        raise ValueError(f"Too many answers (at most {MAX_ANSWERS}).")
    answers = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
            raise ValueError('Each answer must be an object with a "name" and a "value".')
        text = item.get("value")
        text = "" if text is None else str(text)
        if len(text) > MAX_ANSWER_CHARS:
            raise ValueError(f"The answer {item['name']} is longer than {MAX_ANSWER_CHARS} characters.")
        answers.append({"name": item["name"], "value": text})
    return answers
