"""planner: FilePlanner와 run_plan, OpenRouterPlanner의 안전장치·응답 파싱·재시도, 키 순서, 프롬프트 조립.

네트워크는 쓰지 않는다. urllib.request.urlopen을 대역으로 바꾸고, 호출되면 안 되는 자리에는 forbid_network를 둔다.
OpenRouterPlanner에는 ModelConfig를 직접 만들어 준다 (yaml을 읽지 않으므로 PyYAML 없이 돈다).
"""

import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from agent import config
from agent import profile as profile_module
from agent import source
from agent.config import ModelConfig
from agent.planner import FilePlanner, OpenRouterPlanner, PlannerError, build_messages, openrouter, prompts, run_plan
from agent.spec import SpecError, spec_to_dict, validate_against_records, parse_spec

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
REPO_ROOT = EXAMPLE_DIR.parent.parent.parent
ENV_KEYS = (openrouter.KEY_VARIABLE, config.MODEL_VARIABLE, openrouter.ALLOW_VARIABLE)
TEST_PARAMS = {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"}}


def test_config(**overrides):
    """yaml 없이 만든 모델 설정. 경로는 저장소 안이라 dry-run 파일에는 상대 경로로 적힌다."""
    values = dict(name="test", path=REPO_ROOT / "environment" / "models" / "test.yaml", provider="openrouter",
                  model="test/model", params=dict(TEST_PARAMS), timeout_seconds=120, spec_fix_retries=1,
                  profile_max_chars=12000)
    values.update(overrides)
    return ModelConfig(**values)


def clean_env(**values):
    """OPENROUTER_*, AGENT_ALLOW_API 를 지운 환경. values로 일부를 넣을 수 있다."""
    env = {key: value for key, value in os.environ.items() if key not in ENV_KEYS}
    env.update(values)
    return mock.patch.dict(os.environ, env, clear=True)


def load_example():
    _, records = source.load_records(EXAMPLE_DIR / "raw.json")
    prof = profile_module.profile_records(records)
    prompt = (EXAMPLE_DIR / "prompt.txt").read_text(encoding="utf-8")
    spec = json.loads((EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8"))
    return records, prof, prompt, spec


def reply(content):
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


def forbid_network(*args, **kwargs):
    raise AssertionError("urllib.request.urlopen must not be called")


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpenRouter:
    """urlopen 대역. 준비한 응답을 차례로 돌려주고 요청을 기록한다. 응답이 예외면 그 예외를 던진다."""

    def __init__(self, *payloads):
        self.payloads = list(payloads)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        if not self.payloads:
            raise AssertionError("unexpected API call")
        payload = self.payloads.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return FakeResponse(payload)

    def body(self, index=-1):
        return json.loads(self.requests[index][0].data.decode("utf-8"))


class ExampleCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, cls.profile, cls.prompt, cls.spec = load_example()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()


class FilePlannerTest(ExampleCase):
    def test_plan_returns_file_content(self):
        planner = FilePlanner(EXAMPLE_DIR / "task_spec.json")
        self.assertEqual(planner.name, "file")
        self.assertEqual(planner.max_retries, 0)
        self.assertEqual(planner.plan(self.profile, self.prompt), self.spec)

    def test_missing_or_invalid_file(self):
        with self.assertRaises(PlannerError):
            FilePlanner(self.out / "nope.json").plan(self.profile, self.prompt)
        bad = self.out / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        with self.assertRaises(PlannerError):
            FilePlanner(bad).plan(self.profile, self.prompt)
        bad.write_text("[1, 2]", encoding="utf-8")
        with self.assertRaises(PlannerError):
            FilePlanner(bad).plan(self.profile, self.prompt)


class RunPlanTest(ExampleCase):
    def test_writes_task_spec(self):
        spec = run_plan(self.profile, self.prompt, FilePlanner(EXAMPLE_DIR / "task_spec.json"), self.out, self.records)
        self.assertEqual(spec.task.id, "passage-fact-support")
        written = json.loads((self.out / "task_spec.json").read_text(encoding="utf-8"))
        self.assertEqual(written, self.spec)
        self.assertEqual(written, spec_to_dict(spec))

    def test_without_records_only_parses(self):
        spec = run_plan(self.profile, self.prompt, FilePlanner(EXAMPLE_DIR / "task_spec.json"), self.out)
        self.assertTrue((self.out / "task_spec.json").is_file())
        self.assertEqual(spec.task.title, self.spec["task"]["title"])

    def test_invalid_spec_raises_spec_error_without_retry(self):
        broken = dict(self.spec)
        del broken["task"]
        path = self.out / "broken.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        with self.assertRaises(SpecError) as caught:
            run_plan(self.profile, self.prompt, FilePlanner(path), self.out, self.records)
        self.assertTrue(caught.exception.messages)
        self.assertFalse((self.out / "task_spec.json").exists())

    def test_record_validation_catches_bad_path(self):
        broken = json.loads(json.dumps(self.spec))
        broken["item"]["fields"]["question"]["path"] = "$.no_such_key"
        path = self.out / "broken.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        with self.assertRaises(SpecError) as caught:
            run_plan(self.profile, self.prompt, FilePlanner(path), self.out, self.records)
        self.assertTrue(any("question" in message for message in caught.exception.messages))


class OpenRouterSafetyTest(ExampleCase):
    def test_not_allowed_writes_dry_run_and_never_opens_network(self):
        dry = self.out / "plan_request.json"
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=False, dry_run_path=dry)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertIn("API call not allowed", str(caught.exception))
        self.assertIn("--allow-api", str(caught.exception))
        document = json.loads(dry.read_text(encoding="utf-8"))
        self.assertEqual(set(document), {"model_config", "endpoint", "body"})
        self.assertEqual(document["model_config"], {"name": "test", "path": "environment/models/test.yaml",
                                                    "provider": "openrouter", "model": "test/model"})
        self.assertEqual(document["endpoint"], openrouter.ENDPOINT)
        body = document["body"]
        self.assertEqual(body["model"], "test/model")
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertNotIn("sk-test", dry.read_text(encoding="utf-8"))

    def test_not_allowed_without_dry_run_path(self):
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=False)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError):
                planner.plan(self.profile, self.prompt)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_dry_run_method(self):
        dry = self.out / "sub" / "plan_request.json"
        planner = OpenRouterPlanner(test_config(), None, allow_api=False, dry_run_path=dry)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            self.assertEqual(planner.dry_run(self.profile, self.prompt), dry)
        self.assertTrue(dry.is_file())
        document = json.loads(dry.read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"]["name"], "test")
        self.assertEqual(document["body"]["model"], "test/model")
        with self.assertRaises(PlannerError):
            OpenRouterPlanner(test_config(), None, allow_api=False).dry_run(self.profile, self.prompt)

    def test_config_values_reach_planner(self):
        cfg = test_config(model="vendor/other", timeout_seconds=9, spec_fix_retries=3, profile_max_chars=500,
                          params={"temperature": 0.3, "top_p": 0.9})
        planner = OpenRouterPlanner(cfg, "sk-test", allow_api=False)
        self.assertEqual((planner.model, planner.timeout, planner.max_retries), ("vendor/other", 9, 3))
        body = planner.request_body([{"role": "user", "content": "hi"}])
        self.assertEqual(body, {"model": "vendor/other", "messages": [{"role": "user", "content": "hi"}],
                                "temperature": 0.3, "top_p": 0.9})
        self.assertNotIn("response_format", body)
        with mock.patch.object(prompts, "profile_for_prompt", wraps=prompts.profile_for_prompt) as spy:
            planner.messages(self.profile, self.prompt)
        spy.assert_called_once_with(self.profile, 500)

    def test_path_outside_repo_is_kept_as_is(self):
        outside = Path(self.tmp.name) / "elsewhere.yaml"
        planner = OpenRouterPlanner(test_config(name="elsewhere", path=outside), None, allow_api=False,
                                    dry_run_path=self.out / "plan_request.json")
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            planner.dry_run(self.profile, self.prompt)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"]["path"], str(outside))

    def test_allowed_but_no_key(self):
        planner = OpenRouterPlanner(test_config(), None, allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertIn(openrouter.KEY_VARIABLE, str(caught.exception))


class OpenRouterCallTest(ExampleCase):
    def test_plan_parses_canned_response(self):
        fake = FakeOpenRouter(reply(json.dumps(self.spec)))
        planner = OpenRouterPlanner(test_config(timeout_seconds=7), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            data = planner.plan(self.profile, self.prompt)
        self.assertEqual(data, self.spec)
        request, timeout = fake.requests[0]
        self.assertEqual(request.full_url, openrouter.ENDPOINT)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(timeout, 7)
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer sk-test")
        self.assertEqual(headers["content-type"], "application/json")
        body = fake.body()
        self.assertEqual(body["model"], "test/model")
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(set(body), {"model", "messages", *TEST_PARAMS})
        self.assertIn("# Task spec reference", body["messages"][0]["content"])
        self.assertIn(self.prompt.strip(), body["messages"][1]["content"])

    def test_fenced_json_is_stripped(self):
        fenced = "Here is the spec:\n```json\n" + json.dumps(self.spec, indent=2) + "\n```\n"
        fake = FakeOpenRouter(reply(fenced))
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            self.assertEqual(planner.plan(self.profile, self.prompt), self.spec)
        self.assertEqual(openrouter.strip_code_fences("```\n{\"a\": 1}```"), '{"a": 1}')
        self.assertEqual(openrouter.strip_code_fences('  {"a": 1} '), '{"a": 1}')

    def test_content_as_parts(self):
        parts = [{"type": "text", "text": json.dumps(self.spec)}]
        fake = FakeOpenRouter(reply(parts))
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            self.assertEqual(planner.plan(self.profile, self.prompt), self.spec)

    def test_bad_replies(self):
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=True)
        for payload in (reply("not json at all"), reply("[1, 2]"), {"choices": []}, {"error": {"message": "nope"}}):
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(payload)):
                with self.assertRaises(PlannerError):
                    planner.plan(self.profile, self.prompt)

    def test_http_error(self):
        error = urllib.error.HTTPError(openrouter.ENDPOINT, 401, "Unauthorized", {}, io.BytesIO(b'{"error":"bad key"}'))
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=True)
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    planner.plan(self.profile, self.prompt)
        finally:
            error.close()
        self.assertIn("401", str(caught.exception))
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(urllib.error.URLError("no route"))):
            with self.assertRaises(PlannerError):
                planner.plan(self.profile, self.prompt)


class RetryTest(ExampleCase):
    def broken_spec(self):
        broken = json.loads(json.dumps(self.spec))
        broken["item"]["fields"]["question"]["path"] = "$.no_such_key"
        return broken

    def test_retry_sends_errors_and_previous_answer(self):
        broken = self.broken_spec()
        expected_errors = validate_against_records(parse_spec(broken), self.records)
        self.assertTrue(expected_errors)
        fake = FakeOpenRouter(reply(json.dumps(broken)), reply(json.dumps(self.spec)))
        planner = OpenRouterPlanner(test_config(spec_fix_retries=1), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            spec = run_plan(self.profile, self.prompt, planner, self.out, self.records)
        self.assertEqual(spec_to_dict(spec), self.spec)
        self.assertEqual(len(fake.requests), 2)
        messages = fake.body(1)["messages"]
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), broken)
        for message in expected_errors:
            self.assertIn(message, messages[3]["content"])
        self.assertEqual(json.loads((self.out / "task_spec.json").read_text(encoding="utf-8")), self.spec)

    def test_still_invalid_after_retry(self):
        broken = self.broken_spec()
        fake = FakeOpenRouter(reply(json.dumps(broken)), reply(json.dumps(broken)))
        planner = OpenRouterPlanner(test_config(spec_fix_retries=1), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            with self.assertRaises(SpecError) as caught:
                run_plan(self.profile, self.prompt, planner, self.out, self.records)
        self.assertEqual(len(fake.requests), 2)
        self.assertIn("retry", caught.exception.messages[0])
        self.assertFalse((self.out / "task_spec.json").exists())

    def test_no_retry_when_max_retries_is_zero(self):
        fake = FakeOpenRouter(reply(json.dumps(self.broken_spec())))
        planner = OpenRouterPlanner(test_config(spec_fix_retries=0), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            with self.assertRaises(SpecError):
                run_plan(self.profile, self.prompt, planner, self.out, self.records)
        self.assertEqual(len(fake.requests), 1)


class EnvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_env_file_is_reexported_from_config(self):
        # 읽기 자체는 test_config.py 에서 검사한다. 예전 import 경로가 같은 함수를 가리키는지만 본다.
        self.assertIs(openrouter.load_env_file, config.load_env_file)
        path = self.dir / ".env"
        path.write_text("OPENROUTER_KEY=sk-plain\n", encoding="utf-8")
        self.assertEqual(openrouter.load_env_file(path), {"OPENROUTER_KEY": "sk-plain"})

    def test_resolve_api_key_order(self):
        env_file = self.dir / ".env"
        env_file.write_text("OPENROUTER_KEY=from-file\n", encoding="utf-8")
        with clean_env(OPENROUTER_KEY="from-env"):
            self.assertEqual(openrouter.resolve_api_key("explicit", env_file), "explicit")
            self.assertEqual(openrouter.resolve_api_key(None, env_file), "from-env")
            self.assertEqual(openrouter.resolve_api_key("  ", env_file), "from-env")
        with clean_env():
            self.assertEqual(openrouter.resolve_api_key(None, env_file), "from-file")
            self.assertIsNone(openrouter.resolve_api_key(None, self.dir / "missing"))
            self.assertIsNone(openrouter.resolve_api_key(None, None))

    def test_allow_env(self):
        with clean_env():
            self.assertFalse(openrouter.api_allowed_by_env())
        with clean_env(AGENT_ALLOW_API="1"):
            self.assertTrue(openrouter.api_allowed_by_env())
        with clean_env(AGENT_ALLOW_API="yes"):
            self.assertTrue(openrouter.api_allowed_by_env())
        with clean_env(AGENT_ALLOW_API="0"):
            self.assertFalse(openrouter.api_allowed_by_env())

    def test_model_selection_moved_out_of_openrouter(self):
        for name in ("DEFAULT_MODEL", "MODEL_VARIABLE", "default_model"):
            self.assertFalse(hasattr(openrouter, name), name)


class PromptsTest(ExampleCase):
    def test_messages(self):
        messages = build_messages(self.profile, self.prompt)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        system = messages[0]["content"]
        self.assertIn(prompts.ROLE.splitlines()[0], system)
        self.assertIn("# Task spec reference", system)
        self.assertIn("spec_version", system)
        self.assertIn("no markdown code fences", system)
        user = messages[1]["content"]
        self.assertIn(self.prompt.strip(), user)
        self.assertIn('"paths"', user)
        self.assertIn("$.passages.retriever_a", user)
        self.assertNotIn('"source"', user.split("## What the requester wants")[0].split("\n", 1)[1][:40])

    def test_messages_with_errors(self):
        previous = {"spec_version": 1}
        messages = build_messages(self.profile, self.prompt, errors=["$.task: required", "$.item: required"],
                                  previous=previous)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertEqual(json.loads(messages[2]["content"]), previous)
        self.assertIn("$.task: required", messages[3]["content"])
        self.assertIn("$.item: required", messages[3]["content"])
        self.assertEqual(len(build_messages(self.profile, self.prompt, errors=[])), 2)

    def test_profile_max_chars_is_passed_through(self):
        with mock.patch.object(prompts, "profile_for_prompt", wraps=prompts.profile_for_prompt) as spy:
            build_messages(self.profile, self.prompt)
            build_messages(self.profile, self.prompt, profile_max_chars=700)
        self.assertEqual([call.args[1] for call in spy.call_args_list], [config.DEFAULT_PROFILE_MAX_CHARS, 700])
        short = build_messages(self.profile, self.prompt, profile_max_chars=700)[1]["content"]
        full = build_messages(self.profile, self.prompt)[1]["content"]
        self.assertLess(len(short), len(full))


if __name__ == "__main__":
    unittest.main()
