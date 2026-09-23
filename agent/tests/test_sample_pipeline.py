"""익명화한 표본(tests/fixtures/sample.json + sample_spec.json)으로 preprocess → render → validate를 돌린다.

fixture는 `python3 -m agent sample <원본> --out agent/tests/fixtures/sample.json --n 6 --seed 7 --max-list 12`로
만든 것이다. 저장소는 공개이므로 fixture에 데이터셋 항목 ID나 모델·retriever 이름이 남지 않았는지도 여기서 검사한다.

AGENT_LOCAL_SAMPLE_DIR에 raw.json과 task_spec.json이 있으면 (익명화하지 않은 로컬 데이터) 같은 파이프라인을
그 폴더로도 돌린다. 없으면 건너뛴다.
"""

import csv
import json
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from agent import preprocess, render, sample, source, spec, validate

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
SAMPLE = FIXTURE_DIR / "sample.json"
SAMPLE_SPEC = FIXTURE_DIR / "sample_spec.json"
LOCAL_DIR_VARIABLE = "AGENT_LOCAL_SAMPLE_DIR"
DATASET_ID_RE = re.compile(r"[a-z]+_test_\d+")
FIXTURE_BYTES_LIMIT = 600 * 1024


def run_pipeline(spec_path: Path, raw_path: Path, out: Path):
    parsed = spec.load_spec(spec_path)
    shutil.copy(spec_path, out / "task_spec.json")
    summary = preprocess.run_preprocess(parsed, raw_path, out)
    render.run_render(parsed, out)
    result = validate.validate_bundle(out)
    return parsed, summary, result


def walk_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_keys(item)


class SamplePipelineTest(unittest.TestCase):
    def test_spec_matches_sample(self):
        parsed = spec.load_spec(SAMPLE_SPEC)
        _, records = source.load_records(SAMPLE)
        self.assertEqual(len(records), 6)
        self.assertEqual(spec.validate_against_records(parsed, records), [])
        self.assertIsNone(parsed.source.sample)
        self.assertEqual(parsed.hit.items_per_hit, 10)

    def test_full_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            parsed, summary, result = run_pipeline(SAMPLE_SPEC, SAMPLE, out)
            self.assertTrue(result["ok"], result["errors"])
            self.assertEqual(result["warnings"], [])
            self.assertEqual(summary["hits"], 6)
            self.assertEqual(summary["records"]["used"], 6)
            self.assertEqual(summary["attention_items"], 6)
            self.assertEqual(result["stats"]["rows"], 6)
            self.assertLessEqual(summary["hints_missing"], 2)
            self.assertEqual(result["stats"]["hints_missing"], summary["hints_missing"])
            values = summary["reference_values"]
            self.assertEqual(set(values), set(parsed.option_values))
            self.assertTrue(all(count > 0 for count in values.values()), values)

            with (out / "hits.csv").open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 6)
            for row in rows:
                flags = json.loads(row["attention"])
                self.assertEqual(len(flags), 11)  # 10 items + 1 attention
                self.assertEqual(sum(flags), 1)
                self.assertEqual(len(json.loads(row["chunk"])), 11)
                self.assertTrue(all(json.loads(row["facts"])))
            record_ids = {record_id for row in rows for record_id in json.loads(row["record_ids"]) if record_id != "attention"}
            self.assertEqual(len(record_ids), 6)
            for record_id in record_ids:
                self.assertRegex(record_id, sample.TOKEN_RE)


class FixtureLeakTest(unittest.TestCase):
    def test_no_dataset_ids_in_fixtures(self):
        files = sorted(FIXTURE_DIR.glob("*.json"))
        self.assertGreaterEqual(len(files), 2)
        for path in files:
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(DATASET_ID_RE.search(text), f"{path.name}: dataset item id left in the fixture")

    def test_sample_keys_are_anonymous(self):
        data = json.loads(SAMPLE.read_text(encoding="utf-8"))
        self.assertIsInstance(data, list)
        bad = sorted({key for key in walk_keys(data)
                      if not (sample.SNAKE_KEY_RE.match(key) or sample.RENAMED_KEY_RE.match(key) or sample.LABEL_RE.match(key))})
        self.assertEqual(bad, [])
        self.assertTrue(any(sample.RENAMED_KEY_RE.match(key) for key in walk_keys(data)))

    def test_sample_ids_and_texts_are_synthetic(self):
        data = json.loads(SAMPLE.read_text(encoding="utf-8"))
        for record in data:
            self.assertRegex(record["qid"], sample.TOKEN_RE)
            self.assertTrue(record["query"].endswith("?"))
        self.assertLessEqual(SAMPLE.stat().st_size, FIXTURE_BYTES_LIMIT)

    def test_spec_has_no_names(self):
        text = SAMPLE_SPEC.read_text(encoding="utf-8")
        for path in re.findall(r'"path": "([^"]+)"', text):
            for key in re.findall(r"\.([A-Za-z_][A-Za-z0-9_-]*)", path):
                self.assertTrue(sample.is_kept_key(key) or sample.RENAMED_KEY_RE.match(key), path)


@unittest.skipUnless(os.environ.get(LOCAL_DIR_VARIABLE), f"{LOCAL_DIR_VARIABLE} is not set")
class LocalSamplePipelineTest(unittest.TestCase):
    """로컬에만 있는(익명화하지 않은) raw.json + task_spec.json으로 같은 파이프라인을 돌린다."""

    def test_local_pipeline(self):
        local = Path(os.environ[LOCAL_DIR_VARIABLE])
        raw_path, spec_path = local / "raw.json", local / "task_spec.json"
        if not (raw_path.is_file() and spec_path.is_file()):
            self.skipTest(f"{local} lacks raw.json or task_spec.json")
        with tempfile.TemporaryDirectory() as tmp:
            parsed, summary, result = run_pipeline(spec_path, raw_path, Path(tmp))
            self.assertTrue(result["ok"], result["errors"])
            self.assertGreater(summary["hits"], 0)
            self.assertEqual(result["stats"]["rows"], summary["hits"])
            self.assertEqual(set(summary["reference_values"]) - set(parsed.option_values), set())


if __name__ == "__main__":
    unittest.main()
