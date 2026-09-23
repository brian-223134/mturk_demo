"""원본에서 레코드 몇 개를 뽑아 익명화한 표본을 만든다 (tests/fixtures/sample.json이 이렇게 만든 파일이다).

테스트가 assets/ 전체나 Docker 마운트에 기대지 않도록 실제 데이터의 작은 일부만 값으로 쓴다. 저장소는 공개이므로
표본에 데이터셋 항목 ID, 모델·retriever 이름, 본문이 남으면 안 된다. 그래서 커밋하기 전에 여기서 익명화한다.

    sample_records(records, n, seed)          random.Random(seed).sample. 원래 순서를 지킨다. n이 len 이상이면 전부
    anonymize_records(records, seed, max_list)
                                              구조는 두고 이름과 본문만 바꾼다 (규칙은 아래)
    cut_lists(value, max_list)                max_list보다 긴 리스트를 앞 max_list개로 자른다 (재귀)
    run_sample(raw_path, out_path, ...)       읽기 → 표본 → 익명화 → JSON 배열 저장. 요약 dict를 돌려준다
    register_sample_command(subparsers)       `sample` 하위 명령을 붙인다 (cli.py가 부른다). cmd_sample이 실행부다

익명화 규칙 (결정적이다: 같은 seed와 같은 입력이면 결과가 같다):
  - dict 키: snake_case(^[a-z_][a-z0-9_]*$)나 구조용 라벨('Chunk 3', 'Atomic fact1', 'general_0_1' …)은 그대로 둔다.
    그 밖의 키(모델·retriever 이름, 본문을 키로 쓴 것)는 처음 나온 순서대로 key_1, key_2 …로 바꾼다. 같은 원래
    키는 어디에 나오든 같은 key_n이 된다. 원래 이름은 결과나 요약 어디에도 적지 않는다.
  - 문자열 값: 구조용 라벨은 그대로. 24자 이하이고 표본 전체에서 5번 이상, 그리고 2개 이상의 레코드에 나오는
    값('Yes', 'No', 'Covered' 같은 라벨)도 그대로. 나머지는 합성 텍스트로 바꾼다: 공백이 없고 32자 이하면
    token_ + hex 6자리(seed를 키로 한 HMAC), 아니면 같은 길이의 lorem ipsum (원문이 ?로 끝나면 ?로 끝난다).
    같은 원문은 항상 같은 결과가 된다.
  - 숫자, bool, null은 그대로. max_list가 있으면 그보다 긴 리스트는 앞 max_list개만 남긴다 (익명화 전에 자른다).

"2개 이상의 레코드" 조건은 라벨과 본문을 가르기 위한 것이다. 한 레코드 안에서만 되풀이되는 짧은 값(여러 모델이 같은
답을 낸 정답 문자열, 같은 레코드에 여러 번 나오는 질문)은 라벨이 아니라 본문이다. 표본이 레코드 하나뿐이면 이
조건은 적용하지 않는다.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from agent import source

SNAKE_KEY_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
LABEL_RE = re.compile(
    r"^(Atomic fact ?\d+|Chunk ?\d+|Core subquery ?\d+|Subquery ?\d+|Passage ?\d+|Fact ?\d+"
    r"|general_\d+(_\d+)*|attention(_\d+)*|selected_facts)$"
)
RENAMED_KEY_RE = re.compile(r"^key_\d+$")
TOKEN_RE = re.compile(r"^token_[0-9a-f]{6}$")

LABEL_MAX_CHARS = 24
LABEL_MIN_COUNT = 5
LABEL_MIN_RECORDS = 2
TOKEN_MAX_CHARS = 32
TOKEN_HEX_CHARS = 6

DEFAULT_N = 6
DEFAULT_SEED = 7

LOREM = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore "
    "magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo "
    "consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint "
    "occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum"
).split()


def sample_records(records: list, n: int, seed: int) -> list:
    """random.Random(seed).sample로 n개를 고르고 원래 순서대로 돌려준다. n이 len 이상이면 전부 (복사본)."""
    if n < 0:
        raise ValueError("n must be 0 or more")
    if n >= len(records):
        return list(records)
    chosen = random.Random(seed).sample(range(len(records)), n)
    return [records[index] for index in sorted(chosen)]


def cut_lists(value: Any, max_list: int) -> Any:
    """max_list보다 긴 리스트를 앞 max_list개로 자른다 (안쪽까지). dict 키와 스칼라는 그대로다."""
    if max_list < 0:
        raise ValueError("max_list must be 0 or more")
    if isinstance(value, dict):
        return {key: cut_lists(item, max_list) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [cut_lists(item, max_list) for item in list(value)[:max_list]]
    return value


def is_kept_key(key: str) -> bool:
    """이름을 그대로 두는 키인지 (snake_case 필드 이름 또는 구조용 라벨)."""
    return bool(SNAKE_KEY_RE.match(key) or LABEL_RE.match(key))


class Anonymizer:
    """레코드 목록 하나를 익명화한다. run()을 부른 뒤 renamed_keys에 바꾼 키의 개수가 남는다 (원래 이름은 남기지 않는다).

    키 번호와 라벨 판정은 목록 전체를 보고 정하므로 목록 하나에 run()을 한 번 부르는 것이 전제다."""

    def __init__(self, seed: int, max_list: int | None = None) -> None:
        self.seed = seed
        self.max_list = max_list
        self._key_map: dict[str, str] = {}
        self._reserved: set[str] = set()
        self._labels: set[str] = set()
        self._next_key = 1

    @property
    def renamed_keys(self) -> int:
        return len(self._key_map)

    def run(self, records: list) -> list:
        if self.max_list is not None:
            records = [cut_lists(record, self.max_list) for record in records]
        self._prepare(records)
        return [self._value(record) for record in records]

    # 첫 번째 패스: 값의 빈도(라벨 판정)와 그대로 두는 키(key_n과 겹치지 않게)를 모은다
    def _prepare(self, records: list) -> None:
        counts: Counter[str] = Counter()
        record_counts: Counter[str] = Counter()
        kept_keys: set[str] = set()
        for record in records:
            seen: set[str] = set()
            _collect(record, counts, seen, kept_keys)
            for value in seen:
                record_counts[value] += 1
        min_records = min(LABEL_MIN_RECORDS, len(records))
        self._labels = {
            value for value, count in counts.items()
            if len(value) <= LABEL_MAX_CHARS and count >= LABEL_MIN_COUNT and record_counts[value] >= min_records
        }
        self._reserved = kept_keys

    # 두 번째 패스: 실제로 바꾼다
    def _value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._string(value)
        if isinstance(value, dict):
            return {self._key(str(key)): self._value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._value(item) for item in value]
        return value  # 숫자, bool, None

    def _key(self, key: str) -> str:
        if is_kept_key(key):
            return key
        renamed = self._key_map.get(key)
        if renamed is None:
            while True:
                renamed = f"key_{self._next_key}"
                self._next_key += 1
                if renamed not in self._reserved:
                    break
            self._key_map[key] = renamed
        return renamed

    def _string(self, value: str) -> str:
        if LABEL_RE.match(value) or not value.strip() or value in self._labels:
            return value
        if len(value) <= TOKEN_MAX_CHARS and not any(char.isspace() for char in value):
            return self.token(value)
        return self.text(value)

    def _digest(self, kind: str, text: str) -> bytes:
        key = f"sample:{self.seed}".encode("utf-8")
        return hmac.new(key, f"{kind}\x1f{text}".encode("utf-8"), hashlib.sha256).digest()

    def token(self, original: str) -> str:
        """공백 없는 짧은 값(ID, 이름)을 token_ + hex 6자리로 바꾼다. 같은 원문은 같은 token이 된다."""
        return "token_" + self._digest("token", original).hex()[:TOKEN_HEX_CHARS]

    def text(self, original: str) -> str:
        """본문을 같은 길이의 lorem ipsum으로 바꾼다. 원문이 ?로 끝나면 ?, 아니면 .으로 끝난다."""
        end = "?" if original.rstrip().endswith("?") else "."
        target = max(len(original) - len(end), 1)
        rng = random.Random(self._digest("text", original))
        words: list[str] = []
        size = 0
        capitalize = True
        sentence_left = rng.randint(6, 14)
        while size < target:
            word = rng.choice(LOREM)
            if capitalize:
                word, capitalize = word.capitalize(), False
            sentence_left -= 1
            if sentence_left == 0:
                word, capitalize, sentence_left = word + ".", True, rng.randint(6, 14)
            words.append(word)
            size += len(word) + 1
        body = " ".join(words)[:target].rstrip(" .")
        body += "um"[: target - len(body)]  # 자른 자리가 공백이나 마침표였으면 글자로 채워 길이를 맞춘다
        return body + end


def _collect(value: Any, counts: Counter, seen: set[str], kept_keys: set[str]) -> None:
    if isinstance(value, str):
        counts[value] += 1
        seen.add(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            if is_kept_key(str(key)):
                kept_keys.add(str(key))
            _collect(item, counts, seen, kept_keys)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _collect(item, counts, seen, kept_keys)


def anonymize_records(records: list, seed: int, max_list: int | None = None) -> list:
    """레코드 목록을 익명화한 새 목록을 돌려준다 (모듈 설명의 규칙). 입력은 바꾸지 않는다."""
    return Anonymizer(seed, max_list).run(records)


def run_sample(raw_path: Path, out_path: Path, n: int = DEFAULT_N, seed: int = DEFAULT_SEED, anonymize: bool = True,
               max_list: int | None = None, format: str | None = None) -> dict:
    """원본을 읽어 n개를 뽑고 (기본으로 익명화해서) out_path에 JSON 배열로 저장한다.

    돌려주는 요약: records(저장한 수), total(원본 레코드 수), format, anonymized, renamed_keys(바꾼 키의 개수;
    원래 이름은 넣지 않는다), bytes(파일 크기). anonymize가 False면 실제 데이터가 그대로 나가므로 stderr에 경고를
    쓴다. 그 파일은 저장소에 넣으면 안 된다."""
    raw_path = Path(raw_path)
    out_path = Path(out_path)
    source_format, records = source.load_records(raw_path, format)
    sampled = sample_records(records, n, seed)
    renamed = 0
    if anonymize:
        anonymizer = Anonymizer(seed, max_list)
        sampled = anonymizer.run(sampled)
        renamed = anonymizer.renamed_keys
    else:
        if max_list is not None:
            sampled = [cut_lists(record, max_list) for record in sampled]
        print(f"warning: {out_path} holds real data (not anonymized); keep it out of the repository", file=sys.stderr)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(sampled, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    return {
        "records": len(sampled),
        "total": len(records),
        "format": source_format,
        "anonymized": bool(anonymize),
        "renamed_keys": renamed,
        "bytes": out_path.stat().st_size,
    }


def cmd_sample(args: argparse.Namespace) -> int:
    summary = run_sample(Path(args.raw), Path(args.out), n=args.n, seed=args.seed, anonymize=args.anonymize,
                         max_list=args.max_list, format=args.format)
    state = "anonymized" if summary["anonymized"] else "NOT anonymized"
    print(f"Sampled {summary['records']} of {summary['total']} records ({summary['format']}, {state}) -> {args.out}")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def register_sample_command(subparsers: argparse._SubParsersAction) -> None:
    """`sample` 하위 명령: RAW --out FILE [--n N] [--seed N] [--no-anonymize] [--max-list N] [--format F]."""
    parser = subparsers.add_parser("sample", help="write a small anonymized sample of the raw data (for tests)")
    parser.add_argument("raw", metavar="RAW", help="raw data file (.json, .jsonl or .csv)")
    parser.add_argument("--out", required=True, metavar="FILE", help="output file (a JSON array of records)")
    parser.add_argument("--n", type=int, default=DEFAULT_N, metavar="N", help="records to keep (default: %(default)s)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, metavar="N",
                        help="seed for the sample and the synthetic text (default: %(default)s)")
    parser.add_argument("--no-anonymize", dest="anonymize", action="store_false",
                        help="write the real data as it is; never commit such a file")
    parser.add_argument("--max-list", type=int, metavar="N", help="cut every list to its first N elements")
    parser.add_argument("--format", choices=source.FORMATS, help="source format (default: detect from the file)")
    parser.set_defaults(func=cmd_sample)


__all__ = [
    "Anonymizer", "LABEL_RE", "RENAMED_KEY_RE", "SNAKE_KEY_RE", "TOKEN_RE", "anonymize_records", "cmd_sample",
    "cut_lists", "is_kept_key", "register_sample_command", "run_sample", "sample_records",
]
