"""agent/binding.py: LLM 이 binding 을 쓰는 단계의 요청 조립과 호출. 네트워크는 쓰지 않는다."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import binding as binding_module
from agent.config import load_model_config
from agent.planner.openrouter import PlannerError

REQUEST = {
    "design": {"id": "item-list", "rows": [{"slots": ["data", "item-choice"]}]},
    "task_type": "text",
    "prompt": "Check which facts each chunk supports.",
    "data": {"hit_count": 2, "columns": [{"name": "chunks", "shape": "list[3] of str", "samples": [["a"]]}]},
}
MODELS_DIR = Path(__file__).resolve().parents[2] / "environment" / "models"


def config():
    return load_model_config("deepseek-v4.1-flash", MODELS_DIR)


class MessagesTest(unittest.TestCase):
    def test_first_request(self):
        messages = binding_module.build_messages(REQUEST)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn("# Binding format", messages[0]["content"])
        self.assertIn("Check which facts each chunk supports.", messages[1]["content"])
        self.assertIn('"name": "chunks"', messages[1]["content"])
        self.assertIn("item-list", messages[1]["content"])

    def test_errors_add_the_previous_answer(self):
        messages = binding_module.build_messages({**REQUEST, "previous": {"design": "x"}, "errors": ["no column"]})
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), {"design": "x"})
        self.assertIn("- no column", messages[3]["content"])

    def test_revision_sends_the_current_binding_and_earlier_requests(self):
        current = {"design": "item-list", "slots": {"data": {"from": "chunks[i]"}}}
        messages = binding_module.build_messages({**REQUEST, "current": current, "earlier_requests": ["Use Yes and No."]})
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertTrue(messages[1]["content"].startswith("Revise the current binding"))
        self.assertIn('"current"', messages[1]["content"])
        self.assertIn("Use Yes and No.", messages[1]["content"])

    def test_first_write_has_no_current_key(self):
        messages = binding_module.build_messages({**REQUEST, "current": None, "earlier_requests": []})
        self.assertTrue(messages[1]["content"].startswith("Write the binding"))
        self.assertNotIn('"current"', messages[1]["content"])
        self.assertNotIn('"earlier_requests"', messages[1]["content"])

    def test_retry_of_a_revision_keeps_the_current_binding(self):
        current = {"design": "item-list"}
        messages = binding_module.build_messages({**REQUEST, "current": current, "previous": {"design": "x"}, "errors": ["no column"]})
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertIn('"current"', messages[1]["content"])

    def test_message_language_is_asked_right_before_the_request(self):
        for request in (REQUEST, {**REQUEST, "current": {"design": "item-list"}}):
            self.assertIn("Write `message` in the language of `request`.", binding_module.build_messages(request)[1]["content"].split("```json")[0])

    def test_no_errors_means_no_previous(self):
        messages = binding_module.build_messages({**REQUEST, "previous": {"design": "x"}, "errors": []})
        self.assertEqual(len(messages), 2)


class ConfigTest(unittest.TestCase):
    def test_crusoe_falls_back_to_parasail_and_no_further(self):
        cfg = config()
        self.assertEqual(cfg.model, "deepseek/deepseek-v4.1-flash-1017")
        self.assertIsNone(cfg.provider_tag)
        self.assertEqual(cfg.provider, {"order": ["crusoe", "parasail"], "allow_fallbacks": False, "quantizations": ["fp8"]})
        self.assertEqual(cfg.params["temperature"], 0)
        self.assertEqual(cfg.params["response_format"], {"type": "json_object"})


class WriteTest(unittest.TestCase):
    def test_not_allowed_never_calls_the_network(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            with self.assertRaises(PlannerError):
                binding_module.write_binding(config(), "key", False, REQUEST, Path(tmp))
            self.assertTrue(list(Path(tmp).glob("*request*.json")), "요청은 파일로 남는다")

    def test_design_and_task_type_are_kept_from_the_request(self):
        reply = {"design": "stacked", "task_type": "video", "slots": {"data": {"from": "chunks[i]"}}}
        payload = {"choices": [{"message": {"content": json.dumps(reply)}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.01}}
        with mock.patch("agent.planner.openrouter.OpenRouterPlanner._post", return_value=payload) as post:
            result = binding_module.write_binding(config(), "key", True, REQUEST)
        body = post.call_args.args[0]
        self.assertEqual(body["model"], "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(body["provider"]["order"], ["crusoe", "parasail"])
        self.assertEqual(result["binding"]["design"], "item-list")
        self.assertEqual(result["binding"]["task_type"], "text")
        self.assertEqual(result["binding"]["slots"], reply["slots"])
        self.assertEqual(result["usage"]["cost"], 0.01)

    def test_the_provider_that_answered_comes_back(self):
        payload = {"provider": "Parasail", "choices": [{"message": {"content": json.dumps({"slots": {}})}, "finish_reason": "stop"}], "usage": {"cost": 0.01}}
        with mock.patch("agent.planner.openrouter.OpenRouterPlanner._post", return_value=payload):
            result = binding_module.write_binding(config(), "key", True, REQUEST)
        self.assertEqual(result["provider"], "Parasail")

    def test_layout_comes_back_with_the_binding(self):
        layout = {"rows": [{"columns": "2fr 3fr", "slots": ["item-choice", "data"]}]}
        result = self.reply_of({"slots": {"data": {"from": "chunks[i]"}}, "layout": layout, "message": "Moved it."})
        self.assertEqual(result["binding"]["layout"], layout)
        self.assertEqual(result["message"], "Moved it.")

    def reply_of(self, reply):
        payload = {"choices": [{"message": {"content": json.dumps(reply)}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.01}}
        with mock.patch("agent.planner.openrouter.OpenRouterPlanner._post", return_value=payload):
            return binding_module.write_binding(config(), "key", True, REQUEST)

    def test_message_is_taken_out_of_the_binding(self):
        result = self.reply_of({"message": "I renamed the options.", "slots": {}})
        self.assertEqual(result["message"], "I renamed the options.")
        self.assertIsNone(result["cannot"])
        self.assertNotIn("message", result["binding"])

    def test_cannot_has_no_binding(self):
        result = self.reply_of({"cannot": "layout", "message": "That needs another rough design."})
        self.assertIsNone(result["binding"])
        self.assertEqual(result["cannot"], "layout")
        self.assertEqual(result["message"], "That needs another rough design.")
        self.assertEqual(result["usage"]["cost"], 0.01)

    def test_unknown_cannot_is_format_and_a_blank_message_is_none(self):
        result = self.reply_of({"cannot": "something else", "message": "  "})
        self.assertEqual(result["cannot"], "format")
        self.assertIsNone(result["message"])


if __name__ == "__main__":
    unittest.main()
