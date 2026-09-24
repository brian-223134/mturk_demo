"""템플릿 규약 중 placeholder 추출. prototype/src/domain/template.ts 의 extractPlaceholders 와 같은 정규식이다
(agent/validate.py 의 PLACEHOLDER_RE 와도 같다)."""

from __future__ import annotations

import re

PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def extract_placeholders(html: str) -> list[str]:
    """html 에서 `${컬럼명}` 이름을 처음 나온 순서대로, 중복 없이 뽑는다."""
    names: list[str] = []
    for match in PLACEHOLDER_RE.finditer(html):
        if match.group(1) not in names:
            names.append(match.group(1))
    return names
