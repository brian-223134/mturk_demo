"""외부 도구의 예시 6종(completeness, groundedness, retrieval coverage, gt info coverage, pairwise, threeway)을 spec v2로
표현해 익명화한 실제 데이터 표본(fixtures/sample.json)에 돌린다.

spec은 fixtures/external_tasks/<이름>.json 이다. 작업마다 preprocess → render → validate를 돌리고, 답 이름과 문항 종류,
placeholder, 행 크기를 확인한다. reference 값은 원본 레코드에서 따로 계산한 라벨과 같아야 한다 (선택된 key 목록에
target key가 있는지, Covered/Not covered 대응 등). attention 기대 값은 attention 컬럼에만 있고 reference에는 없어야 한다.
"""

import csv
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from agent import preprocess, render, sample, source, spec, validate

csv.field_size_limit(sys.maxsize)

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
TASK_DIR = FIXTURE_DIR / "external_tasks"
SAMPLE = FIXTURE_DIR / "sample.json"
DATASET_ID_RE = re.compile(r"[a-z]+_test_\d+")
ROW_LIMIT = 64 * 1024

# 작업마다 (문항 id, 종류, 범위, 값) — settings.json의 questions와 같아야 한다
QUESTIONS = {
    "completeness": [("relevant", "multi_select", "target", ["relevant", "not_relevant"]),
                     ("coverage", "choice", "item", ["covered", "not_covered"])],
    "groundedness": [("supported", "multi_select", "target", ["supported", "not_supported"])],
    "retrieval_coverage": [("answers", "multi_select", "target", ["answered", "not_answered"])],
    "gt_info_coverage": [("has_info", "choice", "item", ["yes", "no"]), ("missing_info", "text", "item", [])],
    "pairwise": [("better", "choice", "item", ["a", "b", "both", "neither"])],
    "threeway": [("relation", "choice", "target", ["supported", "contradicted", "not_mentioned"])],
}


def labels(record: dict) -> dict:
    return record["relevance_check"]["key_2"]["key_19"]


def fact_keys(record: dict) -> list[str]:
    return list(record["atomic_facts"]["key_2"]["key_19"])


def split_item_id(item_id: str) -> tuple[str, str, str]:
    """"<record id>#<var>=<key>" → (record id, var, key)."""
    record_id, rest = item_id.split("#", 1)
    var, key = rest.split("=", 1)
    return record_id, var, key


def expected_reference(task: str, index: int, record: dict, key: str) -> tuple[dict, dict]:
    """탭 index의 (reference, reason)을 원본 레코드에서 따로 계산한다. key는 item_id의 iterate 키."""
    reference: dict[str, str] = {}
    reasons: dict[str, str] = {}
    if task == "completeness":
        selected = labels(record)["query_fact_relevance"][key]["selected_facts"]
        for j, fact in enumerate(fact_keys(record), 1):
            reference[f"general_{index}_{j}_relevant"] = "relevant" if fact in selected else "not_relevant"
        coverage = {"Covered": "covered", "Not covered": "not_covered"}.get(labels(record)["query_fact_coverage"][key])
        if coverage is not None:  # 익명화로 바뀐 라벨은 대응하지 않는다
            reference[f"general_{index}_coverage"] = coverage
    elif task == "groundedness":
        entry = labels(record)["chunk_fact_relevance"].get(f"Chunk {int(key) + 1}")
        selected = entry["selected_facts"] if entry else []
        for j, fact in enumerate(fact_keys(record), 1):
            reference[f"general_{index}_{j}_supported"] = "supported" if fact in selected else "not_supported"
    elif task == "retrieval_coverage":
        answered = labels(record)["query_chunk_coverage"].get(f"Chunk {int(key) + 1}", [])
        for j, sub in enumerate(record["decomposed_query"], 1):
            reference[f"general_{index}_{j}_answers"] = "answered" if sub in answered else "not_answered"
    elif task == "threeway":
        chunk = record["relevance_check_reasoning"]["key_2"]["key_19"]["chunk_fact_relevance"].get(f"Chunk {int(key) + 1}", {})
        for j, fact in enumerate(fact_keys(record), 1):
            if fact not in chunk:
                continue
            label, reason = chunk[fact][0], chunk[fact][1]
            if label == "Yes":
                reference[f"general_{index}_{j}_relation"] = "supported"
            reasons[f"general_{index}_{j}_relation"] = reason
    return reference, reasons


def attention_expected(task: str, index: int, targets: list) -> dict:
    """attention 탭 index의 기대 값 (spec의 attention.expected를 답 칸마다 편 것)."""
    if task == "completeness":
        out = {f"general_{index}_{j}_relevant": "not_relevant" for j in range(1, len(targets) + 1)}
        out[f"general_{index}_coverage"] = "not_covered"
        return out
    if task == "groundedness":
        return {f"general_{index}_{j}_supported": "not_supported" for j in range(1, len(targets) + 1)}
    if task == "retrieval_coverage":
        return {f"general_{index}_{j}_answers": "not_answered" for j in range(1, len(targets) + 1)}
    if task == "threeway":
        return {f"general_{index}_{j}_relation": "not_mentioned" for j in range(1, len(targets) + 1)}
    if task == "gt_info_coverage":
        return {f"general_{index}_has_info": "no"}
    return {f"general_{index}_better": "neither"}


class ExternalTasksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, records = source.load_records(SAMPLE)
        cls.records = {record["qid"]: record for record in records}
        cls.tmp = tempfile.TemporaryDirectory()
        cls.results = {}
        for task in QUESTIONS:
            out = Path(cls.tmp.name) / task
            out.mkdir()
            path = TASK_DIR / f"{task}.json"
            parsed = spec.load_spec(path)
            shutil.copy(path, out / "task_spec.json")
            summary = preprocess.run_preprocess(parsed, SAMPLE, out)
            render.run_render(parsed, out)
            result = validate.validate_bundle(out)
            with (out / "hits.csv").open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            cls.results[task] = (parsed, out, summary, result, rows)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_specs_validate_against_the_sample(self):
        records = list(self.records.values())
        for task in QUESTIONS:
            with self.subTest(task=task):
                parsed = spec.load_spec(TASK_DIR / f"{task}.json")
                self.assertEqual(parsed.spec_version, 2)
                self.assertEqual(spec.validate_against_records(parsed, records), [])

    def test_bundles_are_valid(self):
        for task, (parsed, out, summary, result, rows) in self.results.items():
            with self.subTest(task=task):
                self.assertTrue(result["ok"], result["errors"])
                self.assertEqual(result["warnings"], [])
                self.assertEqual(result["stats"]["placeholders"], ["hit_id", *parsed.item.fields])
                self.assertEqual(summary["rows_over_64kb"], 0)
                self.assertLess(summary["row_bytes"]["max"], ROW_LIMIT)
                self.assertEqual(len(rows), summary["hits"])
                for key in ("answers", "attention_answers", "hints_missing", "reference_values"):
                    self.assertEqual(result["stats"][key], summary[key], key)
                template = (out / "template.html").read_text(encoding="utf-8")
                self.assertIn("window.TASK_ANSWER_SCHEMA", template)
                self.assertNotIn("attention_", template)
                self.assertLessEqual(len(template.encode("utf-8")), render.SIZE_TARGET)

    def test_questions_and_settings(self):
        for task, (parsed, out, summary, result, rows) in self.results.items():
            with self.subTest(task=task):
                settings = json.loads((out / "settings.json").read_text(encoding="utf-8"))
                self.assertEqual([(q["id"], q["type"], q["scope"], q["values"]) for q in settings["questions"]],
                                 [tuple(entry) for entry in QUESTIONS[task]])
                self.assertEqual(settings["attentionRule"], {"column": "attention_expected", "minCorrectRatio": 1})
                texts = [f"_{qid}" for qid, kind, _, _ in QUESTIONS[task] if kind == "text"]
                self.assertEqual(settings["freeTextSuffixes"], texts)
                self.assertIn("attention_expected", rows[0])

    def test_answer_names_follow_the_slots(self):
        for task, (parsed, out, summary, result, rows) in self.results.items():
            scopes = {qid: scope for qid, _, scope, _ in QUESTIONS[task]}
            target = parsed.target_field.name if parsed.target_field is not None else None
            items = [json.loads(line) for line in (out / "items.jsonl").read_text(encoding="utf-8").splitlines()]
            with self.subTest(task=task):
                for line in items:
                    n_targets = len(line["targets"])
                    expected = []
                    for qid, kind, scope, _ in QUESTIONS[task]:
                        if scope == "item":
                            expected.append(f"general_{line['item_index']}_{qid}")
                        else:
                            expected.extend(f"general_{line['item_index']}_{j}_{qid}" for j in range(1, n_targets + 1))
                    self.assertEqual(line["answer_names"], expected)
                    self.assertEqual(n_targets == 0, target is None)
                    self.assertTrue(all(scopes[a["question"]] == ("item" if a["target_no"] is None else "target") for a in line["answers"]))

    def test_reference_equals_raw_labels(self):
        for task, (parsed, out, summary, result, rows) in self.results.items():
            target = parsed.target_field.name if parsed.target_field is not None else None
            with self.subTest(task=task):
                checked = 0
                for row in rows:
                    flags = json.loads(row["attention"])
                    item_ids = json.loads(row["item_ids"])
                    reference = json.loads(row["llm_label"])
                    reasons = json.loads(row["llm_reason"]) if "llm_reason" in row else {}
                    expected_column = json.loads(row["attention_expected"])
                    want_reference: dict = {}
                    want_reasons: dict = {}
                    want_attention: dict = {}
                    for index, (flag, item_id) in enumerate(zip(flags, item_ids)):
                        if flag:
                            targets = json.loads(row[target])[index] if target else []
                            want_attention.update(attention_expected(task, index, targets))
                            continue
                        record_id, _, key = split_item_id(item_id)
                        ref, why = expected_reference(task, index, self.records[record_id], key)
                        want_reference.update(ref)
                        want_reasons.update(why)
                    self.assertEqual(reference, want_reference)
                    self.assertEqual(expected_column, want_attention)
                    self.assertFalse(set(reference) & set(expected_column))
                    if "llm_reason" in row:
                        self.assertEqual(reasons, want_reasons)
                    checked += len(reference)
                if task in ("gt_info_coverage", "pairwise"):
                    self.assertEqual(checked, 0)  # 기존 라벨이 없는 작업
                else:
                    self.assertGreater(checked, 0)
                    self.assertEqual(sum(summary["reference_values"].values()), checked)

    def test_reference_values_cover_both_labels(self):
        # 표본에 양쪽 라벨이 모두 있어야 대조가 의미 있다
        expectations = {"completeness": {"relevant", "not_relevant", "covered"}, "groundedness": {"supported", "not_supported"},
                        "retrieval_coverage": {"answered", "not_answered"}, "threeway": {"supported"}}
        for task, values in expectations.items():
            with self.subTest(task=task):
                self.assertEqual(set(self.results[task][2]["reference_values"]), values)

    def test_pairs_and_filters(self):
        parsed, out, summary, result, rows = self.results["pairwise"]
        row = rows[0]
        flags = json.loads(row["attention"])
        index = flags.index(0)
        record_id, var, key = split_item_id(json.loads(row["item_ids"])[index])
        chunks = self.records[record_id]["retrieved_chunk"]["key_2"]
        self.assertEqual(var, "pair")
        self.assertEqual(json.loads(row["passage_a"])[index], chunks[int(key)])
        self.assertEqual(json.loads(row["passage_b"])[index], chunks[int(key) + 1])
        self.assertEqual(summary["items"], 30)  # 레코드 6개 × (passage 10개 ÷ 2)
        parsed, out, summary, result, rows = self.results["gt_info_coverage"]
        used = {split_item_id(item_id)[0] for row in rows for item_id in json.loads(row["item_ids"]) if item_id != "attention"}
        self.assertTrue(all(len(self.records[record_id]["gt_chunk"]) <= 3 for record_id in used))
        self.assertEqual(summary["records"]["used"], 4)

    def test_content_checks_catch_real_mistakes(self):
        """실제 계획에서 나온 실수를 표본으로 재현한다: 다른 model의 라벨, 다른 retriever의 문맥, 목록과 맞지 않는 contains,
        없는 라벨을 null로 둔 missing, worker 문구의 내부 이름, 최상위 키 오타."""
        records = list(self.records.values())

        def errors(task, mutate):
            data = json.loads((TASK_DIR / f"{task}.json").read_text(encoding="utf-8"))
            mutate(data)
            return spec.validate_against_records(spec.parse_spec(data), records)

        def other_model(d):
            d["item"]["fields"]["statements"]["path"] = "$.atomic_facts.key_2.key_9[*]"
        self.assertIn("$.item.questions[0].hint.label_path: reads labels for 'key_19' but the targets come from 'key_9' (both are "
                      "keys of $.atomic_facts.key_2); labels must address the same targets — use the same key in both paths",
                      errors("groundedness", other_model))

        def other_retriever(d):
            d["item"]["iterate"][0]["path"] = "$.retrieved_chunk.key_1"
        self.assertIn("$.item.fields.statements.path: the targets come from 'key_2' but the tab shows $.retrieved_chunk.key_1 "
                      "('key_2' and 'key_1' are both keys of $.retrieved_chunk); show targets and context from the same source "
                      "— use the same key in both paths", errors("threeway", other_retriever))

        def target_text(d):
            d["item"]["questions"][0]["hint"]["contains"] = "{target}"
        found = [e for e in errors("retrieval_coverage", target_text) if ".contains:" in e]
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].startswith("$.item.questions[0].hint.contains: '{target}' is never found in the label lists"))
        self.assertTrue(found[0].endswith("the lists hold values like 'Core subquery1'; \"contains\": \"{target_key}\" matches them"))

        def no_missing(d):
            d["item"]["questions"][0]["hint"]["missing"] = None
        found = [e for e in errors("groundedness", no_missing) if ".missing:" in e]
        self.assertEqual(len(found), 1)
        self.assertIn("although the label map $.relevance_check.key_2.key_19.chunk_fact_relevance exists; if an absent entry "
                      "means 'no', set missing to 'not_supported'", found[0])

        def internal_name(d):
            d["task"]["title"] = "Which statements does a key_2 passage support?"
            d["task"]["keywords"].append("key_19")
        self.assertEqual(errors("groundedness", internal_name), [
            "$.task.title: mentions 'key_2', an internal name from the data; describe it in plain words (e.g. 'retrieved passage')",
            "$.task.keywords[3]: mentions 'key_19', an internal name from the data; describe it in plain words (e.g. 'retrieved passage')",
        ])

        def question_key(d):
            d["item"]["fields"]["question"]["path"] = "$.question"
        found = errors("pairwise", question_key)
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].startswith("$.item.fields.question.path: '$.question' does not resolve in record "))
        self.assertIn("(did you mean '$.query'?) (top-level keys: qid, query, gt_answer, gt_chunk, retrieved_chunk,", found[0])

    def test_specs_have_no_names(self):
        for path in sorted(TASK_DIR.glob("*.json")):
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(DATASET_ID_RE.search(text), path.name)
            for spec_path in re.findall(r'"(?:path|label_path|reason_path)": "([^"]+)"', text):
                for key in re.findall(r"\.([A-Za-z_][A-Za-z0-9_-]*)", spec_path):
                    self.assertTrue(sample.is_kept_key(key) or sample.RENAMED_KEY_RE.match(key), f"{path.name}: {spec_path}")


if __name__ == "__main__":
    unittest.main()
