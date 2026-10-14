# MTurk Annotation Console (mock)

Amazon Mechanical Turk(MTurk)로 진행하던 annotation 작업을 **만들고, 게시하고, 검수하고, worker를 관리**하는 웹 콘솔입니다.

실제 MTurk에는 연동하지 않습니다. MTurk의 용어와 화면 구성, 그리고 HIT, assignment, reward, qualification, attention check 같은 annotation 설정 방식을 차용한 자체 annotation 콘솔을 목표로 합니다.
지금은 **mock 단계**라서 익명화한 예시 데이터 위에서 모든 화면과 흐름을 직접 눌러 볼 수 있습니다. Requester와 Worker는 각자 계정으로 로그인하며, Requester가 게시한 batch의 HIT를 worker가 받아 풀고 제출하면 그 응답이 Requester의 검수 화면에 들어옵니다.

콘솔은 mono-repo로 구성되어 있습니다. 주 화면은 `frontend/`(vanilla JavaScript)와 `backend/`(FastAPI)이고, 원본 데이터에서 annotation 템플릿과 HIT를 자동으로 만드는 파이프라인이 `agent/`에 있습니다. 화면과 REST 계약을 처음 설계할 때 만든 React 프로토타입은 `prototype/`에 남아 있습니다.

| 탭 | 하는 일 |
|---|---|
| **Create** | MTurk처럼 작업의 틀인 Project(worker 화면 + 보상·인원·기간 같은 속성)를 만들고, Project에 CSV를 올려 batch를 게시합니다. 원본 데이터와 prompt로 템플릿을 자동으로 만들 수도 있습니다. |
| **Manage** | batch의 진행률과 비용을 확인하고, 제출된 응답을 승인하거나 반려합니다. 부족한 응답은 다시 모집하고, 결과(majority, Fleiss' κ)를 확인해 내보냅니다. |
| **Worker Pool** | worker별 품질 지표를 살펴보고, 믿을 만한 worker와 제외할 worker를 pool로 관리합니다. |

## 빠른 시작

Docker만 설치되어 있으면 됩니다. 저장소 루트에서 다음을 실행하고 http://localhost:3000 을 엽니다. 처음 써 보는 사람은 Create의 `Tutorial` 탭부터 보면 됩니다.

```bash
docker compose up -d --build frontend backend
```

- `frontend`: 화면입니다. 빌드 단계 없이 `frontend/src`를 nginx가 그대로 서빙하고, `/api` 요청을 `backend`로 전달합니다.
- `backend`: FastAPI 백엔드입니다 (http://localhost:8000/api/health). 처음 실행될 때 [data/](data/)의 시작 데이터로 DB를 채우고, agent 파이프라인을 job API로 노출합니다.
- `db`: PostgreSQL입니다. `backend`를 띄우면 함께 뜹니다.

처음에는 계정이 없으므로 admin 계정을 명령으로 만든 뒤 로그인합니다. 비밀번호는 명령이 물어봅니다.

```bash
docker compose exec backend python -m app.users create-admin --email <이메일> --name "<이름>"
```

처음 만든 admin은 이미 있던 데이터(시작 데이터와 그동안 만든 Project, batch, pool)의 주인이 됩니다. 연구실의 다른 Requester는 admin이 `Users` 탭에서 만든 초대 코드로 가입하고, worker는 가입 화면에서 바로 가입합니다. 가입 방식은 설정으로 바꿀 수 있습니다([backend/README.md](backend/README.md#계정)).

게시, 승인과 반려, pool 편집 같은 변경 사항과 자동 생성 job의 상태는 PostgreSQL(Docker volume `backend-pg`)에 저장되므로 컨테이너를 내렸다 올려도 유지됩니다. 처음 상태로 되돌리려면 `docker compose down -v`로 DB를 지웁니다 (프로토타입의 DB도 함께 지워집니다). 이전 버전에서 SQLite에 쌓은 데이터를 옮기는 방법은 [backend/README.md](backend/README.md#db)에 있습니다.

원본 데이터에서 **LLM으로** 템플릿을 만들 때(Create → New Project → Generate from raw data)만 OpenRouter 키가 필요합니다. 유료 호출이라 `environment/.env`에서 호출을 허용하고, 화면의 폼에서도 job마다 `Allow API calls (uses credits)`를 체크해야 합니다(둘 중 하나만으로는 호출하지 않습니다). 키가 없어도 저장소의 예시 명세(`agent/examples/*/task_spec.json`)를 올리면 LLM 없이 생성해 볼 수 있습니다.

```bash
cp environment/.env.example environment/.env      # OPENROUTER_KEY= 에 키를, AGENT_ALLOW_API= 에 1 을 적는다
docker compose restart backend                      # .env 를 바꾼 뒤에는 backend 를 다시 시작한다
```

`.env`를 고치지 않고 한 번만 허용하려면 `AGENT_ALLOW_API=1 docker compose up -d frontend backend`처럼 셸에서 줄 수도 있습니다. 셸에서 준 값이 `.env`보다 앞섭니다.

### 자주 쓰는 명령

| 명령 | 설명 |
|---|---|
| `docker compose run --rm frontend-test` | frontend의 테스트를 실행합니다 (Node 내장 test runner, npm 의존성 없음). |
| `docker compose run --rm backend-test` | backend의 테스트를 실행합니다 (pytest, 테스트 이미지 안에만 설치). |
| `docker compose --profile agent run --rm agent test` | agent 파이프라인의 테스트를 실행합니다. |
| `docker compose restart backend` | backend를 다시 시작합니다. 자동 생성 job 목록을 다시 읽을 때 씁니다. |

### 알아 두면 좋은 점

- `frontend/src`, `backend/app`, `agent/`는 컨테이너에 연결되어 있어서, 고친 뒤 새로고침하면 반영됩니다(backend는 자동으로 다시 시작합니다). 이미지를 다시 만들 필요는 의존성을 바꿨을 때뿐입니다.
- 기본 설정으로는 이 PC에서만 접속할 수 있습니다(`127.0.0.1`). 다른 PC에서 접속하려면 `BIND_ADDR=0.0.0.0`을 붙여 실행합니다. 포트는 `FRONTEND_PORT`와 `BACKEND_PORT`로 바꿉니다.
- 자동 생성 job의 입력과 결과는 `output/jobs/`(저장소에 들어가지 않음)에 저장됩니다. 실행하면 저절로 생기므로 미리 만들 필요는 없습니다.
- 실행 방법과 API는 [backend/README.md](backend/README.md)에, 화면 구성과 코드 구조는 [frontend/README.md](frontend/README.md)에 정리되어 있습니다.

### 프로토타입 콘솔

처음 설계할 때 만든 React + antd 화면과 Node mock API 서버입니다. Create가 이전의 5단계 마법사(Template → Data → Settings → Preview & Cost → Publish)이고, 가짜 응답을 만드는 `Mock tools`가 있습니다. production 화면과 같은 REST 경로 표를 씁니다.

```bash
docker compose up --build        # 프로토타입(web, api)과 production(frontend, backend)을 함께 띄웁니다
```

| 명령 | 설명 |
|---|---|
| (위 명령) | 프로토타입 화면 http://localhost:8080, mock API 서버 http://localhost:8787 |
| `docker compose --profile dev up dev` | 개발용 서버입니다. `prototype/src/`를 고치면 화면에 바로 반영됩니다. http://localhost:5173 |
| `docker compose --profile mock up web-mock` | API 서버 없이 브라우저만으로 동작하는 버전입니다. http://localhost:8081 |
| `docker compose run --rm test` | 프로토타입의 단위 테스트를 실행합니다 (Vitest). |
| `docker compose exec api npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY 1"` | 프로토타입 DB의 내용을 SQL로 조회합니다. |

Docker 없이 실행하려면 Node 24 이상이 필요합니다 (Node에 내장된 SQLite를 사용합니다). `prototype/`에서 `npm install` 뒤 `npm run dev`(브라우저만으로 동작) 또는 `npm run server & npm run dev:http`(mock API 서버와 함께)를 실행합니다.
코드를 고친 뒤에는 `--build`를 붙여 `web`을 다시 빌드해야 하고, 화면이 바뀌지 않으면 `VITE_WATCH_POLLING=true`를 붙여 실행해 봅니다.

## 화면 둘러보기

화면의 글자는 MTurk의 용어와 맞추기 위해 영어로 표시합니다. 이 문서에서 `이렇게 표시한 글자`는 화면에 보이는 그대로입니다.

### 로그인과 계정

- **`Sign in`, `Create an account`**: 로그인하지 않으면 로그인 화면이 열립니다. 가입할 때 계정 종류(`Worker` 또는 `Requester`)를 고르며, Requester는 초대 코드가 있어야 합니다. 로그인 ID는 이메일입니다.
- **Requester**: 아래의 Create, Manage, Worker Pool을 씁니다. Project와 batch는 연구실의 Requester가 함께 보고, 누가 만들었는지는 기록됩니다.
- **Admin**: Requester 화면에 `Users` 탭이 더 있습니다. 초대 코드를 만들고(코드는 만들 때 한 번만 보입니다), 계정을 정지하거나 다시 활성화합니다.
- **Worker**: 아래의 [Worker 화면](#worker-화면-hit-받아-풀기)이 열립니다. Requester 화면에는 worker의 이메일과 이름 대신 Worker ID만 보입니다.

### 상단 바

- **`MOCK` 배지**: 현재 환경을 나타냅니다. mock에서는 항상 `MOCK`입니다. `SANDBOX`(파랑)와 `PRODUCTION`(빨강)은 시험 환경과 실제 환경을 구분하기 위해 남겨 둔 값입니다.
- **계정 메뉴**: 오른쪽 끝의 이름을 누르면 이메일과 `Sign out`이 보입니다.
- **`Balance`**: 잔액입니다. batch를 게시하거나 응답을 추가로 모집하면 비용이 미리 차감되고, 응답을 반려하면 그만큼 돌아옵니다. 잔액이 부족하면 게시와 재모집을 할 수 없습니다.
- 프로토타입 콘솔에는 오른쪽 위에 **`Mock tools`**(가짜 응답 만들기, 상태 내보내기와 불러오기, `Reset to fixtures`)가 더 있습니다.

### Create: Project 만들기와 batch 게시

MTurk의 Requester 화면처럼 **Project**를 만든 뒤, Project에 CSV를 올려 **batch**를 게시합니다. Project는 작업의 틀(worker 화면과 속성)이고, batch는 그 틀에 실제 데이터를 넣어 내보낸 한 번의 게시입니다. 같은 Project로 batch를 여러 번 게시할 수 있습니다.
위쪽에 탭이 세 개 있습니다.

- **`New Batch with an Existing Project`**: Project 목록입니다. 행마다 `Publish Batch`(CSV를 올려 게시), `Edit`, `Copy`, `Delete`가 있습니다.
- **`New Project`**: 무엇으로 시작할지 고릅니다. starter 템플릿 9종(실제 미리보기와 함께), HTML 올리기, 원본 데이터에서 자동으로 만들기(`Generate from raw data`) 중에서 고릅니다.
- **`Tutorial`**: 처음 쓰는 사람을 위한 한국어 따라 하기 안내입니다. 단계마다 그 화면으로 바로 가는 버튼이 있습니다.

Project는 세 탭으로 만듭니다. `Enter Properties`에서 worker에게 보일 제목과 설명, 보상, HIT당 인원, 기간, worker 조건을 정하고, `Design Layout`에서 템플릿 HTML을 고치며 오른쪽의 worker 화면 미리보기를 바로 확인하고, `Preview and Finish`에서 요약을 보고 저장합니다.
batch는 네 단계로 게시합니다. `Upload CSV`에서 템플릿이 쓰는 컬럼이 있는지 검사하고, `Preview tasks`에서 행마다 worker 화면을 보고, `Review settings`에서 attention 규칙과 Review의 대조 기준을 정한 뒤, `Confirm and publish`에서 비용을 확인하고 게시합니다.

starter 템플릿은 콘솔이 제공하는 `<ann-*>` 요소로 쓴 짧은 HTML입니다. 요소가 문항을 그리고, 필수 문항을 검사하고, Review가 읽는 형식으로 답을 제출합니다.
화면별 선택지와 조건은 [Project로 batch 게시하기](docs/create-projects.md)에, 요소는 [`<ann-*>` 요소로 템플릿 쓰기](docs/annotation-elements.md)에 정리되어 있습니다. 프로토타입의 5단계 마법사는 [Create로 batch 게시하기](docs/creating-a-batch.md)에 있습니다.

### Manage: 진행 확인과 검수

**Batch 목록**에서는 batch마다 진행률(완료된 HIT / 전체), 응답 수(Submitted / Approved / Rejected), 반려율, 비용(지출 / 예상), 상태를 한눈에 볼 수 있습니다.
검수할 응답이 남아 있는 batch에는 `Needs review` 표시가 붙습니다.

batch 이름을 누르면 **상세 화면**이 열립니다. 네 개의 탭으로 나뉘어 있습니다.

- **`Overview`**: 진행률, 응답 현황(worker가 지금 풀고 있는 `In progress` 포함), 비용을 요약해 보여 주고 아래에 batch 설정을 표시합니다. `Top up incomplete HITs`(부족한 응답 재모집), `Expire now`(지금 만료), `Export` 버튼이 있습니다.
- **`Review`**: 응답을 검수하는 화면입니다.
  - 상태, attention check 통과 여부, worker, 작업 시간으로 걸러 낸 뒤 검수합니다. 검수 대기 응답마다 `Approve` / `Reject` 라디오가 있고, 기본 정렬(`Row`)에서는 같은 HIT의 응답이 하나로 묶여 HIT 칸의 `Approve all` / `Reject all`로 그 HIT의 worker 전원을 한 번에 정할 수 있습니다. 고른 결정은 페이지를 넘겨도 남으며, 표 위의 `Submit … decisions…`로 한 번에 제출합니다. `Reject attention-failed`는 attention check를 틀린 검수 대기 응답을 모두 `Reject`로 골라 둡니다.
  - 표의 `Answers` 열에는 응답마다 worker의 답과 대조 기준이 두 줄로 항상 보이므로, 행을 열지 않고도 한 페이지를 훑으며 고를 수 있습니다. 대조 기준은 batch를 게시할 때 `Review settings`에서 정하며, 기본은 같은 HIT를 수행한 다른 worker들의 majority이고 정답이나 LLM 라벨이 든 CSV 컬럼을 고를 수도 있습니다.
  - 행을 누르면 응답 상세가 열립니다. 문항마다 이 worker의 답, 같은 HIT를 수행한 다른 worker들의 답, 대조 기준을 나란히 보여 줍니다. `Open task`를 누르면 worker가 실제로 본 화면을 그대로 띄웁니다.
  - 반려할 때는 사유를 반드시 입력해야 하며, 자주 쓰는 문구 세 가지를 바로 고를 수 있습니다. attention check를 통과한 응답을 반려하려고 하면 경고가 표시됩니다.
  - MTurk는 응답을 반려해도 그 자리를 다시 열어 주지 않습니다. 그래서 반려를 확정하면 부족해진 만큼 다시 모집할지 곧바로 물어봅니다.
  - 반려한 응답은 30일 안에 승인으로 되돌릴 수 있습니다 (반려된 행의 `Revert…`).
- **`HITs`**: HIT별로 승인, 반려, 검수 대기, 남은 자리 수와 완료 여부를 보여 줍니다. 미완료 HIT만 골라 볼 수 있고, 선택한 HIT의 응답을 추가로 모집할 수 있습니다. 처음에 응답 수를 10개 미만으로 만든 HIT는 합계를 9개보다 늘릴 수 없다는 MTurk의 제약도 반영되어 있어, 이를 넘는 요청은 이유와 함께 건너뜁니다.
- **`Results`**: annotator 간 일치도(Fleiss' κ, Krippendorff's α)를 승인된 응답, 아직 승인하지 않은 제출(검수 대기), 둘을 합친 것의 세 범위로 나누어 보여 주고(반려된 응답은 어디에도 넣지 않습니다), 문항별 투표와 majority, 만장일치 비율, 라벨 분포를 보여 줍니다. MTurk 결과 CSV 형식이나 라벨 JSON으로 내보낼 수 있습니다.

결과 집계에는 승인된(Approved) 응답의 실제 문항만 들어가며, attention 문항은 제외합니다. κ와 만장일치 비율은 표 수가 목표(HIT당 응답 수)와 같은 문항만으로 계산합니다.
화면에 나오는 숫자를 읽는 방법은 [콘솔의 값 읽기](docs/reading-the-console.md)에 시작 데이터의 실제 값으로 정리되어 있습니다.

### Worker Pool: worker 품질 관리

오른쪽 위의 버튼으로 `Workers`와 `Pools` 화면을 오갑니다.

- **Worker 목록**: 모든 batch를 합산한 worker별 지표를 보여 줍니다. 제출, 승인, 반려 수와 반려율, attention 실패율, 작업 시간 중앙값, majority 일치율, 참여한 batch 수, 마지막 활동일을 볼 수 있습니다. 정렬, 검색, 필터를 지원하고, 여러 명을 선택해 pool에 넣거나 뺄 수 있습니다.
- **차단(`Block…`)**: 차단 창의 기본 선택지는 "Excluded pool에 추가"이며, 그래도 차단하려면 사유를 입력해야 합니다. MTurk에서 차단이 worker 계정에 불이익을 주던 것을 따라, 차단을 마지막 수단으로 두는 설계입니다. 차단과 메모는 MTurk처럼 Requester마다 따로이며, 다른 Requester가 차단했는지는 보이지 않습니다.
- **Pools**: pool을 만들고 구성원을 확인하거나 뺄 수 있습니다. `Fill by criteria…`는 조건(최소 승인 수, 최대 attention 실패율, 최소 일치율 등)을 입력하면 **해당하는 worker가 몇 명인지 먼저 보여 주고**, 확인한 뒤에 추가합니다.
- **Worker 상세**: 지표 요약, batch별 참여 이력, 메모를 볼 수 있습니다. batch 이름을 누르면 그 worker의 응답만 걸러진 Review 화면으로 이동합니다.

pool은 Project의 `Enter Properties`(Worker requirements)에서 "이 pool의 worker만 참여" 또는 "이 pool의 worker는 제외"로 지정합니다. MTurk의 custom Qualification과 같은 역할입니다.

### Worker 화면: HIT 받아 풀기

worker 계정으로 로그인하면 MTurk의 worker 사이트처럼 HIT를 고르고 풉니다.

- **`HITs`**: 받을 수 있는 HIT가 남은 batch 목록입니다. 제목, Requester, 보상, 제한 시간, 남은 HIT 수를 보고 `Accept & Work`로 HIT 하나를 받습니다. 이미 풀고 있는 HIT가 있으면 `Continue`로 이어서 합니다.
- **작업 화면**: Requester가 만든 템플릿이 그대로 열리고, 위쪽에 보상과 남은 시간, `Return HIT`(반납)가 있습니다. 템플릿의 `Submit`을 누르면 제출되고, 기본으로 같은 batch의 다음 HIT가 이어서 열립니다. 제한 시간이 지나면 제출할 수 없고 그 HIT는 다시 다른 worker에게 열립니다.
- **`Your HITs`**: 제출한 HIT의 상태(검수 대기, 승인, 반려)와 받을 금액, 반려 사유를 봅니다.
- 같은 HIT는 한 번만 풀 수 있고, HIT마다 정한 인원(`MaxAssignments`)이 차면 더 받을 수 없습니다. Requester가 차단한 worker와 pool 조건에 맞지 않는 worker에게는 그 batch가 보이지 않습니다.
- 작업 화면에는 템플릿이 쓰는 입력 컬럼만 보냅니다. 정답이 든 컬럼(attention 기대 답 컬럼, 대조 기준 컬럼)은 페이지 소스에도 남지 않으며, Requester는 게시할 때 `Confirm and publish`의 `Workers receive`에서 어떤 컬럼이 가는지 확인합니다.

## 예시 파일로 mock 테스팅 해보기

올려 볼 수 있는 파일은 모두 [example/](example/) 폴더에 준비되어 있습니다. CSV의 한 행이 HIT 하나가 됩니다. 아래에 적은 결과는 이 파일들을 실제로 올려서 확인한 화면의 문구입니다.

```
example/
├─ 1-task-data/         template.html, data.csv              window.TASK_DATA 방식
├─ 2-placeholder/       template.html, data.csv              ${컬럼명} 방식 (MTurk Requester 웹사이트와 동일)
│                       data-missing-column.csv              필요한 컬럼이 빠진 CSV
├─ 3-data-checks/       empty-cells.csv, excel-utf8-bom.csv, CSV 검사를 하나씩 확인하는 CSV
│                       excel-cp949.csv, large-rows.csv
├─ 4-saved-templates/   chunk-fact-relevance-input.csv,      콘솔에 미리 저장된 템플릿에 넣을 입력
│                       query-fact-coverage-input.csv
└─ 5-project/           passage-relevance.csv                starter 로 만든 Project 에 넣을 입력 (attention 행, 정답 컬럼)
```

### starter로 attention check가 있는 batch 게시하기

| 단계 | 진행 방법 | 화면에 표시되는 내용 |
|---|---|---|
| 1. New Project | `Passage relevance`를 고르고 `Create Project`를 누릅니다. | `Enter Properties`에 보상 $0.05, HIT당 3명이 채워져 있고, HIT 하나의 비용 `$0.18`이 보입니다. |
| 2. Preview and Finish | `Finish and publish a batch`를 누릅니다. | Project가 저장되고 Publish Batch가 열립니다. |
| 3. Upload CSV | `5-project/passage-relevance.csv`를 올립니다. | `8 rows, 4 columns`, `OK` 2/2 matched. 쓰이지 않는 컬럼 `gold`, `attention_expected`와 빈 셀이 있는 6행이 `WARN`으로 보이며, 이 빈 셀은 attention 행이 아닌 행의 `attention_expected`라 정상입니다. |
| 4. Review settings | `Attention check`를 켜고 `Expected answers column` → `attention_expected`, `Compare answers with` → `gold`를 고릅니다. | 첫 행의 `gold`가 `relevant`로 읽힌다는 안내가 보입니다. |
| 5. Confirm and publish | 비용을 확인하고 게시합니다. | 8 HITs × 3 assignments × $0.05 = $1.20, 수수료 $0.24, 합계 **$1.44**. 게시가 끝나면 새 batch의 Overview로 갑니다. |

5행과 8행이 질문과 상관없는 passage를 붙인 attention 행입니다. 자세한 설명은 [Project로 batch 게시하기](docs/create-projects.md#따라-하기-starter로-attention-check가-있는-batch-게시하기)에 있습니다.

### 프로토타입 콘솔에서

아래 시나리오는 프로토타입 콘솔(http://localhost:8080)의 5단계 마법사 기준입니다. production 콘솔에서도 같은 파일을 New Project → `Upload or paste HTML`과 Publish Batch의 `Upload CSV`에 올리면 CSV 검사 문구가 같게 나옵니다.

#### 시나리오 1. 처음부터 끝까지 게시해 보기

가장 빠른 방법은 화면의 `Load sample template`과 `Load sample CSV` 버튼입니다. 두 버튼은 `1-task-data/`의 파일을 그대로 불러옵니다. 파일을 직접 올려도 결과는 같습니다.

| 단계 | 진행 방법 | 화면에 표시되는 내용 |
|---|---|---|
| 1. `Template` | `Upload or paste HTML`을 고른 뒤 `Upload .html`로 `1-task-data/template.html`을 올리고 `Save template`을 누릅니다. | `none (uses window.TASK_DATA)`. 이 방식의 템플릿에는 `${...}`가 없습니다. |
| 2. `Data` | `1-task-data/data.csv`를 끌어다 놓습니다. | `10 rows, 5 columns, UTF-8`. 맞춰 볼 placeholder가 없다는 `OK`와, 5개 컬럼을 `window.TASK_DATA`로 쓸 수 있다는 `INFO`가 표시됩니다. |
| 3. `Settings` | `Attention check`의 `Expected value`에 `not_grounded`를 입력합니다. 나머지는 기본값을 그대로 둡니다. | HIT당 응답 수 3, 보상 $0.10 |
| 4. `Preview & Cost` | 보기를 고르고 Submit을 눌러 봅니다. | 비용은 보상 $3.00 + 수수료 $0.60 = **$3.60**입니다. 문항 `general_1`, `attention_1`, `general_2`가 인식되고, `Submit intercepted: 3 answer(s)`가 표시됩니다. |
| 5. `Publish` | `Publish`를 누릅니다. | 새 batch의 Overview로 이동합니다. 잔액이 $500.00에서 $496.40으로 줄어듭니다. |

게시한 뒤 **Mock tools → Generate fake submissions…**로 가짜 응답을 만들면, Manage의 Review에서 검수까지 이어서 해 볼 수 있습니다.

#### 시나리오 2. `${컬럼명}` 방식과 컬럼 누락 오류

MTurk Requester 웹사이트에서 쓰던 템플릿이 이 방식입니다. 템플릿의 `${passage}` 자리에 CSV의 `passage` 셀 내용이 **그대로** 들어갑니다.

| 올리는 파일 | 화면에 표시되는 내용 |
|---|---|
| 템플릿 `2-placeholder/template.html` | 이름 칸이 파일 이름으로 채워집니다. 저장하면 placeholder 5개가 표시됩니다: `${item_id}` `${passage}` `${sentence_1}` `${attention_sentence}` `${sentence_2}` |
| CSV `2-placeholder/data-missing-column.csv` | `ERROR` 1 placeholder(s) have no matching CSV column: `${sentence_2}`. **`Next` 버튼이 비활성화됩니다.** 치환되지 않은 `${...}`는 화면에 글자 그대로 남아 템플릿을 망가뜨리기 때문입니다. |
| CSV `2-placeholder/data.csv` | `8 rows, 6 columns`, `OK` 5/5 matched. 템플릿이 쓰지 않는 컬럼 `note`가 있다는 `WARN`이 표시되지만 진행할 수 있습니다. 쓰이지 않는 컬럼도 HIT에는 함께 저장됩니다. |

Settings의 `Expected value`에는 `not_grounded`를 입력합니다. Preview에서 `Item p01`과 문단이 치환되어 보이는 것을 확인할 수 있습니다.

#### 시나리오 3. Data 단계의 검사 확인하기

시나리오 1의 템플릿을 고른 상태에서 CSV만 바꿔 가며 올려 봅니다 (`Drop another CSV here`).

| CSV | 상황 | 화면에 표시되는 내용 |
|---|---|---|
| `3-data-checks/empty-cells.csv` | 빈 셀이 있는 CSV | `WARN` 2 row(s) have empty cells: row 3, 5. 경고만 하고 진행은 막지 않습니다. |
| `3-data-checks/excel-utf8-bom.csv` | Excel에서 "CSV UTF-8"로 저장한 파일 (맨 앞에 BOM, 줄 끝은 CRLF) | `10 rows, 5 columns, UTF-8 (BOM removed)`. 정상적으로 처리됩니다. BOM을 그대로 두면 첫 컬럼 이름이 달라져 `${...}`와 맞지 않게 됩니다. |
| `3-data-checks/excel-cp949.csv` | 한국어 Excel에서 일반 "CSV"로 저장한 파일 (CP949) | **업로드가 거절됩니다.** `The file is not valid UTF-8. Save it again as "CSV UTF-8" and upload it again.` 그대로 읽으면 글자가 깨진 채 게시되기 때문입니다. 앞서 올린 CSV는 그대로 유지됩니다. |
| `3-data-checks/large-rows.csv` | 한 행의 입력이 64KB를 넘는 CSV | `WARN` max 70.2 KB. 1 row(s) exceed MTurk's 64 KB Question limit. MTurk의 HIT 크기 제한을 기준으로 삼은 경고이며, 진행은 막지 않습니다. |

#### 시나리오 4. 미리 저장된 템플릿 사용하기

콘솔에는 실제 annotation 작업에 쓰던 템플릿 두 개가 저장되어 있습니다. `Template` 단계에서 하나를 고르고, 그 템플릿이 요구하는 16개 컬럼의 CSV를 올립니다.
이 CSV는 셀 하나가 길이 11인 Python 리스트 문자열이고(탭 10개 + attention 1개), 본문은 익명화한 합성 텍스트입니다.

| 템플릿 | CSV | 화면에 표시되는 내용 | `Expected value` |
|---|---|---|---|
| `Chunk-Fact Relevance` | `4-saved-templates/chunk-fact-relevance-input.csv` | `10 rows, 16 columns`, `OK` 12/12 matched, 쓰이지 않는 컬럼 4개(`*_reasoning`)에 대한 `WARN`. 행 크기는 중앙값 18.7 KB, 최대 38.0 KB | `not_grounded` |
| `Query-Fact Coverage` | `4-saved-templates/query-fact-coverage-input.csv` | `8 rows, 16 columns`, `OK` 12/12 matched, 쓰이지 않는 컬럼 4개에 대한 `WARN`. 행 크기는 중앙값 6.3 KB, 최대 8.1 KB | `Not Covered` |

Preview에는 탭 11개로 구성된 worker 화면이 그대로 나타납니다. 이 두 템플릿은 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷 연결이 필요합니다.
반대로 이 템플릿에 시나리오 1의 CSV를 올리면 `ERROR` 12 placeholder(s) have no matching CSV column이 표시됩니다.

### CSV를 만들 때

- 첫 줄에는 컬럼 이름을 쓰고, 둘째 줄부터 한 행이 HIT 하나가 됩니다. 인코딩은 **UTF-8**이어야 합니다 (Excel에서는 "CSV UTF-8"로 저장).
- 템플릿에 쓰인 모든 `${컬럼명}`이 CSV의 컬럼으로 있어야 합니다. 그 밖의 컬럼이 더 있는 것은 괜찮으며, 정답이나 attention 기대 답처럼 worker에게 보이지 않을 값을 두는 데 씁니다. Publish Batch의 `Download CSV template`으로 맞는 머리줄의 양식을 받을 수 있습니다.
- TASK_DATA 방식의 템플릿은 콘솔이 어떤 컬럼이 필요한지 알 수 없으므로 검사 없이 통과합니다. 템플릿이 읽는 키와 CSV의 컬럼 이름을 직접 맞춰 주세요.
- attention check는 두 방식 중 하나를 씁니다. attention 행의 기대 답을 `{"답 이름": "기대 값"}` 모양으로 한 컬럼에 적는 방식(starter, 자동 생성 결과)과, 예전 템플릿처럼 attention 문항의 이름을 `attention_`으로 시작하게 하고 기대 값 하나를 정하는 방식입니다. 둘 다 `Review settings`에서 고릅니다.
- `3-data-checks/`와 `4-saved-templates/`의 CSV는 `python3 scripts/build_examples.py`로 다시 만들 수 있습니다.

## 시작 데이터 (`data/`)

콘솔이 처음 실행될 때 읽는 데이터는 [data/](data/) 폴더에 있습니다. 데이터는 JSON으로, 템플릿은 HTML 파일로 관리합니다. 폴더 구조와 수정 방법은 [data/README.md](data/README.md)에 정리되어 있습니다.

- backend는 DB가 비어 있을 때만 `data/`를 읽습니다. 파일을 고친 뒤 반영하려면 `docker compose down -v`로 DB를 지우고 다시 띄웁니다. 프로토타입 콘솔에서는 **Mock tools → Reset to fixtures**로 바로 반영됩니다.
- 시작 데이터에는 batch 세 개와 템플릿 두 개(`Chunk-Fact Relevance`, `Query-Fact Coverage`)가 들어 있습니다. 템플릿은 Create의 Project 목록에 Project로 보입니다.
- 프로토타입 콘솔에서는 만든 상태를 **Mock tools → Export data (JSON)**으로 내려받아 다른 사람이 **Import data**로 불러오게 하거나, `prototype/`에서 `npm run data:unpack -- <파일>`로 `data/` 구조로 풀어 새로운 시작 상태로 삼을 수 있습니다.
- 들어 있는 batch 세 개는 실제 annotation 결과를 **익명화한 것**입니다. ID는 모두 새로 만들었고, 본문은 같은 길이의 합성 텍스트로 바꿨습니다. 응답 값, 검수 상태, 작업 시간은 그대로 두었기 때문에 진행률, worker 지표, Fleiss' κ는 원본과 같습니다.
- 익명화에 쓰는 salt(`scripts/.fixture_salt`)와 원본 파일 목록(`scripts/fixture_sources.json`)은 저장소와 Docker 이미지에 포함하지 않습니다.

## 동작 방식

```
브라우저 ──▶ frontend (nginx) ── frontend/src 를 그대로 서빙, /elements/(<ann-*> 요소, starter), /example/(예시 파일)
               │ /api
               ▼
            backend (FastAPI) ──▶ db (PostgreSQL, Docker volume backend-pg), 처음 한 번 data/ 로 채움
               └─▶ agent/ (import) ──▶ output/jobs/<job id>/  (자동 생성 job 의 입력과 결과. 상태는 db 에)
```

REST 경로는 [prototype/src/api/http/routes.ts](prototype/src/api/http/routes.ts)의 표 하나에 정의되어 있고, backend(`backend/app/routes.py`)와 frontend(`frontend/src/api-client/routes.js`)가 같은 표를 따릅니다. 테스트가 세 표가 어긋나지 않는지 확인합니다.
화면에서 미리 보는 worker 화면은 sandbox iframe 안에서 그려지고, Submit은 실제로 보내지 않고 가로채 답을 보여 줍니다.

### 프로토타입의 동작 방식

화면 코드는 `prototype/src/api/client.ts`의 `api` 객체만 호출합니다. 그 뒤에서 실제로 무엇이 동작할지는 빌드할 때 `VITE_API_MODE`로 정하며, 어느 쪽이든 화면 코드는 동일합니다.
현재 어떤 방식으로 동작 중인지는 Mock tools 메뉴 맨 아래에 표시됩니다.

| | `http` (Docker 기본값) | `mock` |
|---|---|---|
| 동작하는 곳 | mock API 서버 (`prototype/server/`) | 브라우저 안 |
| 저장 위치 | SQLite | 해당 브라우저의 IndexedDB |
| 시작 데이터 | `data/` 폴더를 디스크에서 읽음 | `data/` 폴더가 빌드 결과에 포함됨 |
| 요청 처리와 계산 | 두 방식 모두 `prototype/src/api/mock/handlers.ts`와 `prototype/src/domain/`의 **같은 코드**를 사용 | |

REST 경로는 [prototype/src/api/http/routes.ts](prototype/src/api/http/routes.ts)의 표 하나에 정의되어 있고, 브라우저 쪽 코드와 서버가 이 표를 함께 사용합니다.
Production 백엔드(FastAPI)는 같은 경로를 구현하며, 화면은 부르는 주소만 바꾸면 됩니다. `/mock/*` 경로는 mock 전용이므로 실제 백엔드에는 만들지 않습니다.

## 원본 데이터에서 HIT 만들기 (`agent/`)

annotation 원본 데이터(JSON, JSONL, CSV)와 "무엇을 판정하게 할지" 적은 prompt로부터 `hits.csv`와 `template.html`을 자동으로 만드는 파이프라인입니다.
원본의 구조를 분석하고(`profile`), 작업 명세(task spec)를 정한 뒤(`plan`), HIT 단위 CSV와 템플릿을 만들어(`preprocess`, `render`) 검증합니다(`validate`). LLM(OpenRouter)이 쓰는 것은 명세 하나뿐이고, 데이터와 HTML은 코드가 만듭니다. 그래서 같은 명세로 다시 돌리면 결과가 똑같이 나오고, 명세를 손으로 고쳐 LLM 없이 다시 만들 수 있습니다.
탭 하나에 문항을 여러 개 둘 수 있고, 문항은 단일 선택, 체크박스 다중 선택, 척도(likert), 자유 서술 네 가지입니다. attention 탭은 worker 화면에서 다른 탭과 구별되지 않습니다.

**콘솔에서 쓰기** (권장): Create → New Project → `Generate from raw data`에서 원본과 prompt를 올려 돌리고, 결과의 `Use this result`로 Project를 만들어 바로 게시합니다. 실행 준비는 [빠른 시작](#빠른-시작)의 OpenRouter 키 설정과 같고, 화면 사용법은 [원본 데이터에서 자동으로 만들기](docs/create-projects.md#원본-데이터에서-자동으로-만들기)에 있습니다.

**명령줄로 쓰기**: agent 컨테이너에는 `var/`와 `output/`만 연결되므로, 입력(원본, prompt, spec)은 `var/<작업 이름>/` 아래에 두고 결과는 `output/` 아래에 받습니다. `--prompt`는 두 방식 모두 필요합니다.

```bash
# 손으로 쓴 spec 으로 실행합니다 (LLM 호출 없음)
docker compose --profile agent run --rm agent run var/<task>/raw.json --prompt @var/<task>/prompt.md --spec var/<task>/task_spec.json --out output/<task>

# LLM 이 spec 을 쓰게 합니다 (environment/.env 의 OPENROUTER_KEY 와 AGENT_ALLOW_API=1 필요, 크레딧 사용)
docker compose --profile agent run --rm agent run var/<task>/raw.json --prompt @var/<task>/prompt.md --planner openrouter --out output/<task>

# 저장소 밖(예: assets/)의 원본은 폴더를 연결해서 씁니다
docker compose --profile agent run --rm -v ./assets:/work/assets:ro agent run assets/<파일>.json --prompt @var/<task>/prompt.md --spec var/<task>/task_spec.json --out output/<task>
```

명령줄로 만든 `template.html`과 `hits.csv`는 New Project → `Upload or paste HTML`과 Publish Batch의 `Upload CSV`로 올립니다. 모델 고르기, 출력 파일, prompt 쓰는 법은 [agent/README.md](agent/README.md)에 정리되어 있습니다.

## Preview

production 콘솔에서 전체 흐름을 한 번 따라가 보는 순서입니다. 시작하기 전에 `docker compose down -v`로 DB를 처음 상태로 되돌려 두세요.
시작 데이터의 템플릿과 자동 생성 템플릿의 미리보기는 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷 연결이 필요합니다.

1. **Manage 목록**: 익명화한 batch 세 개가 보입니다. 진행률, 반려율, 비용이 자동으로 계산되어 있고, `pilot close-ended chunk-fact`에는 `Needs review`가 붙어 있습니다.
2. **Review**: 그 batch의 `Review` 탭에서 Status를 Submitted로 거르면 6건이 나옵니다. 표의 `Answers` 열에서 worker의 답과 다른 worker들의 majority를 바로 비교해 보고, 행을 눌러 응답 상세를 열고 `Open task`로 worker가 본 화면을 열어 봅니다.
3. **반려와 재모집**: 두 건을 골라 반려합니다. attention check를 통과한 응답이라는 경고가 표시되고, 반려를 확정하면 다시 모집할지 물어봅니다. 나머지 응답은 승인합니다.
4. **HITs**: `Incomplete only`를 켜고, HIT 하나에 큰 수를 추가해 봅니다. 9개를 넘을 수 없다는 이유와 함께 건너뛰는 것을 볼 수 있습니다.
5. **Results**: Fleiss' κ가 0.731로 표시됩니다. 이 값은 statsmodels의 `fleiss_kappa` 결과와 소수 여섯째 자리까지 일치하며, 테스트로 고정되어 있습니다. Export로 받는 CSV는 MTurk Requester 웹사이트의 결과 CSV와 컬럼이 같아서 기존 분석 스크립트를 그대로 쓸 수 있습니다.
6. **Create**: `Tutorial` 탭의 순서대로 starter로 Project를 만들고, [위의 예시](#starter로-attention-check가-있는-batch-게시하기)처럼 `5-project/passage-relevance.csv`를 올려 게시합니다. 잔액이 줄고 Manage 목록에 새 batch가 생깁니다. 이어서 Tutorial의 `원본 데이터에서 자동으로 만들기`에서 `Load prompt + example data`를 눌러 합성 예시가 채워진 Generate from raw data를 열고, `Optional task spec · offline replay`에 `agent/examples/groundedness/task_spec.json`을 올려 LLM 없이 자동 생성을 해 봅니다.
7. **Worker Pool**: `Rej%`를 내림차순으로 정렬해 상위 worker를 선택하고 `Block…`을 누른 뒤, 기본 선택지인 "Excluded pool에 추가"를 고릅니다. 이어서 Pools에서 `Fill by criteria…`로 Trusted pool을 채워 봅니다.
   기본 조건(승인 20건 이상, attention 실패 0%, 일치율 90% 이상)으로는 해당하는 worker가 없습니다. 예시 데이터에서는 승인이 가장 많은 worker가 20건이고 attention 실패율이 5%이기 때문입니다. **승인 기준을 5로 낮추면 7명**이 나옵니다.
   이렇게 만든 pool은 Project의 `Enter Properties`에서 참여 또는 제외로 지정합니다.
8. **API 확인**: 터미널에서 `curl localhost:8000/api/batches`로 방금 게시한 batch가 REST 응답에 있는 것을 확인할 수 있습니다.

9. **Worker로 풀어 보기**: 다른 브라우저(또는 시크릿 창)에서 `Create an account`로 worker 계정을 만들고, 6번에서 게시한 batch를 `HITs`에서 받아 풀어 제출합니다. Requester 창의 그 batch `Review` 탭에 응답이 들어오고, 승인하면 worker의 `Your HITs`에 승인과 금액이 보입니다.

시작 데이터의 batch 세 개는 모두 만료되어 worker의 `HITs` 목록에는 보이지 않습니다.

## 폴더 구조

실제 서비스용 화면 `frontend/`와 백엔드 `backend/`, 파이프라인 `agent/`, 프로토타입 `prototype/`이 나란히 있고, 시작 데이터와 예시 파일, 문서는 저장소 루트에 있습니다.

```
frontend/           실제 서비스용 화면 (vanilla JavaScript). src/ 를 nginx 가 그대로 서빙합니다
├─ src/             index.html, main.js, router.js, api-client/(경로 표와 HTTP 클라이언트), pages/, components/, styles.css,
│                   elements/(템플릿이 불러오는 <ann-*> 요소와 starter 템플릿)
├─ nginx.conf.template  정적 파일과 /api 프록시
└─ Dockerfile
backend/            FastAPI 백엔드. 콘솔 REST 와 /api/agent job API
├─ app/             main.py, routes.py(경로 표), routers/, domain/(진행률·비용 계산), db.py, seed.py, agent_jobs/
├─ requirements.txt 이미지 안에만 설치하는 의존성
└─ Dockerfile
prototype/          프로토타입 콘솔(React + antd)과 mock API 서버. npm 명령은 이 폴더에서 실행합니다
├─ src/
│  ├─ api/
│  │  ├─ types.ts   데이터 모델
│  │  ├─ client.ts  화면이 호출하는 API 인터페이스와 동작 방식 선택
│  │  ├─ mock/      메모리 저장소, 요청 처리, 가짜 응답 생성, data/ 읽기와 쓰기
│  │  └─ http/      REST 경로 표와 HTTP 클라이언트
│  ├─ domain/       계산 로직: 비용, attention 판정, 진행률, majority와 κ, worker 지표, 템플릿 렌더링
│  ├─ features/     화면: create, manage, workers
│  └─ components/   공용 컴포넌트: 미리보기 프레임, 구성 막대, Mock tools 메뉴 등
├─ server/          mock API 서버 (HTTP 처리, SQLite 저장)
├─ scripts/         내려받은 상태를 data/로 푸는 스크립트(data:unpack)와 DB 조회 스크립트(sql)
├─ Dockerfile       web, api, dev, test 이미지. 빌드 컨텍스트는 data/와 example/을 함께 복사하기 위해 저장소 루트입니다
├─ nginx.conf       web 이미지의 nginx 설정 (정적 파일, /api 프록시)
└─ package.json, vite.config.ts, tsconfig.json, index.html
agent/              원본 데이터와 prompt로 HIT 단위 CSV와 템플릿을 만드는 파이프라인 (Python)
data/               시작 데이터 (JSON + 템플릿 HTML)
example/            Create에 올려 볼 예시 템플릿과 CSV
docs/               Create의 사용 방법(production, 프로토타입), <ann-*> 요소, 화면에 나오는 값을 읽는 방법, prompt 실험
environment/        agent의 모델 설정(models/)과, OpenRouter 키를 두는 .env (.env 는 저장소에 들어가지 않습니다)
scripts/            데이터 변환과 예시 파일 생성 스크립트 (Python)
docker-compose.yml  frontend, backend, db(PostgreSQL), agent, 테스트, 프로토타입(web, api, dev, test, web-mock) 서비스
.github/workflows/  main 으로의 push 와 pull request 마다 테스트를 돌리는 GitHub Actions (test.yml)

저장소에 들어가지 않는 폴더 (.gitignore)
output/             자동 생성 job 의 입력과 결과 (output/jobs/<job id>/). 실행하면 저절로 생깁니다
assets/             실제 원본 데이터와 예전 템플릿 같은 로컬 참고 자료. 코드와 테스트는 쓰지 않습니다
var/                프로토타입 mock API 서버의 SQLite, agent 명령줄 실행의 입력
```

- 테스트는 `frontend/tests/`(node:test), `backend/tests/`(pytest), `agent/tests/`(unittest), `prototype/`(Vitest)에 있습니다. 계산 규칙의 기대값(κ, 비용, 진행률)은 프로토타입의 테스트에서 시작해 backend 테스트로 옮겨 고정했습니다.
- `main`에 push하거나(merge 포함) `main`을 향한 pull request를 열면 GitHub Actions(`.github/workflows/test.yml`)가 네 묶음을 각각 돌립니다. OpenRouter는 부르지 않으며 secret도 쓰지 않습니다.
