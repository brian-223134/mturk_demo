# backend: FastAPI 백엔드

`backend/`는 콘솔 화면(`frontend/`)이 부르는 REST API와, agent 파이프라인(`agent/`)을 화면에서 돌리기 위한 job API를 제공하는 FastAPI 서버입니다. 콘솔 REST는 프로토타입의 경로 표 `prototype/src/api/http/routes.ts`를 계약으로 삼아 같은 경로, 같은 JSON 모양으로 구현하고, 데이터는 SQLite에 두되 처음 켤 때 `data/` 폴더의 시작 데이터로 채웁니다. agent 파이프라인은 `agent/`를 그대로 import 해서 백그라운드에서 한 번에 하나씩 실행합니다.

```
브라우저 ──▶ frontend (nginx, /api 프록시) ──▶ backend (FastAPI, :8000)
                                               ├─▶ SQLite (volume backend-db). 비어 있으면 ./data 로 채웁니다
                                               └─▶ agent/ (import) → ./output/jobs/<job id>/
```

경로 표의 모든 경로가 구현되어 있어, `/api/mock/*`를 뺀 콘솔 REST 전체가 프로토타입의 mock API 와 같은 요청에 같은 응답을 냅니다. 같은 시작 데이터로 띄운 두 서버에 같은 조회와 같은 변경(검수, 재모집, 만료, 템플릿 저장과 삭제, 게시, pool 편집, 차단, 메모)을 보내 응답과 잔액을 대조해 확인했습니다. agent job API 도 전부 동작합니다.

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
curl -s "http://localhost:8000/api/workers?page=1&pageSize=5&sort=stats.total:desc"
curl -s "http://localhost:8000/api/batches/batch-1000001/assignments?page=1&pageSize=5&filters=%7B%22AssignmentStatus%22%3A%22Submitted%22%7D"
curl -s http://localhost:8000/api/batches/batch-1000001/results | head -c 300
curl -s -X POST http://localhost:8000/api/assignments/reject -H 'Content-Type: application/json' \
     -d '{"ids": ["<AssignmentId>"], "feedback": "Poor Quality."}'
```

OpenAPI 문서는 `http://localhost:8000/api/docs`에서 볼 수 있습니다. SQLite 파일은 volume `backend-db`에 있으며, 처음 상태로 돌리려면 `docker compose down -v`로 volume을 지웁니다 (프로토타입의 `db` volume도 함께 지워집니다).

Docker 없이 띄우려면 가상환경에 `pip install -r backend/requirements.txt`를 한 뒤 저장소 루트에서 `PYTHONPATH=.:backend uvicorn app.main:app --app-dir backend --reload`로 실행합니다. 환경변수를 주지 않으면 저장소 루트 기준으로 `data/`, `var/backend.sqlite`, `output/`, `environment/models/`, `environment/.env`를 씁니다.

## 콘솔 REST

기본 경로는 `/api`입니다. 인자를 싣는 규칙은 `routes.ts`와 같습니다. 경로의 `:이름`은 경로에, GET과 DELETE의 나머지 인자는 query string에(`q`는 `page`, `pageSize`, `sort=필드:방향`, `filters=<JSON>`으로 폅니다), POST와 PUT의 나머지 인자는 JSON body에 이름으로 넣되 인자 이름이 `body`면 그 값 자체가 body입니다. 응답 JSON의 모양은 `prototype/src/api/types.ts`의 타입과 같습니다.

| 이름 | 메서드와 경로 | 모듈 | 상태 |
|---|---|---|---|
| health | `GET /api/health` | console.py | 구현 |
| listTemplates | `GET /api/templates` | console.py | 구현 |
| getTemplate | `GET /api/templates/{id}` | console.py | 구현 |
| saveTemplate | `POST /api/templates` | create.py | 구현 |
| deleteTemplate | `DELETE /api/templates/{id}` | create.py | 구현 (204) |
| listBatches | `GET /api/batches` | console.py | 구현 |
| getBatch | `GET /api/batches/{id}` | console.py | 구현 |
| createBatch | `POST /api/batches` | create.py | 구현 |
| expireBatch | `POST /api/batches/{id}/expire` | manage.py | 구현 (204) |
| listHits | `GET /api/batches/{batchId}/hits` | manage.py | 구현 |
| getHit | `GET /api/hits/{hitId}` | manage.py | 구현 |
| listAssignments | `GET /api/batches/{batchId}/assignments` | manage.py | 구현 |
| approveAssignments | `POST /api/assignments/approve` | manage.py | 구현 |
| rejectAssignments | `POST /api/assignments/reject` | manage.py | 구현 |
| addAssignments | `POST /api/hits/add-assignments` | manage.py | 구현 |
| getResults | `GET /api/batches/{batchId}/results` | manage.py | 구현 |
| exportBatch | `GET /api/batches/{batchId}/export` | manage.py | 구현 |
| listWorkers | `GET /api/workers` | workers.py | 구현 |
| getWorker | `GET /api/workers/{id}` | workers.py | 구현 |
| updateWorkerNote | `PUT /api/workers/{id}/note` | workers.py | 구현 |
| listPools | `GET /api/pools` | create.py | 구현 |
| createPool | `POST /api/pools` | workers.py | 구현 |
| addWorkersToPool | `POST /api/pools/{poolId}/workers` | workers.py | 구현 |
| removeWorkersFromPool | `POST /api/pools/{poolId}/workers/remove` | workers.py | 구현 |
| blockWorkers | `POST /api/workers/block` | workers.py | 구현 (204) |
| unblockWorkers | `POST /api/workers/unblock` | workers.py | 구현 (204) |
| getAccount | `GET /api/account` | console.py | 구현 |

프로토타입의 `/api/mock/*` 경로는 mock 환경 전용이라 만들지 않습니다. 경로 표는 `app/routes.py` 한 곳에 있으며, `routes.ts`의 `API_ROUTES`와 키 하나하나 같습니다. 핸들러는 화면별 모듈(`app/routers/create.py`, `manage.py`, `workers.py`)에 있고, 각 모듈이 자기 몫의 `IMPLEMENTED`(경로 이름 → 핸들러)를 내놓으면 `console.py`가 합쳐서 등록합니다. 표에 있는데 어느 모듈도 구현하지 않은 이름이 생기면 501 stub 이 붙지만, 지금은 그런 경로가 없습니다. 결과가 없는 변경(삭제, 만료, 차단, 해제)은 프로토타입 서버와 같이 본문 없는 204 로 답합니다.

요청 본문은 pydantic 모델이 아니라 JSON 그대로 읽어 프로토타입의 `handlers.ts`와 같은 순서, 같은 문구로 검사합니다. 그래서 화면이 어느 서버에 붙어 있든 같은 오류 문구를 봅니다 (예: `Feedback is required when rejecting. Workers see it as the reason.`). 변경은 SQLite 트랜잭션 하나로 처리하므로, 여러 건 중 하나라도 처리할 수 없으면(없는 assignment, 잔액 부족) 아무것도 바뀌지 않습니다.

`GET /api/health`는 `{"status": "ok", "source": "seed" | "snapshot", "counts": {"templates", "batches", "hits", "assignments", "pools", "workers"}}`를 돌려줍니다. `source`는 이번 프로세스의 데이터가 방금 `data/`에서 올라온 것(`seed`)인지 DB에 있던 것(`snapshot`)인지입니다.

batch 목록과 상세의 상태(`in_progress`, `completed`, `expired`), `needsReview`, 진행률, 비용은 프로토타입과 같은 규칙으로 계산합니다. 계산 규칙은 `app/domain/`에 옮겨 두었고, 각 모듈의 docstring에 프로토타입 테스트의 기대값을 적어 두었습니다.

### 목록 조회 (ListQuery)

`listHits`, `listAssignments`, `listWorkers`는 query string 으로 `page`(1부터, 기본 1), `pageSize`(1~1000, 기본 25), `sort=<필드>:<asc|desc>`, `filters=<JSON 객체>`를 받고 `{"items": [...], "total": <필터 뒤 전체 수>}`를 돌려줍니다 (`app/domain/list_query.py`, 프로토타입의 `listQuery.ts`와 같은 규칙).

- 필드는 `stats.rejectRate`처럼 점 경로도 됩니다. 정렬은 안정적이라 같은 값끼리는 기본 순서를 지키고, 값이 없는(`null`) 항목은 방향과 무관하게 맨 뒤로 갑니다. 문자열은 대소문자를 무시해 비교합니다.
- 필터 값이 배열이면 "그중 하나와 같음", 아니면 "같음"이고, 빈 값(`null`, `""`, `[]`)은 필터가 없는 것으로 봅니다. 예: `filters={"AssignmentStatus":["Submitted","Rejected"]}`.
- 목록마다 특별한 필터가 있습니다. HIT: `incomplete`(true 면 미완료만). assignment: `attention`(`pass`, `fail`, 그 밖의 값은 판정 없음), `maxWorkTime`(초 미만), `workerSearch`(WorkerId 부분 일치). worker: `search`, `poolId`, `notInPool`, `minApproved`, `maxRejectRate`, `maxAttentionFailRate`, `minAgreement`(값이 없는 worker 는 조건을 만족하지 않는 것으로 봅니다).
- 기본 순서는 HIT 는 저장 순서(rowIndex), assignment 는 rowIndex → WorkerId → SubmitTime, worker 는 응답에 처음 나온 순서 → pool 의 worker → 메모나 차단이 붙은 worker 입니다.
- `page`가 정수가 아니거나 `pageSize`가 범위 밖이면 400 (`page must be an integer ≥ 1 (got 0)`), `filters`가 JSON 이 아니면 400 `Malformed query string (filters must be JSON).` 입니다.

`listHits`의 항목(HitListItem)은 `input` 대신 200자로 자른 `inputPreview`와 `progress`(submitted, approved, rejected, open, completed, shortfall), `expired`를 갖고, 전체 입력은 `getHit`으로 받습니다. `listAssignments`의 항목(AssignmentListItem)은 assignment 에 `rowIndex`, `reference`(문항 이름 → 대조 기준 값), `agreement`(attention 을 뺀 문항 중 기준과 같은 비율, 대소문자와 공백 무시)를 더한 것입니다. 대조 기준은 batch 의 `reference`가 `column`이면 그 입력 컬럼의 셀(JSON 이나 Python 리터럴을 읽어 문항 이름이나 위치로 대응, `app/domain/reference.py`), `majority`면 같은 HIT 의 다른 worker 들(반려 제외)의 majority 이고, attention 문항의 기준은 항상 batch 의 `expectedValue`입니다.

### 검수, 재모집, 만료와 잔액

MTurk 처럼 HIT 를 만들 때 비용을 미리 잡아 두고, 반려하면 돌려주며, 잔액이 모자라면 상태를 바꾸기 전에 400 `Insufficient balance: this needs $X but only $Y is available.`로 막습니다. assignment 1건의 값은 reward + 수수료(20%, HIT 의 `MaxAssignments`가 10 이상이면 40%, Masters 면 +5%, 최소 1센트)이며 `app/domain/cost.py`의 `unit_cost_cents`가 계산합니다. `AvailableBalance`는 센트 단위로 계산해 두 자리 문자열로 돌려 씁니다.

| 동작 | 규칙 | 잔액 |
|---|---|---|
| `createBatch` | 템플릿이 요구하는 컬럼, Title, MaxAssignments(정수 ≥ 1), 세 기간(> 0), 자동 승인 30일 상한, 최소 보상 $0.01, pool 존재, 대조 기준 컬럼, 잔액을 검사한 뒤 행마다 HIT(게시 시점의 `templateHtml` 사본, `inputColumns`, `initialMaxAssignments`, `answerSchema`)를 만듭니다. | 견적 총액(행 수 × MaxAssignments × 단가)을 뺍니다 |
| `rejectAssignments` | 사유(feedback)가 필수이고 Submitted 만 반려할 수 있습니다. `RejectionTime`, `RequesterFeedback`을 적습니다. | 건마다 단가를 돌려받습니다 |
| `approveAssignments` | Submitted 를 승인합니다. Rejected 는 `override: true`이고 반려한 지 30일 이내일 때만 되돌립니다. feedback 은 있으면 적고 없으면 지웁니다. | 되돌린 건마다 단가를 다시 냅니다 |
| `addAssignments` | `mode`는 추가할 수(정수 ≥ 1) 또는 `"fill-to-target"`(부족분 = 목표 − 승인 − 검수 대기 − 열린 자리). 처음 10 미만으로 만든 HIT 는 합계 9까지이고, 넘으면 그 HIT 는 건너뛰고 `skipped`에 사유를 적습니다. 만료된 HIT 는 게시 기간(`LifetimeInSeconds`)만큼 연장하며, 부족분이 없어도 만료되어 막힌 미완료 HIT 는 `fill-to-target`에서 추가 없이 연장만 합니다 (`count: 0, expirationExtended: true`). | 추가한 자리 × 단가를 뺍니다 |
| `expireBatch` | 살아 있는 HIT 의 만료 시각을 지금으로 당기고 `HITStatus`를 `Reviewable`로 맞춥니다. | 변화 없음 |

응답은 프로토타입과 같습니다: 승인과 반려는 바뀐 assignment 목록, 재모집은 `{"added": [{HITId, count, expirationExtended}], "skipped": [{HITId, reason}]}`, 게시는 만들어진 batch(`templateHtml` 포함)입니다.

### 결과와 export

`getResults`는 Approved 응답의 일반 문항(attention 제외)만 모아 문항(`<rowIndex>:<answerName>`)마다 `votes`, `workers`, `majority`(동률이면 `null`), `unanimous`를 내고, 투표 수가 정확히 `target`(batch 의 MaxAssignments)인 문항만으로 `unanimousRatio`와 Fleiss' κ(`fleissKappa`, `kappaItemCount`)를 계산합니다 (`app/domain/agreement.py`). 시작 데이터의 κ 는 statsmodels 의 값과 같습니다: batch-1000001 0.730594 (420 문항), batch-1000003 0.938407 (241), batch-1000002 0.856749 (326). `labelDistribution`은 전체 표의 값별 수입니다.

`exportBatch?format=`은 `{"filename", "mimeType", "content"}`(ExportFile)를 돌려줍니다. `mturk-csv`는 MTurk Requester 웹사이트의 결과 CSV 와 같은 컬럼(`HITId … Input.<컬럼> Answer.taskAnswers Approve Reject`, 시각은 `Thu Oct 09 07:30:20 UTC 2025` 형식, `Answer.taskAnswers`는 `[{"input_answers": "<JSON>"}]`)이고, `labels-json`은 `{"<rowIndex>:<answerName>": {votes, majority, workers}}`입니다 (`app/domain/export_formats.py`). 파일 이름은 batch 이름의 slug 에 `-results.csv`, `-labels.json`을 붙인 것입니다.

### worker 와 pool

worker 목록은 모든 assignment 를 훑어 지표(`app/domain/worker_stats.py`: total, approved, rejected, pending, rejectRate, attentionFailRate, medianWorkTimeInSeconds, majorityAgreement, batchCount, lastActiveAt)를 계산한 것입니다. majority 일치율은 자기 표를 빼고 같은 문항의 다른 worker 들(반려 제외) majority 와 비교하며, 다른 표가 없거나 동률인 문항은 뺍니다. 응답이 없어도 pool 에 들어 있거나 메모·차단이 붙은 worker 는 빈 지표로 목록에 나옵니다. `getWorker`는 여기에 batch 별 이력(`batches`), 최근 제출부터의 assignment 요약(`assignments`), 차단됐을 때의 `blockReason`을 더합니다.

pool 은 `pool-<slug>` id 를 받고 이름은 대소문자를 무시해 겹칠 수 없습니다. `addWorkersToPool`은 중복 없이 뒤에 붙이고, `removeWorkersFromPool`은 없는 id 를 무시합니다. `blockWorkers`는 사유가 필수이고 응답이 없는 worker 도 차단할 수 있으며, `unblockWorkers`는 `blockReason`을 지웁니다. `updateWorkerNote`는 목록에 있는 worker 만 받습니다.

### 오류 봉투

오류는 항상 `{"error": {"code": "<CODE>", "message": "<설명>"}}`이며 프로토타입의 서버와 같은 상태 코드를 씁니다.

| 상태 | code | 언제 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 잘못된 요청. FastAPI의 검증 오류(422)도 이 봉투로 바꿉니다 |
| 404 | `NOT_FOUND` | 없는 자원, 없는 경로, 다른 메서드 |
| 501 | `NOT_IMPLEMENTED` | 경로 표에는 있지만 구현하지 않은 경로 (지금은 없습니다. stub 장치만 남아 있습니다) |
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
├─ Dockerfile            python:3.14-slim. runtime stage(실행 이미지)와, 그 위에 requirements-dev.txt 를 더한 test stage.
│                        빌드 컨텍스트는 저장소 루트 (agent/ 와 backend/app 을 함께 복사)
├─ requirements.txt      fastapi, uvicorn[standard], python-multipart, pyyaml
├─ requirements-dev.txt  pytest, httpx2 (테스트 이미지에만 설치)
├─ pytest.ini            pytest 설정 (tests/ 폴더, import 경로)
├─ README.md
├─ tests/                pytest 테스트 (아래 "테스트")
│   ├─ conftest.py       임시 폴더에 DB 와 job 출력을 두고 create_app(Settings(...)) 으로 앱을 만드는 fixture
│   ├─ helpers.py        저장소 경로, routes.ts 파서, 예시 업로드, job 완료 대기
│   └─ test_*.py         경로 표, 계산 규칙, seed, 콘솔 REST, agent job API, 오류 봉투
└─ app/
   ├─ main.py            create_app() 팩토리, 요청 로그 middleware, lifespan (DB 초기화, job worker 시작)
   ├─ settings.py        환경변수 → Settings
   ├─ errors.py          ApiError 와 오류 봉투, 422 → 400 변환
   ├─ routes.py          REST 경로 표 (routes.ts 의 API_ROUTES 와 같음)
   ├─ db.py              SQLite 문서 저장소 (테이블마다 id + JSON doc). 비어 있으면 seed. Store 는 연결 하나 위의 읽기와 쓰기,
   │                     Database.transaction() 이 트랜잭션 하나로 묶어 준다
   ├─ seed.py            data/ 폴더 읽기 (placeholders 와 attention 은 여기서 계산)
   ├─ domain/            프로토타입 계산 규칙의 이식. progress.py (진행률, 재모집 계획), cost.py (수수료, 단가), attention.py,
   │                     template.py (placeholder), agreement.py (majority, Fleiss' κ), reference.py (대조 기준),
   │                     worker_stats.py (worker 지표), export_formats.py (CSV, 라벨 JSON), list_query.py (ListQuery),
   │                     js.py (JS 와 같은 숫자·문자열·정렬 규칙)
   ├─ routers/
   │   ├─ console.py     health, 템플릿 조회, batch 목록과 상세, 계정. 모듈들의 IMPLEMENTED 를 합쳐 경로 표대로 등록
   │   ├─ create.py      saveTemplate, deleteTemplate, createBatch, listPools
   │   ├─ manage.py      listHits, getHit, listAssignments, approve, reject, addAssignments, expireBatch, getResults, exportBatch
   │   ├─ workers.py     listWorkers, getWorker, updateWorkerNote, createPool, add/removeWorkers, block/unblockWorkers
   │   ├─ common.py      요청 읽기, 프로토타입과 같은 검증 오류, 시각과 ID, 잔액, HIT 필드 동기화
   │   └─ agent_jobs.py  /api/agent/models, /api/agent/jobs
   └─ agent_jobs/
       ├─ models.py      Job, Step 과 job.json 의 모양
       └─ runner.py      FIFO 큐 + worker 스레드. agent 의 단계를 job 폴더를 out_dir 로 해서 부릅니다
```

컨테이너 안에서는 `/app/agent`와 `/app/backend/app`이 이미지에 복사되어 있고, compose가 같은 경로에 bind mount를 겁니다. `PYTHONPATH=/app:/app/backend`라서 `import agent`와 `import app`이 모두 됩니다.

## 테스트

`backend/tests/`는 pytest 테스트입니다. 실행 이미지 위에 `requirements-dev.txt`(pytest, httpx2)만 더 설치한 test stage(`backend/Dockerfile`의 `FROM runtime AS test`)로 만든 이미지에서 돌리므로, 개발 의존성은 그 테스트 이미지에만 들어가고 실행 이미지(`backend` 서비스)와 호스트의 Python 에는 설치되지 않습니다.

```bash
docker compose build backend-test            # 처음 한 번, 그리고 requirements*.txt 를 바꿨을 때
docker compose run --rm backend-test         # 전체 테스트 130개 (3초 안팎). 코드와 data/ 는 bind mount 라 다시 빌드할 필요가 없습니다
docker compose run --rm backend-test pytest -q tests/test_console_api.py -k batches   # 일부만
```

테스트는 `create_app(Settings(...))`로 앱을 만들되 SQLite 와 job 출력은 pytest 의 임시 폴더에 두고, 시작 데이터는 저장소의 `data/`, 모델 설정은 `environment/models/`를 읽습니다. `environment/.env`는 읽지 않고(임시 env 파일을 씁니다) OpenRouter 는 부르지 않습니다 (`AGENT_ALLOW_API=0`). 경로는 파일 위치에서 저장소 루트를 찾아 정하므로 컨테이너에서도, 호스트에서 `backend/`로 들어가 `pytest`를 돌려도 같습니다. 파일마다 다루는 것은 다음과 같습니다.

- `test_routes_table.py`: `app/routes.py`의 경로 표가 `prototype/src/api/http/routes.ts`의 `API_ROUTES`와 키 하나하나(이름, 메서드, 경로, 인자 순서) 같은지, 표의 모든 경로가 앱에 등록되어 있고 어느 것도 501 을 내지 않는지, `MOCK_ROUTES`는 등록되어 있지 않은지 확인합니다.
- `test_domain.py`: `app/domain/`의 진행률, 비용, attention, 대조 기준(`reference.py`), worker 지표, export 형식, 재모집 계획, JS 호환 규칙(`js.py`)이 프로토타입 테스트(`prototype/src/domain/*.test.ts`)의 기대값과 같은지 확인합니다.
- `test_domain_agreement.py`: majority(동률은 `null`), Fleiss' κ(Fleiss 1971 예제 0.210, 정의되지 않는 경우), 문항 묶기와 자연 순서 정렬, 그리고 `data/`의 세 batch 에서 κ 가 statsmodels 의 값(0.730594, 0.938407, 0.856749)과 소수 여섯째 자리까지 같은지 확인합니다.
- `test_list_query.py`: ListQuery 의 필터(같음, 배열, 빈 값, custom), 정렬(숫자, boolean, 문자열, 없는 값은 맨 뒤, 안정), 페이지, 잘못된 값의 400 문구, query string 읽기를 확인합니다.
- `test_seed_db.py`: `data/`로 seed 한 규모(templates 2, batches 3, hits 72, assignments 231, pools 2, workers 60), 처음 켤 때 `seed`이고 같은 DB 파일을 다시 열면 `snapshot`인 것, 깨진 seed 폴더(임시 사본에서 파일을 지운 것)에서 `SeedError`가 나는 것을 확인합니다.
- `test_console_api.py`: health, 템플릿 목록과 상세, batch 목록과 상세의 상태·`needsReview`·진행률·비용, 계정, 없는 자원과 없는 경로의 404, 잘못된 입력의 400 봉투, 그리고 경로 표의 모든 경로가 구현되어 501 을 내는 경로가 없는 것을 확인합니다.
- `test_create_api.py`: 템플릿 저장(새 id, `-2` 접미어, 덮어쓰기, placeholders)과 삭제(204, 게시된 batch 의 사본은 그대로), 게시(행마다 HIT, 열린 자리, 잔액 $496.40, 100KB 셀), 게시 검증의 모든 문구, pool 목록을 확인합니다.
- `test_manage_api.py`: HIT 목록의 항목과 조회 조건, assignment 목록의 Row·Agree 열과 필터·기본 순서, column 과 majority 대조 기준, 승인·반려·번복의 상태 변화와 잔액($500.06 → $500.00), 전부 아니면 아무것도 바꾸지 않는 것, 재모집(fill-to-target, 만료 연장, 9개 상한, 잔액 부족), 만료, 결과와 κ, 두 export 형식을 확인합니다.
- `test_workers_api.py`: worker 목록의 지표와 순서, 정렬(값이 없는 항목은 맨 뒤)과 조건 필터, worker 상세, pool 만들기·추가·제거, 차단(사유 필수)·메모·해제, 응답이 없는 worker 가 목록에 나오는 것을 확인합니다.
- `test_agent_jobs_api.py`: 모델 목록, 예시(`agent/examples/groundedness/`)로 접수한 job 이 `succeeded`까지 가는 것(단계, 파일 9개, 검증, 요약)과 결과 파일 내려받기, 400 조건들(raw 없음, spec 도 prompt 도 없음, LLM 호출 불허, 잘못된 spec), spec 이 원본과 맞지 않을 때 `preprocess`에서 `failed`가 되는 것, `prompt_text`, 다른 앱이 같은 출력 폴더를 열어도 job 이 남는 것을 확인합니다.
- `test_errors.py`: 오류 봉투(`ApiError`의 code → 상태 코드, 검증 오류 422 → 400, 없는 경로와 다른 메서드 → 404, 그 밖의 예외 → 500)를 작은 임시 앱으로 확인합니다.
