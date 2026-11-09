"""agent/html_writer.py: Agent 가 task 페이지 HTML 을 쓰는 단계의 요청 조립과 호출. 네트워크는 쓰지 않는다."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import html_writer
from agent.config import load_model_config
from agent.planner.openrouter import PlannerError

REQUEST = {
    "task_type": "text",
    "request": "Put the question on the right.",
    "template": '<script src="/elements/ann-elements.js"></script><ann-form><ann-text>${slot_data}</ann-text></ann-form>',
    "columns": [{"name": "slot_data", "role": "text", "sample": "A passage."}],
    "questions": [{"tag": "ann-choice", "name": "relevance"}],
}
MODELS_DIR = Path(__file__).resolve().parents[2] / "environment" / "models"


def config():
    return load_model_config("deepseek-v4.1-flash", MODELS_DIR)


class MessagesTest(unittest.TestCase):
    def test_first_request_has_the_reference_and_the_task(self):
        messages = html_writer.build_messages(REQUEST)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn("# Writing a task page", messages[0]["content"])
        self.assertIn("Put the question on the right.", messages[1]["content"])
        self.assertIn("${slot_data}", messages[1]["content"])

    def test_only_known_keys_are_sent(self):
        messages = html_writer.build_messages({**REQUEST, "secret": "slot_reference"})
        self.assertNotIn("secret", messages[1]["content"])

    def test_errors_add_the_previous_page(self):
        messages = html_writer.build_messages({**REQUEST, "previous": "<p>old</p>", "errors": ["missing column"]})
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), {"html": "<p>old</p>"})
        self.assertIn("- missing column", messages[3]["content"])


class WriteHtmlTest(unittest.TestCase):
    def fake(self, reply):
        planner = mock.MagicMock()
        planner.complete.return_value = reply
        planner.total_usage = {"calls": 1, "cost": 0.002}
        planner.last_provider = "Crusoe"
        return mock.patch.object(html_writer, "OpenRouterPlanner", return_value=planner)

    def test_page_and_message(self):
        with self.fake({"html": "<ann-form></ann-form>", "message": "Done."}):
            result = html_writer.write_html(config(), "key", True, REQUEST)
        self.assertEqual(result, {"html": "<ann-form></ann-form>", "cannot": None, "message": "Done.", "usage": {"calls": 1, "cost": 0.002}, "provider": "Crusoe"})

    def test_cannot(self):
        with self.fake({"cannot": "anything", "message": "No."}):
            result = html_writer.write_html(config(), "key", True, REQUEST)
        self.assertIsNone(result["html"])
        self.assertEqual(result["cannot"], "format")

    def test_non_text_html_becomes_empty_for_the_checks(self):
        with self.fake({"html": ["not", "text"]}):
            result = html_writer.write_html(config(), "key", True, REQUEST)
        self.assertEqual(result["html"], "")
        self.assertIsNone(result["message"])

    def test_without_permission_the_call_stops_before_the_network(self):
        with self.assertRaises(PlannerError):
            html_writer.write_html(config(), "key", False, REQUEST)


class CommandTest(unittest.TestCase):
    def test_writes_the_reply_file(self):
        with tempfile.TemporaryDirectory() as tmp, self.fake_writer({"html": "<p>x</p>", "cannot": None, "message": "ok", "usage": None, "provider": "P"}):
            request = Path(tmp) / "request.json"
            request.write_text(json.dumps(REQUEST), encoding="utf-8")
            out = Path(tmp) / "reply.json"
            code = html_writer.main([str(request), "--out", str(out), "--models-dir", str(MODELS_DIR)])
            reply = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(reply["html"], "<p>x</p>")
        self.assertEqual(reply["model"]["served_by"], "P")

    def test_a_failed_call_writes_the_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            request = Path(tmp) / "request.json"
            request.write_text(json.dumps(REQUEST), encoding="utf-8")
            out = Path(tmp) / "reply.json"
            with mock.patch.object(html_writer, "write_html", side_effect=PlannerError("not allowed")):
                code = html_writer.main([str(request), "--out", str(out), "--models-dir", str(MODELS_DIR)])
            reply = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 1)
        self.assertEqual(reply, {"error": "not allowed"})

    def fake_writer(self, result):
        return mock.patch.object(html_writer, "write_html", return_value=result)


if __name__ == "__main__":
    unittest.main()
