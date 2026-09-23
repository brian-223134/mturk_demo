"""python3 -m agent 의 하위 명령.

    profile     원본을 분석해 profile.json, profile.md를 만든다
    plan        profile + prompt → task_spec.json (--spec 파일을 그대로 쓰거나 --planner openrouter)
    preprocess  spec + 원본 → items.jsonl, hits.csv, summary.json, settings.json
    render      spec → template.html
    validate    출력 묶음을 검사해 validation.json을 만든다
    run         profile → plan → preprocess → render → validate 를 한 번에
    sample      원본에서 레코드 몇 개를 뽑아 익명화한 표본을 만든다 (agent/sample.py, 테스트 fixture 용)
    test        agent/tests 의 unittest 를 돌린다

preprocess·render·validate 모듈은 하위 명령 안에서 늦게 import 한다. 그래서 그 모듈이 없어도 profile, plan,
test는 돈다. 오류는 SpecError, PlannerError, SourceError, PathError, ConfigError, 그 밖의 ValueError(sample의
잘못된 --n, --max-list 등)와 OSError를 잡아 메시지만 stderr에 쓰고 종료 코드 1을 돌려준다. 출력 파일 이름은
고정이다 (profile.json, task_spec.json, hits.csv, template.html, …).

--planner openrouter 일 때만 모델 설정(environment/models/<이름>.yaml)을 읽는다. 이름은 --model-config, 없으면
AGENT_MODEL(환경변수 → env 파일), 없으면 default 다. --spec 실행은 설정을 읽지 않으므로 PyYAML 없이도 돈다.
"""

from __future__ import annotations

import argparse
import json
import sys
import unittest
from pathlib import Path
from typing import Any

from agent import __version__, source
from agent.config import (DEFAULT_MODELS_DIR, MODEL_VARIABLE, ConfigError, load_model_config,
                          selected_model_name)
from agent.paths import PathError
from agent.planner.base import Planner, PlannerError, run_plan
from agent.planner.file_planner import FilePlanner
from agent.planner.openrouter import (ALLOW_VARIABLE, KEY_VARIABLE, OpenRouterPlanner, api_allowed_by_env,
                                      resolve_api_key)
from agent.profile import run_profile
from agent.sample import register_sample_command
from agent.source import SourceError
from agent.spec import SpecError, TaskSpec, load_spec

AGENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = AGENT_DIR.parent
DEFAULT_ENV_FILE = "environment/.env"
PLAN_REQUEST_FILE = "plan_request.json"
PROMPT_HELP = "annotation goal as text, or @FILE to read it from a file"


# ----------------------------------------------------------------------------------------------
# 공통 도우미
# ----------------------------------------------------------------------------------------------


def read_prompt(value: str) -> str:
    """--prompt 값. '@path'면 파일에서 읽는다. 비어 있으면 PlannerError."""
    if value.startswith("@"):
        path = Path(value[1:])
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            raise PlannerError(f"cannot read prompt file {path}: {error.strerror or error}") from None
    else:
        text = value
    text = text.strip()
    if not text:
        raise PlannerError("the prompt is empty")
    return text


def read_json(path: Path, what: str) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise PlannerError(f"cannot read {what} {path}: {error.strerror or error}") from None
    except ValueError as error:
        raise PlannerError(f"{path}: invalid JSON: {error}") from None


def read_profile(path: Path) -> dict:
    """--profile 파일. profile 명령이 만든 JSON 객체(paths 목록 포함)가 아니면 PlannerError."""
    data = read_json(path, "profile")
    if not isinstance(data, dict) or not isinstance(data.get("paths"), list):
        raise PlannerError(f"{path}: not a profile (expected the profile.json object written by the profile command)")
    return data


def make_planner(args: argparse.Namespace, out_dir: Path) -> Planner:
    """--spec 이면 FilePlanner, --planner openrouter 면 OpenRouterPlanner. --dry-run 이면 API를 허용하지 않는다.

    모델 설정은 openrouter 일 때만 읽는다 (--model-config, 없으면 AGENT_MODEL, 없으면 default). 읽은 설정의 이름과
    파일을 한 줄 출력한다.
    """
    if args.spec:
        return FilePlanner(args.spec)
    models_dir = Path(args.models_dir) if args.models_dir else DEFAULT_MODELS_DIR
    config = load_model_config(args.model_config or selected_model_name(args.env_file), models_dir)
    print(f"Model config: {config.name} ({config.display_path()}) -> {config.provider} {config.model}")
    allowed = (bool(args.allow_api) or api_allowed_by_env()) and not args.dry_run
    dry_run_path = out_dir / PLAN_REQUEST_FILE if args.dry_run else None
    return OpenRouterPlanner(config, api_key=resolve_api_key(None, args.env_file),
                             allow_api=allowed, dry_run_path=dry_run_path)


def dry_run(planner: Planner, profile: dict, prompt: str) -> int:
    path = planner.dry_run(profile, prompt)  # type: ignore[attr-defined]  # make_planner가 OpenRouterPlanner를 준다
    print(f"Dry run: wrote the request to {path} (the API was not called)")
    return 0


def describe_summary(summary: dict) -> str:
    """summary.json의 주요 수치를 한 줄로. 키가 없으면 있는 것만 쓴다."""
    parts: list[str] = []
    records = summary.get("records")
    if isinstance(records, dict) and "used" in records:
        parts.append(f"{records['used']} records")
    for key, label in (("items", "items"), ("hits", "HITs"), ("attention_items", "attention items")):
        if isinstance(summary.get(key), int):
            parts.append(f"{summary[key]} {label}")
    return ", ".join(parts) or "done"


def preprocess_step(spec: TaskSpec, raw_path: Path, out_dir: Path) -> dict:
    from agent.preprocess import run_preprocess

    summary = run_preprocess(spec, raw_path, out_dir)
    print(f"Preprocessed: {describe_summary(summary)} -> {out_dir / 'hits.csv'}"
          f" (+ items.jsonl, summary.json, settings.json)")
    return summary


def render_step(spec: TaskSpec, out_dir: Path) -> Path:
    from agent.render import run_render

    path = run_render(spec, out_dir)
    print(f"Rendered template -> {path}")
    return path


def validate_step(out_dir: Path) -> dict:
    from agent.validate import validate_bundle

    report = validate_bundle(out_dir)
    errors = list(report.get("errors", []))
    warnings = list(report.get("warnings", []))
    for message in errors:
        print(f"  error: {message}")
    for message in warnings:
        print(f"  warning: {message}")
    status = "OK" if report.get("ok") else "FAILED"
    print(f"Validation: {status} ({len(errors)} errors, {len(warnings)} warnings) -> {out_dir / 'validation.json'}")
    return report


# ----------------------------------------------------------------------------------------------
# 하위 명령
# ----------------------------------------------------------------------------------------------


def cmd_profile(args: argparse.Namespace) -> int:
    out_dir = Path(args.out)
    profile = run_profile(Path(args.raw), out_dir, args.format)
    info = profile["source"]
    print(f"Profiled {info['records']} records ({info['format']}) -> {out_dir / 'profile.json'}, {out_dir / 'profile.md'}")
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    out_dir = Path(args.out)
    profile = read_profile(Path(args.profile))
    prompt = read_prompt(args.prompt)
    records = None
    if args.raw:
        _, records = source.load_records(Path(args.raw))
    planner = make_planner(args, out_dir)
    if args.dry_run:
        return dry_run(planner, profile, prompt)
    spec = run_plan(profile, prompt, planner, out_dir, records)
    print(f"Planned with {planner.name}: task {spec.task.id!r} -> {out_dir / 'task_spec.json'}")
    return 0


def cmd_preprocess(args: argparse.Namespace) -> int:
    spec = load_spec(Path(args.spec))
    preprocess_step(spec, Path(args.raw), Path(args.out))
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    spec = load_spec(Path(args.spec))
    render_step(spec, Path(args.out))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    from agent.validate import run_validate

    out_dir = Path(args.out_dir)
    report = run_validate(out_dir)
    ok = bool(report.get("ok"))
    print(f"Validation: {'OK' if ok else 'FAILED'} -> {out_dir / 'validation.json'}")
    return 0 if ok else 1


def cmd_run(args: argparse.Namespace) -> int:
    raw_path = Path(args.raw)
    out_dir = Path(args.out)
    prompt = read_prompt(args.prompt)
    planner = make_planner(args, out_dir)

    profile = run_profile(raw_path, out_dir)
    info = profile["source"]
    print(f"Profiled {info['records']} records ({info['format']}) -> {out_dir / 'profile.json'}, {out_dir / 'profile.md'}")
    if args.dry_run:
        return dry_run(planner, profile, prompt)

    _, records = source.load_records(raw_path, info["format"])
    spec = run_plan(profile, prompt, planner, out_dir, records)
    print(f"Planned with {planner.name}: task {spec.task.id!r} -> {out_dir / 'task_spec.json'}")
    preprocess_step(spec, raw_path, out_dir)
    render_step(spec, out_dir)
    report = validate_step(out_dir)
    return 0 if report.get("ok") else 1


def cmd_test(args: argparse.Namespace) -> int:
    suite = unittest.defaultTestLoader.discover(start_dir=str(AGENT_DIR / "tests"), pattern="test_*.py",
                                                top_level_dir=str(REPO_ROOT))
    result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
    return 0 if result.wasSuccessful() else 1


# ----------------------------------------------------------------------------------------------
# 인자 파서
# ----------------------------------------------------------------------------------------------


def add_planner_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("planner (choose one)")
    group.add_argument("--spec", metavar="FILE", help="use this task spec file as it is (no LLM call)")
    group.add_argument("--planner", choices=["openrouter"], help="ask an LLM through OpenRouter to write the task spec")
    group.add_argument("--model-config", metavar="NAME_OR_PATH",
                       help=f"model config: a name in the models directory or a path to a .yaml file "
                            f"(default: ${MODEL_VARIABLE} from the environment or the env file, else default)")
    group.add_argument("--models-dir", metavar="DIR",
                       help=f"directory with the model config files (default: {DEFAULT_MODELS_DIR.as_posix()})")
    group.add_argument("--dry-run", action="store_true",
                       help="write the request to OUT/plan_request.json and exit without calling the API")
    group.add_argument("--allow-api", action="store_true",
                       help=f"actually call the OpenRouter API; this spends credits (${ALLOW_VARIABLE}=1 also allows it)")
    group.add_argument("--env-file", metavar="FILE", default=DEFAULT_ENV_FILE,
                       help=f"file with {KEY_VARIABLE}=... and {MODEL_VARIABLE}=... (default: %(default)s)")


def check_planner_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if bool(args.spec) == bool(args.planner):
        parser.error("pass exactly one of --spec FILE or --planner openrouter")
    if args.spec and (args.dry_run or args.model_config or args.models_dir):
        parser.error("--dry-run, --model-config and --models-dir apply only to --planner openrouter")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m agent",
        description="Turn raw annotation data and a prompt into HIT data (hits.csv) and an MTurk template (template.html).")
    parser.add_argument("--version", action="version", version=f"agent {__version__}")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    profile = commands.add_parser("profile", help="analyse the raw data and write profile.json and profile.md")
    profile.add_argument("raw", metavar="RAW", help="raw data file (.json, .jsonl or .csv)")
    profile.add_argument("--out", required=True, metavar="DIR", help="output directory")
    profile.add_argument("--format", choices=source.FORMATS, help="source format (default: detect from the file)")
    profile.set_defaults(func=cmd_profile)

    plan = commands.add_parser("plan", help="write task_spec.json from a profile and a prompt")
    plan.add_argument("--profile", required=True, metavar="FILE", help="profile.json from the profile command")
    plan.add_argument("--prompt", required=True, metavar="TEXT", help=PROMPT_HELP)
    plan.add_argument("--out", required=True, metavar="DIR", help="output directory")
    plan.add_argument("--raw", metavar="RAW", help="raw data file; when given, the spec is checked against its records")
    add_planner_arguments(plan)
    plan.set_defaults(func=cmd_plan)

    preprocess = commands.add_parser("preprocess", help="write items.jsonl, hits.csv, summary.json and settings.json")
    preprocess.add_argument("raw", metavar="RAW", help="raw data file")
    preprocess.add_argument("--spec", required=True, metavar="FILE", help="task_spec.json")
    preprocess.add_argument("--out", required=True, metavar="DIR", help="output directory")
    preprocess.set_defaults(func=cmd_preprocess)

    render = commands.add_parser("render", help="write template.html from a task spec")
    render.add_argument("--spec", required=True, metavar="FILE", help="task_spec.json")
    render.add_argument("--out", required=True, metavar="DIR", help="output directory")
    render.set_defaults(func=cmd_render)

    validate = commands.add_parser("validate", help="check an output directory and write validation.json")
    validate.add_argument("out_dir", metavar="DIR", help="output directory with task_spec.json, hits.csv and template.html")
    validate.set_defaults(func=cmd_validate)

    run = commands.add_parser("run", help="profile, plan, preprocess, render and validate in one go")
    run.add_argument("raw", metavar="RAW", help="raw data file (.json, .jsonl or .csv)")
    run.add_argument("--prompt", required=True, metavar="TEXT", help=PROMPT_HELP)
    run.add_argument("--out", required=True, metavar="DIR", help="output directory")
    add_planner_arguments(run)
    run.set_defaults(func=cmd_run)

    register_sample_command(commands)

    test = commands.add_parser("test", help="run the unit tests in agent/tests")
    test.add_argument("-v", "--verbose", action="store_true", help="show every test name")
    test.set_defaults(func=cmd_test)
    return parser


def main(argv: list[str] | None = None) -> int:
    """인자를 파싱해 하위 명령을 실행하고 종료 코드를 돌려준다."""
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command in ("plan", "run"):
        check_planner_arguments(parser, args)
    try:
        return int(args.func(args))
    except SpecError as error:
        print("error: the task spec is not valid:", file=sys.stderr)
        for message in error.messages:
            print(f"  {message}", file=sys.stderr)
        return 1
    except (PlannerError, SourceError, PathError, ValueError) as error:  # ConfigError 는 ValueError 다
        print(f"error: {error}", file=sys.stderr)
        return 1
    except ModuleNotFoundError as error:
        if error.name and error.name.startswith("agent."):
            print(f"error: {error.name} is not available in this checkout", file=sys.stderr)
            return 1
        raise
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
