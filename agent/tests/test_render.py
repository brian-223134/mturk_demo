"""render 모듈: placeholder 집합, LAYOUT, instructions escape, 크기, `${` 거부."""

import copy
import json
import re
import tempfile
import unittest
from pathlib import Path

from agent import render, spec
from agent.validate import extract_placeholders

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"


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
        self.assertEqual(extract_placeholders(self.html), ["hit_id", "attention", "question", "passage", "facts"])
        self.assertEqual(len(re.findall(r"\$\{", self.html)), 5)
        self.assertNotIn("`", self.html)
        self.assertIn("var HIT_ID = ${hit_id};", self.html)
        self.assertIn("var ATTENTION = ${attention};", self.html)
        self.assertIn('FIELDS["passage"] = ${passage};', self.html)

    def test_layout(self):
        layout = layout_of(self.html)
        self.assertEqual(layout["title"], self.spec.task.title)
        self.assertEqual([f["name"] for f in layout["fields"]], ["question", "passage", "facts"])
        self.assertEqual(layout["fields"][1], {"name": "passage", "label": "Passage", "role": "context", "style": "passage"})
        self.assertEqual((layout["target"], layout["target_label"]), ("facts", "Statement"))
        self.assertEqual(layout["question"], "Is this statement supported by the passage?")
        self.assertEqual(layout["options"], [{"value": "grounded", "label": "Supported"}, {"value": "not_grounded", "label": "Not supported"}])
        self.assertEqual(layout["answer_suffix"], "")

    def test_layout_escapes_angle_brackets(self):
        angled = variant(self.spec, lambda d: d["item"]["question"].__setitem__("text", "Is <this> supported?"))
        html = render.render_template(angled)
        self.assertNotIn("<this>", html.split("var LAYOUT")[1].split("\n")[0])
        self.assertEqual(layout_of(html)["question"], "Is <this> supported?")

    def test_structure(self):
        for marker in ("crowd-html-elements.js", "<crowd-form>", "</crowd-form>", 'id="summary-tabs"', "input_answers",
                       'id="submitButton"', "handleFormSubmit", "function esc(", "shadowRoot", '[slot="header"]',
                       "answer(s) remaining", "Instructions", "Background", "How to evaluate", "Notes", "Tip:",
                       "Attention Check Notice", "Research Use Notice", "Your current progress", "Click the tab numbers"):
            self.assertIn(marker, self.html, marker)
        self.assertLess(self.html.index("<crowd-form>"), self.html.index("<script>\nvar HIT_ID"))
        self.assertLess(self.html.index("</crowd-form>"), self.html.index("<style>"))
        self.assertIn("'attention_' : 'general_'", self.html)

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
            lambda d: d["item"]["question"].__setitem__("text", "Is ${x} supported?"),
            lambda d: d["item"]["fields"]["passage"].__setitem__("label", "Pass${age}"),
            lambda d: d["task"].__setitem__("title", "T ${itle}"),
        ):
            with self.assertRaises(ValueError):
                render.render_template(variant(self.spec, mutate))

    def test_run_render_writes_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = render.run_render(self.spec, Path(tmp))
            self.assertEqual(path.name, "template.html")
            self.assertEqual(path.read_text(encoding="utf-8"), self.html)


if __name__ == "__main__":
    unittest.main()
