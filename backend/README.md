# backend: FastAPI 백엔드

`backend/`는 콘솔 화면(`frontend/`)이 부르는 REST API와, agent 파이프라인(`agent/`)을 화면에서 돌리기 위한 job API를 제공하는 FastAPI 서버입니다. 콘솔 REST는 프로토타입의 경로 표 `prototype/src/api/http/routes.ts`를 계약으로 삼아 같은 경로, 같은 JSON 모양으로 구현하고, 데이터는 SQLite에 두되 처음 켤 때 `data/` 폴더의 시작 데이터로 채웁니다. agent 파이프라인은 `agent/`를 그대로 import 해서 백그라운드에서 한 번에 하나씩 실행합니다.

```
브라우저 ──▶ frontend (nginx, /api 프록시) ──▶ backend (FastAPI, :8000)
                                               ├─▶ SQLite (volume backend-db). 비어 있으면 ./data 로 채웁니다
                                               └─▶ agent/ (import) → ./output/jobs/<job id>/
```

이번 단계에서 실제로 동작하는 것은 health, 템플릿 조회, batch 목록과 상세, 계정 조회, 그리고 agent job API 전부입니다. 경로 표의 나머지 경로도 모두 등록되어 있지만 501 `NOT_IMPLEMENTED` 봉투를 돌려주므로, 화면이 "아직 없는 기능"을 알아볼 수 있습니다.

## 실행하기

의존성(`backend/requirements.txt`)은 Docker 이미지 안에만 설치합니다. 코드(`backend/app`, `agent/`)는 컨테이너에 bind mount 되고 uvicorn이 `--reload`로 뜨므로, 고쳐도 이미지를 다시 빌드할 필요가 없습니다. 의존성을 바꿨을 때만 다시 빌드합니다.

```bash
docker compose up --build backend            # http://localhost:8000/api/health
docker compose logs -f backend               # 요청 로그: GET /api/batches → 200 (12 ms)
docker compose stop backend
```

```bash
curl -s http://localhost:8000/api/health
curl -s http://localhost:8000/api/templates | head -c 300
curl -s http://localhost:8000/api/batches
curl -s http://localhost:8000/api/batches/batch-1000001
curl -s http://localhost:8000/api/account
curl -s http://localhost:8000/api/workers       # 501 {"error":{"code":"NOT_IMPLEMENTED", …}}
```

OpenAPI 문서는 `http://localhost:8000/api/docs`에서 볼 수 있습니다. SQLite 파일은 volume `backend-db`에 있으며, 처음 상태로 돌리려면 `docker compose down -v`로 volume을 지웁니다 (프로토타입의 `db` volume도 함께 지워집니다).

Docker 없이 띄우려면 가상환경에 `pip install -r backend/requirements.txt`를 한 뒤 저장소 루트에서 `PYTHONPATH=.:backend uvicorn app.main:app --app-dir backend --reload`로 실행합니다. 환경변수를 주지 않으면 저장소 루트 기준으로 `data/`, `var/backend.sqlite`, `output/`, `environment/models/`, `environment/.env`를 씁니다.

## 콘솔 REST

기본 경로는 `/api`입니다. 인자를 싣는 규칙은 `routes.ts`와 같습니다. 경로의 `:이름`은 경로에, GET과 DELETE의 나머지 인자는 query string에(`q`는 `page`, `pageSize`, `sort=필드:방향`, `filters=<JSON>`으로 폅니다), POST와 PUT의 나머지 인자는 JSON body에 이름으로 넣되 인자 이름이 `body`면 그 값 자체가 body입니다. 응답 JSON의 모양은 `prototype/src/api/types.ts`의 타입과 같습니다.

| 이름 | 메서드와 경로 | 상태 |
|---|---|---|
| health | `GET /api/health` | 구현 |
| listTemplates | `GET /api/templates` | 구현 |
| getTemplate | `GET /api/templates/{id}` | 구현 |
| saveTemplate | `POST /api/templates` | 501 stub |
| deleteTemplate | `DELETE /api/templates/{id}` | 501 stub |
| listBatches | `GET /api/batches` | 구현 |
| getBatch | `GET /api/batches/{id}` | 구현 |
| createBatch | `POST /api/batches` | 501 stub |
| expireBatch | `POST /api/batches/{id}/expire` | 501 stub |
| listHits | `GET /api/batches/{batchId}/hits` | 501 stub |
| getHit | `GET /api/hits/{hitId}` | 501 stub |
| listAssignments | `GET /api/batches/{batchId}/assignments` | 501 stub |
| approveAssignments | `POST /api/assignments/approve` | 501 stub |
| rejectAssignments | `POST /api/assignments/reject` | 501 stub |
| addAssignments | `POST /api/hits/add-assignments` | 501 stub |
| getResults | `GET /api/batches/{batchId}/results` | 501 stub |
| exportBatch | `GET /api/batches/{batchId}/export` | 501 stub |
| listWorkers | `GET /api/workers` | 501 stub |
| getWorker | `GET /api/workers/{id}` | 501 stub |
| updateWorkerNote | `PUT /api/workers/{id}/note` | 501 stub |
| listPools | `GET /api/pools` | 501 stub |
| createPool | `POST /api/pools` | 501 stub |
| addWorkersToPool | `POST /api/pools/{poolId}/workers` | 501 stub |
| removeWorkersFromPool | `POST /api/pools/{poolId}/workers/remove` | 501 stub |
| blockWorkers | `POST /api/workers/block` | 501 stub |
| unblockWorkers | `POST /api/workers/unblock` | 501 stub |
| getAccount | `GET /api/account` | 구현 |

프로토타입의 `/api/mock/*` 경로는 mock 환경 전용이라 만들지 않습니다. 경로 표는 `app/routes.py` 한 곳에 있으며, `routes.ts`의 `API_ROUTES`와 키 하나하나 같습니다.

`GET /api/health`는 `{"status": "ok", "source": "seed" | "snapshot", "counts": {"templates", "batches", "hits", "assignments", "pools", "workers"}}`를 돌려줍니다. `source`는 이번 프로세스의 데이터가 방금 `data/`에서 올라온 것(`seed`)인지 DB에 있던 것(`snapshot`)인지입니다.

batch 목록과 상세의 상태(`in_progress`, `completed`, `expired`), `needsReview`, 진행률, 비용은 프로토타입과 같은 규칙으로 계산합니다. 계산 규칙은 `app/domain/`에 옮겨 두었고, 각 모듈의 docstring에 프로토타입 테스트의 기대값을 적어 두었습니다.

### 오류 봉투

오류는 항상 `{"error": {"code": "<CODE>", "message": "<설명>"}}`이며 프로토타입의 서버와 같은 상태 코드를 씁니다.

| 상태 | code | 언제 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 잘못된 요청. FastAPI의 검증 오류(422)도 이 봉투로 바꿉니다 |
| 404 | `NOT_FOUND` | 없는 자원, 없는 경로, 다른 메서드 |
| 501 | `NOT_IMPLEMENTED` | 경로 표에는 있지만 아직 구현하지 않은 경로 |
| 500 | `UNKNOWN` | 그 밖의 예외 |

## agent job API

원본 데이터와 prompt(또는 손으로 쓴 spec)를 올리면 agent 파이프라인(profile → plan → preprocess → render → validate)을 백그라운드에서 돌리고, 결과 파일을 내려받을 수 있습니다. job은 한 번에 하나씩 순서대로 실행됩니다.

| 메서드와 경로 | 하는 일 |
|---|---|
| `GET /api/agent/models` | 모델 설정 목록입니다. `{"models": [{"name", "model", "api", "provider_tag"}], "default": "<이름>", "api_allowed": bool}`. `models`는 `MODELS_DIR`의 `*.yaml`을 `agent.config.load_model_config`로 읽은 것이고(읽지 못한 파일은 건너뛰고 로그에 남깁니다), `default`는 `AGENT_MODEL`(환경변수 → `ENV_FILE`)이 가리키는 이름, `api_allowed`는 서버의 `AGENT_ALLOW_API`가 `1`인지입니다. |
| `POST /api/agent/jobs` | job을 접수합니다 (`multipart/form-data`). 응답은 202 `{"job": <Job>}`입니다. |
| `GET /api/agent/jobs` | `{"jobs": [<Job>, …]}`. 최신순이며, 서버를 다시 켜기 전에 돌린 job도 `OUTPUT_DIR/jobs/`에서 읽어 함께 보입니다. |
| `GET /api/agent/jobs/{id}` | `<Job>`. 없으면 404입니다. |
| `GET /api/agent/jobs/{id}/files/{name}` | 결과 파일입니다. `job.files`에 있는 이름만 받으며(그 밖의 이름은 404), 확장자에 따라 `Content-Type`을 정하고(`.csv` text/csv, `.html` text/html, `.json` application/json, `.md` text/markdown, `.jsonl` application/x-ndjson) `Content-Disposition: attachment; filename="<name>"`을 붙입니다. |

### POST /api/agent/jobs 의 필드

| 필드 | 종류 | 설명 |
|---|---|---|
| `raw` | 파일, 필수 | 원본 데이터입니다. JSON, JSONL, CSV를 받으며 형식은 agent의 `source.load_records`가 확장자로 정합니다. |
| `prompt` | 파일 | annotation 목적을 적은 prompt(`prompt.md`)입니다. `prompt_text`로 본문을 문자열로 보내도 됩니다. |
| `prompt_text` | 문자열 | prompt 본문입니다. `prompt` 파일 대신 씁니다. |
| `spec` | 파일 | 손으로 쓴 `task_spec.json`입니다. 있으면 LLM을 부르지 않고 이 spec을 그대로 씁니다(file planner). 접수할 때 `agent.spec.load_spec`으로 검사해 잘못되어 있으면 400으로 알립니다. |
| `model_config` | 문자열 | OpenRouter로 spec을 만들 때 쓸 모델 설정 이름입니다 (`MODELS_DIR`의 파일 이름, 확장자 없이). 생략하면 `GET /api/agent/models`의 `default`입니다. |
| `allow_api` | `"true"` / `"false"` | 실제 OpenRouter 호출을 허용할지입니다. 기본은 `false`입니다. |
| `name` | 문자열 | 목록에 보이는 이름입니다. 생략하면 원본 파일 이름입니다. |

`spec`이 있으면 prompt는 선택이고, `plan` 단계는 `skipped`가 됩니다. `spec`이 없으면 prompt가 필수이고, OpenRouter를 부르므로 **요청의 `allow_api=true`와 서버의 환경변수 `AGENT_ALLOW_API=1`이 모두** 있어야 합니다. 둘 중 하나라도 없으면 네트워크를 쓰지 않고 400 `INVALID_REQUEST`로 끝나며, 메시지에 무엇이 빠졌는지 적혀 있습니다. 서버를 `AGENT_ALLOW_API=1 docker compose up backend`로 띄웠을 때만 호출이 가능하고, 키는 `environment/.env`의 `OPENROUTER_KEY`에서 읽습니다. 호출은 크레딧을 씁니다.

LLM 없이 예시로 돌려 보려면 `agent/examples/groundedness/`의 세 파일을 올립니다.

```bash
curl -s -F raw=@agent/examples/groundedness/raw.json \
        -F prompt=@agent/examples/groundedness/prompt.md \
        -F spec=@agent/examples/groundedness/task_spec.json \
        -F name=example \
        http://localhost:8000/api/agent/jobs
# → 202 {"job": {"id": "job-20260924-133205-67b6", "status": "queued", …}}

curl -s http://localhost:8000/api/agent/jobs/job-20260924-133205-67b6          # status, steps, files, validation …
curl -sO -J http://localhost:8000/api/agent/jobs/job-20260924-133205-67b6/files/template.html
curl -sO -J http://localhost:8000/api/agent/jobs/job-20260924-133205-67b6/files/hits.csv
```

### Job 객체

```
{"id": "job-YYYYMMDD-HHMMSS-<4 hex>", "name": "…", "status": "queued" | "running" | "succeeded" | "failed",
 "created_at": ISO 8601 UTC, "started_at": ISO 8601 | null, "finished_at": ISO 8601 | null,
 "input": {"raw": "<원본 파일 이름>", "prompt": "<파일 이름>" | "prompt_text" | null, "spec": "<파일 이름>" | null},
 "planner": {"mode": "file" | "openrouter", "model_config": "<이름>" | null, "allow_api": bool},
 "steps": [{"name": "profile" | "plan" | "preprocess" | "render" | "validate",
            "status": "pending" | "running" | "succeeded" | "failed" | "skipped",
            "started_at": …, "finished_at": …, "error": string | null}],
 "log": ["<ISO 시각> <메시지>", …],
 "planner_notes": string | null, "summary": <summary.json> | null, "validation": <validation.json> | null,
 "usage": {"calls", "prompt_tokens", "completion_tokens", "total_tokens", "cost": float | null} | null,
 "files": ["profile.json", "profile.md", "task_spec.json", "hits.csv", "settings.json", "items.jsonl",
           "summary.json", "template.html", "validation.json", …있는 파일만…],
 "error": string | null}
```

- job 폴더는 `OUTPUT_DIR/jobs/<job id>/`입니다. 업로드는 `input/`에, 파이프라인 결과는 폴더에 바로 쓰며, 상태가 바뀔 때마다 `job.json`을 다시 써서 서버를 다시 켜도 목록에 남습니다. 다시 켤 때 `running`이던 job은 `failed`로, `queued`이던 job은 다시 큐에 넣습니다.
- `validate` 단계가 통과하지 못하면(`validation.json`의 `ok`가 `false`) job은 `failed`가 되고 `error`에 검증 요약이 들어가지만, 만들어진 파일은 그대로 `files`에 남습니다.
- `usage`는 OpenRouter를 불렀을 때만 있습니다 (모델 설정의 `usage: {include: true}` 덕분에 실제 청구액 `cost`가 들어옵니다).
- 컨테이너의 stdout에도 같은 job 로그가 `[job-…] profile: started`처럼 찍힙니다.

## 환경변수

docker-compose.yml의 `backend` 서비스가 컨테이너 경로로 채워 줍니다. 값을 주지 않으면 저장소 루트 기준의 기본값을 씁니다.

| 변수 | 컨테이너의 값 | 뜻 |
|---|---|---|
| `DATA_DIR` | `/app/data` | 시작 데이터 (`data/`, 읽기 전용). DB가 비어 있을 때 한 번 올립니다 |
| `DB_PATH` | `/app/var/backend.sqlite` | SQLite 파일 (volume `backend-db`) |
| `OUTPUT_DIR` | `/app/output` | agent job의 입력과 결과 (`output/jobs/<job id>/`, gitignore) |
| `MODELS_DIR` | `/app/environment/models` | 모델 설정 yaml |
| `ENV_FILE` | `/app/environment/.env` | `OPENROUTER_KEY`, `AGENT_MODEL`을 읽는 파일 |
| `AGENT_ALLOW_API` | `${AGENT_ALLOW_API:-0}` | `1`일 때만 OpenRouter 호출을 허용합니다 |

## 폴더 구성

```
backend/
├─ Dockerfile            python:3.14-slim. 빌드 컨텍스트는 저장소 루트 (agent/ 와 backend/app 을 함께 복사)
├─ requirements.txt      fastapi, uvicorn[standard], python-multipart, pyyaml
├─ README.md
└─ app/
   ├─ main.py            create_app() 팩토리, 요청 로그 middleware, lifespan (DB 초기화, job worker 시작)
   ├─ settings.py        환경변수 → Settings
   ├─ errors.py          ApiError 와 오류 봉투, 422 → 400 변환
   ├─ routes.py          REST 경로 표 (routes.ts 의 API_ROUTES 와 같음)
   ├─ db.py              SQLite 문서 저장소 (테이블마다 id + JSON doc). 비어 있으면 seed
   ├─ seed.py            data/ 폴더 읽기 (placeholders 와 attention 은 여기서 계산)
   ├─ domain/            progress.py, cost.py, attention.py, template.py (프로토타입 계산 규칙의 이식)
   ├─ routers/
   │   ├─ console.py     콘솔 REST. 구현된 핸들러와 501 stub
   │   └─ agent_jobs.py  /api/agent/models, /api/agent/jobs
   └─ agent_jobs/
       ├─ models.py      Job, Step 과 job.json 의 모양
       └─ runner.py      FIFO 큐 + worker 스레드. agent 의 단계를 job 폴더를 out_dir 로 해서 부릅니다
```

컨테이너 안에서는 `/app/agent`와 `/app/backend/app`이 이미지에 복사되어 있고, compose가 같은 경로에 bind mount를 겁니다. `PYTHONPATH=/app:/app/backend`라서 `import agent`와 `import app`이 모두 됩니다.

## 테스트

`backend/tests/`는 다음 단계에서 추가합니다. 계획은 다음과 같습니다.

- `app/routes.py`가 `prototype/src/api/http/routes.ts`의 `API_ROUTES`와 키 하나하나 같은지 대조하는 테스트
- `app/domain/`의 계산 규칙이 프로토타입 테스트의 기대값과 같은지 확인하는 테스트 (docstring에 적어 둔 값)
- `data/`로 seed 한 뒤 목록과 상세가 프로토타입 mock API의 응답과 같은지 확인하는 테스트
- 예시(`agent/examples/groundedness/`)로 job을 접수해 `succeeded`까지 가는지, 그리고 400 조건들을 확인하는 테스트
