#!/usr/bin/env python3
"""MTurk 결과 CSV를 익명화해서 mock 시작 데이터(data/ 폴더)로 변환한다.

    python3 scripts/build_fixtures.py --source <원본 폴더> [--config scripts/fixture_sources.json] [--out data]

표준 라이브러리만 쓴다. 어떤 CSV와 템플릿을 읽을지는 설정 파일에 적는다. 설정 파일에는 내부 경로가 들어가므로
저장소에 넣지 않는다 (.gitignore). 형식은 scripts/fixture_sources.example.json에 있다.

출력 (구조는 data/README.md):

    data/templates/index.json, data/templates/<이름>.html
    data/batches/<batchId>/batch.json, template.html, hits.json, assignments.json

pools.json, workers.json, account.json은 사람이 관리하는 파일이라 없을 때만 기본값으로 만든다.

익명화: 이 저장소는 공개되므로 data/에는 원본의 식별자와 본문이 하나도 남지 않아야 한다.
  - WorkerId, HITId, AssignmentId는 salt를 넣은 HMAC으로 바꾼다. batch id와 이름은 설정 파일에 적은 값을 쓴다.
  - 입력 셀의 본문(질문, 문단, fact, reasoning)은 같은 길이의 합성 텍스트로 바꾼다. 셀은 Python 리터럴이므로
    구조(리스트의 모양과 길이, 'Chunk 0' 같은 구조용 라벨, 숫자)는 그대로 두고 본문 문자열만 바꾼다.
    그래서 템플릿은 그대로 렌더되고, 입력 크기의 분포도 원본과 같다. 같은 원문은 같은 합성 텍스트가 된다.
  - idx와 qid(모델 이름과 데이터셋 항목 ID가 들어 있다)는 순번으로 바꾼다.
  - 시각은 salt에서 정한 만큼 통째로 옮긴다. 간격(작업시간, 검수까지 걸린 시간)은 그대로다.
  - HIT의 Title, Description, Keywords는 일반적인 문구로 바꾼다.
  - 템플릿의 `var x = ${x}; // e.g: ...` 주석에는 데이터셋 예문이 있어 주석을 지운다.
  응답 값, 검수 상태, 작업시간, 반려 사유는 그대로 둔다. 화면의 분포와 Fleiss kappa가 원본과 같다.

salt는 환경변수 FIXTURE_SALT, 없으면 scripts/.fixture_salt에서 읽고, 파일이 없으면 새로 만든다.
salt가 공개되면 알려진 ID나 원문을 대조해 볼 수 있으므로 저장소에 넣지 않는다. salt가 바뀌면 모든 ID가 바뀐다.

Assignment.attention은 여기서 계산하지 않는다. 판정 로직을 src/domain/attention.ts 한 곳에만 두기 위해
앱이 data/를 올릴 때 batch의 attentionRule로 계산한다.
"""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

csv.field_size_limit(sys.maxsize)

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
SALT_FILE = SCRIPTS / ".fixture_salt"
DEFAULT_CONFIG = SCRIPTS / "fixture_sources.json"

INITIAL_MAX_ASSIGNMENTS = 3
ISO = "%Y-%m-%dT%H:%M:%SZ"

# MTurk Requester 웹사이트의 결과 CSV는 입력 컬럼명을 38자로 자른다. 원래 이름으로 되돌린다.
TRUNCATED_COLUMNS = {
    "query_fact_relevance_check_reaso": "query_fact_relevance_check_reasoning",
    "chunk_fact_relevance_check_reaso": "chunk_fact_relevance_check_reasoning",
    "query_fact_coverage_check_reason": "query_fact_coverage_check_reasoning",
    "query_chunk_coverage_check_reaso": "query_chunk_coverage_check_reasoning",
}

# 공개용 HIT 문구. 실제 HIT의 제목은 MTurk에서 requester를 찾는 단서가 된다.
PUBLIC_HIT_TEXT = {
    "Title": "Sentence and passage relevance quiz",
    "Description": "Read a sentence and a passage, then assess their relevance.",
    "Keywords": "English, Reading, Sentence, Passage, Quiz",
}

PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
TEMPLATE_EXAMPLE_COMMENT_RE = re.compile(r"^(\s*var \w+ = \$\{\w+\};)\s*//.*$", re.MULTILINE)
TZ_OFFSETS = {"PDT": -7, "PST": -8, "UTC": 0, "GMT": 0}

# 구조용 라벨. 본문이 아니라 위치를 가리키는 값이라 그대로 둔다 (템플릿이 이 값으로 표시할 항목을 찾는다).
LABEL_RE = re.compile(
    r"^(attention|selected_facts|Covered|Not covered|Atomic fact ?\d+|Chunk ?\d+|chunk_\d+"
    r"|Core subquery ?\d+|general_\d+(_\d+)*|\d+)$"
)
# 순번으로 바꿀 컬럼. 값이 곧 식별자다.
ID_COLUMNS = {"idx": "", "qid": "q"}

LOREM = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore "
    "magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo "
    "consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint "
    "occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum"
).split()


class Anonymizer:
    def __init__(self, salt: str):
        self.salt = salt.encode("utf-8")
        self.sequences: dict[str, dict[str, str]] = {}
        digest = self._digest("time-shift")
        # 100~299일, 그리고 하루 안의 임의의 초만큼 과거로 옮긴다
        self.time_shift = timedelta(days=100 + digest[0] % 200, seconds=int.from_bytes(digest[1:4], "big") % 86400)

    def _digest(self, *parts: str) -> bytes:
        return hmac.new(self.salt, "\x1f".join(parts).encode("utf-8"), hashlib.sha256).digest()

    def worker_id(self, original: str) -> str:
        # M0부터 써 온 방식. 이미 나간 WorkerId가 바뀌지 않게 그대로 둔다.
        return "W" + hashlib.sha256(f"{self.salt.decode()}:{original}".encode("utf-8")).hexdigest()[:12]

    def mturk_id(self, kind: str, original: str) -> str:
        """HITId, AssignmentId처럼 보이는 30자. 원본과는 관계가 없다."""
        chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        digest = self._digest(kind, original)
        return "3" + "".join(chars[b % len(chars)] for b in digest[:29])

    def sequence(self, kind: str, original: str, prefix: str, width: int) -> str:
        table = self.sequences.setdefault(kind, {})
        if original not in table:
            table[original] = f"{prefix}{len(table) + 1:0{width}d}"
        return table[original]

    def time(self, mturk_time: str) -> str | None:
        """'Thu Oct 09 00:30:20 PDT 2025' 형식을 UTC ISO 8601로 바꾸고 time_shift만큼 옮긴다. 빈 값은 None."""
        text = mturk_time.strip()
        if not text:
            return None
        parts = text.split()
        if len(parts) != 6 or parts[4] not in TZ_OFFSETS:
            raise ValueError(f"알 수 없는 시각 형식: {mturk_time!r}")
        naive = datetime.strptime(" ".join(parts[:4] + parts[5:]), "%a %b %d %H:%M:%S %Y")
        utc = naive - timedelta(hours=TZ_OFFSETS[parts[4]])
        return (utc - self.time_shift).replace(tzinfo=timezone.utc).strftime(ISO)

    def text(self, original: str) -> str:
        """본문을 같은 길이의 합성 텍스트로 바꾼다. 같은 원문은 항상 같은 결과가 된다."""
        if not original.strip():
            return original
        stripped = original.rstrip()
        if stripped.endswith("?"):
            head, end = "Synthetic question: ", "?"
        elif len(original) > 400:
            head, end = "Synthetic passage: ", "."
        else:
            head, end = "Synthetic statement: ", "."
        rng = random.Random(self._digest("text", original))
        words: list[str] = []
        length = len(head)
        target = max(len(original) - len(end), len(head) + 5)
        sentence_left = rng.randint(6, 14)
        capitalize = True
        while length < target:
            word = rng.choice(LOREM)
            if capitalize:
                word, capitalize = word.capitalize(), False
            sentence_left -= 1
            if sentence_left == 0 and length + len(word) + 2 < target:
                word, capitalize, sentence_left = word + ".", True, rng.randint(6, 14)
            words.append(word)
            length += len(word) + 1
        return (head + " ".join(words)).rstrip(" .") + end

    def cell(self, column: str, cell: str) -> str:
        """입력 셀 하나. Python 리터럴로 읽어 구조는 두고 문자열만 바꾼 뒤 다시 리터럴로 쓴다."""
        try:
            value = ast.literal_eval(cell)
        except (ValueError, SyntaxError) as error:
            raise ValueError(f"{column}: Python 리터럴이 아닌 셀은 익명화할 수 없다 ({error})") from error
        return repr(self._walk(column, value))

    def _walk(self, column: str, value):
        if isinstance(value, str):
            return self._string(column, value)
        if isinstance(value, dict):
            return {self._walk(column, k): self._walk(column, v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._walk(column, v) for v in value]
        return value  # 숫자, bool, None

    def _string(self, column: str, value: str) -> str:
        if column in ID_COLUMNS:
            # 'attention'과 '<모델>_attention'은 attention 탭의 자리 표시다
            if value == "attention" or value.endswith("_attention"):
                return "attention"
            return self.sequence(column, value, ID_COLUMNS[column], 1 if column == "idx" else 4)
        if LABEL_RE.match(value):
            return value
        return self.text(value)


def load_salt() -> str:
    salt = os.environ.get("FIXTURE_SALT")
    if salt:
        return salt
    if SALT_FILE.exists():
        return SALT_FILE.read_text(encoding="utf-8").strip()
    salt = secrets.token_hex(16)
    SALT_FILE.write_text(salt + "\n", encoding="utf-8")
    print(f"새 salt를 만들었습니다: {SALT_FILE} (저장소에 넣지 마세요)")
    return salt


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    """헤더 이름 기준으로 읽는다. 행이 헤더보다 짧으면(44열 vs 46열) 없는 컬럼은 빈 문자열이다."""
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = [
            {name: (raw[i] if i < len(raw) else "") for i, name in enumerate(header)}
            for raw in reader
            if raw
        ]
    return header, rows


def parse_answers(task_answers: str) -> list[dict[str, str]]:
    outer = json.loads(task_answers)
    inner = json.loads(outer[0]["input_answers"])
    return [{"name": str(a["name"]), "value": str(a["value"])} for a in inner]


def build_templates(config: dict, source: Path) -> list[dict]:
    templates = []
    for spec in config["templates"]:
        # 원본 파일은 확장자만 .py이고 내용은 HTML이다
        html = (source / spec["source"]).read_text(encoding="utf-8")
        html = TEMPLATE_EXAMPLE_COMMENT_RE.sub(r"\1", html)
        templates.append(
            {
                "id": spec["id"],
                "name": spec["name"],
                "file": spec["out"],
                "html": html,
                "placeholders": list(OrderedDict.fromkeys(PLACEHOLDER_RE.findall(html))),
                "updatedAt": spec["updatedAt"],
            }
        )
    return templates


def build_batch(spec: dict, source: Path, anonymizer: Anonymizer):
    header, rows = read_rows(source / spec["csv"])
    source_columns = [h for h in header if h.startswith("Input.")]
    input_columns = [TRUNCATED_COLUMNS.get(h[len("Input."):], h[len("Input."):]) for h in source_columns]
    blank_columns = set(spec.get("blankColumns", []))

    by_hit: OrderedDict[str, list[dict[str, str]]] = OrderedDict()
    for row in rows:
        by_hit.setdefault(row["HITId"], []).append(row)

    hits, assignments = [], []
    for row_index, (original_hit_id, hit_rows) in enumerate(by_hit.items()):
        head = hit_rows[0]
        hit_id = anonymizer.mturk_id("hit", original_hit_id)
        # 템플릿이 화면에 쓰지 않는 무거운 컬럼은 "[]"로 비운다. 컬럼을 지우면 ${...} 치환이 실패하므로 지우지 않는다.
        hit_input = {
            name: "[]" if name in blank_columns else anonymizer.cell(name, head[src])
            for src, name in zip(source_columns, input_columns)
        }
        statuses = Counter(r["AssignmentStatus"] for r in hit_rows)
        max_assignments = max(int(r["MaxAssignments"]) for r in hit_rows)
        hits.append(
            {
                "HITId": hit_id,
                # 게시 기간이 지난 batch다. 만료된 HIT는 MTurk에서 Reviewable이다.
                "HITStatus": "Reviewable",
                "MaxAssignments": max_assignments,
                "NumberOfAssignmentsPending": 0,
                "NumberOfAssignmentsAvailable": max_assignments - len(hit_rows),
                "NumberOfAssignmentsCompleted": statuses["Approved"] + statuses["Rejected"],
                "CreationTime": anonymizer.time(head["CreationTime"]),
                "Expiration": anonymizer.time(head["Expiration"]),
                "batchId": spec["id"],
                "rowIndex": row_index,  # 결과 CSV에서 HIT가 처음 나온 순서
                "input": hit_input,
                "initialMaxAssignments": INITIAL_MAX_ASSIGNMENTS,
            }
        )

        for r in hit_rows:
            assignment = {
                "AssignmentId": anonymizer.mturk_id("assignment", r["AssignmentId"]),
                "HITId": hit_id,
                "WorkerId": anonymizer.worker_id(r["WorkerId"]),
                "AssignmentStatus": r["AssignmentStatus"],
                "AcceptTime": anonymizer.time(r["AcceptTime"]),
                "SubmitTime": anonymizer.time(r["SubmitTime"]),
                "AutoApprovalTime": anonymizer.time(r["AutoApprovalTime"]),
            }
            for field in ("ApprovalTime", "RejectionTime"):
                iso = anonymizer.time(r[field])
                if iso:
                    assignment[field] = iso
            if r["RequesterFeedback"].strip():
                assignment["RequesterFeedback"] = r["RequesterFeedback"].strip()
            assignment["answers"] = parse_answers(r["Answer.taskAnswers"])
            assignment["workTimeInSeconds"] = int(r["WorkTimeInSeconds"])
            assignments.append(assignment)

    first = rows[0]
    created = min(h["CreationTime"] for h in hits)
    expiration = min(h["Expiration"] for h in hits)
    lifetime = int((datetime.strptime(expiration, ISO) - datetime.strptime(created, ISO)).total_seconds())
    batch = {
        "id": spec["id"],
        "name": spec["name"],
        "env": "mock",
        "templateId": spec["templateId"],
        "inputColumns": input_columns,
        "settings": {
            **PUBLIC_HIT_TEXT,
            "Reward": first["Reward"].lstrip("$"),
            "MaxAssignments": INITIAL_MAX_ASSIGNMENTS,
            "AssignmentDurationInSeconds": int(first["AssignmentDurationInSeconds"]),
            "LifetimeInSeconds": lifetime,  # 결과 CSV에는 비어 있어 Expiration - CreationTime으로 구한다
            "AutoApprovalDelayInSeconds": int(first["AutoApprovalDelayInSeconds"]),
            "QualificationRequirements": [],  # 결과 CSV에는 없는 정보
        },
        "attentionRule": {
            "namePrefix": "attention_",
            "expectedValue": spec["attentionExpected"],
            "minCorrectRatio": 1.0,
        },
        "requiredPoolIds": [],
        "excludedPoolIds": [],
        "createdAt": created,
    }
    return batch, hits, assignments


def write_pretty(path: Path, data) -> int:
    """작은 파일은 사람이 읽고 고치기 쉽게 들여쓴다."""
    text = json.dumps(data, ensure_ascii=False, indent=2)
    path.write_text(text + "\n", encoding="utf-8")
    return len(text.encode("utf-8"))


def write_records(path: Path, records: list) -> int:
    """큰 목록은 레코드 하나를 한 줄에 쓴다. 파일이 지나치게 길어지지 않고, grep과 diff가 레코드 단위로 된다."""
    lines = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in records)
    text = "[\n" + lines + "\n]"
    path.write_text(text + "\n", encoding="utf-8")
    return len(text.encode("utf-8"))


# 사람이 관리하는 파일. 이미 있으면 건드리지 않는다.
HAND_MANAGED_DEFAULTS = {
    "account.json": {"env": "mock", "AvailableBalance": "500.00"},
    "pools.json": [
        {
            "id": "pool-trusted",
            "name": "Trusted",
            "description": "Workers with a consistent record. Use as a required pool.",
            "workerIds": [],
        },
        {
            "id": "pool-excluded",
            "name": "Excluded",
            "description": "Workers to keep out of future batches. Preferred over blocking.",
            "workerIds": [],
        },
    ],
    "workers.json": {},
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, required=True, help="원본 폴더. 설정 파일의 경로는 이 폴더 기준이다")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out", type=Path, default=ROOT / "data")
    args = parser.parse_args()

    if not args.config.exists():
        sys.exit(f"설정 파일이 없습니다: {args.config}\nscripts/fixture_sources.example.json을 복사해서 만드세요.")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    anonymizer = Anonymizer(load_salt())

    templates = build_templates(config, args.source)
    template_by_id = {t["id"]: t for t in templates}

    template_dir = args.out / "templates"
    template_dir.mkdir(parents=True, exist_ok=True)
    for t in templates:
        (template_dir / t["file"]).write_text(t["html"], encoding="utf-8")
    write_pretty(
        template_dir / "index.json",
        [{"id": t["id"], "name": t["name"], "file": t["file"], "updatedAt": t["updatedAt"]} for t in templates],
    )

    workers = set()
    for spec in config["batches"]:
        batch, hits, assignments = build_batch(spec, args.source, anonymizer)
        batch_dir = args.out / "batches" / batch["id"]
        batch_dir.mkdir(parents=True, exist_ok=True)
        write_pretty(batch_dir / "batch.json", batch)
        # 게시 시점의 템플릿 사본. 이후 templates/의 템플릿을 고쳐도 이 batch는 바뀌지 않는다.
        (batch_dir / "template.html").write_text(template_by_id[spec["templateId"]]["html"], encoding="utf-8")
        hits_size = write_records(batch_dir / "hits.json", hits)
        assignments_size = write_records(batch_dir / "assignments.json", assignments)
        workers |= {a["WorkerId"] for a in assignments}

        statuses = Counter(a["AssignmentStatus"] for a in assignments)
        print(
            f"{batch['id']}: {len(hits)} HIT, {len(assignments)} assignment {dict(statuses)}, "
            f"MaxAssignments {sorted({h['MaxAssignments'] for h in hits})}, ${batch['settings']['Reward']} "
            f"(hits {hits_size / 1024:,.0f} KB, assignments {assignments_size / 1024:,.0f} KB)"
        )

    for name, default in HAND_MANAGED_DEFAULTS.items():
        if not (args.out / name).exists():
            write_pretty(args.out / name, default)
            print(f"  기본값으로 만듦: {name}")

    print(f"worker {len(workers)}명, 템플릿 {len(templates)}개 → {args.out}")


if __name__ == "__main__":
    main()
