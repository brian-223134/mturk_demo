"""source 모듈: JSON 배열, JSON 객체 값, JSONL, CSV 로더와 형식 감지."""

import json
import tempfile
import unittest
from pathlib import Path

from agent import source
from agent.source import SourceError


class SourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_json_array(self):
        path = self.write("a.json", json.dumps([{"id": "a"}, {"id": "b"}, "plain"]))
        self.assertEqual(source.detect_format(path), "json_array")
        fmt, records = source.load_records(path)
        self.assertEqual(fmt, "json_array")
        self.assertEqual(records, [{"id": "a"}, {"id": "b"}, {"_value": "plain"}])

    def test_json_object_values(self):
        path = self.write("o.json", json.dumps({"k1": {"x": 1, "_key": "old"}, "k2": {"x": 2}}))
        self.assertEqual(source.detect_format(path), "json_object_values")
        fmt, records = source.load_records(path)
        self.assertEqual(fmt, "json_object_values")
        self.assertEqual(records, [{"_key": "k1", "x": 1}, {"_key": "k2", "x": 2}])
        self.assertEqual(list(records[0]), ["_key", "x"])

    def test_json_single_object(self):
        path = self.write("s.json", json.dumps({"x": 1, "y": [1, 2]}))
        self.assertEqual(source.detect_format(path), "json_array")
        self.assertEqual(source.load_records(path), ("json_array", [{"x": 1, "y": [1, 2]}]))

    def test_explicit_format_mismatch(self):
        path = self.write("a.json", json.dumps([{"id": "a"}]))
        with self.assertRaises(SourceError):
            source.load_records(path, "json_object_values")
        with self.assertRaises(SourceError):
            source.load_records(path, "unknown")

    def test_jsonl_and_csv_are_refused(self):
        for name in ("l.jsonl", "n.ndjson", "c.csv", "t.tsv"):
            path = self.write(name, '{"id": 1}\n')
            with self.assertRaisesRegex(SourceError, "must be a JSON file"):
                source.load_records(path)
            with self.assertRaisesRegex(SourceError, "must be a JSON file"):
                source.detect_format(path)
        path = self.write("ok.json", '[{"id": 1}]')
        for format in ("jsonl", "csv"):
            with self.assertRaisesRegex(SourceError, "unknown source format"):
                source.load_records(path, format)

    def test_other_extension_is_read_as_json(self):
        array = self.write("data.txt", json.dumps([{"a": 1}]))
        self.assertEqual(source.detect_format(array), "json_array")
        self.assertEqual(source.load_records(array), ("json_array", [{"a": 1}]))
        table = self.write("data.tbl", "a,b\n1,2\n")
        with self.assertRaisesRegex(SourceError, "invalid JSON"):
            source.detect_format(table)

    def test_errors(self):
        with self.assertRaises(SourceError):
            source.load_records(self.dir / "missing.json")
        empty = self.write("empty.json", "[]")
        with self.assertRaisesRegex(SourceError, "no records"):
            source.load_records(empty)
        broken = self.write("broken.json", "{not json")
        with self.assertRaisesRegex(SourceError, "invalid JSON"):
            source.load_records(broken)
        scalar = self.write("scalar.json", "42")
        with self.assertRaises(SourceError):
            source.load_records(scalar)


if __name__ == "__main__":
    unittest.main()
