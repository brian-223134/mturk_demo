"""모델 설정: 이름·경로 풀이, env 파일, AGENT_MODEL 선택 순서, PyYAML 없을 때의 안내, yaml 읽기와 검사 오류,
environment/models/ 의 설정 파일들(default, qwen3-235b, deepseek-v3.2).

yaml 을 실제로 읽는 테스트는 PyYAML 이 있을 때만 돈다 (컨테이너 안). 나머지는 표준 라이브러리만으로 돈다.
PyYAML 이 없는 상황은 sys.modules["yaml"] = None 으로 만들어 어디서든 검사한다. 설정 파일의 글자 수준 검사
(비밀 없음, provider/model 줄, usage: {include: true})는 yaml 없이도 돈다. provider 태그("gmicloud/fp8")의 풀이는 ParseModelConfigTest 가 본다.
"""

import importlib.util
import os
import re
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from agent import config
from agent import profile as profile_module
from agent.config import (ConfigError, ModelConfig, load_env_file, load_model_config, resolve_model_config_path,
                          selected_model_name)
from agent.planner import openrouter

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODELS_DIR = REPO_ROOT / "environment" / "models"
YAML_AVAILABLE = importlib.util.find_spec("yaml") is not None
COMMITTED_CONFIGS = ("default", "qwen3-235b", "deepseek-v3.2")
# usage: {include: true} 는 OpenRouter 가 응답 usage 에 실제 청구액 cost 를 넣게 한다 (세 설정 파일 모두)
USAGE_PARAM = {"include": True}
DEFAULT_PARAMS = {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"},
                  "usage": USAGE_PARAM, "reasoning": {"effort": "medium"}}
TAG_ROUTING = {"order": ["gmicloud"], "allow_fallbacks": False, "quantizations": ["fp8"]}
VALID_YAML = textwrap.dedent("""\
    api: openrouter
    model: vendor/model
    params:
      temperature: 0.5
    timeout_seconds: 30
    planner:
      spec_fix_retries: 2
      profile_max_chars: 4000
    """)


def clean_env(**values):
    env = {key: value for key, value in os.environ.items() if key != config.MODEL_VARIABLE}
    env.update(values)
    return mock.patch.dict(os.environ, env, clear=True)


def no_yaml():
    """import yaml 이 실패하게 만든다 (PyYAML 이 설치돼 있어도)."""
    return mock.patch.dict(sys.modules, {"yaml": None})


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path


class ResolvePathTest(unittest.TestCase):
    def test_empty_means_default(self):
        self.assertEqual(resolve_model_config_path(None), config.DEFAULT_MODELS_DIR / "default.yaml")
        self.assertEqual(resolve_model_config_path(""), config.DEFAULT_MODELS_DIR / "default.yaml")
        self.assertEqual(resolve_model_config_path("  ", MODELS_DIR), MODELS_DIR / "default.yaml")

    def test_name_is_looked_up_in_models_dir(self):
        self.assertEqual(resolve_model_config_path("fast", MODELS_DIR), MODELS_DIR / "fast.yaml")
        self.assertEqual(resolve_model_config_path(" fast ", "some/dir"), Path("some/dir") / "fast.yaml")
        self.assertEqual(resolve_model_config_path("fast-v1.2", MODELS_DIR), MODELS_DIR / "fast-v1.2.yaml")
        self.assertEqual(resolve_model_config_path("fast"), config.DEFAULT_MODELS_DIR / "fast.yaml")

    def test_suffix_or_separator_means_path(self):
        self.assertEqual(resolve_model_config_path("custom.yaml", MODELS_DIR), Path("custom.yaml"))
        self.assertEqual(resolve_model_config_path("custom.YML", MODELS_DIR), Path("custom.YML"))
        self.assertEqual(resolve_model_config_path("configs/other.yml", MODELS_DIR), Path("configs/other.yml"))
        self.assertEqual(resolve_model_config_path("sub/name", MODELS_DIR), Path("sub/name"))
        self.assertEqual(resolve_model_config_path("/abs/dir/x.yaml", MODELS_DIR), Path("/abs/dir/x.yaml"))

    def test_display_path(self):
        self.assertEqual(config.display_path(MODELS_DIR / "default.yaml"), "environment/models/default.yaml")
        self.assertEqual(config.display_path(REPO_ROOT.parent / "outside.yaml"), str(REPO_ROOT.parent / "outside.yaml"))
        cfg = ModelConfig(name="x", path=MODELS_DIR / "x.yaml", api="openrouter", provider=None, model="m", params={},
                          timeout_seconds=1, spec_fix_retries=0, profile_max_chars=0)
        self.assertEqual(cfg.display_path(), "environment/models/x.yaml")


class EnvFileTest(TempDirCase):
    def test_load_env_file(self):
        path = self.write(".env", "\n".join([
            "# comment",
            "",
            "OPENROUTER_KEY=sk-plain",
            "export EXPORTED='single quoted'",
            'DOUBLE="double # not a comment"',
            "SPACED = spaced value   # trailing comment",
            "AGENT_MODEL=fast",
            "NOVALUE=",
            "not a pair",
            "=nokey",
        ]) + "\n")
        self.assertEqual(load_env_file(path), {
            "OPENROUTER_KEY": "sk-plain",
            "EXPORTED": "single quoted",
            "DOUBLE": "double # not a comment",
            "SPACED": "spaced value",
            "AGENT_MODEL": "fast",
            "NOVALUE": "",
        })
        self.assertEqual(load_env_file(str(path)), load_env_file(path))
        self.assertEqual(load_env_file(self.dir / "missing"), {})
        self.assertEqual(load_env_file(None), {})

    def test_reexported_from_openrouter(self):
        self.assertIs(openrouter.load_env_file, load_env_file)

    def test_env_example_lists_the_variables(self):
        example = REPO_ROOT / "environment" / ".env.example"
        if not example.is_file():
            self.skipTest("environment/.env.example is not available here (it is not mounted into the container)")
        values = load_env_file(example)
        self.assertEqual(set(values), {"OPENROUTER_KEY", "AGENT_MODEL", "AGENT_ALLOW_API"})
        self.assertEqual(values["OPENROUTER_KEY"], "")
        self.assertEqual(values["AGENT_MODEL"], "default")
        self.assertEqual(values["AGENT_ALLOW_API"], "0")


class SelectedModelNameTest(TempDirCase):
    def test_order_env_then_file_then_default(self):
        env_file = self.write("model.env", "AGENT_MODEL=from-file\n")
        with clean_env(AGENT_MODEL="from-env"):
            self.assertEqual(selected_model_name(env_file), "from-env")
            self.assertEqual(selected_model_name(None), "from-env")
        with clean_env(AGENT_MODEL="  "):
            self.assertEqual(selected_model_name(env_file), "from-file")
        with clean_env():
            self.assertEqual(selected_model_name(env_file), "from-file")
            self.assertEqual(selected_model_name(str(env_file)), "from-file")
            self.assertEqual(selected_model_name(self.dir / "missing.env"), "default")
            self.assertEqual(selected_model_name(None), "default")
        empty = self.write("empty.env", "AGENT_MODEL=\nOPENROUTER_KEY=sk\n")
        with clean_env():
            self.assertEqual(selected_model_name(empty), "default")

    def test_path_in_env_file_is_kept(self):
        env_file = self.write("model.env", "AGENT_MODEL=configs/mine.yaml\n")
        with clean_env():
            self.assertEqual(selected_model_name(env_file), "configs/mine.yaml")
            self.assertEqual(resolve_model_config_path(selected_model_name(env_file), MODELS_DIR),
                             Path("configs/mine.yaml"))


class WithoutPyYamlTest(TempDirCase):
    def test_missing_pyyaml_gives_a_clear_message(self):
        with no_yaml():
            with self.assertRaises(ConfigError) as caught:
                load_model_config("default", MODELS_DIR)
        message = str(caught.exception)
        self.assertEqual(message, config.NO_PYYAML)
        self.assertIn("PyYAML is not installed", message)
        self.assertIn("docker compose run --rm agent", message)
        self.assertIn("virtual environment", message)

    def test_missing_file_is_reported_before_yaml_is_needed(self):
        with no_yaml():
            with self.assertRaises(ConfigError) as caught:
                load_model_config("no-such-model", MODELS_DIR)
        self.assertIn("model config file not found", str(caught.exception))
        self.assertIn("environment/models/no-such-model.yaml", str(caught.exception))
        with no_yaml():
            with self.assertRaises(ConfigError):
                load_model_config(str(self.dir / "nope.yaml"))

    def test_config_error_is_a_value_error(self):
        self.assertTrue(issubclass(ConfigError, ValueError))


class ParseModelConfigTest(unittest.TestCase):
    """yaml 없이, 읽은 값의 검사만 본다 (parse_model_config 는 dict 를 받는다)."""

    PATH = MODELS_DIR / "unit.yaml"

    def parse(self, data):
        return config.parse_model_config(data, "unit", self.PATH)

    def test_defaults(self):
        cfg = self.parse({"api": "openrouter", "model": " vendor/model "})
        self.assertEqual(cfg, ModelConfig(name="unit", path=self.PATH, api="openrouter", provider=None, model="vendor/model",
                                          params={}, timeout_seconds=120, spec_fix_retries=1,
                                          profile_max_chars=24000))
        self.assertIsNone(cfg.provider_tag)
        self.assertEqual(config.DEFAULT_PROFILE_MAX_CHARS, 24000)
        # profile_for_prompt 의 기본값(agent/profile.py)과 같은 값을 쓴다
        self.assertEqual(config.DEFAULT_PROFILE_MAX_CHARS, profile_module.PROMPT_MAX_CHARS_DEFAULT)
        cfg = self.parse({"api": "openrouter", "model": "m", "params": None, "planner": None})
        self.assertEqual((cfg.params, cfg.spec_fix_retries), ({}, 1))

    def test_errors(self):
        cases = [
            (["a", "b"], "must be a mapping"),
            ("text", "must be a mapping"),
            (None, "must be a mapping"),
            ({"model": "m"}, "api must be one of openrouter"),
            ({"api": "other", "model": "m"}, "api must be one of openrouter (got 'other')"),
            ({"api": None, "model": "m"}, "api must be one of"),
            # 예전 형식: provider: openrouter (대소문자 무관). api 가 있든 없든 이름을 바꾸라는 안내
            ({"provider": "openrouter", "model": "m"}, "rename it to 'api: openrouter'"),
            ({"provider": "OPENROUTER", "model": "m"}, "rename it to 'api: openrouter'"),
            ({"api": "openrouter", "model": "m", "provider": "openrouter"}, "rename it to 'api: openrouter'"),
            ({"api": "openrouter", "model": "m", "provider": " OpenRouter "}, "rename it to 'api: openrouter'"),
            ({"api": "openrouter", "model": "m", "provider": "openrouter"}, "a tag such as gmicloud/fp8"),
            # provider: other 는 업체 태그로는 맞는 형식이다. 문제는 api 가 없는 것
            ({"provider": "other", "model": "m"}, "api must be one of openrouter"),
            # provider 는 없거나, 태그이거나, 라우팅 매핑이어야 한다
            ({"api": "openrouter", "model": "m", "provider": ["DeepInfra"]}, "provider must be omitted"),
            ({"api": "openrouter", "model": "m", "provider": ["gmicloud/fp8"]}, "a provider tag such as gmicloud/fp8"),
            ({"api": "openrouter", "model": "m", "provider": 3}, "provider must be omitted"),
            ({"api": "openrouter", "model": "m", "provider": True}, "provider must be omitted"),
            # 잘못된 태그
            ({"api": "openrouter", "model": "m", "provider": "gmicloud/fp9"}, "unknown quantization 'fp9'"),
            ({"api": "openrouter", "model": "m", "provider": "gmicloud/"}, "unknown quantization"),
            ({"api": "openrouter", "model": "m", "provider": "gmicloud/fp8/extra"}, "unknown quantization"),
            ({"api": "openrouter", "model": "m", "provider": "GMI Cloud"}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "provider": "-gmicloud"}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "provider": "gmi_cloud/fp8"}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "provider": "/fp8"}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "provider": ""}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "provider": "   "}, "is not a provider tag"),
            ({"api": "openrouter", "model": "m", "params": {"provider": {"order": ["x"]}}},
             "params must not contain provider"),
            ({"api": "openrouter"}, "model"),
            ({"api": "openrouter", "model": ""}, "model"),
            ({"api": "openrouter", "model": "  "}, "model"),
            ({"api": "openrouter", "model": 3}, "model"),
            ({"api": "openrouter", "model": "m", "params": [1]}, "params"),
            ({"api": "openrouter", "model": "m", "params": {"model": "x"}}, "params must not contain model"),
            ({"api": "openrouter", "model": "m", "params": {"messages": []}}, "params must not contain messages"),
            ({"api": "openrouter", "model": "m", "timeout_seconds": 0}, "timeout_seconds"),
            ({"api": "openrouter", "model": "m", "timeout_seconds": -5}, "timeout_seconds"),
            ({"api": "openrouter", "model": "m", "timeout_seconds": "120"}, "timeout_seconds"),
            ({"api": "openrouter", "model": "m", "timeout_seconds": True}, "timeout_seconds"),
            ({"api": "openrouter", "model": "m", "timeout_seconds": 1.5}, "timeout_seconds"),
            ({"api": "openrouter", "model": "m", "planner": "x"}, "planner"),
            ({"api": "openrouter", "model": "m", "planner": {"spec_fix_retries": -1}}, "spec_fix_retries"),
            ({"api": "openrouter", "model": "m", "planner": {"spec_fix_retries": "1"}}, "spec_fix_retries"),
            ({"api": "openrouter", "model": "m", "planner": {"profile_max_chars": -1}}, "profile_max_chars"),
            ({"api": "openrouter", "model": "m", "planner": {"profile_max_chars": False}}, "profile_max_chars"),
        ]
        for data, expected in cases:
            with self.subTest(data=data):
                with self.assertRaises(ConfigError) as caught:
                    self.parse(data)
                self.assertIn(expected, str(caught.exception))
                self.assertIn("environment/models/unit.yaml", str(caught.exception))

    def test_bad_provider_tag_message_explains_the_format(self):
        with self.assertRaises(ConfigError) as caught:
            self.parse({"api": "openrouter", "model": "m", "provider": "gmicloud/fp9"})
        message = str(caught.exception)
        self.assertIn("'<slug>' or '<slug>/<quantization>'", message)
        self.assertIn("gmicloud/fp8", message)
        self.assertIn("python3 -m agent providers <model>", message)
        for quantization in config.QUANTIZATIONS:
            self.assertIn(quantization, message)

    def test_provider_tag(self):
        cases = [
            ("gmicloud/fp8", "gmicloud/fp8", TAG_ROUTING),
            ("deepinfra", "deepinfra", {"order": ["deepinfra"], "allow_fallbacks": False}),
            (" GMICloud/FP8 ", "gmicloud/fp8", TAG_ROUTING),           # 소문자로 정규화한다
            ("Together", "together", {"order": ["together"], "allow_fallbacks": False}),
            ("venice/unknown", "venice/unknown", {"order": ["venice"], "allow_fallbacks": False,
                                                   "quantizations": ["unknown"]}),
            ("a1-b2/bf16", "a1-b2/bf16", {"order": ["a1-b2"], "allow_fallbacks": False, "quantizations": ["bf16"]}),
        ]
        for text, tag, routing in cases:
            with self.subTest(text=text):
                cfg = self.parse({"api": "openrouter", "model": "m", "provider": text})
                self.assertEqual(cfg.provider, routing)
                self.assertEqual(cfg.provider_tag, tag)
                self.assertEqual(config.parse_provider_tag(text), (tag, routing))
        for quantization in config.QUANTIZATIONS:
            cfg = self.parse({"api": "openrouter", "model": "m", "provider": f"x/{quantization}"})
            self.assertEqual(cfg.provider, {"order": ["x"], "allow_fallbacks": False, "quantizations": [quantization]})
        self.assertEqual(config.QUANTIZATIONS, ("int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16",
                                                "bf16", "fp32", "unknown"))
        # 매핑을 직접 적었거나 없으면 provider_tag 는 None
        self.assertIsNone(self.parse({"api": "openrouter", "model": "m", "provider": TAG_ROUTING}).provider_tag)
        self.assertIsNone(self.parse({"api": "openrouter", "model": "m"}).provider_tag)
        self.assertIsNone(self.parse({"api": "openrouter", "model": "m", "provider": None}).provider_tag)
        # 매핑에 tag 를 적어도 그대로 지나간다 (검사는 매핑인지만)
        cfg = self.parse({"api": "openrouter", "model": "m", "provider": {"order": ["gmicloud"]}})
        self.assertEqual((cfg.provider, cfg.provider_tag), ({"order": ["gmicloud"]}, None))

    def test_zero_retries_and_zero_chars_are_allowed(self):
        cfg = self.parse({"api": "openrouter", "model": "m",
                          "planner": {"spec_fix_retries": 0, "profile_max_chars": 0}})
        self.assertEqual((cfg.spec_fix_retries, cfg.profile_max_chars), (0, 0))

    def test_params_are_copied(self):
        params = {"temperature": 0}
        cfg = self.parse({"api": "openrouter", "model": "m", "params": params})
        params["temperature"] = 1
        self.assertEqual(cfg.params, {"temperature": 0})

    def test_provider_routing_block(self):
        routing = {"order": ["DeepInfra", "Together"], "allow_fallbacks": True, "quantizations": ["fp8"],
                   "ignore": ["Other"], "sort": "price", "require_parameters": True, "data_collection": "deny"}
        cfg = self.parse({"api": "openrouter", "model": "m", "provider": routing})
        self.assertEqual(cfg.provider, routing)
        self.assertIsNone(cfg.provider_tag)
        self.assertIsNot(cfg.provider, routing)  # 최상위 dict 는 복사한다
        for data in ({"api": "openrouter", "model": "m"}, {"api": "openrouter", "model": "m", "provider": None},
                     {"api": "openrouter", "model": "m", "provider": {}}):
            with self.subTest(data=data):
                cfg = self.parse(data)
                self.assertEqual(cfg.provider, None if data.get("provider") is None else {})
        self.assertEqual(config.SUPPORTED_APIS, ("openrouter",))
        self.assertFalse(hasattr(config, "SUPPORTED_PROVIDERS"))

    def test_nested_params_pass(self):
        params = {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"},
                  "reasoning": {"effort": "medium"}, "plugins": [{"id": "web"}], "stop": ["\n\n"]}
        cfg = self.parse({"api": "openrouter", "model": "m", "params": params})
        self.assertEqual(cfg.params, params)
        self.assertEqual(cfg.params["reasoning"], {"effort": "medium"})


class ModelConfigFilesTest(unittest.TestCase):
    """environment/models/*.yaml 의 글자 수준 검사. yaml 없이 돌므로 호스트에서도 파일이 깨지지 않았는지 본다."""

    def files(self):
        if not MODELS_DIR.is_dir():
            self.skipTest("environment/models is not available here")
        return sorted(MODELS_DIR.glob("*.yaml"))

    def test_committed_files_exist(self):
        names = {path.stem for path in self.files()}
        for name in COMMITTED_CONFIGS:
            self.assertIn(name, names)

    def test_no_secrets_and_required_lines(self):
        for path in self.files():
            with self.subTest(path=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertRegex(text, r"(?m)^api: openrouter\b")
                self.assertRegex(text, r"(?m)^model: \S+/\S+")
                self.assertRegex(text, r"(?m)^planner:")
                self.assertNotRegex(text, r"(?m)^provider:")  # provider 는 주석으로만 (기본: OpenRouter 가 고른다)
                self.assertRegex(text, r"(?m)^  usage:\n    include: true\b")  # 응답 usage 에 실제 청구액 cost
                # 주석의 예시 두 줄: 태그 한 줄과 매핑 한 줄. 태그는 실제로 풀리는 형식이어야 한다
                tags = re.findall(r"(?m)^# provider: ([a-z0-9-]+/[a-z0-9]+)$", text)
                self.assertEqual(len(tags), 1, text)
                self.assertEqual(config.parse_provider_tag(tags[0])[0], tags[0])
                self.assertRegex(text, r"(?m)^# provider: \{order: \[")
                self.assertIn("allow_fallbacks", text)
                self.assertIn("python3 -m agent providers", text)
                self.assertNotRegex(text, r"sk-or-|OPENROUTER_KEY\s*[:=]\s*\S|Bearer ")
                self.assertNotIn("/Users/", text)

    def test_reasoning_only_where_supported(self):
        texts = {path.stem: path.read_text(encoding="utf-8") for path in self.files()}
        self.assertRegex(texts["default"], r"(?m)^  reasoning:\n    effort: medium")
        self.assertRegex(texts["deepseek-v3.2"], r"(?m)^  reasoning:\n    effort: low")
        self.assertNotRegex(texts["qwen3-235b"], r"(?m)^  reasoning:")
        self.assertIn("openai/gpt-oss-120b", texts["default"])
        self.assertIn("qwen/qwen3-235b-a22b-2507", texts["qwen3-235b"])
        self.assertIn("deepseek/deepseek-v3.2", texts["deepseek-v3.2"])


@unittest.skipUnless(YAML_AVAILABLE, "PyYAML is not installed (run inside Docker)")
class LoadYamlTest(TempDirCase):
    def test_default_yaml(self):
        cfg = load_model_config(None, MODELS_DIR)
        self.assertEqual(cfg.name, "default")
        self.assertEqual(cfg.path, MODELS_DIR / "default.yaml")
        self.assertEqual(cfg.display_path(), "environment/models/default.yaml")
        self.assertEqual(cfg.api, "openrouter")
        self.assertIsNone(cfg.provider)  # 라우팅 블록은 주석으로만 있다: OpenRouter 가 고른다
        self.assertEqual(cfg.model, "openai/gpt-oss-120b")
        self.assertEqual(cfg.params, DEFAULT_PARAMS)
        self.assertEqual(cfg.timeout_seconds, 180)
        self.assertEqual(cfg.spec_fix_retries, 1)
        self.assertEqual(cfg.profile_max_chars, 24000)
        self.assertEqual(load_model_config("default", MODELS_DIR), cfg)
        self.assertEqual(load_model_config(str(MODELS_DIR / "default.yaml")), cfg)
        self.assertEqual(load_model_config(str(MODELS_DIR / "default.yaml"), self.dir), cfg)

    def test_alternative_model_configs(self):
        qwen = load_model_config("qwen3-235b", MODELS_DIR)
        self.assertEqual((qwen.name, qwen.api, qwen.model), ("qwen3-235b", "openrouter", "qwen/qwen3-235b-a22b-2507"))
        self.assertEqual(qwen.params, {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"},
                                       "usage": USAGE_PARAM})
        self.assertNotIn("reasoning", qwen.params)  # instruct 모델이라 reasoning 파라미터가 없다
        deepseek = load_model_config("deepseek-v3.2", MODELS_DIR)
        self.assertEqual((deepseek.name, deepseek.api, deepseek.model),
                         ("deepseek-v3.2", "openrouter", "deepseek/deepseek-v3.2"))
        self.assertEqual(deepseek.params, {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"},
                                           "usage": USAGE_PARAM, "reasoning": {"effort": "low"}})
        for cfg in (qwen, deepseek):
            self.assertEqual((cfg.timeout_seconds, cfg.spec_fix_retries, cfg.profile_max_chars), (180, 1, 24000))
            self.assertIsNone(cfg.provider)
            self.assertIsNone(cfg.provider_tag)
        # AGENT_MODEL 로 고르는 경로
        env_file = self.write("model.env", "AGENT_MODEL=qwen3-235b\n")
        with clean_env():
            self.assertEqual(load_model_config(selected_model_name(env_file), MODELS_DIR), qwen)

    def test_every_committed_model_config_loads(self):
        files = sorted(MODELS_DIR.glob("*.yaml"))
        names = {path.stem for path in files}
        for name in COMMITTED_CONFIGS:
            self.assertIn(name, names)
        for path in files:
            with self.subTest(path=path.name):
                cfg = load_model_config(path.stem, MODELS_DIR)
                self.assertEqual(cfg.api, "openrouter")
                self.assertIsNone(cfg.provider)
                self.assertIsNone(cfg.provider_tag)
                self.assertTrue(cfg.model)
                self.assertEqual(cfg.params["response_format"], {"type": "json_object"})
                self.assertEqual(cfg.params["temperature"], 0)
                self.assertEqual(cfg.params["usage"], USAGE_PARAM)  # 응답 usage 에 cost 가 오게 한다
                self.assertGreaterEqual(cfg.params["max_tokens"], 4000)
                reasoning = cfg.params.get("reasoning")
                if reasoning is not None:
                    self.assertIn(reasoning.get("effort"), ("low", "medium", "high"))

    def test_name_and_path_resolution(self):
        path = self.write("fast.yaml", VALID_YAML)
        by_name = load_model_config("fast", self.dir)
        by_path = load_model_config(str(path))
        self.assertEqual(by_name, by_path)
        self.assertEqual(by_name.name, "fast")
        self.assertEqual(by_name.path, path)
        self.assertEqual(by_name.model, "vendor/model")
        self.assertEqual(by_name.params, {"temperature": 0.5})
        self.assertEqual((by_name.timeout_seconds, by_name.spec_fix_retries, by_name.profile_max_chars), (30, 2, 4000))
        yml = self.write("other.yml", VALID_YAML)
        self.assertEqual(load_model_config(str(yml)).name, "other")

    def test_defaults_when_optional_keys_are_missing(self):
        self.write("minimal.yaml", "api: openrouter\nmodel: vendor/model\n")
        cfg = load_model_config("minimal", self.dir)
        self.assertEqual(cfg.params, {})
        self.assertEqual((cfg.timeout_seconds, cfg.spec_fix_retries, cfg.profile_max_chars), (120, 1, 24000))

    def test_provider_routing_from_yaml(self):
        self.write("routed.yaml", textwrap.dedent("""\
            api: openrouter
            model: vendor/model
            provider:
              order: [DeepInfra]
              allow_fallbacks: true
              quantizations: [fp8]
            params:
              temperature: 0
            """))
        cfg = load_model_config("routed", self.dir)
        self.assertEqual(cfg.api, "openrouter")
        self.assertEqual(cfg.provider, {"order": ["DeepInfra"], "allow_fallbacks": True, "quantizations": ["fp8"]})
        self.assertIsNone(cfg.provider_tag)
        self.assertEqual(cfg.params, {"temperature": 0})
        self.write("unrouted.yaml", "api: openrouter\nmodel: vendor/model\nprovider:\n")
        self.assertIsNone(load_model_config("unrouted", self.dir).provider)
        self.assertIsNone(load_model_config("unrouted", self.dir).provider_tag)

    def test_provider_tag_from_yaml(self):
        self.write("tagged.yaml", "api: openrouter\nmodel: vendor/model\nprovider: gmicloud/fp8\n")
        cfg = load_model_config("tagged", self.dir)
        self.assertEqual(cfg.provider, TAG_ROUTING)
        self.assertEqual(cfg.provider_tag, "gmicloud/fp8")
        self.write("slug.yaml", "api: openrouter\nmodel: vendor/model\nprovider: DeepInfra\n")
        cfg = load_model_config("slug", self.dir)
        self.assertEqual((cfg.provider, cfg.provider_tag), ({"order": ["deepinfra"], "allow_fallbacks": False}, "deepinfra"))
        # 설정 파일 주석에 적은 매핑 예시(flow 형식)도 그대로 읽힌다
        self.write("flow.yaml", "api: openrouter\nmodel: vendor/model\n"
                                "provider: {order: [deepinfra, gmicloud], allow_fallbacks: true, quantizations: [fp8]}\n")
        cfg = load_model_config("flow", self.dir)
        self.assertEqual(cfg.provider, {"order": ["deepinfra", "gmicloud"], "allow_fallbacks": True,
                                        "quantizations": ["fp8"]})
        self.assertIsNone(cfg.provider_tag)

    def test_commented_provider_examples_in_committed_files_load(self):
        """environment/models/*.yaml 의 '# provider: …' 예시 줄은 주석을 벗기면 그대로 읽히는 값이어야 한다."""
        for path in sorted(MODELS_DIR.glob("*.yaml")):
            text = path.read_text(encoding="utf-8")
            examples = re.findall(r"(?m)^# (provider: .+)$", text)
            self.assertEqual(len(examples), 2, path.name)
            for example in examples:
                with self.subTest(path=path.name, example=example):
                    self.write(path.name, text + "\n" + example + "\n")
                    cfg = load_model_config(path.stem, self.dir)
                    self.assertIsInstance(cfg.provider, dict)
                    self.assertTrue(cfg.provider.get("order"))
                    if "{" in example:
                        self.assertIsNone(cfg.provider_tag)
                    else:
                        self.assertEqual(cfg.provider_tag, example.split(": ", 1)[1])

    def test_nested_params_from_yaml(self):
        self.write("nested.yaml", textwrap.dedent("""\
            api: openrouter
            model: vendor/model
            params:
              response_format:
                type: json_object
              reasoning:
                effort: high
            """))
        cfg = load_model_config("nested", self.dir)
        self.assertEqual(cfg.params, {"response_format": {"type": "json_object"}, "reasoning": {"effort": "high"}})

    def test_invalid_files(self):
        cases = [
            ("list.yaml", "- a\n- b\n", "must be a mapping"),
            ("empty.yaml", "", "must be a mapping"),
            ("no-api.yaml", "model: m\n", "api must be one of"),
            ("bad-api.yaml", "api: other\nmodel: m\n", "api must be one of"),
            ("old-key.yaml", "provider: openrouter\nmodel: m\n", "rename it to 'api: openrouter'"),
            ("provider-str.yaml", "api: openrouter\nmodel: m\nprovider: OpenRouter\n", "rename it to 'api: openrouter'"),
            ("provider-list.yaml", "api: openrouter\nmodel: m\nprovider: [DeepInfra]\n", "provider must be omitted"),
            ("provider-bad-tag.yaml", "api: openrouter\nmodel: m\nprovider: gmicloud/fp9\n", "unknown quantization"),
            ("provider-bad-slug.yaml", "api: openrouter\nmodel: m\nprovider: GMI Cloud\n", "is not a provider tag"),
            ("params-provider.yaml", "api: openrouter\nmodel: m\nparams:\n  provider:\n    order: [x]\n",
             "params must not contain provider"),
            ("no-model.yaml", "api: openrouter\n", "model"),
            ("empty-model.yaml", "api: openrouter\nmodel: ''\n", "model"),
            ("params-list.yaml", "api: openrouter\nmodel: m\nparams: [1]\n", "params"),
            ("params-model.yaml", "api: openrouter\nmodel: m\nparams:\n  model: x\n", "params must not contain"),
            ("params-messages.yaml", "api: openrouter\nmodel: m\nparams:\n  messages: []\n", "params must not contain"),
            ("timeout-zero.yaml", "api: openrouter\nmodel: m\ntimeout_seconds: 0\n", "timeout_seconds"),
            ("timeout-str.yaml", "api: openrouter\nmodel: m\ntimeout_seconds: '10'\n", "timeout_seconds"),
            ("planner-str.yaml", "api: openrouter\nmodel: m\nplanner: x\n", "planner"),
            ("retries.yaml", "api: openrouter\nmodel: m\nplanner:\n  spec_fix_retries: -1\n", "spec_fix_retries"),
            ("chars.yaml", "api: openrouter\nmodel: m\nplanner:\n  profile_max_chars: no\n", "profile_max_chars"),
            ("syntax.yaml", "provider: [openrouter\nmodel: m\n", "invalid YAML"),
        ]
        for name, text, expected in cases:
            with self.subTest(name=name):
                self.write(name, text)
                with self.assertRaises(ConfigError) as caught:
                    load_model_config(name[:-len(".yaml")], self.dir)
                self.assertIn(expected, str(caught.exception))

    def test_missing_file(self):
        with self.assertRaises(ConfigError) as caught:
            load_model_config("nope", self.dir)
        self.assertIn("not found", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
