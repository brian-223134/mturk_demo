"""paths 모듈: 문법, 와일드카드, MISSING, 변수 치환, 오류."""

import pickle
import unittest

from agent import paths
from agent.paths import MISSING, PathError, Segment

RECORD = {
    "id": "r1",
    "question": "Q?",
    "passages": {"retriever_a": ["p1", "p2", "p3"]},
    "facts": {"model_a": {"Fact 1": "f1", "Fact 2": "f2"}},
    "labels": {"Passage 1": {"Fact 1": ["Yes", "because"]}, "it's": {"say \"hi\"": 7}},
    "pairs": [{"b": [1, 2]}, {"b": "not a list"}, {"c": 0}, {"b": [3]}],
    "dash-key": True,
}


class ParseTest(unittest.TestCase):
    def test_grammar(self):
        self.assertEqual(paths.parse("$"), [Segment("root")])
        self.assertEqual(paths.parse("$.a.b-c"), [Segment("root"), Segment("key", "a"), Segment("key", "b-c")])
        self.assertEqual(paths.parse("$['k k'][\"q\"]"), [Segment("root"), Segment("key", "k k"), Segment("key", "q")])
        self.assertEqual(paths.parse("$[0][-1]"), [Segment("root"), Segment("index", 0), Segment("index", -1)])
        self.assertEqual(paths.parse("$[*].*"), [Segment("root"), Segment("wild"), Segment("wild")])
        self.assertEqual(paths.parse("{v}"), [Segment("var", "v")])
        self.assertEqual(paths.parse("{v}.x[1]"), [Segment("var", "v"), Segment("key", "x"), Segment("index", 1)])

    def test_quoted_escapes(self):
        self.assertEqual(paths.parse("$['it\\'s']")[1], Segment("key", "it's"))
        self.assertEqual(paths.parse('$["say \\"hi\\""]')[1], Segment("key", 'say "hi"'))
        self.assertEqual(paths.parse("$['back\\\\slash']")[1], Segment("key", "back\\slash"))

    def test_format_roundtrip(self):
        for path in ("$", "$.a.b-c[0][-1][*]", "$['k k']['it\\'s'].x", "{v}.x[1]"):
            self.assertEqual(paths.format_path(paths.parse(path)), path)
        self.assertEqual(paths.format_key("plain"), ".plain")
        self.assertEqual(paths.format_key("Passage 1"), "['Passage 1']")

    def test_errors(self):
        for bad in ("", "a.b", "$.", "$[", "$['x", "$[x]", "$.a b", "{}", "{1}", "$..a", "$[1", "$.a[*", "{v"):
            with self.assertRaises(PathError, msg=bad):
                paths.parse(bad)

    def test_helpers(self):
        self.assertTrue(paths.has_wildcard("$.facts.model_a[*]"))
        self.assertFalse(paths.has_wildcard("$.a[{i}]"))
        self.assertEqual(paths.variable_names("{p}.x['Fact {n}'][{n}]"), ["p", "n"])
        paths.check_syntax("$.labels['Passage {passage_no}']['Fact {target_no}'][0]")
        with self.assertRaises(PathError):
            paths.check_syntax("$.a.{name}")


class EvaluateTest(unittest.TestCase):
    def test_single_values(self):
        self.assertEqual(paths.evaluate("$", RECORD), RECORD)
        self.assertEqual(paths.evaluate("$.question", RECORD), "Q?")
        self.assertEqual(paths.evaluate("$.passages.retriever_a[0]", RECORD), "p1")
        self.assertEqual(paths.evaluate("$.passages.retriever_a[-1]", RECORD), "p3")
        self.assertEqual(paths.evaluate("$['dash-key']", RECORD), True)
        self.assertEqual(paths.evaluate("$.dash-key", RECORD), True)
        self.assertEqual(paths.evaluate("$.labels['Passage 1']['Fact 1'][0]", RECORD), "Yes")
        self.assertEqual(paths.evaluate("$.labels['it\\'s'][\"say \\\"hi\\\"\"]", RECORD), 7)

    def test_wildcards(self):
        self.assertEqual(paths.evaluate("$.passages.retriever_a[*]", RECORD), ["p1", "p2", "p3"])
        self.assertEqual(paths.evaluate("$.facts.model_a[*]", RECORD), ["f1", "f2"])
        self.assertEqual(paths.evaluate("$.facts.model_a.*", RECORD), ["f1", "f2"])
        self.assertEqual(paths.evaluate("$.pairs[*].b[*]", RECORD), [1, 2, 3])
        self.assertEqual(paths.evaluate("$.pairs[*].b", RECORD), [[1, 2], "not a list", [3]])
        self.assertEqual(paths.evaluate("$.passages[*][0]", RECORD), ["p1"])
        self.assertEqual(paths.evaluate("$.facts[*][*]", RECORD), ["f1", "f2"])

    def test_missing(self):
        self.assertIs(paths.evaluate("$.nope", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.question.deeper", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.passages.retriever_a[3]", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.passages.retriever_a[-4]", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.passages.retriever_a.x", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.facts[0]", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.question[*]", RECORD), MISSING)
        self.assertIs(paths.evaluate("$.nope[*]", RECORD), MISSING)
        self.assertEqual(paths.evaluate("$.pairs[*].c", RECORD), [0])
        self.assertEqual(paths.evaluate("$.pairs[*].zzz", RECORD), [])

    def test_missing_sentinel(self):
        self.assertFalse(MISSING)
        self.assertEqual(repr(MISSING), "MISSING")
        self.assertIs(paths.Missing(), MISSING)
        self.assertIs(pickle.loads(pickle.dumps(MISSING)), MISSING)

    def test_variables(self):
        variables = {"passage_no": 1, "target_no": 1, "passage": "p1", "obj": {"text": "t"}}
        self.assertEqual(paths.evaluate("$.labels['Passage {passage_no}']['Fact {target_no}'][0]", RECORD, variables), "Yes")
        self.assertEqual(paths.evaluate("{passage}", RECORD, variables), "p1")
        self.assertEqual(paths.evaluate("{obj}.text", RECORD, variables), "t")
        self.assertIs(paths.evaluate("{passage}.text", RECORD, variables), MISSING)
        self.assertEqual(paths.evaluate("$.passages.retriever_a[{passage_no}]", RECORD, variables), "p2")
        with self.assertRaises(PathError):
            paths.evaluate("$.labels['Passage {unknown}']", RECORD, variables)
        with self.assertRaises(PathError):
            paths.evaluate("{unknown}.text", RECORD, variables)
        with self.assertRaises(PathError):
            paths.evaluate("{passage}", RECORD)

    def test_substitute(self):
        self.assertEqual(paths.substitute("$.a['Fact {n}'][{n}]", {"n": 2}), "$.a['Fact 2'][2]")
        self.assertEqual(paths.substitute("{p}.x['{k}']", {"p": "ignored", "k": "key"}), "{p}.x['key']")
        self.assertEqual(paths.substitute("$.a['{k}']", {"k": "{again}"}), "$.a['{again}']")
        self.assertEqual(paths.substitute("$.a", {}), "$.a")
        with self.assertRaises(PathError):
            paths.substitute("$.a['{k}']", {})


if __name__ == "__main__":
    unittest.main()
