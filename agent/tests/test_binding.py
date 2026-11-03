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

    def test_no_errors_means_no_previous(self):
        messages = binding_module.build_messages({**REQUEST, "previous": {"design": "x"}, "errors": []})
        self.assertEqual(len(messages), 2)


class ConfigTest(unittest.TestCase):
    def test_model_and_provider_are_pinned(self):
        cfg = config()
        self.assertEqual(cfg.model, "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(cfg.provider_tag, "crusoe/fp8")
        self.assertEqual(cfg.provider, {"order": ["crusoe"], "allow_fallbacks": False, "quantizations": ["fp8"]})
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
        self.assertEqual(body["provider"]["order"], ["crusoe"])
        self.assertEqual(result["binding"]["design"], "item-list")
        self.assertEqual(result["binding"]["task_type"], "text")
        self.assertEqual(result["binding"]["slots"], reply["slots"])
        self.assertEqual(result["usage"]["cost"], 0.01)


if __name__ == "__main__":
    unittest.main()
