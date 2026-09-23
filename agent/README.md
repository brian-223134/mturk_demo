# agent: 원본 데이터에서 HIT 묶음까지

`agent/`는 annotation 원본 데이터와 "무엇을 판정하게 할지" 적은 prompt를 받아, MTurk에 게시할 수 있는 HIT 묶음을 만드는 파이프라인입니다. 원본을 자동으로 분석하고, 작업 명세(task spec)를 정한 뒤, HIT 단위 CSV와 MTurk crowd-form HTML 템플릿을 만들고, 그 결과가 콘솔에 올릴 수 있는 상태인지 검증합니다.

파이프라인은 Python 표준 라이브러리만 사용합니다. OpenRouter로 spec을 만들 때 모델 설정 파일을 읽기 위한 PyYAML 하나만 더 필요하며, 이것은 Docker 이미지 안에만 설치됩니다 (아래 [모델 설정](#모델-설정)). 실행은 항상 저장소 루트에서 `python3 -m agent …` 또는 Docker로 합니다.

## 흐름

```
원본 데이터 (JSON / JSONL / CSV)   +   prompt (annotation 목적)
            │
            ▼
   profile  ─── 경로, 타입, 길이, 값 분포, 이상치를 자동 분석 ───▶ profile.json, profile.md
            │
            ▼
   plan     ─── task_spec.json ──── LLM(OpenRouter)이 채우거나, 손으로 쓴 파일을 그대로 씁니다
            │
            ▼
   preprocess ───▶ items.jsonl, hits.csv, summary.json, settings.json
   render     ───▶ template.html
   validate   ───▶ validation.json
            │
            ▼
   콘솔 Create 탭:  Template ◀ template.html   Data ◀ hits.csv   Settings ◀ settings.json의 값
```

## 원칙: LLM은 spec만 채우고, 나머지는 코드가 합니다

LLM이 하는 일은 `task_spec.json` 하나를 쓰는 것뿐입니다. 어느 필드를 보여 줄지, 무엇을 판정할지, 어떤 선택지를 줄지, LLM 라벨(대조 기준)이 어디에 있는지, attention check를 어떻게 만들지를 spec에 적으면, 정제·렌더·검증은 spec만 보고 결정적으로 동작합니다.

이렇게 나눈 이유는 두 가지입니다.

- **재현성**: 같은 원본과 같은 spec을 주면 언제나 같은 `hits.csv`와 `template.html`이 나옵니다. spec은 사람이 읽고 고칠 수 있는 작은 JSON이므로, 결과가 이상하면 spec을 보면 됩니다.
- **크레딧 없이 실행**: spec을 손으로 쓰거나 이전에 만든 것을 다시 쓰면 LLM 호출 없이 전 과정을 돌릴 수 있습니다. 테스트와 예시도 모두 LLM 없이 동작합니다.

spec의 형식은 [spec_reference.md](spec_reference.md)에 영어로 설명되어 있습니다. 이 문서는 LLM에게 보내는 프롬프트에 그대로 들어가므로, 사람과 LLM이 같은 설명을 읽습니다.

## 실행하기

### Docker로 실행하기

이미지는 한 번만 빌드하면 됩니다. 코드는 컨테이너에 복사하지 않고 연결(bind mount)하므로, `agent/`를 고쳐도 다시 빌드할 필요가 없습니다. 모델 설정 파일을 읽는 PyYAML은 이 이미지 안에만 설치됩니다.

```bash
docker compose --profile agent build agent
```

입력과 출력은 `var/<작업 이름>/` 아래에 둡니다. `var/`는 `.gitignore`에 들어 있으므로 실제 데이터가 저장소에 들어가는 일은 없고, 폴더가 없으면 처음 실행할 때 만들어집니다. 컨테이너 안에서는 `/work/var`로 보이며, 명령에는 저장소 루트 기준의 상대 경로를 그대로 씁니다. `assets/`는 데이터 형식을 이해하기 위한 예시 자료를 두는 곳이라 컨테이너에 연결하지 않습니다. 다른 폴더의 파일을 쓰려면 실행할 때 `-v <폴더>:/work/<이름>`으로 연결합니다. 모델 설정 폴더 `environment/models/`는 읽기 전용으로 연결됩니다.

```bash
# spec 파일을 그대로 써서 전 과정을 실행합니다 (LLM 호출 없음)
docker compose run --rm agent run var/<task>/raw.json --prompt @var/<task>/prompt.txt --spec var/<task>/task_spec.json --out var/<task>/out

# 저장소 밖의 폴더를 /work/data 로 연결해서 실행합니다
docker compose run --rm -v <폴더>:/work/data agent run data/raw.json --prompt @data/prompt.txt --spec data/task_spec.json --out var/<task>/out

# 단위 테스트
docker compose run --rm agent test

# 하위 명령 도움말
docker compose run --rm agent --help
```

OpenRouter로 spec을 만들 때는 `AGENT_ALLOW_API=1`을 붙여야 실제 호출이 일어납니다. 키는 `environment/.env`에서 읽고, 모델은 같은 파일의 `AGENT_MODEL`이 가리키는 `environment/models/<이름>.yaml`에서 읽습니다 (아래 [OpenRouter로 spec 만들기](#openrouter로-spec-만들기)와 [모델 설정](#모델-설정)).

```bash
AGENT_ALLOW_API=1 docker compose run --rm agent run var/<task>/raw.json --prompt @var/<task>/prompt.txt --planner openrouter --out var/<task>/out
```

### Docker 없이 실행하기

Python 3.12 이상이면 됩니다. 저장소 루트에서 실행합니다. `--spec`으로 실행하는 전 과정과 테스트는 표준 라이브러리만으로 돌아갑니다. `--planner openrouter`는 모델 설정 파일을 읽기 위해 PyYAML이 필요하므로 Docker로 실행하거나, 직접 만든 가상환경에 `pip install -r agent/requirements.txt`로 설치한 뒤 실행합니다.

```bash
python3 -m agent --help
python3 -m agent run var/<task>/raw.json --prompt @var/<task>/prompt.txt --spec var/<task>/task_spec.json --out var/<task>/out
python3 -m agent test
```

## 하위 명령

| 명령 | 하는 일 |
|---|---|
| `profile RAW --out DIR [--format F]` | 원본을 분석해 `profile.json`과 `profile.md`를 만듭니다. 형식은 확장자와 내용으로 알아내며, `--format`으로 정해 줄 수도 있습니다. |
| `plan --profile DIR/profile.json --prompt TEXT --out DIR (--spec FILE \| --planner openrouter …) [--raw RAW]` | `task_spec.json`을 만듭니다. `--spec`은 그 파일을 검증만 해서 저장하고, `--planner openrouter`는 LLM에게 묻습니다. `--raw`를 주면 spec의 경로가 실제 레코드에서 풀리는지도 검사합니다. |
| `preprocess RAW --spec DIR/task_spec.json --out DIR` | spec대로 항목을 만들고 HIT로 묶어 `items.jsonl`, `hits.csv`, `summary.json`, `settings.json`을 만듭니다. |
| `render --spec DIR/task_spec.json --out DIR` | spec에서 MTurk 템플릿 `template.html`을 만듭니다. |
| `validate DIR` | 출력 폴더를 검사해 `validation.json`을 만듭니다. 오류가 있으면 종료 코드 1입니다. |
| `run RAW --prompt TEXT --out DIR (--spec FILE \| --planner openrouter …)` | 위 다섯 단계를 차례로 실행하고 각 결과 파일의 경로를 출력합니다. 검증에 실패하면 종료 코드 1입니다. |
| `sample RAW --out FILE [--n N] [--seed N] [--max-list N] [--format F] [--no-anonymize]` | 원본에서 레코드 몇 개를 뽑아 익명화한 표본을 JSON 배열로 저장합니다. 테스트용 fixture를 만들 때 씁니다 (아래 [실제 데이터의 일부로 테스트하기](#실제-데이터의-일부로-테스트하기-sample)). |
| `test` | `agent/tests`의 단위 테스트를 실행합니다. |

`--prompt`에는 문장을 직접 쓰거나 `@파일경로`로 파일을 가리킵니다. `--planner openrouter`일 때는 `--model-config`로 모델 설정을, `--env-file`로 키 파일을 바꿀 수 있습니다. 각 명령의 옵션은 `python3 -m agent <명령> --help`에서 볼 수 있습니다.

## 출력 파일

모두 `--out`으로 준 폴더에 고정된 이름으로 저장됩니다.

| 파일 | 내용 |
|---|---|
| `profile.json` | 원본의 구조 분석 결과입니다. 경로마다 타입, 등장 횟수, 길이 통계, 예시, 값 분포가 있고, 이상치와 planner를 위한 힌트 문장이 들어 있습니다. |
| `profile.md` | 같은 내용을 사람이 읽기 좋게 정리한 표입니다. |
| `plan_request.json` | `--dry-run`일 때 OpenRouter에 보낼 요청입니다. 어떤 모델 설정을 썼는지(`model_config`), 보낼 주소(`endpoint`), 요청 본문(`body`)이 들어 있습니다. 프롬프트를 확인하는 용도이며 키는 들어 있지 않습니다. |
| `task_spec.json` | 작업 명세입니다. 어떤 planner를 썼든 검증을 통과한 뒤 같은 형태로 저장됩니다. |
| `items.jsonl` | 항목(탭 하나) 단위의 중간 결과입니다. 레코드 ID, 필드 값, 판정 대상, 대조 기준, 답 이름이 한 줄에 하나씩 있습니다. |
| `hits.csv` | HIT 단위 CSV입니다. 콘솔의 `Data` 단계에 올립니다. 모든 셀은 JSON이며 템플릿이 그대로 읽습니다. |
| `summary.json` | 레코드·항목·HIT 수, attention 항목 수, 대조 기준 값의 분포, 행 크기 같은 요약입니다. |
| `settings.json` | 콘솔 `Settings`에 넣을 값입니다. 제목, 설명, 키워드, attention 규칙, 대조 기준 컬럼, 답 이름 규칙이 들어 있습니다. |
| `template.html` | MTurk crowd-form 템플릿입니다. 콘솔의 `Template` 단계에 올립니다. |
| `validation.json` | 검증 결과입니다. `ok`, `errors`(게시 불가), `warnings`(참고), `stats`가 있습니다. |

## 콘솔에 올리기

결과를 콘솔의 **Create** 탭에서 순서대로 올립니다.

1. `Template` 단계에서 `Upload or paste HTML`을 고르고 `template.html`을 올린 뒤 저장합니다. 템플릿이 쓰는 `${컬럼}` 목록이 표시됩니다.
2. `Data` 단계에서 `hits.csv`를 올립니다. 템플릿의 컬럼이 모두 있는지 콘솔이 검사합니다.
3. `Settings` 단계에서 `settings.json`의 값을 옮겨 적습니다. 제목·설명·키워드를 넣고, `Attention check`를 켜서 이름 접두어에 `attention_`, `Expected value`에 `settings.json`의 `attentionRule.expectedValue`를 입력합니다. `Review reference`에서는 `settings.json`의 `reference.column`에 적힌 컬럼(기본 `llm_label`)을 고릅니다. 그러면 Manage의 `Answers` 열에 worker의 답과 LLM 라벨이 나란히 보입니다.
4. `Preview & Cost`에서 한 HIT를 열어 보고 `Publish`로 게시합니다.

## OpenRouter로 spec 만들기

`--planner openrouter`를 주면 profile과 prompt, spec 형식 설명서를 묶어 OpenRouter의 chat completions에 보내고, 돌아온 JSON을 검증해 `task_spec.json`으로 저장합니다. 검증에 실패하면 오류 목록을 붙여 다시 묻습니다. 다시 묻는 횟수는 모델 설정의 `spec_fix_retries`로 정하며, 기본은 한 번입니다.

- **키**: `environment/.env`에 `OPENROUTER_KEY=…`를 적어 둡니다. 이 파일은 저장소에 들어가지 않습니다. 환경변수 `OPENROUTER_KEY`가 있으면 그것을 먼저 쓰고, 다른 파일을 쓰려면 `--env-file`로 가리킵니다.
- **모델**: `environment/models/<이름>.yaml`에 적힌 모델 설정을 씁니다. 이름은 `environment/.env`의 `AGENT_MODEL` 또는 명령의 `--model-config`로 고르고, 둘 다 없으면 `environment/models/default.yaml`을 씁니다 (아래 [모델 설정](#모델-설정)).
- **요청 확인**: `--dry-run`을 붙이면 API를 부르지 않고 `plan_request.json`만 저장한 뒤 정상 종료합니다. 프롬프트에 무엇이 들어가는지 먼저 확인할 때 씁니다.
- **크레딧 안전장치**: 실제 호출은 크레딧을 쓰므로 `--allow-api`를 붙이거나 환경변수 `AGENT_ALLOW_API=1`을 줄 때만 일어납니다. 둘 다 없으면 요청을 보내지 않고 `API call not allowed` 오류로 끝납니다. 테스트는 네트워크를 전혀 쓰지 않습니다.

아래 명령은 PyYAML이 있는 곳에서 실행합니다. Docker로 실행할 때는 `python3 -m agent`를 `docker compose run --rm agent`로 바꾸면 됩니다.

```bash
python3 -m agent profile var/<task>/raw.json --out var/<task>/out
python3 -m agent plan --profile var/<task>/out/profile.json --prompt @var/<task>/prompt.txt --planner openrouter --dry-run --out var/<task>/out
python3 -m agent plan --profile var/<task>/out/profile.json --prompt @var/<task>/prompt.txt --planner openrouter --allow-api --raw var/<task>/raw.json --out var/<task>/out
```

## 모델 설정

LLM에 관한 설정은 모델마다 하나의 YAML 파일로 `environment/models/`에 둡니다. 저장소에는 `default.yaml`이 들어 있고, 다른 모델을 쓰려면 이 파일을 복사해 `<이름>.yaml`로 저장한 뒤 고릅니다. API 키 같은 비밀은 설정 파일에 적지 않고 `environment/.env`에만 둡니다. `.env`는 저장소에 들어가지 않으며, 형식은 `environment/.env.example`에 있습니다.

| 키 | 의미 |
|---|---|
| `provider` | LLM을 부르는 방식입니다. 지금은 `openrouter`만 지원합니다. |
| `model` | provider에 넘기는 모델 id입니다. |
| `params` | chat completions 요청 본문에 그대로 들어가는 파라미터입니다. `temperature`, `max_tokens`, `response_format` 등을 적습니다. `model`과 `messages`는 코드가 채우므로 여기에 적을 수 없습니다. |
| `timeout_seconds` | 요청 하나를 기다리는 최대 시간(초)입니다. 기본값은 120입니다. |
| `planner.spec_fix_retries` | spec 검증에 실패했을 때 오류를 붙여 다시 묻는 횟수입니다. 기본값은 1입니다. |
| `planner.profile_max_chars` | 프롬프트에 넣는 profile의 최대 글자 수입니다. 기본값은 12000입니다. |

어느 설정을 쓸지는 두 가지 방법으로 고릅니다.

- `environment/.env`에 `AGENT_MODEL=<이름>`을 적어 둡니다. 이름은 `environment/models/` 안의 파일 이름(확장자 없이)이거나 `.yaml` 파일의 경로입니다. 환경변수 `AGENT_MODEL`이 있으면 그것을 먼저 씁니다.
- 명령에 `--model-config <이름 또는 경로>`를 붙입니다. 이것이 `.env`보다 우선합니다. 설정 파일을 다른 폴더에 두었다면 `--models-dir DIR`로 폴더를 바꿀 수 있습니다.

둘 다 없으면 `default`를 씁니다. 설정은 `--planner openrouter`일 때만 읽으며, 어떤 설정을 읽었는지 실행 시작 시 `Model config: …` 한 줄로 출력합니다.

YAML 파일을 읽는 PyYAML은 컨테이너 안에만 설치되어 있습니다. 그래서 OpenRouter로 spec을 만드는 실행은 Docker로 하고 (`docker compose run --rm agent …`), 호스트에서 직접 하려면 가상환경을 만들어 `pip install -r agent/requirements.txt`로 설치한 뒤 실행합니다. `--spec`으로 실행하는 전 과정은 설정을 읽지 않으므로 PyYAML 없이도 돌아갑니다.

`--dry-run`을 붙이면 API를 부르지 않고 `plan_request.json`만 저장합니다. 파일에는 어떤 설정을 썼는지(`model_config`), 어디에 보내는지(`endpoint`), 무엇을 보내는지(`body`)가 들어 있고 키는 들어 있지 않습니다. `model_config.path`는 저장소 루트 기준의 상대 경로입니다.

```json
{
  "model_config": {"name": "default", "path": "environment/models/default.yaml", "provider": "openrouter", "model": "…"},
  "endpoint": "https://openrouter.ai/api/v1/chat/completions",
  "body": {
    "model": "…",
    "messages": [{"role": "system", "content": "…"}, {"role": "user", "content": "…"}],
    "temperature": 0,
    "max_tokens": 8000,
    "response_format": {"type": "json_object"}
  }
}
```

```bash
# .env 의 AGENT_MODEL 대신 다른 설정으로 요청만 확인합니다
docker compose run --rm agent plan --profile var/<task>/out/profile.json --prompt @var/<task>/prompt.txt --planner openrouter --dry-run --model-config <이름> --out var/<task>/out
```

## 예시로 해 보기

`examples/groundedness/`에는 합성 데이터(`raw.json`), prompt(`prompt.txt`), 그 데이터용 spec(`task_spec.json`)이 있습니다. 실제 데이터는 아니며, 형식만 실제 작업과 같습니다. 다음 명령은 LLM 없이 전 과정을 실행합니다.

```bash
python3 -m agent run agent/examples/groundedness/raw.json --prompt @agent/examples/groundedness/prompt.txt --spec agent/examples/groundedness/task_spec.json --out /tmp/agent-example
```

`/tmp/agent-example/`에 위 출력 파일들이 생기고, `template.html`과 `hits.csv`를 콘솔의 Create 탭에 올려 볼 수 있습니다.

## 실제 데이터의 일부로 테스트하기 (`sample`)

테스트는 `assets/`나 Docker 마운트에 기대지 않고 저장소 안의 파일만으로 돌아가야 합니다. 그래서 실제 데이터의 형식을 검사하는 테스트에는 실제 원본에서 레코드 몇 개만 뽑은 표본을 씁니다. 저장소가 공개되어 있으므로 표본은 커밋하기 전에 익명화하며, `sample` 명령이 그 일을 합니다. `tests/fixtures/sample.json`은 다음 명령으로 만든 파일입니다.

```bash
python3 -m agent sample <원본> --out agent/tests/fixtures/sample.json --n 6 --seed 7 --max-list 12
```

옵션은 다음과 같습니다.

- `--n`은 뽑을 레코드 수이며 기본값은 6입니다. 원래 순서는 유지됩니다.
- `--seed`는 어떤 레코드를 뽑을지 정하는 난수 seed이며 기본값은 7입니다. 합성 텍스트를 만들 때도 같은 seed를 쓰므로, 같은 원본과 같은 seed면 언제나 같은 표본이 나옵니다.
- `--max-list N`은 익명화하기 전에 모든 리스트를 앞 N개로 자릅니다. 표본 크기를 줄일 때 씁니다.
- `--format`은 `profile`과 같이 원본 형식을 정해 줍니다. 없으면 확장자와 내용으로 알아냅니다.
- `--no-anonymize`는 실제 데이터를 그대로 저장합니다. 경고를 출력하며, 이렇게 만든 파일은 절대 커밋하면 안 됩니다.

익명화는 구조를 그대로 두고 이름과 본문만 바꿉니다. 그대로 두는 것은 구조(리스트 길이, 중첩), 숫자·bool·null, snake_case 키, `Chunk 3`, `Atomic fact1`, `Core subquery1`, `general_0_1`, `selected_facts` 같은 구조용 라벨, 그리고 `Yes`/`No`처럼 짧고(24자 이하) 표본 전체에서 5번 이상, 2개 이상의 레코드에 나오는 라벨 값입니다. 바꾸는 것은 그 밖의 키(모델이나 retriever 이름 등)로, 처음 나온 순서대로 `key_1`, `key_2`, …가 되며 같은 원래 키는 어디에 나오든 같은 이름이 됩니다. 공백이 없는 짧은 값(ID 등)은 `token_` 뒤에 hex 6자리가 붙은 형태로, 나머지 문자열은 같은 길이의 lorem ipsum으로 바뀌고 원문이 `?`로 끝나면 결과도 `?`로 끝납니다.

표본을 다시 만들면 키 이름이 바뀔 수 있으므로, `tests/fixtures/sample_spec.json`의 경로를 새 `key_n` 이름에 맞게 다시 고쳐야 합니다. `tests/test_sample_pipeline.py`는 이 표본과 spec으로 전 과정(preprocess, render, validate)을 돌리고, 표본에 `<이름>_test_123` 같은 데이터셋 항목 ID가 남아 있지 않은지와 키가 모두 익명인지도 검사합니다.

익명화하지 않은 로컬 데이터로도 같은 테스트를 돌릴 수 있습니다. 환경변수 `AGENT_LOCAL_SAMPLE_DIR`에 `raw.json`과 `task_spec.json`이 있는 폴더를 주면 그 폴더로 전 과정을 한 번 더 돌리고, 없으면 그 테스트는 건너뜁니다.

```bash
AGENT_LOCAL_SAMPLE_DIR=<폴더> python3 -m agent test
```

## spec을 손으로 쓰기

LLM 없이 새 작업을 만들려면 `examples/groundedness/task_spec.json`을 복사해 고치는 것이 가장 빠릅니다. 각 키의 의미, 경로 언어, 변수, 답 이름 규칙, attention 전략은 [spec_reference.md](spec_reference.md)에 있습니다. 고친 spec은 `plan --spec FILE --raw RAW`로 실제 레코드에 대해 검사할 수 있습니다.
