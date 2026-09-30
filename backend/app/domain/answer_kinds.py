"""답 이름의 종류: attention 답, 자유 서술 답, 그 밖의 라벨. 어떤 답을 계산에서 뺄지는 모두 여기서 정한다.

라벨만 κ, majority, 라벨 분포, 대조 기준과 일치율, worker 의 majority 일치율, labels-json 에 들어간다. attention 답과
자유 서술 답은 Review 의 답 표시, 응답 상세, mturk-csv export 에는 그대로 남는다.

    attention 답   batch.attentionRule 이 null 이면 기본 접두어 attention_ 로 시작하는 이름 (시작 데이터 호환),
                   접두어 방식이면 namePrefix 로 시작하는 이름, 컬럼 방식이면 그 HIT 의 기대 답 셀의 키 (attention.py)
    자유 서술 답   이름이 batch.freeTextSuffixes 의 접미어 중 하나로 끝나는 답. attention 답이면 attention 이 먼저다

컬럼 방식은 HIT 마다 다르므로 answer_kinds(batch, hit_input) 은 HIT 하나의 분류다. 접두어 방식은 hit_input 을 읽지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.domain.attention import DEFAULT_ATTENTION_PREFIX, attention_column_of, expected_attention_answers, is_attention_name


@dataclass(frozen=True)
class AnswerKinds:
    """HIT 하나의 답 분류."""

    attention_prefix: str | None = DEFAULT_ATTENTION_PREFIX   # 접두어 방식의 접두어. 컬럼 방식이면 None
    expected: dict[str, str | None] = field(default_factory=dict)   # 컬럼 방식: 이 HIT 의 attention 답 이름 → 기대 값
    prefix_expected: Any = None                               # 접두어 방식 rule 의 expectedValue (rule 이 없으면 None)
    free_text_suffixes: tuple[str, ...] = ()

    def is_attention(self, name: str) -> bool:
        if self.attention_prefix is not None:
            return is_attention_name(name, self.attention_prefix)
        return name in self.expected

    def is_free_text(self, name: str) -> bool:
        return not self.is_attention(name) and any(name.endswith(suffix) for suffix in self.free_text_suffixes)

    def is_excluded(self, name: str) -> bool:
        """라벨이 아닌 답 (attention 또는 자유 서술)."""
        return self.is_attention(name) or self.is_free_text(name)

    def expected_value(self, name: str) -> Any:
        """attention 답의 기대 값. Review 에서 그 답의 대조 기준 자리에 보인다. attention 답이 아니거나 기대 값이 없으면 None."""
        if self.attention_prefix is not None:
            return self.prefix_expected if self.is_attention(name) else None
        return self.expected.get(name)


def free_text_suffixes_of(batch: dict | None) -> tuple[str, ...]:
    suffixes = (batch or {}).get("freeTextSuffixes")
    return tuple(s for s in suffixes if isinstance(s, str) and s) if isinstance(suffixes, list) else ()


def reads_hit_input(batch: dict | None) -> bool:
    """attention 이 컬럼 방식이면 HIT 마다 입력을 읽어야 분류할 수 있다."""
    return attention_column_of((batch or {}).get("attentionRule")) is not None


def answer_kinds(batch: dict | None, hit_input: dict | None = None) -> AnswerKinds:
    """batch 와 그 HIT 의 입력으로 답 분류를 만든다. batch 가 없으면 기본 접두어만 쓴다."""
    rule = (batch or {}).get("attentionRule")
    suffixes = free_text_suffixes_of(batch)
    expected = expected_attention_answers(rule, hit_input)
    if expected is not None:
        return AnswerKinds(attention_prefix=None, expected=expected, free_text_suffixes=suffixes)
    rule = rule if isinstance(rule, dict) else {}
    prefix = rule.get("namePrefix")
    return AnswerKinds(attention_prefix=prefix if isinstance(prefix, str) else DEFAULT_ATTENTION_PREFIX,
                       prefix_expected=rule.get("expectedValue") if rule else None, free_text_suffixes=suffixes)
