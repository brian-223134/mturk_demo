"""render 모듈: placeholder 집합, LAYOUT, 위젯, TASK_ANSWER_SCHEMA, attention 숨김, instructions escape, 크기, `${` 거부."""

import copy
import json
import re
import tempfile
import unittest
from pathlib import Path

from agent import render, spec
from agent.validate import extract_placeholders

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
COVERAGE_DIR = EXAMPLE_DIR.parent / "coverage"


def variant(base: spec.TaskSpec, mutate) -> spec.TaskSpec:
    data = copy.deepcopy(spec.spec_to_dict(base))
    mutate(data)
    return spec.parse_spec(data)


def layout_of(html: str) -> dict:
    match = re.search(r"^var LAYOUT = (.*);$", html, re.MULTILINE)
    assert match, "LAYOUT not found"
    return json.loads(match.group(1))


class RenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        cls.html = render.render_template(cls.spec)

    def test_placeholders_are_exactly_the_columns(self):
        self.assertEqual(extract_placeholders(self.html), ["hit_id", "question", "passage", "facts"])
        self.assertEqual(len(re.findall(r"\$\{", self.html)), 4)
        self.assertNotIn("`", self.html)
        self.assertIn("var HIT_ID = ${hit_id};", self.html)
        self.assertNotIn("ATTENTION", self.html)
        self.assertIn('FIELDS["passage"] = ${passage};', self.html)

    def test_layout(self):
        layout = layout_of(self.html)
        self.assertEqual(layout["title"], self.spec.task.title)
        self.assertEqual([f["name"] for f in layout["fields"]], ["question", "passage", "facts"])
        self.assertEqual(layout["fields"][1], {"name": "passage", "label": "Passage", "role": "context", "style": "passage"})
        self.assertEqual((layout["target"], layout["target_label"]), ("facts", "Statement"))
        self.assertEqual(layout["blocks"], [{"kind": "targets", "questions": [0]}])
        question = layout["questions"][0]
        self.assertEqual(question["text"], "Is this statement supported by the passage?")
        self.assertEqual(question["options"], [{"value": "grounded", "label": "Supported"}, {"value": "not_grounded", "label": "Not supported"}])
        self.assertEqual((question["id"], question["type"], question["scope"], question["suffix"]), ("support", "choice", "target", "_support"))
        self.assertEqual((question["values"], question["required"], question["required_when"]), (["grounded", "not_grounded"], True, None))

    def test_layout_escapes_angle_brackets(self):
        angled = variant(self.spec, lambda d: d["item"]["questions"][0].__setitem__("text", "Is <this> **really** supported?"))
        html = render.render_template(angled)
        self.assertNotIn("<this>", html.split("var LAYOUT")[1].split("\n")[0])
        self.assertEqual(layout_of(html)["questions"][0]["text"], "Is &lt;this&gt; <strong>really</strong> supported?")

    def test_structure(self):
        for marker in ("crowd-html-elements.js", "<crowd-form>", "</crowd-form>", 'id="summary-tabs"', "input_answers",
                       'id="submitButton"', "handleFormSubmit", "function esc(", "shadowRoot", '[slot="header"]',
                       "answer(s) remaining", "Instructions", "Background", "How to evaluate", "Notes", "Tip:",
                       "Attention Check Notice", "Research Use Notice", "Your current progress", "Click the tab numbers"):
            self.assertIn(marker, self.html, marker)
        self.assertLess(self.html.index("<crowd-form>"), self.html.index("<script>\nvar HIT_ID"))
        self.assertLess(self.html.index("</crowd-form>"), self.html.index("<style>"))
        self.assertIn("return 'general_' + i", self.html)
        self.assertIn("window.TASK_ANSWER_SCHEMA = ", self.html)
        # crowd-html-elements가 입력의 change를 문서까지 올리지 않으므로 capture 단계에서 듣는다
        self.assertEqual(self.html.count("}, true);"), 2)
        # 페이지 어디에도 attention 탭을 가리는 표시나 참조 라벨 컬럼이 없다
        for absent in ("attention_", "llm_label", "llm_reason", "attention_expected", "${attention}"):
            self.assertNotIn(absent, self.html)

    def test_instructions_are_escaped_and_bold_is_kept(self):
        def mutate(d):
            d["instructions"]["summary"] = "Judge <b>only</b> the **passage** & nothing else."
            d["instructions"]["criteria"][0]["label"] = "A & B"
            d["instructions"]["steps"] = ["Step with **bold** and <i>tags</i>"]
            d["instructions"]["tip"] = "Tip <script>alert(1)</script>"
        html = render.render_template(variant(self.spec, mutate))
        self.assertIn("Judge &lt;b&gt;only&lt;/b&gt; the <strong>passage</strong> &amp; nothing else.", html)
        self.assertIn('<span class="crit-label">A &amp; B</span>', html)
        self.assertIn("Step with <strong>bold</strong> and &lt;i&gt;tags&lt;/i&gt;", html)
        self.assertIn("Tip &lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertEqual(html.count("</script"), 2)
        self.assertNotIn("<i>tags</i>", html)
        for step in self.spec.instructions.steps:
            self.assertIn(render.rich(step), self.html)

    def test_optional_sections(self):
        def mutate(d):
            d["instructions"].update({"background": None, "notes": [], "tip": None, "notices": {"attention": False, "research": False}})
        html = render.render_template(variant(self.spec, mutate))
        for absent in ("Background", "<h3>Notes</h3>", 'class="notice-box notice-tip"', 'class="notice-box notice-attention"',
                       'class="notice-box notice-research"'):
            self.assertNotIn(absent, html)
        self.assertIn('class="notice-box notice-attention"', self.html)
        self.assertIn('class="notice-box notice-research"', self.html)

    def test_size(self):
        self.assertLessEqual(len(self.html.encode("utf-8")), 40 * 1024)

    def test_placeholder_syntax_in_spec_is_rejected(self):
        for mutate in (
            lambda d: d["instructions"].__setitem__("summary", "Do not type ${anything}."),
            lambda d: d["item"]["questions"][0].__setitem__("text", "Is ${x} supported?"),
            lambda d: d["item"]["fields"]["passage"].__setitem__("label", "Pass${age}"),
            lambda d: d["task"].__setitem__("title", "T ${itle}"),
        ):
            with self.assertRaises(ValueError):
                render.render_template(variant(self.spec, mutate))

    def test_legacy_spec_renders_like_v2(self):
        legacy = copy.deepcopy(spec.spec_to_dict(self.spec))
        question = legacy["item"].pop("questions")[0]
        legacy["spec_version"] = 1
        legacy["item"]["iterate"] = [{"var": "passage", "path": "$.passages.retriever_a", "limit": 4}]
        legacy["item"]["question"] = {"text": question["text"], "options": question["options"], "answer_suffix": ""}
        legacy["item"]["hint"] = {k: v for k, v in question["hint"].items() if k != "contains"}
        legacy["hit"]["attention"]["expected_value"] = legacy["hit"]["attention"].pop("expected")["support"]
        del legacy["output"]["attention_column"]
        html = render.render_template(spec.parse_spec(legacy))
        layout = layout_of(html)
        self.assertEqual(layout["questions"][0]["suffix"], "")
        self.assertEqual(layout["questions"][0]["id"], "answer")
        # LAYOUT 한 줄만 다르다 (문항 id와 접미어)
        self.assertEqual(html.split("var LAYOUT")[0], self.html.split("var LAYOUT")[0])
        self.assertEqual(html.split("var LAYOUT")[1].split("\n", 1)[1], self.html.split("var LAYOUT")[1].split("\n", 1)[1])
        self.assertNotIn("attention_", html)

    def test_run_render_writes_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = render.run_render(self.spec, Path(tmp))
            self.assertEqual(path.name, "template.html")
            self.assertEqual(path.read_text(encoding="utf-8"), self.html)



class WidgetTest(unittest.TestCase):
    """문항 종류별 위젯: multi_select 체크박스와 "해당 없음", item 문항 카드, text 상자, likert 척도."""

    @classmethod
    def setUpClass(cls):
        cls.spec = spec.load_spec(COVERAGE_DIR / "task_spec.json")
        cls.html = render.render_template(cls.spec)

    def test_coverage_layout(self):
        layout = layout_of(self.html)
        self.assertEqual(layout["blocks"], [{"kind": "multi", "questions": [0]}, {"kind": "item", "questions": [1]},
                                            {"kind": "item", "questions": [2]}])
        relevant, coverage, missing = layout["questions"]
        self.assertEqual((relevant["type"], relevant["none_label"], relevant["values"]),
                         ("multi_select", "None of the statements helps answer it", ["relevant", "not_relevant"]))
        self.assertEqual(relevant["text"], "Which statements help answer the <strong>sub-question</strong>? Tick every statement "
                                           "that gives part or all of its answer.")
        self.assertEqual((coverage["scope"], coverage["suffix"]), ("item", "_coverage"))
        self.assertEqual((missing["type"], missing["values"], missing["min_chars"]), ("text", [], 10))
        self.assertEqual(missing["required_when"], {"question": "coverage", "value": "not_covered"})
        self.assertEqual(extract_placeholders(self.html), ["hit_id", "question", "subquestion", "statements"])

    def test_widget_markup(self):
        for marker in ('type="checkbox"', 'data-none="1"', "data-group", "chk-opt", "chk-none", "multi-body", "q-card",
                       '<textarea class="ft"', "ft-count", "req-note", "likertRow", "TASK_ANSWER_SCHEMA",
                       "required: !!q.required && !q.required_when", "input[name^=\"general_\"], textarea[name^=\"general_\"]"):
            self.assertIn(marker, self.html, marker)
        for absent in ("attention_", "llm_label", "attention_expected"):
            self.assertNotIn(absent, self.html)
        self.assertLessEqual(len(self.html.encode("utf-8")), 40 * 1024)
        self.assertEqual(self.html.count("</script"), 2)

    def test_likert_layout(self):
        def mutate(d):
            d["item"]["questions"].append({"id": "confidence", "text": "How sure are you?", "type": "likert", "scope": "item",
                                           "scale": {"min": 1, "max": 5, "min_label": "Guessing", "max_label": "Certain"}})
        html = render.render_template(variant(self.spec, mutate))
        question = layout_of(html)["questions"][3]
        self.assertEqual(question["values"], ["1", "2", "3", "4", "5"])
        self.assertEqual(question["scale"], {"min": 1, "max": 5, "min_label": "Guessing", "max_label": "Certain"})
        self.assertEqual(question["options"], [])


if __name__ == "__main__":
    unittest.main()
