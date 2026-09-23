"""planner: FilePlanner와 run_plan, OpenRouterPlanner의 안전장치·응답 파싱·재시도·로그 파일·usage(cost 포함), 키 순서, 프롬프트 조립.

프롬프트는 [system, user(예시 작업), assistant(예시 spec), user(실제 작업)] 이고 재시도 쌍이 뒤에 붙는다 (FEW_SHOT, RETRY).
예시 대화는 프로세스마다 한 번만 만들므로(prompts.example_messages) profile_for_prompt 를 spy 하는 테스트는 먼저 예시를 만들어 둔다.

네트워크는 쓰지 않는다. urllib.request.urlopen을 대역으로 바꾸고, 호출되면 안 되는 자리에는 forbid_network를 둔다.
OpenRouterPlanner에는 ModelConfig를 직접 만들어 준다 (yaml을 읽지 않으므로 PyYAML 없이 돈다).
log_dir 가 있을 때 plan_request*.json / plan_response*.json 이 어떻게 남는지는 OpenRouterLogTest 가 본다.
공개 endpoint 목록(fetch_endpoints, format_endpoints)은 EndpointsTest 가 urlopen 대역과 준비한 payload 로 본다.
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
FEW_SHOT = ["system", "user", "assistant", "user"]          # 시스템, 예시 작업, 예시 spec, 실제 작업
RETRY = FEW_SHOT + ["assistant", "user"]                    # + 직전 답, 수정 요청


def test_config(**overrides):
    """yaml 없이 만든 모델 설정. 경로는 저장소 안이라 dry-run 파일에는 상대 경로로 적힌다."""
    values = dict(name="test", path=REPO_ROOT / "environment" / "models" / "test.yaml", api="openrouter",
                  model="test/model", params=dict(TEST_PARAMS), provider=None, timeout_seconds=120, spec_fix_retries=1,
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
    prompt = (EXAMPLE_DIR / "prompt.md").read_text(encoding="utf-8")
    spec = json.loads((EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8"))
    return records, prof, prompt, spec


def reply(content, **extra):
    """chat completions 응답 모양. extra 로 usage, id 같은 다른 키를 붙인다."""
    payload = {"choices": [{"message": {"role": "assistant", "content": content}}]}
    payload.update(extra)
    return payload


def usage(prompt, completion):
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


MODEL_CONFIG_SUMMARY = {"name": "test", "path": "environment/models/test.yaml", "api": "openrouter",
                        "model": "test/model", "provider": None, "provider_tag": None}
ROUTING = {"order": ["DeepInfra"], "allow_fallbacks": True, "quantizations": ["fp8"]}
TAG_ROUTING = {"order": ["gmicloud"], "allow_fallbacks": False, "quantizations": ["fp8"]}  # config.py 가 "gmicloud/fp8" 을 푼 것

# OpenRouter 의 GET /models/<author>/<slug>/endpoints 응답 모양 (2026-09 기준). 값은 지어낸 것이다.
ENDPOINTS_PAYLOAD = {"data": {"id": "vendor/model", "name": "Vendor: Model", "endpoints": [
    {"name": "Vendor: Model | gmicloud", "provider_name": "GMICloud", "tag": "gmicloud/fp8", "quantization": "fp8",
     "context_length": 131072, "max_completion_tokens": None,
     "pricing": {"prompt": "0.00000015", "completion": "0.0000006", "request": "0", "image": "0"},
     "uptime_last_30m": 99.94, "status": 0, "supported_parameters": ["temperature", "response_format"]},
    {"name": "Vendor: Model | deepinfra", "provider_name": "DeepInfra", "tag": "deepinfra/fp4", "quantization": "fp4",
     "context_length": 131072, "pricing": {"prompt": "0.00000005", "completion": "0.00000024"},
     "uptime_last_30m": 100, "status": 0},
    {"name": "Vendor: Model | venice", "provider_name": "Venice", "tag": "venice", "quantization": None,
     "context_length": 131000, "pricing": {"prompt": "0.00000015", "completion": "0.0000005"}, "status": -2},
    {"name": "Vendor: Model | nopricing", "provider_name": "NoPricing", "tag": "nopricing/bf16", "quantization": "bf16",
     "context_length": None, "uptime_last_30m": 12.345, "status": None},
]}}
ENDPOINTS_TABLE = "\n".join([
    "tag             quantization  context  $in/M  $out/M  uptime30m  status",
    "deepinfra/fp4   fp4            131072   0.05    0.24      100.0  0",
    "venice          -              131000   0.15    0.50          -  -2",
    "gmicloud/fp8    fp8            131072   0.15    0.60       99.9  0",
    "nopricing/bf16  bf16                -      -       -       12.3  -",
    "4 endpoints for vendor/model",
])


def forbid_network(*args, **kwargs):
    raise AssertionError("urllib.request.urlopen must not be called")


class FakeResponse:
    """urlopen 이 돌려주는 응답 대역. payload 가 bytes 면 그대로 (JSON 이 아닌 응답을 흉내낼 때), 아니면 JSON 으로 준다."""

    def __init__(self, payload):
        self.payload = payload

    def read(self):
        if isinstance(self.payload, bytes):
            return self.payload
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
    def test_not_allowed_writes_request_and_never_opens_network(self):
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=False, log_dir=self.out)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertEqual(str(caught.exception), openrouter.NOT_ALLOWED)
        self.assertIn("API call not allowed", str(caught.exception))
        self.assertIn("--allow-api", str(caught.exception))
        # 요청은 안전장치보다 먼저 저장된다 (무엇을 보냈을지 확인할 수 있게). 응답 파일은 없다.
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), ["plan_request.json"])
        request = self.out / "plan_request.json"
        document = json.loads(request.read_text(encoding="utf-8"))
        self.assertEqual(set(document), {"model_config", "endpoint", "body"})
        self.assertEqual(document["model_config"], MODEL_CONFIG_SUMMARY)
        self.assertEqual(document["endpoint"], openrouter.ENDPOINT)
        body = document["body"]
        self.assertEqual(body["model"], "test/model")
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual([m["role"] for m in body["messages"]], FEW_SHOT)
        self.assertNotIn("sk-test", request.read_text(encoding="utf-8"))
        self.assertEqual(planner.calls, 1)
        self.assertIsNone(planner.last_usage)
        self.assertIsNone(planner.total_usage)

    def test_not_allowed_without_log_dir(self):
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=False)
        self.assertIsNone(planner.log_dir)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError):
                planner.plan(self.profile, self.prompt)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_dry_run_method(self):
        log_dir = self.out / "sub"
        planner = OpenRouterPlanner(test_config(), None, allow_api=False, log_dir=log_dir)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            self.assertEqual(planner.dry_run(self.profile, self.prompt), log_dir / "plan_request.json")
        self.assertEqual([path.name for path in log_dir.iterdir()], ["plan_request.json"])
        document = json.loads((log_dir / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"]["name"], "test")
        self.assertEqual(document["body"]["model"], "test/model")
        self.assertEqual(planner.calls, 0)  # dry run 은 호출 횟수에 들어가지 않는다
        with self.assertRaises(PlannerError):
            OpenRouterPlanner(test_config(), None, allow_api=False).dry_run(self.profile, self.prompt)

    def test_dry_run_path_keyword_is_gone(self):
        with self.assertRaises(TypeError):
            OpenRouterPlanner(test_config(), None, allow_api=False, dry_run_path=self.out / "x.json")  # type: ignore[call-arg]

    def test_config_values_reach_planner(self):
        cfg = test_config(model="vendor/other", timeout_seconds=9, spec_fix_retries=3, profile_max_chars=500,
                          params={"temperature": 0.3, "top_p": 0.9})
        planner = OpenRouterPlanner(cfg, "sk-test", allow_api=False)
        self.assertEqual((planner.model, planner.timeout, planner.max_retries), ("vendor/other", 9, 3))
        body = planner.request_body([{"role": "user", "content": "hi"}])
        self.assertEqual(body, {"model": "vendor/other", "messages": [{"role": "user", "content": "hi"}],
                                "temperature": 0.3, "top_p": 0.9})
        self.assertNotIn("response_format", body)
        self.assertNotIn("provider", body)  # 라우팅 설정이 없으면 키 자체가 없다 (OpenRouter 가 고른다)
        prompts.example_messages()  # 예시는 프로세스마다 한 번만 만든다. 미리 만들어 두어 spy 에 잡히지 않게 한다
        with mock.patch.object(prompts, "profile_for_prompt", wraps=prompts.profile_for_prompt) as spy:
            planner.messages(self.profile, self.prompt)
        spy.assert_called_once_with(self.profile, 500)

    def test_provider_routing_is_sent_verbatim(self):
        planner = OpenRouterPlanner(test_config(provider=ROUTING), "sk-test", allow_api=False, log_dir=self.out)
        body = planner.request_body([{"role": "user", "content": "hi"}])
        self.assertEqual(body, {"model": "test/model", "messages": [{"role": "user", "content": "hi"}], **TEST_PARAMS,
                                "provider": ROUTING})
        self.assertIsNot(body["provider"], ROUTING)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            planner.dry_run(self.profile, self.prompt)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"], {**MODEL_CONFIG_SUMMARY, "provider": ROUTING})
        self.assertEqual(document["body"]["provider"], ROUTING)
        # 실제 호출에서도 본문에 그대로 간다
        fake = FakeOpenRouter(reply(json.dumps(self.spec)))
        planner = OpenRouterPlanner(test_config(provider=ROUTING), "sk-test", allow_api=True)
        with mock.patch.object(urllib.request, "urlopen", fake):
            planner.plan(self.profile, self.prompt)
        self.assertEqual(fake.body()["provider"], ROUTING)

    def test_provider_tag_is_sent_as_the_resolved_mapping(self):
        """설정 파일의 태그는 config.py 가 매핑으로 풀어 둔다. 본문에는 매핑만 가고, 로그의 model_config 에 태그가 남는다."""
        cfg = test_config(provider=TAG_ROUTING, provider_tag="gmicloud/fp8")
        planner = OpenRouterPlanner(cfg, "sk-test", allow_api=False, log_dir=self.out)
        body = planner.request_body([{"role": "user", "content": "hi"}])
        self.assertEqual(body["provider"], TAG_ROUTING)
        self.assertNotIn("provider_tag", body)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            planner.dry_run(self.profile, self.prompt)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"],
                         {**MODEL_CONFIG_SUMMARY, "provider": TAG_ROUTING, "provider_tag": "gmicloud/fp8"})
        self.assertEqual(document["body"]["provider"], TAG_ROUTING)
        fake = FakeOpenRouter(reply(json.dumps(self.spec)))
        planner = OpenRouterPlanner(cfg, "sk-test", allow_api=True, log_dir=self.out)
        with mock.patch.object(urllib.request, "urlopen", fake):
            planner.plan(self.profile, self.prompt)
        self.assertEqual(fake.body()["provider"], TAG_ROUTING)
        self.assertNotIn("provider_tag", fake.body())
        response = json.loads((self.out / "plan_response.json").read_text(encoding="utf-8"))
        self.assertEqual(response["model_config"]["provider_tag"], "gmicloud/fp8")

    def test_nested_params_are_sent_as_they_are(self):
        cfg = test_config(params={"temperature": 0, "response_format": {"type": "json_object"},
                                  "reasoning": {"effort": "medium"}})
        planner = OpenRouterPlanner(cfg, "sk-test", allow_api=False, log_dir=self.out)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            planner.dry_run(self.profile, self.prompt)
        body = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))["body"]
        self.assertEqual(body["reasoning"], {"effort": "medium"})
        self.assertEqual(body["response_format"], {"type": "json_object"})

    def test_path_outside_repo_is_kept_as_is(self):
        outside = Path(self.tmp.name) / "elsewhere.yaml"
        planner = OpenRouterPlanner(test_config(name="elsewhere", path=outside), None, allow_api=False,
                                    log_dir=self.out)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            planner.dry_run(self.profile, self.prompt)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"]["path"], str(outside))

    def test_allowed_but_no_key(self):
        planner = OpenRouterPlanner(test_config(), None, allow_api=True, log_dir=self.out)
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertEqual(str(caught.exception), openrouter.NO_KEY)
        self.assertIn(openrouter.KEY_VARIABLE, str(caught.exception))
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), ["plan_request.json"])


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
        self.assertEqual([m["role"] for m in body["messages"]], FEW_SHOT)
        self.assertIn(self.prompt.strip(), body["messages"][-1]["content"])

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


class OpenRouterLogTest(ExampleCase):
    """log_dir 가 있을 때 남는 plan_request*.json / plan_response*.json 과 usage 기록."""

    def names(self):
        return sorted(path.name for path in self.out.iterdir())

    def read(self, name):
        return json.loads((self.out / name).read_text(encoding="utf-8"))

    def planner(self, **overrides):
        return OpenRouterPlanner(test_config(**overrides), "sk-test", allow_api=True, log_dir=self.out)

    def test_success_writes_request_and_response(self):
        payload = reply(json.dumps(self.spec), id="gen-1", model="test/model", usage=usage(1200, 300))
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(payload)):
            self.assertEqual(planner.plan(self.profile, self.prompt), self.spec)
        self.assertEqual(self.names(), ["plan_request.json", "plan_response.json"])
        request = self.read("plan_request.json")
        self.assertEqual(set(request), {"model_config", "endpoint", "body"})
        self.assertEqual(request["model_config"], MODEL_CONFIG_SUMMARY)
        self.assertEqual(request["body"]["model"], "test/model")
        response = self.read("plan_response.json")
        self.assertEqual(response, {"model_config": MODEL_CONFIG_SUMMARY, **payload})
        self.assertEqual(response["usage"], usage(1200, 300))
        self.assertEqual(json.loads(response["choices"][0]["message"]["content"]), self.spec)
        for name in ("plan_request.json", "plan_response.json"):
            self.assertNotIn("sk-test", (self.out / name).read_text(encoding="utf-8"))
        self.assertEqual(planner.calls, 1)
        self.assertEqual(planner.last_usage, usage(1200, 300))
        self.assertEqual(planner.total_usage, {"calls": 1, **usage(1200, 300)})

    def test_log_dir_is_created(self):
        log_dir = self.out / "deep" / "er"
        planner = OpenRouterPlanner(test_config(), "sk-test", allow_api=True, log_dir=log_dir)
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(reply(json.dumps(self.spec)))):
            planner.plan(self.profile, self.prompt)
        self.assertEqual(sorted(path.name for path in log_dir.iterdir()), ["plan_request.json", "plan_response.json"])

    def test_retry_writes_numbered_files(self):
        broken = json.loads(json.dumps(self.spec))
        broken["item"]["fields"]["question"]["path"] = "$.no_such_key"
        fake = FakeOpenRouter(reply(json.dumps(broken), usage=usage(1000, 200)),
                              reply(json.dumps(self.spec), usage=usage(1500, 250)))
        planner = self.planner(spec_fix_retries=1)
        with mock.patch.object(urllib.request, "urlopen", fake):
            spec = run_plan(self.profile, self.prompt, planner, self.out, self.records)
        self.assertEqual(spec_to_dict(spec), self.spec)
        self.assertEqual(self.names(), ["plan_request.json", "plan_request_2.json", "plan_response.json",
                                        "plan_response_2.json", "task_spec.json"])
        first = self.read("plan_request.json")["body"]["messages"]
        second = self.read("plan_request_2.json")["body"]["messages"]
        self.assertEqual([m["role"] for m in first], FEW_SHOT)
        self.assertEqual([m["role"] for m in second], RETRY)
        self.assertEqual(json.loads(self.read("plan_response.json")["choices"][0]["message"]["content"]), broken)
        self.assertEqual(json.loads(self.read("plan_response_2.json")["choices"][0]["message"]["content"]), self.spec)
        self.assertEqual(self.read("plan_response_2.json")["model_config"], MODEL_CONFIG_SUMMARY)
        self.assertEqual(planner.calls, 2)
        self.assertEqual(planner.last_usage, usage(1500, 250))
        self.assertEqual(planner.total_usage, {"calls": 2, "prompt_tokens": 2500, "completion_tokens": 450,
                                               "total_tokens": 2950})

    def test_third_call_is_numbered_3(self):
        planner = self.planner()
        fake = FakeOpenRouter(*(reply(json.dumps(self.spec)) for _ in range(3)))
        with mock.patch.object(urllib.request, "urlopen", fake):
            for _ in range(3):
                planner.plan(self.profile, self.prompt)
        self.assertEqual(self.names(), ["plan_request.json", "plan_request_2.json", "plan_request_3.json",
                                        "plan_response.json", "plan_response_2.json", "plan_response_3.json"])
        self.assertEqual(openrouter.log_file_name("request", 1), "plan_request.json")
        self.assertEqual(openrouter.log_file_name("response", 2), "plan_response_2.json")
        self.assertEqual(openrouter.log_file_name("request", 10), "plan_request_10.json")

    def test_http_error_body_is_in_message_and_file(self):
        body = b'{"error":{"message":"Insufficient credits. Add more credits.","code":402}}'
        error = urllib.error.HTTPError(openrouter.ENDPOINT, 402, "Payment Required", {}, io.BytesIO(body))
        planner = self.planner()
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    planner.plan(self.profile, self.prompt)
        finally:
            error.close()
        message = str(caught.exception)
        self.assertIn("HTTP 402", message)
        self.assertIn("Insufficient credits", message)
        self.assertEqual(self.names(), ["plan_request.json", "plan_response.json"])
        response = self.read("plan_response.json")
        self.assertEqual(response["model_config"], MODEL_CONFIG_SUMMARY)
        self.assertEqual(response["http_status"], 402)
        self.assertEqual(response["http_reason"], "Payment Required")
        self.assertEqual(response["error"], {"message": "Insufficient credits. Add more credits.", "code": 402})
        self.assertNotIn("sk-test", (self.out / "plan_response.json").read_text(encoding="utf-8"))
        self.assertIsNone(planner.last_usage)
        self.assertIsNone(planner.total_usage)

    def test_http_error_text_body_is_cut_in_message_but_whole_in_file(self):
        long_text = "gateway error " * 100
        error = urllib.error.HTTPError(openrouter.ENDPOINT, 502, "Bad Gateway", {}, io.BytesIO(long_text.encode("utf-8")))
        planner = self.planner()
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    planner.plan(self.profile, self.prompt)
        finally:
            error.close()
        message = str(caught.exception)
        self.assertIn("HTTP 502", message)
        self.assertIn("gateway error", message)
        self.assertLess(len(message), openrouter.ERROR_BODY_CHARS + 50)
        response = self.read("plan_response.json")
        self.assertEqual((response["http_status"], response["http_reason"]), (502, "Bad Gateway"))
        self.assertEqual(response["body"], long_text)

    def test_http_error_without_body_uses_reason(self):
        error = urllib.error.HTTPError(openrouter.ENDPOINT, 401, "Unauthorized", {}, io.BytesIO(b""))
        planner = self.planner()
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    planner.plan(self.profile, self.prompt)
        finally:
            error.close()
        self.assertIn("HTTP 401: Unauthorized", str(caught.exception))
        self.assertEqual(self.read("plan_response.json")["http_status"], 401)

    def test_error_field_in_ok_payload_is_written(self):
        payload = {"error": {"message": "provider is down", "code": 503}}
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(payload)):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertIn("provider is down", str(caught.exception))
        self.assertEqual(self.read("plan_response.json"), {"model_config": MODEL_CONFIG_SUMMARY, **payload})

    def test_non_json_response_is_written(self):
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(b"<html>oops</html>")):
            with self.assertRaises(PlannerError) as caught:
                planner.plan(self.profile, self.prompt)
        self.assertIn("not JSON", str(caught.exception))
        self.assertEqual(self.read("plan_response.json"), {"model_config": MODEL_CONFIG_SUMMARY, "body": "<html>oops</html>"})

    def test_network_error_leaves_only_the_request(self):
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(urllib.error.URLError("no route"))):
            with self.assertRaises(PlannerError):
                planner.plan(self.profile, self.prompt)
        self.assertEqual(self.names(), ["plan_request.json"])

    def test_stale_logs_are_removed_before_the_first_write(self):
        for name in ("plan_request.json", "plan_request_2.json", "plan_response.json", "plan_response_2.json",
                     "plan_response_10.json"):
            (self.out / name).write_text("old", encoding="utf-8")
        (self.out / "task_spec.json").write_text("keep", encoding="utf-8")
        (self.out / "plan_requests.json").write_text("keep", encoding="utf-8")  # 이름 규칙에 안 맞는 파일은 그대로
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(reply(json.dumps(self.spec)))):
            planner.plan(self.profile, self.prompt)
        self.assertEqual(self.names(), ["plan_request.json", "plan_requests.json", "plan_response.json", "task_spec.json"])
        self.assertNotEqual((self.out / "plan_request.json").read_text(encoding="utf-8"), "old")
        self.assertEqual((self.out / "task_spec.json").read_text(encoding="utf-8"), "keep")
        # dry run 도 같은 정리를 한다
        (self.out / "plan_response_2.json").write_text("old", encoding="utf-8")
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            OpenRouterPlanner(test_config(), None, allow_api=False, log_dir=self.out).dry_run(self.profile, self.prompt)
        self.assertEqual(self.names(), ["plan_request.json", "plan_requests.json", "task_spec.json"])
        self.assertEqual(openrouter.clear_logs(self.out / "missing"), [])

    def test_usage_is_none_when_the_payload_has_none(self):
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(reply(json.dumps(self.spec)))):
            planner.plan(self.profile, self.prompt)
        self.assertIsNone(planner.last_usage)
        self.assertIsNone(planner.total_usage)
        self.assertNotIn("usage", self.read("plan_response.json"))
        with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(reply(json.dumps(self.spec), usage="n/a"))):
            planner.plan(self.profile, self.prompt)
        self.assertIsNone(planner.last_usage)
        self.assertIsNone(planner.total_usage)

    def test_usage_with_extra_or_missing_keys(self):
        first = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.001,
                 "completion_tokens_details": {"reasoning_tokens": 2}}
        second = {"prompt_tokens": 20}
        fake = FakeOpenRouter(reply(json.dumps(self.spec), usage=first), reply(json.dumps(self.spec), usage=second))
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", fake):
            planner.plan(self.profile, self.prompt)
            planner.plan(self.profile, self.prompt)
        self.assertEqual(planner.last_usage, second)
        self.assertEqual(planner.total_usage, {"calls": 2, "prompt_tokens": 30, "completion_tokens": 5, "total_tokens": 15,
                                               "cost": 0.001})
        self.assertEqual(self.read("plan_response.json")["usage"], first)

    def test_cost_is_summed_when_present(self):
        """usage: {include: true} 로 받은 usage.cost(USD, 실수)는 total_usage 에 더해진다. 숫자가 아니면 뺀다."""
        first = {**usage(10, 5), "cost": 0.0012}
        second = {**usage(20, 7), "cost": 0.0021}
        third = {**usage(1, 1), "cost": "n/a"}
        fake = FakeOpenRouter(*(reply(json.dumps(self.spec), usage=u) for u in (first, second, third)))
        planner = self.planner()
        with mock.patch.object(urllib.request, "urlopen", fake):
            for _ in range(3):
                planner.plan(self.profile, self.prompt)
        self.assertEqual(planner.last_usage, third)
        total = planner.total_usage
        self.assertEqual((total["calls"], total["prompt_tokens"], total["completion_tokens"]), (3, 31, 13))
        self.assertAlmostEqual(total["cost"], 0.0033)
        self.assertEqual(openrouter.USAGE_KEYS, ("prompt_tokens", "completion_tokens", "total_tokens", "cost"))


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
        self.assertEqual([m["role"] for m in messages], RETRY)
        self.assertEqual(json.loads(messages[-2]["content"]), broken)
        for message in expected_errors:
            self.assertIn(message, messages[-1]["content"])
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


class EndpointsTest(unittest.TestCase):
    """공개 endpoint 목록: fetch_endpoints 는 키 없이 GET 하고, format_endpoints 는 값이 싼 순서의 표를 만든다."""

    def test_fetch_uses_the_public_url_without_a_key(self):
        fake = FakeOpenRouter(ENDPOINTS_PAYLOAD)
        with clean_env(OPENROUTER_KEY="sk-must-not-be-sent"), mock.patch.object(urllib.request, "urlopen", fake):
            payload = openrouter.fetch_endpoints("vendor/model", timeout=5)
        self.assertEqual(payload, ENDPOINTS_PAYLOAD)
        request, timeout = fake.requests[0]
        self.assertEqual(request.full_url, "https://openrouter.ai/api/v1/models/vendor/model/endpoints")
        self.assertEqual(request.full_url, openrouter.ENDPOINTS_URL.format(model="vendor/model"))
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(timeout, 5)
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertNotIn("authorization", headers)
        self.assertNotIn("sk-must-not-be-sent", str(headers))
        # timeout 기본값과 model id 의 공백 정리
        fake = FakeOpenRouter(ENDPOINTS_PAYLOAD)
        with mock.patch.object(urllib.request, "urlopen", fake):
            openrouter.fetch_endpoints("  vendor/model ")
        self.assertEqual(fake.requests[0][1], openrouter.ENDPOINTS_TIMEOUT)
        self.assertEqual(openrouter.ENDPOINTS_TIMEOUT, 30)
        self.assertEqual(fake.requests[0][0].full_url, "https://openrouter.ai/api/v1/models/vendor/model/endpoints")

    def test_fetch_rejects_a_model_id_without_author(self):
        with mock.patch.object(urllib.request, "urlopen", forbid_network):
            for model in ("model", "", "  ", "/"):
                with self.subTest(model=model):
                    with self.assertRaises(PlannerError) as caught:
                        openrouter.fetch_endpoints(model)
                    self.assertIn("author/slug", str(caught.exception))

    def test_fetch_http_error_carries_the_body(self):
        body = b'{"error":{"message":"No endpoints found for vendor/model.","code":404}}'
        error = urllib.error.HTTPError(openrouter.ENDPOINTS_URL.format(model="vendor/model"), 404, "Not Found", {},
                                       io.BytesIO(body))
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    openrouter.fetch_endpoints("vendor/model")
        finally:
            error.close()
        message = str(caught.exception)
        self.assertIn("HTTP 404", message)
        self.assertIn("No endpoints found for vendor/model.", message)
        # 긴 본문은 앞 300 자만
        long_text = "gateway error " * 100
        error = urllib.error.HTTPError(openrouter.ENDPOINTS_URL.format(model="vendor/model"), 502, "Bad Gateway", {},
                                       io.BytesIO(long_text.encode("utf-8")))
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    openrouter.fetch_endpoints("vendor/model")
        finally:
            error.close()
        self.assertIn("HTTP 502", str(caught.exception))
        self.assertLess(len(str(caught.exception)), openrouter.ENDPOINTS_ERROR_CHARS + 120)
        self.assertEqual(openrouter.ENDPOINTS_ERROR_CHARS, 300)
        # 본문이 없으면 reason
        error = urllib.error.HTTPError(openrouter.ENDPOINTS_URL.format(model="vendor/model"), 429, "Too Many Requests",
                                       {}, io.BytesIO(b""))
        try:
            with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(error)):
                with self.assertRaises(PlannerError) as caught:
                    openrouter.fetch_endpoints("vendor/model")
        finally:
            error.close()
        self.assertIn("HTTP 429 for https://openrouter.ai/api/v1/models/vendor/model/endpoints: Too Many Requests",
                      str(caught.exception))

    def test_fetch_other_failures(self):
        cases = [
            (urllib.error.URLError("no route"), "no route"),
            (b"<html>oops</html>", "not JSON"),
            ({"error": {"message": "Model not found", "code": 404}}, "Model not found"),
            ({"data": {}}, "data.endpoints"),
            ({"data": {"endpoints": "x"}}, "data.endpoints"),
            ([1, 2], "not a JSON object"),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                with mock.patch.object(urllib.request, "urlopen", FakeOpenRouter(payload)):
                    with self.assertRaises(PlannerError) as caught:
                        openrouter.fetch_endpoints("vendor/model")
                self.assertIn(expected, str(caught.exception))

    def test_format_endpoints_table(self):
        self.assertEqual(openrouter.format_endpoints(ENDPOINTS_PAYLOAD), ENDPOINTS_TABLE)
        lines = openrouter.format_endpoints(ENDPOINTS_PAYLOAD).splitlines()
        self.assertEqual(lines[0].split(), ["tag", "quantization", "context", "$in/M", "$out/M", "uptime30m", "status"])
        self.assertEqual([line.split()[0] for line in lines[1:-1]],
                         ["deepinfra/fp4", "venice", "gmicloud/fp8", "nopricing/bf16"])  # 입력 값, 출력 값 순. 값 없음은 뒤
        self.assertEqual(lines[-1], "4 endpoints for vendor/model")
        self.assertEqual(openrouter.ENDPOINT_COLUMNS, ("tag", "quantization", "context", "$in/M", "$out/M", "uptime30m",
                                                       "status"))

    def test_format_endpoints_edge_cases(self):
        empty = {"data": {"id": "vendor/model", "endpoints": []}}
        self.assertEqual(openrouter.format_endpoints(empty).splitlines(),
                         ["tag  quantization  context  $in/M  $out/M  uptime30m  status", "0 endpoints for vendor/model"])
        # tag 가 없으면 provider_name, id 가 없으면 name
        payload = {"data": {"name": "Vendor: Model", "endpoints": [
            {"provider_name": "Some Host", "pricing": {"prompt": "0.000001", "completion": "0.000002"}},
            "not an endpoint"]}}
        lines = openrouter.format_endpoints(payload).splitlines()
        self.assertEqual(lines[1].split("  ")[0], "Some Host")
        self.assertIn("1.00", lines[1])
        self.assertIn("2.00", lines[1])
        self.assertEqual(lines[-1], "1 endpoints for Vendor: Model")
        for bad in ({}, {"data": []}, {"data": {"endpoints": None}}, "text"):
            with self.subTest(bad=bad):
                with self.assertRaises(PlannerError):
                    openrouter.format_endpoints(bad)


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
    """메시지 순서 [system, user(예시), assistant(예시 spec), user(실제)], 예시 캐시, 참고 문서의 예시 절 제외, 재시도 쌍."""

    def test_messages(self):
        messages = build_messages(self.profile, self.prompt)
        self.assertEqual([m["role"] for m in messages], FEW_SHOT)
        system = messages[0]["content"]
        self.assertIn(prompts.ROLE.splitlines()[0], system)
        self.assertIn("# Task spec reference", system)
        self.assertIn("spec_version", system)
        self.assertIn("no markdown code fences", system)
        self.assertIn("example exchange", system)
        # 참고 문서의 마지막 절(예시 spec)은 시스템 프롬프트에 없다. 파일과 spec_reference() 에는 그대로 있다
        self.assertNotIn("## 10. Complete example", system)
        self.assertNotIn('"passage-fact-support"', system)
        self.assertIn("## 10. Complete example", prompts.spec_reference())
        self.assertIn("## 10. Complete example", prompts.REFERENCE_PATH.read_text(encoding="utf-8"))
        trimmed = prompts.spec_reference(for_prompt=True)
        self.assertIn("## 9. How to design a spec from a prompt", trimmed)
        self.assertNotIn("Complete example", trimmed)
        self.assertTrue(trimmed.rstrip().endswith("no unknown keys."), trimmed[-120:])
        user = messages[-1]["content"]
        self.assertIn(self.prompt.strip(), user)
        self.assertIn('"paths"', user)
        self.assertIn("$.passages.retriever_a", user)
        self.assertNotIn('"source"', user.split("## What the requester wants")[0].split("\n", 1)[1][:40])

    def test_example_turns(self):
        messages = build_messages(self.profile, self.prompt)
        example_user, example_assistant = messages[1], messages[2]
        self.assertEqual((example_user["role"], example_assistant["role"]), ("user", "assistant"))
        example_prompt = (EXAMPLE_DIR / "prompt.md").read_text(encoding="utf-8")
        self.assertIn(example_prompt.strip(), example_user["content"])
        self.assertIn("## Data profile (JSON)", example_user["content"])
        self.assertIn("groundedness", example_user["content"])
        # 예시 profile 은 EXAMPLE_PROFILE_MAX_CHARS 자로 줄여도 예시 spec 이 쓰는 경로를 전부 담고 있다
        profile_json = example_user["content"].split("## What the requester wants")[0].split("\n", 1)[1]
        example_profile = json.loads(profile_json)
        paths = {entry["path"] for entry in example_profile["paths"]}
        for path in ("$.id", "$.question", "$.passages.retriever_a", "$.facts.model_a.{key}",
                     "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[0]"):
            self.assertIn(path, paths)
        self.assertEqual(example_profile["record_id"], {"path": prompts.EXAMPLE_RECORD_ID, "unique": True})
        self.assertEqual(prompts.EXAMPLE_PROFILE_MAX_CHARS, 8000)
        self.assertLessEqual(profile_module._json_len(example_profile), prompts.EXAMPLE_PROFILE_MAX_CHARS)
        # assistant 답은 예시 spec 파일의 원문 그대로다
        self.assertEqual(example_assistant["content"], (EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(example_assistant["content"]), self.spec)

    def test_example_is_built_once_and_copied(self):
        first = prompts.example_messages()
        self.assertIs(first, prompts.example_messages())
        messages = build_messages(self.profile, self.prompt)
        messages[1]["content"] = "changed"
        self.assertNotEqual(prompts.example_messages()[0]["content"], "changed")
        self.assertEqual(build_messages(self.profile, self.prompt)[1]["content"], first[0]["content"])

    def test_example_can_be_switched_off(self):
        messages = build_messages(self.profile, self.prompt, example=False)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertEqual(messages[0], build_messages(self.profile, self.prompt)[0])
        self.assertEqual(messages[1], build_messages(self.profile, self.prompt)[-1])
        with_errors = build_messages(self.profile, self.prompt, errors=["$.task: required"], previous={}, example=False)
        self.assertEqual([m["role"] for m in with_errors], ["system", "user", "assistant", "user"])

    def test_messages_with_errors(self):
        previous = {"spec_version": 1}
        messages = build_messages(self.profile, self.prompt, errors=["$.task: required", "$.item: required"],
                                  previous=previous)
        self.assertEqual([m["role"] for m in messages], RETRY)
        self.assertEqual(json.loads(messages[-2]["content"]), previous)
        self.assertIn("$.task: required", messages[-1]["content"])
        self.assertIn("$.item: required", messages[-1]["content"])
        self.assertEqual(len(build_messages(self.profile, self.prompt, errors=[])), 4)

    def test_system_and_example_size_stays_reasonable(self):
        """시스템 + 예시 두 턴은 모든 호출에 붙는 고정 비용이다 (지금 약 4만 자, 1만 토큰쯤). 5만 자 안에 둔다."""
        messages = build_messages(self.profile, self.prompt)
        fixed = sum(len(m["content"]) for m in messages[:3])
        self.assertLess(fixed, 50000, fixed)
        self.assertLess(len(messages[1]["content"]), 16000)

    def test_profile_max_chars_is_passed_through(self):
        prompts.example_messages()  # 예시는 프로세스마다 한 번만 만든다. 미리 만들어 두어 spy 에 잡히지 않게 한다
        with mock.patch.object(prompts, "profile_for_prompt", wraps=prompts.profile_for_prompt) as spy:
            build_messages(self.profile, self.prompt)
            build_messages(self.profile, self.prompt, profile_max_chars=700)
        self.assertEqual([call.args[1] for call in spy.call_args_list], [config.DEFAULT_PROFILE_MAX_CHARS, 700])
        short = build_messages(self.profile, self.prompt, profile_max_chars=700)[-1]["content"]
        full = build_messages(self.profile, self.prompt)[-1]["content"]
        self.assertLess(len(short), len(full))


if __name__ == "__main__":
    unittest.main()
