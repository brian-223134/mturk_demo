"""모델 설정: 이름·경로 풀이, env 파일, AGENT_MODEL 선택 순서, PyYAML 없을 때의 안내, yaml 읽기와 검사 오류.

yaml 을 실제로 읽는 테스트는 PyYAML 이 있을 때만 돈다 (컨테이너 안). 나머지는 표준 라이브러리만으로 돈다.
PyYAML 이 없는 상황은 sys.modules["yaml"] = None 으로 만들어 어디서든 검사한다.
"""

import importlib.util
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from agent import config
from agent.config import (ConfigError, ModelConfig, load_env_file, load_model_config, resolve_model_config_path,
                          selected_model_name)
from agent.planner import openrouter

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODELS_DIR = REPO_ROOT / "environment" / "models"
YAML_AVAILABLE = importlib.util.find_spec("yaml") is not None
DEFAULT_PARAMS = {"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"}}
VALID_YAML = textwrap.dedent("""\
    provider: openrouter
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
        cfg = ModelConfig(name="x", path=MODELS_DIR / "x.yaml", provider="openrouter", model="m", params={},
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
        cfg = self.parse({"provider": "openrouter", "model": " vendor/model "})
        self.assertEqual(cfg, ModelConfig(name="unit", path=self.PATH, provider="openrouter", model="vendor/model",
                                          params={}, timeout_seconds=120, spec_fix_retries=1,
                                          profile_max_chars=12000))
        cfg = self.parse({"provider": "openrouter", "model": "m", "params": None, "planner": None})
        self.assertEqual((cfg.params, cfg.spec_fix_retries), ({}, 1))

    def test_errors(self):
        cases = [
            (["a", "b"], "must be a mapping"),
            ("text", "must be a mapping"),
            (None, "must be a mapping"),
            ({"model": "m"}, "provider"),
            ({"provider": "other", "model": "m"}, "provider"),
            ({"provider": "openrouter"}, "model"),
            ({"provider": "openrouter", "model": ""}, "model"),
            ({"provider": "openrouter", "model": "  "}, "model"),
            ({"provider": "openrouter", "model": 3}, "model"),
            ({"provider": "openrouter", "model": "m", "params": [1]}, "params"),
            ({"provider": "openrouter", "model": "m", "params": {"model": "x"}}, "params must not contain model"),
            ({"provider": "openrouter", "model": "m", "params": {"messages": []}}, "params must not contain messages"),
            ({"provider": "openrouter", "model": "m", "timeout_seconds": 0}, "timeout_seconds"),
            ({"provider": "openrouter", "model": "m", "timeout_seconds": -5}, "timeout_seconds"),
            ({"provider": "openrouter", "model": "m", "timeout_seconds": "120"}, "timeout_seconds"),
            ({"provider": "openrouter", "model": "m", "timeout_seconds": True}, "timeout_seconds"),
            ({"provider": "openrouter", "model": "m", "timeout_seconds": 1.5}, "timeout_seconds"),
            ({"provider": "openrouter", "model": "m", "planner": "x"}, "planner"),
            ({"provider": "openrouter", "model": "m", "planner": {"spec_fix_retries": -1}}, "spec_fix_retries"),
            ({"provider": "openrouter", "model": "m", "planner": {"spec_fix_retries": "1"}}, "spec_fix_retries"),
            ({"provider": "openrouter", "model": "m", "planner": {"profile_max_chars": -1}}, "profile_max_chars"),
            ({"provider": "openrouter", "model": "m", "planner": {"profile_max_chars": False}}, "profile_max_chars"),
        ]
        for data, expected in cases:
            with self.subTest(data=data):
                with self.assertRaises(ConfigError) as caught:
                    self.parse(data)
                self.assertIn(expected, str(caught.exception))
                self.assertIn("environment/models/unit.yaml", str(caught.exception))

    def test_zero_retries_and_zero_chars_are_allowed(self):
        cfg = self.parse({"provider": "openrouter", "model": "m",
                          "planner": {"spec_fix_retries": 0, "profile_max_chars": 0}})
        self.assertEqual((cfg.spec_fix_retries, cfg.profile_max_chars), (0, 0))

    def test_params_are_copied(self):
        params = {"temperature": 0}
        cfg = self.parse({"provider": "openrouter", "model": "m", "params": params})
        params["temperature"] = 1
        self.assertEqual(cfg.params, {"temperature": 0})


@unittest.skipUnless(YAML_AVAILABLE, "PyYAML is not installed (run inside Docker)")
class LoadYamlTest(TempDirCase):
    def test_default_yaml(self):
        cfg = load_model_config(None, MODELS_DIR)
        self.assertEqual(cfg.name, "default")
        self.assertEqual(cfg.path, MODELS_DIR / "default.yaml")
        self.assertEqual(cfg.display_path(), "environment/models/default.yaml")
        self.assertEqual(cfg.provider, "openrouter")
        self.assertEqual(cfg.model, "openai/gpt-4o-mini")
        self.assertEqual(cfg.params, DEFAULT_PARAMS)
        self.assertEqual(cfg.timeout_seconds, 120)
        self.assertEqual(cfg.spec_fix_retries, 1)
        self.assertEqual(cfg.profile_max_chars, 12000)
        self.assertEqual(load_model_config("default", MODELS_DIR), cfg)
        self.assertEqual(load_model_config(str(MODELS_DIR / "default.yaml")), cfg)
        self.assertEqual(load_model_config(str(MODELS_DIR / "default.yaml"), self.dir), cfg)

    def test_every_committed_model_config_loads(self):
        files = sorted(MODELS_DIR.glob("*.yaml"))
        self.assertIn(MODELS_DIR / "default.yaml", files)
        for path in files:
            with self.subTest(path=path.name):
                cfg = load_model_config(path.stem, MODELS_DIR)
                self.assertEqual(cfg.provider, "openrouter")
                self.assertTrue(cfg.model)

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
        self.write("minimal.yaml", "provider: openrouter\nmodel: vendor/model\n")
        cfg = load_model_config("minimal", self.dir)
        self.assertEqual(cfg.params, {})
        self.assertEqual((cfg.timeout_seconds, cfg.spec_fix_retries, cfg.profile_max_chars), (120, 1, 12000))

    def test_invalid_files(self):
        cases = [
            ("list.yaml", "- a\n- b\n", "must be a mapping"),
            ("empty.yaml", "", "must be a mapping"),
            ("no-provider.yaml", "model: m\n", "provider"),
            ("bad-provider.yaml", "provider: other\nmodel: m\n", "provider"),
            ("no-model.yaml", "provider: openrouter\n", "model"),
            ("empty-model.yaml", "provider: openrouter\nmodel: ''\n", "model"),
            ("params-list.yaml", "provider: openrouter\nmodel: m\nparams: [1]\n", "params"),
            ("params-model.yaml", "provider: openrouter\nmodel: m\nparams:\n  model: x\n", "params must not contain"),
            ("params-messages.yaml", "provider: openrouter\nmodel: m\nparams:\n  messages: []\n", "params must not contain"),
            ("timeout-zero.yaml", "provider: openrouter\nmodel: m\ntimeout_seconds: 0\n", "timeout_seconds"),
            ("timeout-str.yaml", "provider: openrouter\nmodel: m\ntimeout_seconds: '10'\n", "timeout_seconds"),
            ("planner-str.yaml", "provider: openrouter\nmodel: m\nplanner: x\n", "planner"),
            ("retries.yaml", "provider: openrouter\nmodel: m\nplanner:\n  spec_fix_retries: -1\n", "spec_fix_retries"),
            ("chars.yaml", "provider: openrouter\nmodel: m\nplanner:\n  profile_max_chars: no\n", "profile_max_chars"),
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
