"""CLI: 인자 파싱, profile/plan 하위 명령, --prompt @file, OpenRouter dry-run(네트워크 없음), 모델 설정 선택, 오류 출력.

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
from unittest import mock

from agent import cli, config, sample
from agent.config import ModelConfig
from agent.planner import openrouter

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODELS_DIR = REPO_ROOT / "environment" / "models"
RAW = str(EXAMPLE_DIR / "raw.json")
SPEC = str(EXAMPLE_DIR / "task_spec.json")
PROMPT_FILE = str(EXAMPLE_DIR / "prompt.txt")
ENV_KEYS = (openrouter.KEY_VARIABLE, config.MODEL_VARIABLE, openrouter.ALLOW_VARIABLE)
PIPELINE_AVAILABLE = all(importlib.util.find_spec(name) is not None
                         for name in ("agent.preprocess", "agent.render", "agent.validate"))
YAML_AVAILABLE = importlib.util.find_spec("yaml") is not None
TEST_CONFIG = ModelConfig(name="test", path=MODELS_DIR / "test.yaml", provider="openrouter", model="test/model",
                          params={"temperature": 0, "max_tokens": 8000, "response_format": {"type": "json_object"}},
                          timeout_seconds=120, spec_fix_retries=1, profile_max_chars=12000)


def fake_config():
    """cli.load_model_config 를 대역으로: yaml 을 읽지 않고 TEST_CONFIG 를 돌려준다. 호출 인자를 확인할 수 있다."""
    return mock.patch.object(cli, "load_model_config", return_value=TEST_CONFIG)


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


class ParserTest(unittest.TestCase):
    def test_every_subcommand_parses(self):
        parser = cli.build_parser()
        self.assertEqual(parser.parse_args(["profile", "raw.json", "--out", "o"]).command, "profile")
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
        self.assertIn("Model config: test (environment/models/test.yaml) -> openrouter test/model", stdout)
        self.assertIn("plan_request.json", stdout)
        document = json.loads((self.out / "plan_request.json").read_text(encoding="utf-8"))
        self.assertEqual(document["model_config"], {"name": "test", "path": "environment/models/test.yaml",
                                                    "provider": "openrouter", "model": "test/model"})
        self.assertEqual(document["endpoint"], openrouter.ENDPOINT)
        body = document["body"]
        self.assertEqual(body["model"], "test/model")
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertIn("groundedness", body["messages"][1]["content"])
        self.assertFalse((self.out / "task_spec.json").exists())

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
            self.assertEqual(document["model_config"]["provider"], "openrouter")
            self.assertEqual(document["body"]["model"], document["model_config"]["model"])
            self.assertEqual(document["body"]["max_tokens"], 8000)
            self.assertEqual(document["body"]["response_format"], {"type": "json_object"})

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
            code, _, stderr = run_cli(["plan", "--profile", str(self.out / "profile.json"), "--prompt", "x",
                                       "--out", str(self.out), "--planner", "openrouter", "--env-file", self.no_env])
        self.assertEqual(code, 1)
        self.assertIn("API call not allowed", stderr)
        self.assertFalse((self.out / "plan_request.json").exists())

    def test_plan_openrouter_allowed_uses_fake_api(self):
        self.profile()
        spec = json.loads(Path(SPEC).read_text(encoding="utf-8"))
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            return FakeResponse({"choices": [{"message": {"content": json.dumps(spec)}}]})

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
        self.assertEqual(json.loads((self.out / "task_spec.json").read_text(encoding="utf-8")), spec)

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


class ModuleEntryTest(unittest.TestCase):
    def test_python_m_agent_help(self):
        result = subprocess.run([sys.executable, "-m", "agent", "--help"], cwd=REPO_ROOT,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("profile", "plan", "preprocess", "render", "validate", "run", "sample", "test"):
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
