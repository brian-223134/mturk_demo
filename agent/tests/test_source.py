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

    def test_jsonl(self):
        path = self.write("l.jsonl", '{"id": 1}\n\n{"id": 2}\n[1, 2]\n')
        self.assertEqual(source.detect_format(path), "jsonl")
        fmt, records = source.load_records(path)
        self.assertEqual(fmt, "jsonl")
        self.assertEqual(records, [{"id": 1}, {"id": 2}, {"_value": [1, 2]}])
        bad = self.write("bad.jsonl", '{"id": 1}\nnot json\n')
        with self.assertRaisesRegex(SourceError, "line 2"):
            source.load_records(bad)

    def test_csv(self):
        text = (
            "idx,question,chunks,labels,flag,plain,empty\n"
            "﻿" if False else ""
        )
        text = (
            "idx,question,chunks,labels,flag,plain,empty\n"
            "1,\"What is it?\",\"['Chunk 0', 'Chunk 1']\",\"{\"\"a\"\": [1, 2]}\",True,Yes,\n"
            "2,\"Second, with comma\",\"[\"\"x\"\"]\",\"{'k': 'v'}\",false,No,\n"
        )
        path = self.write("c.csv", "﻿" + text)
        self.assertEqual(source.detect_format(path), "csv")
        fmt, records = source.load_records(path)
        self.assertEqual(fmt, "csv")
        self.assertEqual(len(records), 2)
        first, second = records
        self.assertEqual(first["idx"], 1)
        self.assertEqual(first["question"], "What is it?")
        self.assertEqual(first["chunks"], ["Chunk 0", "Chunk 1"])
        self.assertEqual(first["labels"], {"a": [1, 2]})
        self.assertIs(first["flag"], True)
        self.assertEqual(first["plain"], "Yes")
        self.assertEqual(first["empty"], "")
        self.assertEqual(second["chunks"], ["x"])
        self.assertEqual(second["labels"], {"k": "v"})
        self.assertIs(second["flag"], False)
        self.assertEqual(second["question"], "Second, with comma")

    def test_decode_cell(self):
        self.assertEqual(source.decode_cell("007"), "007")
        self.assertEqual(source.decode_cell("12"), 12)
        self.assertIsNone(source.decode_cell("None"))
        self.assertEqual(source.decode_cell("2025-01-01"), "2025-01-01")
        self.assertEqual(source.decode_cell("  "), "  ")
        self.assertEqual(source.decode_cell(None), "")

    def test_sniff_unknown_extension(self):
        array = self.write("data.txt", json.dumps([{"a": 1}]))
        self.assertEqual(source.detect_format(array), "json_array")
        lines = self.write("data.dat", '{"a": 1}\n{"a": 2}\n')
        self.assertEqual(source.detect_format(lines), "jsonl")
        table = self.write("data.tbl", "a,b\n1,2\n")
        self.assertEqual(source.detect_format(table), "csv")

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
