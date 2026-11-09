"""agent/contract_writer.py: Agent 가 자유 계약을 쓰는 단계의 요청 조립과 호출. 네트워크는 쓰지 않는다."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import contract_writer
from agent.config import load_model_config
from agent.planner.openrouter import PlannerError

REQUEST = {
    "request": "Ask Yes or No for each passage. gold has the answers.",
    "data": {"hit_count": 2, "columns": [{"name": "passage", "shape": "str", "samples": ["A passage."]}, {"name": "gold", "shape": "str", "samples": ["yes"]}]},
}
MODELS_DIR = Path(__file__).resolve().parents[2] / "environment" / "models"
CONTRACT = {"instructions": "Read.", "fields": [{"id": "p", "from": "passage"}], "questions": [{"name": "a", "type": "choice", "header": "Q?", "options": ["yes", "no"]}]}


def config():
    return load_model_config("deepseek-v4.1-flash", MODELS_DIR)


class MessagesTest(unittest.TestCase):
    def test_first_request_has_the_reference_and_the_task(self):
        messages = contract_writer.build_messages(REQUEST)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn("# Task contract format", messages[0]["content"])
        self.assertIn("gold has the answers", messages[1]["content"])
        self.assertIn('"name": "passage"', messages[1]["content"])

    def test_errors_add_the_previous_contract(self):
        messages = contract_writer.build_messages({**REQUEST, "previous": CONTRACT, "errors": ["no column"]})
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), {"contract": CONTRACT})
        self.assertIn("- no column", messages[3]["content"])


class WriteContractTest(unittest.TestCase):
    def fake(self, reply):
        planner = mock.MagicMock()
        planner.complete.return_value = reply
        planner.total_usage = {"calls": 1, "cost": 0.001}
        planner.last_provider = "Crusoe"
        return mock.patch.object(contract_writer, "OpenRouterPlanner", return_value=planner)

    def test_contract_and_message(self):
        with self.fake({"contract": CONTRACT, "message": "Done."}):
            result = contract_writer.write_contract(config(), "key", True, REQUEST)
        self.assertEqual(result["contract"], CONTRACT)
        self.assertEqual(result["message"], "Done.")
        self.assertIsNone(result["cannot"])

    def test_a_bare_contract_is_read_as_the_contract(self):
        with self.fake({**CONTRACT, "message": "Done."}):
            result = contract_writer.write_contract(config(), "key", True, REQUEST)
        self.assertEqual(result["contract"], CONTRACT)

    def test_cannot(self):
        with self.fake({"cannot": "x", "message": "No."}):
            result = contract_writer.write_contract(config(), "key", True, REQUEST)
        self.assertIsNone(result["contract"])
        self.assertEqual(result["cannot"], "format")

    def test_without_permission_the_call_stops_before_the_network(self):
        with self.assertRaises(PlannerError):
            contract_writer.write_contract(config(), "key", False, REQUEST)

    def test_command_writes_the_reply_file(self):
        result = {"contract": CONTRACT, "cannot": None, "message": "ok", "usage": None, "provider": "P"}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(contract_writer, "write_contract", return_value=result):
            request = Path(tmp) / "request.json"
            request.write_text(json.dumps(REQUEST), encoding="utf-8")
            out = Path(tmp) / "reply.json"
            code = contract_writer.main([str(request), "--out", str(out), "--models-dir", str(MODELS_DIR)])
            reply = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(reply["contract"], CONTRACT)
        self.assertEqual(reply["model"]["served_by"], "P")


if __name__ == "__main__":
    unittest.main()
