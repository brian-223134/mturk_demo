"""예시 spec으로 preprocess → render → validate를 한 번에 돌린다."""

import csv
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from agent import preprocess, render, spec, validate

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
EXPECTED_FILES = {"task_spec.json", "items.jsonl", "hits.csv", "summary.json", "settings.json", "template.html", "validation.json"}


class EndToEndTest(unittest.TestCase):
    def test_example_pipeline(self):
        parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            shutil.copy(EXAMPLE_DIR / "task_spec.json", out / "task_spec.json")
            summary = preprocess.run_preprocess(parsed, EXAMPLE_DIR / "raw.json", out)
            template = render.run_render(parsed, out)
            result = validate.validate_bundle(out)

            self.assertEqual({path.name for path in out.iterdir()}, EXPECTED_FILES)
            self.assertTrue(result["ok"], result["errors"])
            self.assertEqual(result["warnings"], [])
            self.assertEqual(result["stats"]["rows"], summary["hits"])
            self.assertEqual(result["stats"]["targets"], summary["targets"])
            self.assertEqual(result["stats"]["row_bytes"], summary["row_bytes"])
            self.assertEqual(result["stats"]["reference_values"], summary["reference_values"])

            # 첫 행을 콘솔처럼 렌더하면 데이터가 JS 리터럴로 들어가고 placeholder가 남지 않는다
            with (out / "hits.csv").open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            rendered = validate.substitute_row(template.read_text(encoding="utf-8"), rows[0])
            self.assertEqual(validate.extract_placeholders(rendered), [])
            self.assertIn('var HIT_ID = "hit-0001";', rendered)
            self.assertIn("var ATTENTION = [", rendered)
            self.assertIn('FIELDS["facts"] = [[', rendered)
            self.assertEqual(rendered.count("</script"), 2)
            self.assertEqual(json.loads(rows[0]["hit_id"]), "hit-0001")

            settings = json.loads((out / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(settings["reference"]["column"], parsed.output.reference_column)
            self.assertIn(settings["reference"]["column"], rows[0])


if __name__ == "__main__":
    unittest.main()
