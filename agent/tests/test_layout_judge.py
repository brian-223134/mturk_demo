"""agent/layout_judge.py: 그려진 페이지가 요청한 배치대로인지 판정하는 단계의 요청 조립과 답 정리. 네트워크는 쓰지 않는다."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import layout_judge
from agent.config import load_model_config
from agent.planner.openrouter import PlannerError

PAGE = {"width": 1100, "tabs": 0, "blocks": [{"kind": "value", "label": "Passage", "text": "A passage.", "x": 0, "w": 60, "y": 120, "h": 200}, {"kind": "question", "label": "Does it answer?", "x": 62, "w": 38, "y": 120, "h": 150}]}
REQUEST = {"request": "Put the questions on the right of the passage.", "page": PAGE}
MODELS_DIR = Path(__file__).resolve().parents[2] / "environment" / "models"


def config():
    return load_model_config("deepseek-v4.1-flash", MODELS_DIR)


class JudgeTest(unittest.TestCase):
    def fake(self, reply):
        planner = mock.MagicMock()
        planner.complete.return_value = reply
        planner.total_usage = {"calls": 1, "cost": 0.0005}
        planner.last_provider = "Crusoe"
        return mock.patch.object(layout_judge, "OpenRouterPlanner", return_value=planner)

    def test_messages_hold_the_request_and_the_measured_page(self):
        messages = layout_judge.build_messages(REQUEST)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn("# Checking a task page against the request", messages[0]["content"])
        self.assertIn("Put the questions on the right", messages[1]["content"])
        self.assertIn('"x": 62', messages[1]["content"])
        self.assertNotIn('"fixed"', messages[1]["content"])
        with_fixed = layout_judge.build_messages({**REQUEST, "fixed": ["Query is shown for each item."]})
        self.assertIn("Query is shown for each item.", with_fixed[1]["content"])

    def test_checks_are_cleaned(self):
        reply = {"checks": [{"wish": " questions on the right ", "result": "met", "evidence": "x 62%"}, {"wish": "bold title", "result": "maybe"}, {"result": "met"}, "bad"], "message": "Mostly fine."}
        with self.fake(reply):
            result = layout_judge.judge_layout(config(), "key", True, REQUEST)
        self.assertEqual(result["checks"], [{"wish": "questions on the right", "result": "met", "evidence": "x 62%"}, {"wish": "bold title", "result": "unclear", "evidence": ""}])
        self.assertEqual(result["message"], "Mostly fine.")
        self.assertEqual(result["provider"], "Crusoe")

    def test_without_permission_the_call_stops_before_the_network(self):
        with self.assertRaises(PlannerError):
            layout_judge.judge_layout(config(), "key", False, REQUEST)

    def test_command_writes_the_reply_file(self):
        result = {"checks": [], "message": None, "usage": None, "provider": "P"}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(layout_judge, "judge_layout", return_value=result):
            request = Path(tmp) / "request.json"
            request.write_text(json.dumps(REQUEST), encoding="utf-8")
            out = Path(tmp) / "reply.json"
            code = layout_judge.main([str(request), "--out", str(out), "--models-dir", str(MODELS_DIR)])
            reply = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(reply["model"]["served_by"], "P")


if __name__ == "__main__":
    unittest.main()
