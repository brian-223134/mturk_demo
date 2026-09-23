"""sample 모듈: 표본 추출(개수·순서·결정성), 익명화 규칙(키·라벨·token·lorem), run_sample, argparse 등록.

examples/groundedness/raw.json(합성 데이터)을 입력으로 쓰고, 키 이름 바꾸기처럼 예시에 없는 경우는 작은 합성
레코드로 검사한다.
"""

import argparse
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from agent import sample, source

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
RAW = EXAMPLE_DIR / "raw.json"
LONG_TEXT = 20


def load_example():
    return source.load_records(RAW)[1]


def shape(value):
    """구조 비교용: dict는 (키 → shape), list는 [shape …], 문자열은 'str', 나머지는 값 그대로."""
    if isinstance(value, dict):
        return {key: shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(item) for item in value]
    if isinstance(value, str):
        return "str"
    return value


def string_pairs(old, new):
    """같은 자리의 (원래 문자열, 바뀐 문자열) 쌍. 키는 그대로라는 전제로 두 구조를 나란히 걷는다."""
    if isinstance(old, dict):
        for key, item in old.items():
            yield from string_pairs(item, new[key])
    elif isinstance(old, list):
        for a, b in zip(old, new):
            yield from string_pairs(a, b)
    elif isinstance(old, str):
        yield old, new


def all_strings(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from all_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from all_strings(item)
    elif isinstance(value, str):
        yield value


class SampleRecordsTest(unittest.TestCase):
    def test_count_and_original_order(self):
        records = load_example()
        picked = sample.sample_records(records, 3, seed=1)
        self.assertEqual(len(picked), 3)
        positions = [records.index(record) for record in picked]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(len(set(positions)), 3)

    def test_n_at_least_len_returns_all(self):
        records = load_example()
        self.assertEqual(sample.sample_records(records, len(records), seed=1), records)
        self.assertEqual(sample.sample_records(records, 1000, seed=1), records)
        self.assertIsNot(sample.sample_records(records, 1000, seed=1), records)
        self.assertEqual(sample.sample_records(records, 0, seed=1), [])

    def test_deterministic(self):
        records = load_example()
        self.assertEqual(sample.sample_records(records, 4, seed=7), sample.sample_records(records, 4, seed=7))
        with self.assertRaises(ValueError):
            sample.sample_records(records, -1, seed=7)


class AnonymizeStructureTest(unittest.TestCase):
    def test_structure_preserved(self):
        records = load_example()
        anonymized = sample.anonymize_records(records, seed=7)
        self.assertEqual(len(anonymized), len(records))
        # 예시의 키는 전부 snake_case이거나 구조용 라벨이라 키 집합과 리스트 길이가 그대로다
        self.assertEqual([shape(record) for record in anonymized], [shape(record) for record in records])
        self.assertEqual(records, load_example())  # 입력은 바뀌지 않는다

    def test_deterministic(self):
        records = load_example()
        self.assertEqual(sample.anonymize_records(records, seed=3), sample.anonymize_records(records, seed=3))

    def test_max_list_cuts_every_list(self):
        records = load_example()
        anonymized = sample.anonymize_records(records, seed=7, max_list=3)
        for record in anonymized:
            for passages in record["passages"].values():
                self.assertEqual(len(passages), 3)
        cut = sample.cut_lists({"a": [1, 2, 3, 4], "b": {"c": [[1, 2, 3], [4]]}, "d": "x"}, 2)
        self.assertEqual(cut, {"a": [1, 2], "b": {"c": [[1, 2], [4]]}, "d": "x"})
        with self.assertRaises(ValueError):
            sample.cut_lists([], -1)

    def test_scalars_kept(self):
        records = [{"n": 3, "f": 1.5, "t": True, "z": None, "empty": "", "blank": "  \n"}]
        self.assertEqual(sample.anonymize_records(records, seed=1), records)


class AnonymizeKeysTest(unittest.TestCase):
    def make(self):
        return [
            {"id": "r1", "Model-A": {"Fact 1": "alpha beta gamma delta"}, "scores": {"Model-A": 1, "Model B": 2}},
            {"id": "r2", "Model-A": {"Fact 1": "epsilon zeta eta theta"}, "scores": {"Model B": 3, "Model-A": 4}},
        ]

    def test_snake_case_and_labels_kept_others_renamed_consistently(self):
        anonymizer = sample.Anonymizer(seed=1)
        out = anonymizer.run(self.make())
        self.assertEqual(set(out[0]), {"id", "key_1", "scores"})
        self.assertEqual(set(out[0]["key_1"]), {"Fact 1"})
        self.assertEqual(out[0]["scores"], {"key_1": 1, "key_2": 2})
        self.assertEqual(out[1]["scores"], {"key_2": 3, "key_1": 4})  # 같은 원래 키 → 같은 key_n
        self.assertEqual(anonymizer.renamed_keys, 2)

    def test_first_appearance_order(self):
        out = sample.anonymize_records([{"Zeta": 1, "Alpha": 2}, {"Alpha": 3, "Beta": 4}], seed=1)
        self.assertEqual(out, [{"key_1": 1, "key_2": 2}, {"key_2": 3, "key_3": 4}])

    def test_existing_key_n_is_not_reused(self):
        out = sample.anonymize_records([{"key_1": 0, "Model-A": 1}], seed=1)
        self.assertEqual(out, [{"key_1": 0, "key_2": 1}])

    def test_structural_labels_kept(self):
        labels = ["Atomic fact1", "Atomic fact 12", "Chunk 3", "Core subquery1", "Subquery 2", "Passage 8", "Fact 1",
                  "general_0_1", "attention_2_1", "attention", "selected_facts"]
        out = sample.anonymize_records([{label: label for label in labels}], seed=1)
        self.assertEqual(out, [{label: label for label in labels}])


class AnonymizeStringsTest(unittest.TestCase):
    def test_long_strings_replaced_with_same_length(self):
        records = load_example()
        anonymized = sample.anonymize_records(records, seed=7)
        originals = {text for text in all_strings(records) if len(text) >= LONG_TEXT}
        self.assertGreater(len(originals), 20)
        dumped = json.dumps(anonymized, ensure_ascii=False)
        for text in originals:
            self.assertNotIn(text, dumped)
        for old, new in string_pairs(records, anonymized):
            if len(old) >= LONG_TEXT:
                self.assertNotEqual(old, new)
                self.assertEqual(len(new), len(old))
                self.assertTrue(new.endswith("?") if old.rstrip().endswith("?") else new.endswith("."), (old, new))

    def test_label_like_values_kept(self):
        records = load_example()
        anonymized = sample.anonymize_records(records, seed=7)
        for record in anonymized:
            support = record["labels"]["retriever_a"]["model_a"]["passage_fact_support"]
            for passage in support.values():
                for label, _reason in passage.values():
                    self.assertIn(label, ("Yes", "No"))

    def test_label_needs_repeats_across_records(self):
        # 5번 이상, 2개 이상의 레코드에 나오는 짧은 값만 라벨로 본다
        kept = [{"a": ["Maybe so"] * 3}, {"a": ["Maybe so"] * 2}]
        self.assertEqual(sample.anonymize_records(kept, seed=1), kept)
        one_record = [{"a": ["Maybe so"] * 9}, {"a": ["other one"]}]
        out = sample.anonymize_records(one_record, seed=1)
        self.assertNotIn("Maybe so", all_strings(out))
        too_few = [{"a": ["Maybe so"] * 2}, {"a": ["Maybe so"] * 2}]
        out = sample.anonymize_records(too_few, seed=1)
        self.assertNotIn("Maybe so", all_strings(out))
        single = [{"a": ["Maybe so"] * 5}]
        self.assertEqual(sample.anonymize_records(single, seed=1), single)
        long_label = [{"a": ["x" * 25 + " y"] * 3}, {"a": ["x" * 25 + " y"] * 3}]
        self.assertNotIn("x" * 25 + " y", all_strings(sample.anonymize_records(long_label, seed=1)))

    def test_tokens_deterministic(self):
        out = sample.anonymize_records([{"id": "abc_test_12", "same": "abc_test_12"}], seed=5)
        token = out[0]["id"]
        self.assertRegex(token, sample.TOKEN_RE)
        self.assertEqual(out[0]["same"], token)
        self.assertEqual(sample.anonymize_records([{"id": "abc_test_12"}], seed=5)[0]["id"], token)
        self.assertNotEqual(sample.anonymize_records([{"id": "abc_test_12"}], seed=6)[0]["id"], token)
        self.assertNotEqual(sample.anonymize_records([{"id": "abc_test_13"}], seed=5)[0]["id"], token)

    def test_short_text_with_spaces_becomes_lorem(self):
        out = sample.anonymize_records([{"q": "What is it?", "s": "Some text.", "w": "a b"}], seed=1)
        self.assertEqual(len(out[0]["q"]), len("What is it?"))
        self.assertTrue(out[0]["q"].endswith("?"))
        self.assertNotEqual(out[0]["q"], "What is it?")
        self.assertEqual(len(out[0]["s"]), len("Some text."))
        self.assertTrue(out[0]["s"].endswith("."))
        self.assertEqual(len(out[0]["w"]), 3)

    def test_long_token_without_spaces_becomes_lorem(self):
        original = "x" * 40
        out = sample.anonymize_records([{"v": original}], seed=1)
        self.assertEqual(len(out[0]["v"]), 40)
        self.assertNotRegex(out[0]["v"], sample.TOKEN_RE)


class RunSampleTest(unittest.TestCase):
    def test_writes_file_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nested" / "sample.json"
            summary = sample.run_sample(RAW, out, n=3, seed=1, max_list=2)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(len(data), 3)
            self.assertEqual(summary["records"], 3)
            self.assertEqual(summary["total"], 6)
            self.assertEqual(summary["format"], "json_array")
            self.assertTrue(summary["anonymized"])
            self.assertEqual(summary["renamed_keys"], 0)
            self.assertEqual(summary["bytes"], out.stat().st_size)
            self.assertEqual(set(summary), {"records", "total", "format", "anonymized", "renamed_keys", "bytes"})
            for record in data:
                self.assertEqual(len(record["passages"]["retriever_a"]), 2)
            self.assertEqual(data, sample.anonymize_records(sample.sample_records(load_example(), 3, 1), 1, 2))

    def test_no_anonymize_warns_and_keeps_real_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "real.json"
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                summary = sample.run_sample(RAW, out, n=2, seed=1, anonymize=False)
            self.assertIn("warning", err.getvalue())
            self.assertIn("repository", err.getvalue())
            self.assertFalse(summary["anonymized"])
            self.assertEqual(json.loads(out.read_text(encoding="utf-8")), sample.sample_records(load_example(), 2, 1))


class CommandTest(unittest.TestCase):
    def build_parser(self):
        parser = argparse.ArgumentParser()
        commands = parser.add_subparsers(dest="command", required=True)
        sample.register_sample_command(commands)
        return parser

    def test_arguments_and_defaults(self):
        parser = self.build_parser()
        args = parser.parse_args(["sample", "raw.json", "--out", "o.json"])
        self.assertEqual((args.command, args.raw, args.out), ("sample", "raw.json", "o.json"))
        self.assertEqual((args.n, args.seed, args.anonymize, args.max_list, args.format), (6, 7, True, None, None))
        self.assertIs(args.func, sample.cmd_sample)
        args = parser.parse_args(["sample", "raw.json", "--out", "o.json", "--n", "2", "--seed", "3", "--no-anonymize",
                                  "--max-list", "4", "--format", "jsonl"])
        self.assertEqual((args.n, args.seed, args.anonymize, args.max_list, args.format), (2, 3, False, 4, "jsonl"))
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                parser.parse_args(["sample", "raw.json"])

    def test_cmd_sample_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "sample.json"
            args = self.build_parser().parse_args(["sample", str(RAW), "--out", str(out), "--n", "2", "--seed", "3",
                                                   "--max-list", "1"])
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = args.func(args)
            self.assertEqual(code, 0)
            lines = stdout.getvalue().splitlines()
            self.assertIn("Sampled 2 of 6 records", lines[0])
            self.assertIn("anonymized", lines[0])
            printed = json.loads(lines[1])
            self.assertEqual((printed["records"], printed["anonymized"]), (2, True))
            self.assertEqual(len(json.loads(out.read_text(encoding="utf-8"))), 2)


if __name__ == "__main__":
    unittest.main()
