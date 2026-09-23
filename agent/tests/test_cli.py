"""CLI: 인자 파싱, profile/plan 하위 명령, --prompt @file, OpenRouter dry-run(네트워크 없음), 모델 설정 선택, 오류 출력,
요청·응답 로그 파일, Usage(cost 포함)/Planner notes 출력, providers 명령(urlopen 대역), --out 기본값(DefaultOutTest).

run 의 전체 파이프라인은 preprocess·render·validate 모듈이 있을 때만 검사한다 (없으면 건너뛴다).
OpenRouter 를 쓰는 명령은 cli.load_model_config 를 대역으로 바꿔 PyYAML 없이 돈다. 실제 yaml 을 읽는 테스트 하나만
PyYAML 이 있을 때 돈다.
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from agent import cli, config, sample
from agent.config import ModelConfig
from agent.planner import openrouter

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODELS_DIR = REPO_ROOT / "environment" / "models"
RAW = str(EXAMPLE_DIR / "raw.json")
SPEC = str(EXAMPLE_DIR / "task_spec.json")
PROMPT_FILE = str(EXAMPLE_DIR / "prompt.md")
ENV_KEYS = (openrouter.KEY_VARIABLE, config.MODEL_VARIABLE, openrouter.ALLOW_VARIABLE)
PIPELINE_AVAILABLE = all(importlib.util.find_spec(name) is not None
                         for name in ("agent.preprocess", "agent.render", "agent.validate"))
YAML_AVAILABLE = importlib.util.find_spec("yaml") is not None
TEST_CONFIG = ModelConfig(name="test", path=MODELS_DIR / "test.yaml", api="openrouter", model="test/model",
                          params={"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"}},
                          provider=None, timeout_seconds=120, spec_fix_retries=1, profile_max_chars=12000)
TAG_ROUTING = {"order": ["gmicloud"], "allow_fallbacks": False, "quantizations": ["fp8"]}
ENDPOINTS_PAYLOAD = {"data": {"id": "vendor/model", "name": "Vendor: Model", "endpoints": [
    {"tag": "gmicloud/fp8", "provider_name": "GMICloud", "quantization": "fp8", "context_length": 131072,
     "pricing": {"prompt": "0.00000015", "completion": "0.0000006"}, "uptime_last_30m": 99.94, "status": 0},
    {"tag": "deepinfra/fp4", "provider_name": "DeepInfra", "quantization": "fp4", "context_length": 131072,
     "pricing": {"prompt": "0.00000005", "completion": "0.00000024"}, "uptime_last_30m": 100, "status": 0},
]}}
ENDPOINTS_TABLE = "\n".join([
    "tag            quantization  context  $in/M  $out/M  uptime30m  status",
    "deepinfra/fp4  fp4            131072   0.05    0.24      100.0  0",
    "gmicloud/fp8   fp8            131072   0.15    0.60       99.9  0",
    "2 endpoints for vendor/model",
])


def fake_config(config=TEST_CONFIG):
    """cli.load_model_config 를 대역으로: yaml 을 읽지 않고 config(기본 TEST_CONFIG)를 돌려준다. 호출 인자를 확인할 수 있다."""
    return mock.patch.object(cli, "load_model_config", return_value=config)


def no_yaml():
    """import yaml 이 실패하게 만든다 (PyYAML 이 설치돼 있어도)."""
    return mock.patch.dict(sys.modules, {"yaml": None})


def clean_env(**values):
    env = {key: value for key, value in os.environ.items() if key not in ENV_KEYS}
    env.update(values)
    return mock.patch.dict(os.environ, env, clear=True)


def forbid_network(*args, **kwargs):
    raise AssertionError("urllib.request.urlopen must not be called")


def run_cli(argv):
    """cli.main을 부르고 (종료 코드, stdout, stderr)를 돌려준다."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(argv)
    return code, out.getvalue(), err.getvalue()


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakePlanner:
    """run_plan 을 대역으로 바꿀 때 쓰는 planner. total_usage 만 갖는다 (OpenRouterPlanner 가 채우는 것과 같은 모양)."""

    name = "fake"

    def __init__(self, total_usage=None):
        self.total_usage = total_usage

    def plan(self, profile, prompt):
        raise AssertionError("run_plan is replaced in this test")


def fake_spec(**attrs):
    values = {"task": SimpleNamespace(id="t1")}
    values.update(attrs)
    return SimpleNamespace(**values)


class ParserTest(unittest.TestCase):
    def test_every_subcommand_parses(self):
        parser = cli.build_parser()
        self.assertEqual(parser.parse_args(["profile", "raw.json", "--out", "o"]).command, "profile")
        # --out 은 선택이다 (기본값은 DefaultOutTest 가 본다)
        self.assertIsNone(parser.parse_args(["profile", "raw.json"]).out)
        self.assertIsNone(parser.parse_args(["plan", "--profile", "p", "--prompt", "hi", "--spec", "s"]).out)
        self.assertIsNone(parser.parse_args(["preprocess", "raw", "--spec", "s"]).out)
        self.assertIsNone(parser.parse_args(["render", "--spec", "s"]).out)
        self.assertIsNone(parser.parse_args(["run", "raw", "--prompt", "hi", "--spec", "s"]).out)
        args = parser.parse_args(["plan", "--profile", "p.json", "--prompt", "hi", "--out", "o", "--spec", "s.json"])
        self.assertEqual((args.command, args.spec, args.env_file), ("plan", "s.json", cli.DEFAULT_ENV_FILE))
        args = parser.parse_args(["plan", "--profile", "p", "--prompt", "@f", "--out", "o", "--planner", "openrouter",
                                  "--model-config", "m", "--models-dir", "d", "--dry-run", "--allow-api",
                                  "--env-file", "e"])
        self.assertTrue(args.dry_run and args.allow_api)
        self.assertEqual((args.planner, args.model_config, args.models_dir, args.env_file), ("openrouter", "m", "d", "e"))
        args = parser.parse_args(["run", "raw", "--prompt", "hi", "--out", "o", "--planner", "openrouter"])
        self.assertEqual((args.model_config, args.models_dir), (None, None))
        self.assertEqual(parser.parse_args(["preprocess", "raw", "--spec", "s", "--out", "o"]).command, "preprocess")
        self.assertEqual(parser.parse_args(["render", "--spec", "s", "--out", "o"]).command, "render")
        self.assertEqual(parser.parse_args(["validate", "o"]).out_dir, "o")
        self.assertEqual(parser.parse_args(["run", "raw", "--prompt", "hi", "--out", "o", "--spec", "s"]).command, "run")
        args = parser.parse_args(["sample", "raw", "--out", "o.json", "--n", "2", "--seed", "3", "--max-list", "4"])
        self.assertEqual((args.command, args.raw, args.out, args.n, args.seed, args.max_list, args.anonymize),
                         ("sample", "raw", "o.json", 2, 3, 4, True))
        self.assertIs(args.func, sample.cmd_sample)
        self.assertFalse(parser.parse_args(["sample", "raw", "--out", "o", "--no-anonymize"]).anonymize)
        self.assertEqual(parser.parse_args(["test"]).command, "test")
        self.assertEqual(parser.parse_args(["test", "-v"]).verbose, True)
        args = parser.parse_args(["providers", "vendor/model"])
        self.assertEqual((args.command, args.model_id, args.timeout), ("providers", "vendor/model", 30))
        self.assertIs(args.func, cli.cmd_providers)
        self.assertEqual(parser.parse_args(["providers", "vendor/model", "--timeout", "5"]).timeout, 5)
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in (["providers"], ["providers", "vendor/model", "--timeout", "0"],
                         ["providers", "vendor/model", "--timeout", "x"], ["providers", "vendor/model", "--allow-api"]):
                with self.assertRaises(SystemExit):
                    parser.parse_args(argv)

    def test_providers_help_says_no_key_and_no_credits(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
            cli.main(["providers", "--help"])
        help_text = " ".join(out.getvalue().split())
        self.assertIn("no API key is sent", help_text)
        self.assertIn("no credits are spent", help_text)
        self.assertIn("tag column", help_text)
        self.assertIn("provider: field", help_text)
        self.assertIn("provider: gmicloud/fp8", help_text)
        self.assertIn("environment/models/", help_text)
        self.assertIn("--timeout", help_text)

    def test_planner_choice_is_required_and_exclusive(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                cli.main(["plan", "--profile", "p", "--prompt", "hi", "--out", "o"])
            with self.assertRaises(SystemExit):
                cli.main(["plan", "--profile", "p", "--prompt", "hi", "--out", "o", "--spec", "s", "--planner", "openrouter"])
            with self.assertRaises(SystemExit):
                cli.main(["run", "raw", "--prompt", "hi", "--out", "o", "--spec", "s", "--dry-run"])
            with self.assertRaises(SystemExit):
                cli.main(["run", "raw", "--prompt", "hi", "--out", "o", "--spec", "s", "--model-config", "m"])
            with self.assertRaises(SystemExit):
                cli.main(["plan", "--profile", "p", "--prompt", "hi", "--out", "o", "--spec", "s", "--models-dir", "d"])
            with self.assertRaises(SystemExit):
                cli.main(["nonsense"])
            with self.assertRaises(SystemExit):
                cli.main([])

    def test_model_option_is_gone(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                cli.main(["plan", "--profile", "p", "--prompt", "hi", "--out", "o", "--planner", "openrouter",
                          "--model", "vendor/model"])
        for command in ("plan", "run"):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
                cli.main([command, "--help"])
            self.assertIn("--model-config", out.getvalue())
            self.assertIn("--models-dir", out.getvalue())
            self.assertNotRegex(out.getvalue(), r"--model\b(?!-)")

    def test_help_names_the_models_dir_and_the_log_files(self):
        for command in ("plan", "run"):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
                cli.main([command, "--help"])
            help_text = " ".join(out.getvalue().split())
            self.assertIn("environment/models/", help_text)
            self.assertIn("$AGENT_MODEL", help_text)
            self.assertIn("default.yaml", help_text)
            self.assertIn("plan_request.json", help_text)
            self.assertIn("plan_response.json", help_text)
        for command, default in (("profile", "output/<RAW file name without extension>"),
                                 ("preprocess", "output/<RAW file name without extension>"),
                                 ("run", "output/<RAW file name without extension>"),
                                 ("plan", "the directory of --profile"), ("render", "the directory of --spec")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(SystemExit):
                cli.main([command, "--help"])
            self.assertIn(default, " ".join(out.getvalue().split()), command)

    def test_read_prompt(self):
        self.assertEqual(cli.read_prompt("  judge this  "), "judge this")
        self.assertIn("groundedness", cli.read_prompt("@" + PROMPT_FILE))
        with self.assertRaises(cli.PlannerError):
            cli.read_prompt("@" + str(EXAMPLE_DIR / "missing.txt"))
        with self.assertRaises(cli.PlannerError):
            cli.read_prompt("   ")


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "out"
        self.no_env = str(Path(self.tmp.name) / "no-such.env")

    def tearDown(self):
        self.tmp.cleanup()

    def profile(self):
        code, stdout, stderr = run_cli(["profile", RAW, "--out", str(self.out)])
        self.assertEqual((code, stderr), (0, ""))
        return stdout

    def test_profile(self):
        stdout = self.profile()
        self.assertTrue((self.out / "profile.json").is_file())
        self.assertTrue((self.out / "profile.md").is_file())
        self.assertIn("profile.json", stdout)
        self.assertIn("6 records", stdout)
        profile = json.loads((self.out / "profile.json").read_text(encoding="utf-8"))
        self.assertEqual(profile["source"]["format"], "json_array")

    def test_plan_with_spec_file(self):
        self.profile()
        code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "judge facts",
                                        "--out", str(self.out), "--spec", SPEC, "--raw", RAW])
        self.assertEqual((code, stderr), (0, ""))
        self.assertIn("task_spec.json", stdout)
        written = json.loads((self.out / "task_spec.json").read_text(encoding="utf-8"))
        self.assertEqual(written, json.loads(Path(SPEC).read_text(encoding="utf-8")))

    def test_plan_with_prompt_file(self):
        self.profile()
        code, _, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "@" + PROMPT_FILE,
                                   "--out", str(self.out), "--spec", SPEC])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue((self.out / "task_spec.json").is_file())

    def test_plan_with_non_object_profile_is_reported(self):
        for name, content in (("list.json", "[1, 2]"), ("scalar.json", "3"), ("no-paths.json", '{"source": {}}'),
                              ("paths-not-list.json", '{"paths": {}}')):
            with self.subTest(name=name):
                path = Path(self.tmp.name) / name
                path.write_text(content, encoding="utf-8")
                code, _, stderr = run_cli(["plan", "--profile", str(path), "--prompt", "x", "--out", str(self.out),
                                           "--spec", SPEC])
                self.assertEqual(code, 1)
                self.assertIn("error:", stderr)
                self.assertIn("not a profile", stderr)
                self.assertNotIn("Traceback", stderr)
        self.assertFalse((self.out / "task_spec.json").exists())

    def test_sample_command(self):
        out = Path(self.tmp.name) / "fixtures" / "sample.json"
        code, stdout, stderr = run_cli(["sample", RAW, "--out", str(out), "--n", "2", "--seed", "3"])
        self.assertEqual((code, stderr), (0, ""))
        self.assertIn("Sampled 2 of 6 records", stdout)
        data = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(len(data), 2)
        originals = json.loads(Path(RAW).read_text(encoding="utf-8"))
        original_ids = {record["id"] for record in originals}
        for record in data:
            self.assertEqual(set(record), set(originals[0]))  # 예시의 키는 전부 snake_case 라 이름이 그대로다
            self.assertRegex(record["id"], sample.TOKEN_RE)
            self.assertNotIn(record["id"], original_ids)
            self.assertTrue(record["question"].endswith("?"))
            self.assertNotIn(record["question"], {r["question"] for r in originals})
        keys = set()

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    keys.add(key)
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(data)
        self.assertTrue(keys)
        for key in keys:
            self.assertTrue(sample.is_kept_key(key) or sample.RENAMED_KEY_RE.match(key), key)

    def test_sample_errors_are_reported_not_raised(self):
        out = str(Path(self.tmp.name) / "sample.json")
        code, _, stderr = run_cli(["sample", str(Path(self.tmp.name) / "missing.json"), "--out", out])
        self.assertEqual(code, 1)
        self.assertIn("error:", stderr)
        code, _, stderr = run_cli(["sample", RAW, "--out", out, "--n", "-1"])
        self.assertEqual(code, 1)
        self.assertIn("error: n must be 0 or more", stderr)
        code, _, stderr = run_cli(["sample", RAW, "--out", out, "--max-list", "-1"])
        self.assertEqual(code, 1)
        self.assertIn("error: max_list must be 0 or more", stderr)
        self.assertFalse(Path(out).exists())

    def test_plan_with_invalid_spec_prints_messages(self):
        self.profile()
        broken = json.loads(Path(SPEC).read_text(encoding="utf-8"))
        del broken["task"]
        path = Path(self.tmp.name) / "broken.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        code, _, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                   "--out", str(self.out), "--spec", str(path)])
        self.assertEqual(code, 1)
        self.assertIn("error: the task spec is not valid", stderr)
        self.assertIn("$.task", stderr)
        self.assertFalse((self.out / "task_spec.json").exists())

    def test_missing_files_are_reported_not_raised(self):
        code, _, stderr = run_cli(["profile", str(Path(self.tmp.name) / "missing.json"), "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertIn("error:", stderr)
        code, _, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                   "--out", str(self.out), "--spec", SPEC])
        self.assertEqual(code, 1)
        self.assertIn("error:", stderr)

    def test_plan_openrouter_dry_run(self):
        self.profile()
        with clean_env(), fake_config() as loader, mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"),
                                            "--prompt", "@" + PROMPT_FILE, "--out", str(self.out),
                                            "--planner", "openrouter", "--dry-run", "--model-config", "test",
                                            "--env-file", self.no_env])
        self.assertEqual((code, stderr), (0, ""))
        loader.assert_called_once_with("test", config.DEFAULT_MODELS_DIR)
        self.assertIn("Model config: test (environment/models/test.yaml) -> openrouter test/model (provider: auto)\n",
                      stdout)
        self.assertIn("plan_request.json", stdout)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"], {"name": "test", "path": "environment/models/test.yaml",
                                                    "api": "openrouter", "model": "test/model", "provider": None,
                                                    "provider_tag": None})
        self.assertNotIn("provider", document["body"])
        self.assertEqual(document["endpoint"], openrouter.ENDPOINT)
        body = document["body"]
        self.assertEqual(body["model"], "test/model")
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user", "assistant", "user"])
        self.assertIn("groundedness", body["messages"][-1]["content"])
        self.assertIn(f"Output folder: {self.out}\n", stdout)
        self.assertFalse((self.out / "task_spec.json").exists())
        self.assertFalse((self.out / "plan_response.json").exists())

    def test_model_config_line_shows_the_provider(self):
        self.profile()
        base = ["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x", "--out", str(self.out),
                "--planner", "openrouter", "--dry-run", "--env-file", self.no_env]
        tagged = ModelConfig(name="pinned", path=MODELS_DIR / "pinned.yaml", api="openrouter", model="test/model",
                             params={}, provider=TAG_ROUTING, timeout_seconds=120, spec_fix_retries=1,
                             profile_max_chars=12000, provider_tag="gmicloud/fp8")
        mapped = ModelConfig(name="mapped", path=MODELS_DIR / "mapped.yaml", api="openrouter", model="test/model",
                             params={}, provider={"order": ["DeepInfra"]}, timeout_seconds=120, spec_fix_retries=1,
                             profile_max_chars=12000)
        cases = [(TEST_CONFIG, "auto", None), (tagged, "gmicloud/fp8", TAG_ROUTING),
                 (mapped, "mapping", {"order": ["DeepInfra"]})]
        for cfg, label, routing in cases:
            with self.subTest(label=label), clean_env(), fake_config(cfg), \
                    mock.patch.object(urllib.request, "urlopen", forbid_network):
                code, stdout, stderr = run_cli(base)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn(f"Model config: {cfg.name} (environment/models/{cfg.name}.yaml) -> openrouter test/model "
                          f"(provider: {label})\n", stdout)
            document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
            self.assertEqual(document["model_config"]["provider"], routing)
            self.assertEqual(document["model_config"]["provider_tag"], cfg.provider_tag)
            if routing is None:
                self.assertNotIn("provider", document["body"])
            else:
                self.assertEqual(document["body"]["provider"], routing)
        self.assertEqual(cli.describe_provider(TEST_CONFIG), "auto")
        self.assertEqual(cli.describe_provider(tagged), "gmicloud/fp8")
        self.assertEqual(cli.describe_provider(mapped), "mapping")

    @unittest.skipUnless(YAML_AVAILABLE, "PyYAML is not installed (run inside Docker)")
    def test_plan_openrouter_dry_run_reads_default_yaml(self):
        self.profile()
        for extra in (["--model-config", str(MODELS_DIR / "default.yaml")],
                      ["--model-config", "default", "--models-dir", str(MODELS_DIR)]):
            with self.subTest(extra=extra), clean_env(), mock.patch.object(urllib.request, "urlopen", forbid_network):
                code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                                "--out", str(self.out), "--planner", "openrouter", "--dry-run",
                                                "--env-file", self.no_env] + extra)
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn("Model config: default (environment/models/default.yaml)", stdout)
            document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
            self.assertEqual(document["model_config"]["name"], "default")
            self.assertEqual(document["model_config"]["path"], "environment/models/default.yaml")
            self.assertEqual(document["model_config"]["api"], "openrouter")
            self.assertIsNone(document["model_config"]["provider"])
            self.assertIsNone(document["model_config"]["provider_tag"])
            self.assertIn("(provider: auto)", stdout)
            self.assertNotIn("provider", document["body"])
            self.assertEqual(document["body"]["model"], document["model_config"]["model"])
            self.assertEqual(document["body"]["max_tokens"], 8000)
            self.assertEqual(document["body"]["response_format"], {"type": "json_object"})
            self.assertEqual(document["body"]["reasoning"], {"effort": "medium"})

    @unittest.skipUnless(YAML_AVAILABLE, "PyYAML is not installed (run inside Docker)")
    def test_plan_openrouter_dry_run_with_other_committed_configs(self):
        self.profile()
        for name, model in (("qwen3-235b", "qwen/qwen3-235b-a22b-2507"), ("deepseek-v3.2", "deepseek/deepseek-v3.2")):
            with self.subTest(name=name), clean_env(AGENT_MODEL=name), \
                    mock.patch.object(urllib.request, "urlopen", forbid_network):
                code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                                "--out", str(self.out), "--planner", "openrouter", "--dry-run",
                                                "--env-file", self.no_env, "--models-dir", str(MODELS_DIR)])
            self.assertEqual((code, stderr), (0, ""))
            self.assertIn(f"Model config: {name} (environment/models/{name}.yaml) -> openrouter {model}", stdout)
            document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
            self.assertEqual(document["body"]["model"], model)

    def test_model_config_selection_order(self):
        self.profile()
        env_file = Path(self.tmp.name) / "model.env"
        env_file.write_text("AGENT_MODEL=from-file\n", encoding="utf-8")
        base = ["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x", "--out", str(self.out),
                "--planner", "openrouter", "--dry-run"]
        cases = [
            ({}, ["--env-file", self.no_env], "default", config.DEFAULT_MODELS_DIR),
            ({}, ["--env-file", str(env_file)], "from-file", config.DEFAULT_MODELS_DIR),
            ({"AGENT_MODEL": "from-env"}, ["--env-file", str(env_file)], "from-env", config.DEFAULT_MODELS_DIR),
            ({"AGENT_MODEL": "from-env"}, ["--env-file", str(env_file), "--model-config", "flag"], "flag",
             config.DEFAULT_MODELS_DIR),
            ({}, ["--env-file", self.no_env, "--models-dir", "other/models"], "default", Path("other/models")),
        ]
        for env, extra, expected_name, expected_dir in cases:
            with self.subTest(env=env, extra=extra), clean_env(**env), fake_config() as loader, \
                    mock.patch.object(urllib.request, "urlopen", forbid_network):
                code, _, stderr = run_cli(base + extra)
            self.assertEqual((code, stderr), (0, ""))
            loader.assert_called_once_with(expected_name, expected_dir)

    def test_config_errors_are_reported_not_raised(self):
        self.profile()
        base = ["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x", "--out", str(self.out),
                "--planner", "openrouter", "--dry-run", "--env-file", self.no_env]
        with clean_env(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, _, stderr = run_cli(base + ["--model-config", "no-such-model", "--models-dir", str(MODELS_DIR)])
        self.assertEqual(code, 1)
        self.assertIn("error: model config file not found", stderr)
        self.assertIn("no-such-model.yaml", stderr)
        with clean_env(), no_yaml(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, _, stderr = run_cli(base + ["--model-config", str(MODELS_DIR / "default.yaml")])
        self.assertEqual(code, 1)
        self.assertIn("error: PyYAML is not installed", stderr)
        self.assertIn("docker compose run --rm agent", stderr)
        self.assertFalse((self.out / "plan_request.json").exists())

    def test_spec_planner_never_loads_model_config(self):
        self.profile()
        never = mock.patch.object(cli, "load_model_config", side_effect=AssertionError("must not load a model config"))
        with no_yaml(), never:
            code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                            "--out", str(self.out), "--spec", SPEC, "--raw", RAW])
        self.assertEqual((code, stderr), (0, ""))
        self.assertNotIn("Model config", stdout)
        self.assertTrue((self.out / "task_spec.json").is_file())

    def test_plan_openrouter_without_allow_is_refused(self):
        self.profile()
        with clean_env(), fake_config(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                            "--out", str(self.out), "--planner", "openrouter", "--env-file", self.no_env])
        self.assertEqual(code, 1)
        self.assertIn("API call not allowed", stderr)
        self.assertNotIn("Usage:", stdout)
        # 요청은 거절되기 전에 저장된다 (보냈을 내용을 확인할 수 있게). 응답 파일과 spec 은 없다.
        self.assertTrue((self.out / "plan_request.json").is_file())
        self.assertFalse((self.out / "plan_response.json").exists())
        self.assertFalse((self.out / "task_spec.json").exists())

    def test_plan_openrouter_allowed_uses_fake_api(self):
        self.profile()
        spec = json.loads(Path(SPEC).read_text(encoding="utf-8"))
        calls = []

        usage = {"prompt_tokens": 11873, "completion_tokens": 2910, "total_tokens": 14783, "cost": 0.0034}

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            return FakeResponse({"id": "gen-1", "choices": [{"message": {"content": json.dumps(spec)}}], "usage": usage})

        env_file = Path(self.tmp.name) / "keys.env"
        env_file.write_text("OPENROUTER_KEY=sk-from-file\n", encoding="utf-8")
        with clean_env(), fake_config(), mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            code, stdout, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                            "--out", str(self.out), "--planner", "openrouter", "--allow-api",
                                            "--env-file", str(env_file), "--raw", RAW])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer sk-from-file")
        self.assertIn("Planned with openrouter", stdout)
        self.assertIn("Usage: prompt 11873, completion 2910, cost $0.0034\n", stdout)
        # 예시 spec 에 planner_notes 가 있으면 그 줄이 나오고, 없으면 나오지 않는다 (spec 형식과 무관하게 getattr 로 본다)
        notes = cli.describe_notes(cli.load_spec(Path(SPEC)))
        if notes:
            self.assertIn(f"Planner notes: {notes}\n", stdout)
        else:
            self.assertNotIn("Planner notes", stdout)
        self.assertEqual(json.loads((self.out / "task_spec.json").read_text(encoding="utf-8")), spec)
        # 요청과 응답이 출력 폴더에 남는다. 키는 어디에도 없다.
        request = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(request["body"]["model"], "test/model")
        response = json.loads((self.out / "plan_response.json").read_text(encoding="utf-8"))
        self.assertEqual(response["usage"], usage)
        self.assertEqual(response["id"], "gen-1")
        self.assertEqual(response["model_config"]["name"], "test")
        for name in ("plan_request.json", "plan_response.json"):
            self.assertNotIn("sk-from-file", (self.out / name).read_text(encoding="utf-8"))
        self.assertFalse((self.out / "plan_request_2.json").exists())

    def test_plan_prints_usage_and_planner_notes(self):
        self.profile()
        base = ["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x", "--out", str(self.out),
                "--planner", "openrouter", "--env-file", self.no_env]
        cases = [
            # (total_usage, planner_notes, 기대하는 줄, 없어야 하는 문구)
            ({"calls": 1, "prompt_tokens": 12000, "completion_tokens": 3000, "total_tokens": 15000},
             "Used one passage per item.",
             ["Usage: prompt 12000, completion 3000", "Planner notes: Used one passage per item."], []),
            ({"calls": 2, "prompt_tokens": 25000, "completion_tokens": 6100, "total_tokens": 31100},
             ["first note", " second note ", ""],
             ["Usage: prompt 25000, completion 6100 (2 calls)", "Planner notes: first note; second note"], []),
            ({"calls": 1, "prompt_tokens": 12000, "completion_tokens": 3000, "total_tokens": 15000, "cost": 0.0034},
             None, ["Usage: prompt 12000, completion 3000, cost $0.0034"], ["Planner notes"]),
            ({"calls": 2, "prompt_tokens": 25000, "completion_tokens": 6100, "total_tokens": 31100, "cost": 0.0068},
             None, ["Usage: prompt 25000, completion 6100, cost $0.0068 (2 calls)"], []),
            (None, None, [], ["Usage:", "Planner notes"]),
            (None, "   ", [], ["Usage:", "Planner notes"]),
            ({"calls": 1}, "", [], ["Usage:", "Planner notes"]),
        ]
        for total_usage, notes, expected, absent in cases:
            spec = fake_spec(planner_notes=notes) if notes is not None else fake_spec()
            with self.subTest(usage=total_usage, notes=notes), clean_env(), \
                    mock.patch.object(cli, "make_planner", return_value=FakePlanner(total_usage)), \
                    mock.patch.object(cli, "run_plan", return_value=spec) as run, \
                    mock.patch.object(urllib.request, "urlopen", forbid_network):
                code, stdout, stderr = run_cli(base)
            self.assertEqual((code, stderr), (0, ""))
            run.assert_called_once()
            lines = stdout.splitlines()
            self.assertIn(f"Planned with fake: task 't1' -> {self.out / 'task_spec.json'}", lines)
            for line in expected:
                self.assertIn(line, lines)
            for text in absent:
                self.assertNotIn(text, stdout)

    def test_describe_usage_and_notes_helpers(self):
        self.assertIsNone(cli.describe_usage(cli.FilePlanner(SPEC)))
        self.assertIsNone(cli.describe_usage(FakePlanner(None)))
        self.assertIsNone(cli.describe_usage(FakePlanner({"calls": 1})))
        self.assertEqual(cli.describe_usage(FakePlanner({"prompt_tokens": 5})), "Usage: prompt 5, completion ?")
        self.assertEqual(cli.describe_usage(FakePlanner({"calls": 3, "prompt_tokens": 5, "completion_tokens": 1})),
                         "Usage: prompt 5, completion 1 (3 calls)")
        # cost 가 숫자면 붙이고, 아니면 뺀다
        self.assertEqual(cli.describe_usage(FakePlanner({"prompt_tokens": 5, "completion_tokens": 1, "cost": 0.0034})),
                         "Usage: prompt 5, completion 1, cost $0.0034")
        self.assertEqual(cli.describe_usage(FakePlanner({"calls": 2, "prompt_tokens": 5, "completion_tokens": 1,
                                                         "cost": 0.5})),
                         "Usage: prompt 5, completion 1, cost $0.5000 (2 calls)")
        self.assertEqual(cli.describe_usage(FakePlanner({"prompt_tokens": 5, "completion_tokens": 1, "cost": "n/a"})),
                         "Usage: prompt 5, completion 1")
        self.assertEqual(cli.describe_usage(FakePlanner({"prompt_tokens": 5, "completion_tokens": 1, "cost": True})),
                         "Usage: prompt 5, completion 1")
        self.assertEqual(cli.format_cost(0.0034), "$0.0034")
        self.assertEqual(cli.format_cost(0), "$0.0000")
        self.assertEqual(cli.format_cost(0.00004), "$0.000040")
        self.assertEqual(cli.format_cost(1.5), "$1.5000")
        self.assertEqual(cli.describe_notes(fake_spec()), "")
        self.assertEqual(cli.describe_notes(fake_spec(planner_notes=None)), "")
        self.assertEqual(cli.describe_notes(fake_spec(planner_notes="  note ")), "note")
        self.assertEqual(cli.describe_notes(fake_spec(planner_notes=["a", "b"])), "a; b")

    def test_env_variable_allows_api(self):
        self.profile()
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            return FakeResponse({"choices": [{"message": {"content": Path(SPEC).read_text(encoding="utf-8")}}]})

        with clean_env(AGENT_ALLOW_API="1", OPENROUTER_KEY="sk-env"), fake_config(), \
                mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            code, _, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                       "--out", str(self.out), "--planner", "openrouter", "--env-file", self.no_env])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(len(calls), 1)

    def test_run_dry_run_profiles_then_stops(self):
        with clean_env(), fake_config(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = run_cli(["run", RAW, "--prompt", "@" + PROMPT_FILE, "--out", str(self.out),
                                            "--planner", "openrouter", "--dry-run", "--env-file", self.no_env])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue((self.out / "profile.json").is_file())
        self.assertTrue((self.out / "plan_request.json").is_file())
        self.assertIn("Dry run", stdout)
        self.assertFalse((self.out / "task_spec.json").exists())
        self.assertFalse((self.out / "plan_response.json").exists())

    def test_providers_prints_the_table(self):
        with clean_env(), no_yaml(), mock.patch.object(cli, "fetch_endpoints", return_value=ENDPOINTS_PAYLOAD) as fetch, \
                mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = run_cli(["providers", "vendor/model"])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, ENDPOINTS_TABLE + "\n")
        fetch.assert_called_once_with("vendor/model", timeout=30)
        with clean_env(), mock.patch.object(cli, "fetch_endpoints", return_value=ENDPOINTS_PAYLOAD) as fetch:
            code, stdout, _ = run_cli(["providers", "vendor/model", "--timeout", "5"])
        self.assertEqual(code, 0)
        fetch.assert_called_once_with("vendor/model", timeout=5)
        self.assertNotIn("Model config", stdout)

    def test_providers_calls_the_public_url_without_a_key(self):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append((request, timeout))
            return FakeResponse(ENDPOINTS_PAYLOAD)

        with clean_env(OPENROUTER_KEY="sk-must-not-be-sent"), mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            code, stdout, stderr = run_cli(["providers", "vendor/model", "--timeout", "7"])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[-1], "2 endpoints for vendor/model")
        self.assertEqual(len(calls), 1)
        request, timeout = calls[0]
        self.assertEqual(request.full_url, "https://openrouter.ai/api/v1/models/vendor/model/endpoints")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(timeout, 7)
        self.assertIsNone(request.get_header("Authorization"))
        self.assertNotIn("sk-must-not-be-sent", stdout)

    def test_providers_errors_are_reported_not_raised(self):
        error = cli.PlannerError("OpenRouter returned HTTP 404 for https://openrouter.ai/…: No endpoints found")
        with clean_env(), mock.patch.object(cli, "fetch_endpoints", side_effect=error):
            code, stdout, stderr = run_cli(["providers", "vendor/model"])
        self.assertEqual((code, stdout), (1, ""))
        self.assertEqual(stderr, "error: OpenRouter returned HTTP 404 for https://openrouter.ai/…: No endpoints found\n")
        with clean_env(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = run_cli(["providers", "nomodel"])
        self.assertEqual((code, stdout), (1, ""))
        self.assertIn("error: model id must look like author/slug", stderr)
        self.assertNotIn("Traceback", stderr)

    @unittest.skipUnless(PIPELINE_AVAILABLE, "preprocess/render/validate modules are not available")
    def test_run_full_pipeline_with_spec(self):
        with no_yaml():  # --spec 실행은 모델 설정을 읽지 않으므로 PyYAML 없이 돈다
            code, stdout, stderr = run_cli(["run", RAW, "--prompt", "@" + PROMPT_FILE, "--out", str(self.out),
                                            "--spec", SPEC])
        self.assertEqual((code, stderr), (0, ""))
        for name in ("profile.json", "profile.md", "task_spec.json", "items.jsonl", "hits.csv", "summary.json",
                     "settings.json", "template.html", "validation.json"):
            self.assertTrue((self.out / name).is_file(), name)
        for word in ("Profiled", "Planned", "Preprocessed", "Rendered", "Validation: OK"):
            self.assertIn(word, stdout)
        code, _, _ = run_cli(["validate", str(self.out)])
        self.assertEqual(code, 0)

    @unittest.skipUnless(PIPELINE_AVAILABLE, "preprocess/render/validate modules are not available")
    def test_preprocess_and_render_commands(self):
        code, stdout, stderr = run_cli(["preprocess", RAW, "--spec", SPEC, "--out", str(self.out)])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue((self.out / "hits.csv").is_file())
        code, stdout, stderr = run_cli(["render", "--spec", SPEC, "--out", str(self.out)])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue((self.out / "template.html").is_file())


class DefaultOutTest(unittest.TestCase):
    """--out 을 빼면 profile·preprocess·run 은 output/<원본 파일 이름>/, plan 은 --profile 의 폴더, render 는 --spec 의 폴더에 쓴다.

    기본값은 현재 폴더 기준의 상대 경로라 임시 폴더로 chdir 해서 돌린다. 정해진 폴더는 "Output folder: …" 줄로 나온다.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_in_tmp(self, argv):
        with contextlib.chdir(self.dir):
            return run_cli(argv)

    def test_default_out_dir_helpers(self):
        self.assertEqual(cli.DEFAULT_OUT_ROOT, Path("output"))
        self.assertEqual(cli.default_out_dir("raw.json"), Path("output/raw"))
        self.assertEqual(cli.default_out_dir(Path("var/task/data.jsonl")), Path("output/data"))
        self.assertEqual(cli.default_out_dir("/abs/dir/records.csv"), Path("output/records"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.resolve_out_dir("here", Path("output/raw")), Path("here"))
            self.assertEqual(cli.resolve_out_dir(None, Path("output/raw")), Path("output/raw"))
            self.assertEqual(cli.resolve_out_dir("", Path("output/raw")), Path("output/raw"))
        self.assertEqual(out.getvalue(), "Output folder: here\nOutput folder: output/raw\nOutput folder: output/raw\n")

    def test_profile_writes_to_output_raw(self):
        code, stdout, stderr = self.run_in_tmp(["profile", RAW])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: output/raw")
        self.assertTrue((self.dir / "output" / "raw" / "profile.json").is_file())
        self.assertTrue((self.dir / "output" / "raw" / "profile.md").is_file())
        # --out 을 주면 그대로 쓴다
        code, stdout, _ = self.run_in_tmp(["profile", RAW, "--out", "elsewhere"])
        self.assertEqual(code, 0)
        self.assertEqual(stdout.splitlines()[0], "Output folder: elsewhere")
        self.assertTrue((self.dir / "elsewhere" / "profile.json").is_file())

    def test_plan_writes_next_to_the_profile(self):
        code, _, _ = self.run_in_tmp(["profile", RAW, "--out", "p"])
        self.assertEqual(code, 0)
        code, stdout, stderr = self.run_in_tmp(["plan", "--profile", "p/profile.json", "--prompt", "x", "--spec", SPEC])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: p")
        self.assertTrue((self.dir / "p" / "task_spec.json").is_file())
        self.assertFalse((self.dir / "output").exists())

    def test_plan_dry_run_logs_next_to_the_profile(self):
        self.run_in_tmp(["profile", RAW, "--out", "p"])
        with clean_env(), fake_config(), mock.patch.object(urllib.request, "urlopen", forbid_network):
            code, stdout, stderr = self.run_in_tmp(["plan", "--profile", "p/profile.json", "--prompt", "x",
                                                    "--planner", "openrouter", "--dry-run", "--env-file", "no-such.env"])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: p")
        self.assertTrue((self.dir / "p" / "plan_request.json").is_file())

    @unittest.skipUnless(PIPELINE_AVAILABLE, "preprocess/render/validate modules are not available")
    def test_render_writes_next_to_the_spec(self):
        (self.dir / "s").mkdir()
        (self.dir / "s" / "task_spec.json").write_text(Path(SPEC).read_text(encoding="utf-8"), encoding="utf-8")
        code, stdout, stderr = self.run_in_tmp(["render", "--spec", "s/task_spec.json"])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: s")
        self.assertTrue((self.dir / "s" / "template.html").is_file())

    @unittest.skipUnless(PIPELINE_AVAILABLE, "preprocess/render/validate modules are not available")
    def test_preprocess_and_run_write_to_output_raw(self):
        code, stdout, stderr = self.run_in_tmp(["preprocess", RAW, "--spec", SPEC])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: output/raw")
        self.assertTrue((self.dir / "output" / "raw" / "hits.csv").is_file())
        with no_yaml():
            code, stdout, stderr = self.run_in_tmp(["run", RAW, "--prompt", "@" + PROMPT_FILE, "--spec", SPEC])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout.splitlines()[0], "Output folder: output/raw")
        for name in ("profile.json", "task_spec.json", "hits.csv", "template.html", "validation.json"):
            self.assertTrue((self.dir / "output" / "raw" / name).is_file(), name)
        code, _, _ = self.run_in_tmp(["validate", "output/raw"])
        self.assertEqual(code, 0)


class ModuleEntryTest(unittest.TestCase):
    def test_python_m_agent_help(self):
        result = subprocess.run([sys.executable, "-m", "agent", "--help"], cwd=REPO_ROOT,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("profile", "plan", "preprocess", "render", "validate", "run", "sample", "providers", "test"):
            self.assertIn(name, result.stdout)

    def test_python_m_agent_reports_errors_without_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, "-m", "agent", "profile", str(Path(tmp) / "missing.json"),
                                     "--out", tmp], cwd=REPO_ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("error:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            bad_profile = Path(tmp) / "raw-as-profile.json"
            bad_profile.write_text("[{\"id\": \"r1\"}]", encoding="utf-8")
            result = subprocess.run([sys.executable, "-m", "agent", "plan", "--profile", str(bad_profile),
                                     "--prompt", "x", "--out", tmp, "--spec", SPEC],
                                    cwd=REPO_ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("error:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
