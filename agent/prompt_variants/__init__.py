"""UI의 requester prompt 후보. planner의 고정 예시 파일과 분리한다."""
from pathlib import Path

DIRECTORY = Path(__file__).parent / "groundedness"
EXAMPLE_RAW = Path(__file__).parents[1] / "examples" / "groundedness" / "raw.json"
CANDIDATES = (
    ("baseline", "Baseline", "Original instructions with fixed comparison conditions."),
    ("data-explicit", "Explicit data mapping", "Adds path, label alignment and data preservation requirements."),
    ("instructions", "Clear worker instructions", "Adds concise decision rules and worker-facing examples."),
    ("combined", "Data + instructions", "Combines explicit data mapping and clearer worker instructions."),
)


def prompt_candidates() -> list[dict]:
    return [{"id": key, "name": f"Groundedness · {name}", "description": description,
             "prompt_text": (DIRECTORY / f"{key}.md").read_text(encoding="utf-8")}
            for key, name, description in CANDIDATES]
