# MTurk Annotation Console (mock)

MTurk annotation을 게시하고, 검수하고, worker를 관리하는 사내 웹 콘솔의 1단계 mock이다. 실제 MTurk에는 연결하지 않는다.
이 README와 코드 주석에 나오는 장 번호(5.2, 8.3 등)는 설계 명세서의 장이다. 명세서는 이 저장소에 포함하지 않았다.

## 실행

Docker만 있으면 된다.

```bash
docker compose up --build          # http://localhost:8080
```

| 서비스 | 내용 |
|---|---|
| `web` | 빌드한 화면을 nginx로 서빙하고 `/api`를 api로 넘긴다 |
| `api` | mock API 서버 (Node + SQLite). 처음 뜰 때 [data/](data/) 폴더를 DB에 올리고 6장의 REST 경로로 답한다. http://localhost:8787/api/health |

검수, 게시, pool 같은 변경은 SQLite(volume `db`)에 남으므로 브라우저나 PC를 바꿔도 같은 상태를 본다.
처음 상태로 돌리려면 화면 오른쪽 위 **Mock tools → Reset to fixtures**, 또는 `docker compose down -v`.

| 명령 | 내용 |
|---|---|
| `docker compose --profile dev up dev` | Vite dev 서버 + api. `src/`를 고치면 HMR로 반영된다. http://localhost:5173 |
| `docker compose --profile mock up web-mock` | **서버 없이** 브라우저만으로 도는 빌드. http://localhost:8081 (아래 "두 가지 구현") |
| `docker compose run --rm test` | 단위 테스트 (Vitest) |
| `docker compose exec api npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY 1"` | DB를 SQL로 조회 |

- 기본은 이 PC에서만 접속된다(`127.0.0.1`). 다른 PC에서 보려면 `BIND_ADDR=0.0.0.0 docker compose up`. 포트는 `WEB_PORT`, `API_PORT`로 바꾼다.
- `web`은 코드를 고친 뒤 `--build`로 다시 빌드해야 한다. `data/`는 api에 mount되어 있어 고친 뒤 Reset만 누르면 된다.
- dev에서 소스를 고쳐도 화면이 안 바뀌면 `VITE_WATCH_POLLING=true`로 띄운다 (파일 이벤트가 컨테이너로 넘어오지 않는 환경).

Docker 없이 실행하려면 Node 24가 필요하다 (내장 `node:sqlite`를 쓴다).

```bash
npm install
npm run dev                         # 브라우저만으로 (mock 구현). http://localhost:5173
npm run server & npm run dev:http   # mock API 서버 + http 구현. DB는 var/mturk-console.sqlite
npm test && npm run typecheck
```

## 화면 안내 (5장)

화면의 글자는 MTurk 용어와 맞추려고 영어로 쓴다. 아래에서 `이렇게 쓴 것`은 화면에 보이는 라벨 그대로다.

### 공통: 머리줄과 탭

| 요소 | 내용 |
|---|---|
| `MOCK` 배지 | 지금 환경. 연동 후에는 `SANDBOX`(파랑), `PRODUCTION`(빨강)이 된다 |
| `Balance` | 잔액. 게시와 재모집은 비용을 미리 빼고, 반려하면 돌려준다. 잔액이 모자라면 게시와 재모집이 막힌다 |
| `Mock tools` | mock 환경에서만 보인다. `Generate fake submissions…`(열린 자리에 검수 대기 응답을 만든다), `Export data (JSON)`, `Import data (JSON)…`, `Reset to fixtures`. 맨 아래 줄에 지금의 구현체와 저장 위치가 나온다 (예: `API: http · Store: SQLite (server)`) |
| 탭 | `Create` · `Manage` · `Worker Pool` |

### Create — batch 게시 (`/create`, 5.2)

템플릿과 CSV로 batch를 게시하는 5단계 wizard다. 입력은 브라우저에 임시 저장되어 새로고침하거나 다른 탭에 다녀와도 남는다(`Start over`로 비운다).
앞 단계로는 위의 단계 표시를 눌러 돌아가고, 다음 단계로는 검증을 통과한 `Next`로만 간다.

| 단계 | 화면에 있는 것 |
|---|---|
| 1 `Template` | 저장된 템플릿 목록에서 고르거나(`Edit`로 수정), `.html` 파일을 올리거나(`From a file`), 붙여넣어(`Template HTML`) 새로 만든다. `Template name`은 필수. 저장하면 `${...}` placeholder가 태그로 나오고, TASK_DATA 방식이면 `none (uses window.TASK_DATA)`라고 나온다. `Load sample template`은 예시 템플릿을 채워 준다 |
| 2 `Data` | CSV를 끌어다 놓거나 `Load sample CSV`(올릴 파일은 아래 "업로드 시나리오"). 파일 이름, 행·열 수, 인코딩(BOM은 떼고, UTF-8이 아니면 거절)이 나온다. **Placeholder check**: `ERROR` 템플릿의 placeholder가 CSV에 없음 → `Next`가 막힌다 / `WARN` 템플릿이 안 쓰는 컬럼, 빈 셀이 있는 행, 64KB를 넘는 행 / `INFO` 행 입력 크기의 중앙값과 최댓값. 아래에 첫 5행 미리보기(셀은 잘라서 표시) |
| 3 `Settings` | `What workers see in the HIT list`(Title, Description, Keywords) · `Payment and timing`(Reward per assignment, MaxAssignments, Time allotted, HIT lifetime, Auto-approval delay. MaxAssignments가 10 이상이면 수수료 40% 안내) · `Qualification requirements`(승인율 ≥ N%, 승인된 HIT 수 ≥ N, 국가) · `Worker pools`(`Only workers in` / `Exclude workers in`. 같은 pool을 양쪽에 넣을 수 없다) · `Attention check`(prefix, 정답 값, 통과 비율) |
| 4 `Preview & Cost` | `Cost estimate` 표(reward 합계, 수수료와 수수료율, 총액, 게시 후 잔액. 총액이 잔액을 넘으면 막힌다) · `Answer fields found in this row`(미리보기에서 읽어 낸 문항 이름과 선택지) · `Task preview`: 고른 행으로 템플릿을 렌더한 worker 화면 그대로. `Prev row` / `Next row` / 행 번호로 이동. Submit을 누르면 제출을 가로채 `input_answers` JSON을 보여주고 아무것도 보내지 않는다 |
| 5 `Publish` | `Batch name`(템플릿 이름 + 날짜로 제안)과 전체 요약. `Publish`를 누르면 그 batch의 Overview로 이동한다. production 환경에서는 batch 이름을 한 번 더 입력해야 버튼이 켜진다 |

### Manage — 진행 확인과 검수 (5.3)

**Batch 목록 (`/manage`).** `Name`(검수할 건이 있으면 `Needs review`) · `Env` · `Created` · `HITs`(완료/전체) · `Assignments (S / A / R)`(Submitted / Approved / Rejected) · `Reject rate` · `Cost`(지출/예상, 수수료 포함) · `Status`(`In progress`, `Completed`, `Expired`). 이름을 누르면 상세로 간다.

**Batch 상세 (`/manage/<batchId>/…`).** 하위 탭 네 개. `Review (6)`의 숫자는 검수 대기 건수다.

| 탭 | 화면에 있는 것 |
|---|---|
| `Overview` | 버튼: `Top up incomplete HITs`(미완료 HIT를 목표까지 재모집하고, 만료된 HIT는 게시 기간을 연장), `Expire now`, `Export`(MTurk 결과 CSV / 라벨 JSON). 카드: `HITs completed`(완료 HIT / 전체) · `Assignments`(`Waiting for review`, `Reject rate`, Approved·Submitted·Rejected·Open의 구성 막대) · `Cost`(`Spent on approved work`, `Estimated total`). 아래에 `Settings` 표(보상, 목표 라벨 수, 기간, attention rule, qualification, pool 조건, 템플릿) |
| `Review` | 필터: `Status`, `Attention`(통과/실패/문항 없음), `WorkerId`, `Work time under N s`. 버튼: `Select attention-failed`(attention을 틀린 검수 대기 건을 한 번에 선택), `Approve selected`, `Reject selected…`, `Revert to approved…`(반려 번복, 30일 이내). 표: `Row` · `Worker` · `Status` · `Time` · `Attention`(예: `2/2 PASS`) · `Agree`(같은 HIT 다른 worker들의 majority와 일치한 비율) · `Submitted` · `Feedback`. **행을 누르면 응답 상세**가 열린다: 문항별로 `This worker` / `Other workers on this HIT` / `Expected / majority`를 나란히 보여주고(`Only differences`로 다른 것만), `Open task`는 그 HIT의 입력으로 템플릿을 렌더해 worker가 본 화면을 띄운다. 반려 창에는 사유 프리셋 세 개와 `Other reason`이 있고, attention을 통과한 건이 섞여 있으면 경고한다. 반려를 확정하면 재모집할지 묻는다 |
| `HITs` | `Incomplete only` 스위치, `Show input column`(표에 보일 입력 컬럼. `qid`가 있으면 기본). 표: `Row` · 입력 컬럼 · `Max` · `Approved` · `Rejected` · `Submitted` · `Open` · `State`(`Completed` / `Incomplete`, `needs +N`, `Expired`) · `Expires` · `Open task`. 여러 HIT를 골라 `Top up selected…`: 목표까지 채우기 또는 고정 개수. 9개 상한에 걸린 HIT는 사유와 함께 건너뛴다 |
| `Results` | 카드: `Fleiss' κ`(해석 구간, 계산에 들어간 문항 수 × 평가자 수) · `Unanimous items` · `Items with votes`(목표 표 수에 못 미친 문항, 동률 문항 수) · `Label distribution`(승인된 표의 구성 막대). 표: `Row` · `Item` · `Votes (approved)`(표에 마우스를 올리면 worker) · `n` · `Majority`(동률은 `tie`). 필터: 전체 / 만장일치 아님 / 동률 / 표 부족. `Export` |

집계에는 Approved assignment의 실제 문항만 들어간다(attention 문항 제외). κ와 만장일치 비율은 표가 정확히 목표 수인 문항만으로 계산한다.

### Worker Pool — worker 품질 관리 (5.4)

오른쪽 위에서 `Workers`와 `Pools`를 오간다.

| 화면 | 화면에 있는 것 |
|---|---|
| Worker 목록 (`/workers`) | 모든 batch를 합산한 지표: `Worker` · `Subm` · `Appr` · `Rej` · `Rej%` · `Attn fail` · `Med time` · `Agree` · `Batches` · `Pools` · `Last active`. 정렬, 검색(`Search WorkerId`), `Pool` 필터, `Blocked only`, 페이지 이동은 전부 서버가 처리한다. 여러 명을 골라(페이지를 넘겨도 유지) `Add to pool`, `Remove from pool`, `Block…`. **`Block…` 창**은 차단이 worker의 MTurk 계정에 불이익을 준다고 알리고, 기본 버튼이 `Add to Excluded pool instead`다. `Block anyway…`는 사유를 적어야 한다. 고른 worker가 전부 차단 상태면 `Unblock`으로 바뀐다 |
| Pools (`/workers/pools`) | `New pool`(같은 이름은 거절). 표: 이름, 설명, 인원, `QualificationTypeId`(연동 후 채워짐). `View members`로 펼치면 소속 worker와 지표가 나오고 한 명씩 또는 여러 명을 뺄 수 있다. **`Fill by criteria…`**: `Minimum approved assignments`, `Maximum attention-fail rate`, `Minimum majority agreement`, `Maximum reject rate (optional)`을 넣으면 **먼저 몇 명이 해당하는지와 미리보기 목록**을 보여주고, 확인해야 추가한다. 차단된 worker와 이미 들어 있는 worker는 제외한다 |
| Worker 상세 (`/workers/<WorkerId>`) | 머리줄: WorkerId, 소속 pool, `Blocked`와 사유, pool 추가/제거와 차단/해제. 지표 10개: `Submitted` · `Approved` · `Rejected` · `Pending review` · `Reject rate` · `Attention fail rate` · `Median work time` · `Majority agreement` · `Batches` · `Last active`. `By batch` 표(batch 이름을 누르면 그 batch의 Review가 이 worker로 걸러져 열린다) · assignment 이력 표(`Submitted`, `Batch`, `Row`, `Status`, `Work time`, `Attention`, `Feedback`) · `Note`(메모. 이 콘솔에서만 보인다) |

pool은 Create의 `Settings`에서 포함/제외로 지정한다. 연동 후에는 pool 하나가 custom Qualification 하나가 되고, 포함은 `Exists`, 제외는 `DoesNotExist` 조건으로 바뀐다.

## 업로드 시나리오: Create에 무엇을 올리나

Create wizard는 **템플릿(`.html`) 하나와 데이터(`.csv`) 하나**를 받는다. CSV의 1행이 HIT 1개가 된다.
올려 볼 파일은 전부 [example/](example/) 폴더에 있다. 아래의 결과는 이 파일들을 실제로 올려서 확인한 화면의 문구다.

```
example/
├─ 1-task-data/          template.html + data.csv                 window.TASK_DATA 방식 (새 템플릿에 권장)
├─ 2-placeholder/        template.html + data.csv                 ${컬럼명} 방식 (MTurk Requester 웹사이트와 같다)
│                        data-missing-column.csv                  오류: 템플릿이 쓰는 컬럼이 없는 CSV
├─ 3-data-checks/        empty-cells / excel-utf8-bom / excel-cp949 / large-rows .csv     Data 단계의 검사를 하나씩 보는 CSV
└─ 4-saved-templates/    chunk-fact-relevance-input.csv, query-fact-coverage-input.csv    콘솔에 저장돼 있는 기존 템플릿용 입력
```

### 시나리오 1. 처음부터 끝까지 (TASK_DATA 방식)

가장 빠른 길은 `Load sample template`과 `Load sample CSV` 버튼이다. 두 버튼은 아래의 파일을 그대로 채운다. 직접 올려도 결과가 같다.

| 단계 | 할 일 | 나오는 것 |
|---|---|---|
| 1 `Template` | `Upload or paste HTML`을 고르고 `Upload .html`로 `1-task-data/template.html`을 올린 뒤 `Save template` | `none (uses window.TASK_DATA)`. 이 방식은 템플릿에 `${...}`가 없다 |
| 2 `Data` | `1-task-data/data.csv`를 끌어다 놓는다 | `10 rows, 5 columns, UTF-8` · `OK` placeholder가 없어 맞춰 볼 것이 없음 · `INFO` 5개 컬럼을 `window.TASK_DATA`로 쓸 수 있음 · `INFO` Row input size: median 338 B, max 389 B |
| 3 `Settings` | `Attention check`의 `Expected value`에 `not_grounded`. 나머지는 기본값 | MaxAssignments 3, 보상 $0.10 |
| 4 `Preview & Cost` | 라디오를 고르고 Submit을 눌러 본다 | 비용 $3.00 + 수수료 $0.60 = **$3.60**. 읽어 낸 문항 `general_1`, `attention_1`, `general_2`. `Submit intercepted: 3 answer(s)` |
| 5 `Publish` | `Publish` | 새 batch의 Overview로 이동. 잔액 $500.00 → $496.40 |

게시한 뒤 **Mock tools → Generate fake submissions…**로 응답을 만들면 Manage › Review에서 검수를 이어 갈 수 있다.

### 시나리오 2. `${컬럼명}` 방식과 컬럼 누락 오류

기존에 MTurk Requester 웹사이트에서 쓰던 템플릿이 이 방식이다. 템플릿의 `${passage}` 자리에 CSV의 `passage` 셀이 **그대로** 들어간다.

| 올리는 것 | 나오는 것 |
|---|---|
| 템플릿 `2-placeholder/template.html` | 이름 칸이 파일 이름으로 채워지고, 저장하면 placeholder 5개가 태그로 나온다: `${item_id}` `${passage}` `${sentence_1}` `${attention_sentence}` `${sentence_2}` |
| CSV `2-placeholder/data-missing-column.csv` | **`ERROR` 1 placeholder(s) have no matching CSV column: `${sentence_2}`** 그리고 `Next`가 꺼진다. 치환되지 않은 `${x}`는 화면에 글자 그대로 남아 템플릿을 깨뜨리기 때문이다. `INFO` 4/5 matched |
| CSV `2-placeholder/data.csv` | `8 rows, 6 columns` · `OK` 5/5 matched · `WARN` 1 column(s) not used by the template: `note` (안 쓰는 컬럼도 HIT에는 저장된다). `Next`가 켜진다 |

Settings의 `Expected value`는 `not_grounded`. Preview에서 `Item p01`과 문단이 치환되어 보인다.

### 시나리오 3. Data 단계의 검사

시나리오 1의 템플릿을 고른 상태에서 CSV만 바꿔 올린다(`Drop another CSV here`).

| CSV | 상황 | 나오는 것 |
|---|---|---|
| `3-data-checks/empty-cells.csv` | 빈 셀이 있다 | `WARN` 2 row(s) have empty cells: row 3, 5. 막지는 않는다 |
| `3-data-checks/excel-utf8-bom.csv` | Excel에서 "CSV UTF-8"로 저장한 파일 (맨 앞에 BOM, 줄 끝 CRLF) | `10 rows, 5 columns, UTF-8 (BOM removed)`. 정상 처리된다. BOM을 떼지 않으면 첫 컬럼 이름이 달라져 `${...}`와 맞지 않는다 |
| `3-data-checks/excel-cp949.csv` | 한국어 Excel에서 그냥 "CSV"로 저장한 파일 (CP949) | **거절**: `The file is not valid UTF-8. Save it again as "CSV UTF-8" and upload it again.` 그대로 읽으면 글자가 깨진 채 게시되기 때문이다. 앞서 올린 CSV는 그대로 남는다 |
| `3-data-checks/large-rows.csv` | 한 행의 입력이 64KB를 넘는다 | `WARN` max 70.2 KB. 1 row(s) exceed MTurk's 64 KB Question limit → 연동 단계에서는 ExternalQuestion으로 게시해야 한다. mock에서는 그대로 진행된다 |

### 시나리오 4. 콘솔에 저장돼 있는 기존 템플릿

`Template` 단계에서 저장된 템플릿을 고르고, 그 템플릿이 기대하는 16개 컬럼의 CSV를 올린다. 셀 하나가 길이 11인 Python 리스트 문자열이고(탭 10개 + attention 1개), 본문은 익명화한 합성 텍스트다.

| 템플릿 | CSV | 나오는 것 | Settings의 `Expected value` |
|---|---|---|---|
| `Chunk-Fact Relevance` | `4-saved-templates/chunk-fact-relevance-input.csv` | `10 rows, 16 columns` · `OK` 12/12 matched · `WARN` 안 쓰는 컬럼 4개(`*_reasoning`) · Row input size: median 18.7 KB, max 38.0 KB | `not_grounded` |
| `Query-Fact Coverage` | `4-saved-templates/query-fact-coverage-input.csv` | `8 rows, 16 columns` · `OK` 12/12 matched · `WARN` 안 쓰는 컬럼 4개 · median 6.3 KB, max 8.1 KB | `Not Covered` |

Preview에는 탭 11개짜리 worker 화면이 그대로 나온다. 이 두 템플릿은 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷이 필요하다.
반대로 이 템플릿에 시나리오 1의 CSV를 올리면 `ERROR` 12 placeholder(s) have no matching CSV column이 나온다.

### 자기 CSV를 만들 때

- 첫 줄은 컬럼 이름, 그다음부터 1행이 HIT 1개다. 인코딩은 **UTF-8**(Excel이면 "CSV UTF-8").
- `${컬럼명}` 방식 템플릿이면 템플릿의 모든 placeholder가 컬럼으로 있어야 한다. 남는 컬럼은 있어도 된다.
- TASK_DATA 방식 템플릿은 콘솔이 필요한 컬럼을 알 수 없으므로 검사 없이 통과한다. 템플릿이 읽는 키와 컬럼 이름을 직접 맞춘다.
- attention 문항을 쓰려면 템플릿에서 그 문항의 `name`을 `attention_`으로 시작하게 하고, Settings에 정답 값을 적는다.
- 검사용 CSV와 시나리오 4의 CSV는 `python3 scripts/build_examples.py`로 다시 만든다.

## 두 가지 구현 (3.1)

화면은 `src/api/client.ts`의 `api`만 부른다. 그 뒤의 구현은 빌드할 때 `VITE_API_MODE`로 고르고, 화면 코드는 두 경우에 똑같다.
지금 어느 쪽인지는 Mock tools 메뉴 맨 아래에 나온다.

| | `http` (Docker의 기본) | `mock` |
|---|---|---|
| 동작하는 곳 | mock API 서버 (`server/`) | 브라우저 안 |
| 저장 | SQLite | 그 브라우저의 IndexedDB |
| 시작 데이터 | `data/` 폴더를 디스크에서 읽는다 | `data/` 폴더가 번들에 들어 있다 |
| 핸들러와 계산 | `src/api/mock/handlers.ts` + `src/domain/` — **같은 소스** | |

REST 경로는 [src/api/http/routes.ts](src/api/http/routes.ts)의 표 하나에 있고, 브라우저의 http 구현과 서버가 이 표를 함께 쓴다.
연동 단계에서는 같은 경로를 구현한 실제 백엔드(FastAPI + boto3)로 주소만 바꾼다. `/mock/*` 경로는 mock 전용이라 실제 백엔드에는 만들지 않는다.

## 데이터와 템플릿 (data/)

시작 데이터는 [data/](data/) 폴더에 JSON(데이터)과 HTML(템플릿)으로 있다. 구조와 고치는 방법은 [data/README.md](data/README.md).

- 고치고 **Reset to fixtures**를 누르면 반영된다. 파일이 서로 맞지 않으면 어느 파일의 무엇이 틀렸는지 알려준다.
- 콘솔에서 만든 상태는 **Mock tools → Export data (JSON)**으로 내려받아 다른 사람에게 주거나(**Import data**),
  `npm run data:unpack -- <파일>`로 `data/` 구조로 풀어 다음 시작점으로 삼는다.
- 들어 있는 세 batch는 실제 annotation 결과를 **익명화한 것**이다. ID는 전부 다시 만들었고 본문은 같은 길이의 합성 텍스트로 바꿨다.
  응답 값, 검수 상태, 작업시간은 그대로라 진행률, worker 지표, Fleiss κ가 원본과 같다. 자기 데이터로 다시 만드는 방법은 [data/README.md](data/README.md)에 있다.
  익명화에 쓰는 salt(`scripts/.fixture_salt`)와 원본 목록(`scripts/fixture_sources.json`)은 저장소와 Docker 이미지에 넣지 않는다.

## 시연 순서 (10~15분)

시작 전에 **Reset to fixtures**를 눌러 둔다. 미리보기에서 기존 템플릿이 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷이 필요하다.

1. **Manage 목록** — 실제 annotation 결과를 익명화한 batch 세 개. 진행률, 반려율, 비용이 계산되어 나오고, F1에는 "Needs review"가 붙어 있다.
   기존에는 결과 CSV를 내려받아 스크립트로 세던 값이다 (1.1).
2. **F1 › Review** — Status를 Submitted로 거르면 6건. 행을 누르면 문항별로 이 worker, 같은 HIT의 다른 worker, majority가 나란히 나온다.
   **Open task**는 그 HIT의 입력으로 기존 템플릿을 그대로 렌더한다 (sandbox iframe).
3. **반려 → 재모집** — 두 건을 골라 Reject. 사유 프리셋 세 개는 실제 검수에서 쓰던 문구다. attention을 통과한 건을 반려하려 하면 경고한다.
   확정하면 "재모집하시겠습니까?"를 묻는다 (MTurk는 반려해도 자리를 다시 열어 주지 않는다). 나머지는 Approve.
4. **F1 › HITs** — Incomplete only. 한 HIT에 큰 수를 더해 보면 "9개를 넘을 수 없다"는 사유와 함께 건너뛴다 (8.3).
5. **F1 › Results** — Fleiss κ 0.731. statsmodels의 `fleiss_kappa`와 소수 여섯째 자리까지 같다 (테스트에 고정). Export의 CSV는 MTurk Requester 웹사이트의 결과 CSV와 같은 컬럼이라 기존 분석 스크립트가 그대로 읽는다.
6. **Create** — "Load sample template", "Load sample CSV"로 5단계를 끝까지 (업로드 시나리오 1). 저장된 기존 템플릿(Chunk-Fact Relevance)에 같은 CSV를 넣으면 placeholder 오류로 막히고, `example/4-saved-templates/`의 CSV를 넣으면 통과한다 (시나리오 4).
   Preview에서 Submit을 누르면 응답 JSON을 가로채 보여준다. 게시하면 잔액이 줄고 Manage에 새 batch가 생긴다.
7. **Mock tools → Generate fake submissions** — 방금 게시한 batch에 응답을 만들어 Review 흐름을 이어 간다.
8. **Worker Pool** — Rej% 내림차순으로 정렬해 상위 worker를 고르고 Block… → 기본 동선은 "Excluded pool에 추가"다 (차단은 worker 계정에 불이익을 준다).
   Pools에서 "Fill by criteria"로 Trusted pool을 채운다. 기본 조건(승인 ≥ 20건, attention 실패 0%, 일치율 ≥ 90%)으로는 0명이 나온다
   (세 batch만으로는 승인이 가장 많은 worker가 20건이고 attention 실패가 5%다). **승인 기준을 5로 낮추면 7명**이 걸린다.
   추가하기 전에 몇 명이 해당하는지 먼저 보여주는 것이 요점이다. Create의 Settings에서 이 pool들을 포함/제외로 지정하면 가짜 제출도 그 조건을 지킨다.
9. **구현체 교체와 DB** — Mock tools 메뉴 맨 아래의 "API: http · Store: SQLite". 터미널에서
   `docker compose exec api npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY 1"`로 방금 한 검수가 DB에 있는 것을 보여주고,
   `curl localhost:8787/api/batches`로 REST 계약을 보여준다. 같은 화면이 서버 없이도 돈다: http://localhost:8081 (`--profile mock`).

백엔드 설계로 이어질 질문: MTurk API의 `Question`은 64KB 제한이 있어 입력이 큰 task는 ExternalQuestion이 필요하다는 점, MTurk API에는 batch 개념이 없다는 점, 목록 API는 100건씩 받아 와 동기화해야 한다는 점.

## 구조 (3.3)

```
data/                           시작 데이터 (JSON + 템플릿 HTML)
example/                        Create에 올려 볼 예시 템플릿과 CSV (위의 "업로드 시나리오")
server/                         mock API 서버: index.ts, app.ts(HTTP 처리), sqliteSnapshot.ts
scripts/                        build_fixtures.py, build_examples.py, unpack-state.ts, sql.ts
src/api/types.ts                데이터 모델 (4장)
src/api/client.ts               API 인터페이스 (6장) + 구현체 선택
src/api/mock/                   store(메모리 + 스냅샷), handlers(Api 구현), simulate(가짜 제출), tools, seedFiles
src/api/http/                   routes.ts(REST 경로 표), client.ts
src/domain/                     순수 함수: attention, progress, cost, agreement(κ), workerStats, template, dataCheck, exportFormats
src/features/                   create(wizard) / manage(목록, 상세 네 탭) / workers(목록, 상세, pool)
src/components/                 TaskPreviewFrame, StackedBar, MockToolsMenu ...
Dockerfile, docker-compose.yml, docker/nginx.conf
```

계산은 전부 `src/domain/`의 순수 함수이고 단위 테스트가 있다 (9장). `npm test`는 `data/`가 기대한 규모와 맞는지,
κ가 statsmodels와 같은지, REST 왕복과 SQLite 저장이 되는지도 확인한다.

## 진행 상황 (10장)

| 단계 | 상태 |
|---|---|
| M0 뼈대 | 완료 |
| M1 Create | 완료. wizard 5단계, placeholder 검증, 미리보기(제출 가로채기), 비용 견적, 게시 |
| M2 Manage | 완료. 검수(승인/반려/번복), 재모집(9개 상한), 가짜 제출 생성, Results(κ), export |
| M3 Worker Pool | 완료. pool 편집, 조건으로 채우기, 차단, worker 상세, Create 설정과 연결 |
| M4 리뷰 반영 | 예정. 12장의 미결정 사항 확정 |
