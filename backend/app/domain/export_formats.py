"""Export 형식: MTurk 결과 CSV 호환 형식과 라벨 JSON. prototype/src/domain/exportFormats.ts 를 그대로 옮겼다.

    to_csv(["a", "b"], [["1", "x,y"]]) == 'a,b\\r\\n1,"x,y"\\r\\n'      (RFC 4180. 쉼표, 따옴표, 줄바꿈이 있는 셀만 감싼다)
    to_mturk_time("2025-10-09T07:30:20Z") == "Thu Oct 09 07:30:20 UTC 2025"
    build_mturk_csv(batch, hits, assignments)   MTurk Requester 웹사이트의 결과 CSV 와 같은 컬럼. Answer.taskAnswers 는
                                                `[{"input_answers": "<JSON 문자열>"}]`
    build_labels_json(items)                    { "<rowIndex>:<answerName>": { votes, majority, workers } } (들여쓰기 2)
"""

from __future__ import annotations

import json
import re
from datetime import timezone

from app.domain.agreement import VotedItem
from app.domain.js import js_string
from app.domain.progress import parse_time

_NEEDS_QUOTES_RE = re.compile(r'[",\r\n]')
WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

MTURK_CSV_COLUMNS = [
    "HITId", "HITTypeId", "Title", "Description", "Keywords", "Reward", "CreationTime", "MaxAssignments",
    "RequesterAnnotation", "AssignmentDurationInSeconds", "AutoApprovalDelayInSeconds", "Expiration",
    "NumberOfSimilarHITs", "LifetimeInSeconds", "AssignmentId", "WorkerId", "AssignmentStatus", "AcceptTime",
    "SubmitTime", "AutoApprovalTime", "ApprovalTime", "RejectionTime", "RequesterFeedback", "WorkTimeInSeconds",
    "LifetimeApprovalRate", "Last30DaysApprovalRate", "Last7DaysApprovalRate",
]


def to_csv(header: list[str], rows: list[list[str]]) -> str:
    def cell(value: str) -> str:
        return f'"{value.replace(chr(34), chr(34) * 2)}"' if _NEEDS_QUOTES_RE.search(value) else value

    return "\r\n".join(",".join(cell(v) for v in row) for row in [header, *rows]) + "\r\n"


def to_mturk_time(iso: str | None) -> str:
    """MTurk 결과 CSV 의 시각 표기 (UTC): "Thu Oct 09 07:30:20 UTC 2025". 없으면 빈 칸."""
    if not iso:
        return ""
    value = parse_time(iso)
    if value is None:
        return "undefined undefined NaN NaN:NaN:NaN UTC NaN"   # JS 의 Invalid Date 가 내는 글자 그대로
    value = value.astimezone(timezone.utc)
    weekday = WEEKDAYS[(value.weekday() + 1) % 7]
    return f"{weekday} {MONTHS[value.month - 1]} {value.day:02d} {value.hour:02d}:{value.minute:02d}:{value.second:02d} UTC {value.year}"


def _js_json(value: object) -> str:
    """JSON.stringify(value) (공백 없음, 비 ASCII 는 그대로)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _text(value: object) -> str:
    """CSV 셀 (String(value), undefined 는 빈 칸)."""
    return "" if value is None else js_string(value)


def build_mturk_csv(batch: dict, hits: list[dict], assignments: list[dict]) -> str:
    """MTurk Requester 웹사이트의 결과 CSV 와 같은 컬럼. 입력 컬럼명을 38자로 자르는 MTurk 의 동작은 흉내 내지 않는다."""
    hit_by_id = {hit["HITId"]: hit for hit in hits}
    settings = batch["settings"]
    input_columns = list(batch.get("inputColumns", []))
    header = [*MTURK_CSV_COLUMNS, *(f"Input.{c}" for c in input_columns), "Answer.taskAnswers", "Approve", "Reject"]
    rows: list[list[str]] = []
    for assignment in assignments:
        hit = hit_by_id.get(assignment["HITId"])
        if hit is None:
            continue
        hit_input = hit.get("input", {})
        rows.append([
            hit["HITId"], "", _text(settings.get("Title")), _text(settings.get("Description")), _text(settings.get("Keywords")),
            f"${_text(settings.get('Reward'))}", to_mturk_time(hit.get("CreationTime")), _text(hit.get("MaxAssignments")),
            f"BatchId:{batch['id']};", _text(settings.get("AssignmentDurationInSeconds")),
            _text(settings.get("AutoApprovalDelayInSeconds")), to_mturk_time(hit.get("Expiration")), "",
            _text(settings.get("LifetimeInSeconds")),
            assignment["AssignmentId"], assignment["WorkerId"], assignment["AssignmentStatus"],
            to_mturk_time(assignment.get("AcceptTime")), to_mturk_time(assignment.get("SubmitTime")),
            to_mturk_time(assignment.get("AutoApprovalTime")), to_mturk_time(assignment.get("ApprovalTime")),
            to_mturk_time(assignment.get("RejectionTime")), _text(assignment.get("RequesterFeedback")),
            _text(assignment.get("workTimeInSeconds")), "", "", "",
            *(_text(hit_input.get(c, "")) for c in input_columns),
            _js_json([{"input_answers": _js_json(assignment.get("answers", []))}]), "", "",
        ])
    return to_csv(header, rows)


def build_labels_json(items: list[VotedItem]) -> str:
    """`{ "<rowIndex>:<answerName>": { votes, majority, workers } }` (JSON.stringify(labels, null, 2))."""
    labels = {item.key: {"votes": item.votes, "majority": item.majority, "workers": item.workers} for item in items}
    return json.dumps(labels, ensure_ascii=False, indent=2)
