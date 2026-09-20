#!/usr/bin/env python3
"""example/ 폴더의 CSV 가운데 손으로 만들기 어려운 것을 만든다 (인코딩, 크기, data/에서 뽑는 것).

    python3 scripts/build_examples.py

표준 라이브러리만 쓴다. 손으로 쓴 파일(1-task-data, 2-placeholder)은 건드리지 않는다.

  example/3-data-checks/     Create의 Data 단계가 하는 검사를 하나씩 보여주는 CSV. 1-task-data의 템플릿과 함께 쓴다
  example/4-saved-templates/ 콘솔에 저장돼 있는 기존 템플릿 두 개에 넣을 입력 CSV. data/의 HIT 입력에서 뽑는다
"""

from __future__ import annotations

import csv
import io
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "example"
BASE_CSV = EXAMPLE / "1-task-data" / "data.csv"

LOREM = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore "
    "magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat"
).split()


def to_csv(columns: list[str], rows: list[dict[str, str]], newline: str = "\n") -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, lineterminator=newline)
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def filler(target_bytes: int, seed: int) -> str:
    rng = random.Random(seed)
    words: list[str] = []
    size = 0
    while size < target_bytes:
        word = rng.choice(LOREM)
        words.append(word)
        size += len(word) + 1
    return " ".join(words).capitalize() + "."


def build_data_checks() -> None:
    out = EXAMPLE / "3-data-checks"
    out.mkdir(parents=True, exist_ok=True)
    with BASE_CSV.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        columns = list(reader.fieldnames or [])
        base = list(reader)

    # 경고: 빈 셀이 있는 행 (3행과 5행)
    rows = [dict(r) for r in base[:6]]
    rows[2]["sentence_2"] = ""
    rows[4]["sentence_1"] = ""
    (out / "empty-cells.csv").write_text(to_csv(columns, rows), encoding="utf-8")

    # 정상: Excel의 "CSV UTF-8"로 저장한 파일. 맨 앞에 BOM이 붙고 줄 끝이 CRLF다
    (out / "excel-utf8-bom.csv").write_bytes(b"\xef\xbb\xbf" + to_csv(columns, base, "\r\n").encode("utf-8"))

    # 오류: 한국어 Excel에서 그냥 "CSV"로 저장한 파일 (CP949). UTF-8이 아니라서 거절된다
    korean = [
        {
            "item_id": "k01",
            "passage": "꿀벌은 8자 춤으로 먹이가 있는 곳을 알린다. 춤의 각도는 해를 기준으로 한 방향을, 춤의 길이는 거리를 나타낸다.",
            "sentence_1": "꿀벌은 춤으로 먹이의 위치를 알린다.",
            "sentence_2": "8자 춤은 꽃의 색깔을 알려 준다.",
            "attention_sentence": "주의력 확인 문항입니다. 이 문장은 \"Not grounded\"를 고르세요.",
        },
        {
            "item_id": "k02",
            "passage": "밀물과 썰물은 주로 달의 인력 때문에 생기고, 해의 영향도 조금 있다. 대부분의 해안에서 하루에 두 번씩 일어난다.",
            "sentence_1": "해는 조수에 아무 영향을 주지 않는다.",
            "sentence_2": "대부분의 해안에서 밀물은 하루에 두 번 온다.",
            "attention_sentence": "주의력 확인 문항입니다. 이 문장은 \"Not grounded\"를 고르세요.",
        },
    ]
    (out / "excel-cp949.csv").write_bytes(to_csv(columns, korean, "\r\n").encode("cp949"))

    # 경고: 입력이 64KB를 넘는 행 (2행). MTurk API의 Question 크기 제한과 관련된다
    rows = [dict(r) for r in base[:3]]
    rows[1]["passage"] = filler(70 * 1024, seed=64)
    (out / "large-rows.csv").write_text(to_csv(columns, rows), encoding="utf-8")


def build_saved_template_inputs() -> None:
    """data/의 HIT 입력(익명화된 합성 텍스트)을 CSV로 되돌린다. 셀은 Python 리터럴 문자열 그대로다."""
    out = EXAMPLE / "4-saved-templates"
    out.mkdir(parents=True, exist_ok=True)
    for batch_id, name, count in (
        ("batch-1000001", "chunk-fact-relevance-input.csv", 10),
        ("batch-1000003", "query-fact-coverage-input.csv", 8),
    ):
        batch_dir = ROOT / "data" / "batches" / batch_id
        columns = json.loads((batch_dir / "batch.json").read_text(encoding="utf-8"))["inputColumns"]
        hits = json.loads((batch_dir / "hits.json").read_text(encoding="utf-8"))
        rows = [h["input"] for h in sorted(hits, key=lambda h: h["rowIndex"])[:count]]
        (out / name).write_text(to_csv(columns, rows), encoding="utf-8")


def main() -> None:
    build_data_checks()
    build_saved_template_inputs()
    for path in sorted(EXAMPLE.rglob("*.csv")):
        print(f"{path.stat().st_size / 1024:8.1f} KB  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
