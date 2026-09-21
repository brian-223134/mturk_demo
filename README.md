# MTurk Annotation Console (mock)

Amazon Mechanical Turk(MTurk)로 진행하는 annotation 작업을 **게시하고, 검수하고, worker를 관리**하는 웹 콘솔입니다.

지금은 **mock 단계**입니다. 실제 MTurk에는 연결하지 않으며, 익명화한 예시 데이터 위에서 모든 화면과 흐름을 직접 눌러 볼 수 있습니다.
화면 구성을 검토하고 실제 백엔드를 설계하기 위한 프로토타입입니다. Production 용도의 설계를 진행할 때, mono-repo 구조로 진행할 예정이며, 기술 스택은 frontend: vanilla javascript, backend: fastapi(python)으로 생각하고 있습니다.

| 탭 | 하는 일 |
|---|---|
| **Create** | 템플릿(HTML)과 데이터(CSV)를 올려 batch를 게시합니다. worker에게 보일 화면을 미리 보고 비용을 확인합니다. |
| **Manage** | batch의 진행률과 비용을 확인하고, 제출된 응답을 승인하거나 반려합니다. 부족한 응답은 다시 모집하고, 결과(majority, Fleiss' κ)를 확인해 내보냅니다. |
| **Worker Pool** | worker별 품질 지표를 살펴보고, 믿을 만한 worker와 제외할 worker를 pool로 관리합니다. |

## 빠른 시작

Docker만 설치되어 있으면 됩니다.

```bash
docker compose up --build
```

브라우저에서 http://localhost:8080 을 열면 됩니다. 컨테이너 두 개가 실행됩니다.

- `web`: 화면을 제공하고 `/api` 요청을 `api`로 전달합니다 (nginx).
- `api`: mock API 서버입니다 (Node + SQLite). 처음 실행될 때 [data/](data/) 폴더의 내용을 DB에 채웁니다.

승인과 반려, batch 게시, pool 편집 같은 변경 사항은 SQLite에 저장됩니다. 그래서 브라우저나 PC를 바꿔도 같은 상태를 볼 수 있습니다.
처음 상태로 되돌리려면 화면 오른쪽 위의 **Mock tools → Reset to fixtures**를 누르거나, `docker compose down -v`로 DB를 지웁니다.

### 자주 쓰는 명령

| 명령 | 설명 |
|---|---|
| `docker compose --profile dev up dev` | 개발용 서버입니다. `src/`를 고치면 화면에 바로 반영됩니다. http://localhost:5173 |
| `docker compose --profile mock up web-mock` | API 서버 없이 브라우저만으로 동작하는 버전입니다. http://localhost:8081 |
| `docker compose run --rm test` | 단위 테스트를 실행합니다. |
| `docker compose exec api npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY 1"` | DB의 내용을 SQL로 조회합니다. |

### 알아 두면 좋은 점

- 기본 설정으로는 이 PC에서만 접속할 수 있습니다(`127.0.0.1`). 다른 PC에서 접속하려면 `BIND_ADDR=0.0.0.0 docker compose up`으로 실행합니다. 포트는 `WEB_PORT`와 `API_PORT`로 바꿉니다.
- 코드를 고친 뒤에는 `--build`를 붙여 `web`을 다시 빌드해야 합니다. `data/` 폴더는 `api`에 연결되어 있으므로, 고친 뒤 **Reset to fixtures**만 누르면 반영됩니다.
- 개발용 서버에서 코드를 고쳐도 화면이 바뀌지 않는다면 `VITE_WATCH_POLLING=true`를 붙여 실행해 보세요. 파일 변경 알림이 컨테이너까지 전달되지 않는 환경에서 필요합니다.

### Docker 없이 실행하기

Node 24 이상이 필요합니다 (Node에 내장된 SQLite를 사용합니다).

```bash
npm install
npm run dev                         # 브라우저만으로 동작 (http://localhost:5173)
npm run server & npm run dev:http   # mock API 서버와 함께 실행. DB는 var/mturk-console.sqlite
npm test && npm run typecheck
```

## 화면 둘러보기

화면의 글자는 MTurk의 용어와 맞추기 위해 영어로 표시합니다. 이 문서에서 `이렇게 표시한 글자`는 화면에 보이는 그대로입니다.

### 상단 바

- **`MOCK` 배지**: 현재 환경을 나타냅니다. 실제 MTurk와 연동하면 `SANDBOX`(파랑) 또는 `PRODUCTION`(빨강)으로 표시됩니다.
- **`Balance`**: 잔액입니다. batch를 게시하거나 응답을 추가로 모집하면 비용이 미리 차감되고, 응답을 반려하면 그만큼 돌아옵니다. 잔액이 부족하면 게시와 재모집을 할 수 없습니다.
- **`Mock tools`**: mock 환경에서만 보이는 도구 모음입니다.
  - `Generate fake submissions…`: 아직 비어 있는 응답 자리에 검수 대기 상태의 가짜 응답을 채웁니다. 실제 worker 없이도 검수 과정을 따라가 볼 수 있습니다.
  - `Export data (JSON)` / `Import data (JSON)…`: 현재 상태 전체를 파일 하나로 내려받거나 불러옵니다.
  - `Reset to fixtures`: 모든 변경 사항을 버리고 `data/` 폴더의 처음 상태로 되돌립니다.
  - 메뉴 맨 아래에는 현재 동작 방식과 저장 위치가 표시됩니다 (예: `API: http · Store: SQLite (server)`).

### Create: batch 게시

템플릿과 CSV로 batch를 게시하는 5단계 마법사입니다. 입력한 내용은 브라우저에 임시로 저장되므로, 새로고침하거나 다른 탭에 다녀와도 이어서 진행할 수 있습니다. 처음부터 다시 하려면 `Start over`를 누릅니다.

| 단계 | 내용 |
|---|---|
| 1. `Template` | 저장된 템플릿을 고르거나, `.html` 파일을 올리거나, HTML을 직접 붙여 넣어 새로 만듭니다. 저장하면 템플릿에 쓰인 `${컬럼명}` 목록이 표시됩니다. |
| 2. `Data` | CSV를 올리면 템플릿과 맞는지 검사합니다. 템플릿이 쓰는 컬럼이 CSV에 없으면 다음 단계로 넘어갈 수 없습니다. 빈 셀, 쓰이지 않는 컬럼, 64KB를 넘는 행은 경고로 알려 줍니다. |
| 3. `Settings` | 제목과 설명, 보상, HIT당 응답 수(MaxAssignments), 제한 시간과 게시 기간을 정합니다. 자격 조건(승인율, 승인된 HIT 수, 국가), 참여시키거나 제외할 worker pool, attention check 규칙도 여기서 정합니다. |
| 4. `Preview & Cost` | 고른 행의 데이터로 worker가 보게 될 화면을 그대로 미리 봅니다. Submit을 눌러도 실제로 제출되지는 않고, 제출되었을 응답(JSON)을 보여 줍니다. 예상 비용(보상 + 수수료)과 게시 후 잔액도 함께 표시됩니다. |
| 5. `Publish` | batch 이름과 전체 요약을 확인하고 게시합니다. 게시가 끝나면 그 batch의 Overview로 이동합니다. production 환경에서는 실수를 막기 위해 batch 이름을 한 번 더 입력해야 합니다. |

어떤 파일을 올리면 되는지는 아래의 [예시 파일로 직접 해 보기](#예시-파일로-직접-해-보기)에서 설명합니다.

### Manage: 진행 확인과 검수

**Batch 목록**에서는 batch마다 진행률(완료된 HIT / 전체), 응답 수(Submitted / Approved / Rejected), 반려율, 비용(지출 / 예상), 상태를 한눈에 볼 수 있습니다.
검수할 응답이 남아 있는 batch에는 `Needs review` 표시가 붙습니다.

batch 이름을 누르면 **상세 화면**이 열립니다. 네 개의 탭으로 나뉘어 있습니다.

- **`Overview`**: 진행률, 응답 현황, 비용을 요약해 보여 주고 아래에 batch 설정을 표시합니다. `Top up incomplete HITs`(부족한 응답 재모집), `Expire now`(지금 만료), `Export` 버튼이 있습니다.
- **`Review`**: 응답을 검수하는 화면입니다.
  - 상태, attention check 통과 여부, worker, 작업 시간으로 걸러 낸 뒤 여러 건을 한 번에 승인하거나 반려할 수 있습니다. `Select attention-failed`는 attention check를 틀린 검수 대기 응답을 한 번에 선택합니다.
  - 행을 누르면 응답 상세가 열립니다. 문항마다 이 worker의 답, 같은 HIT를 수행한 다른 worker들의 답, majority를 나란히 보여 줍니다. `Open task`를 누르면 worker가 실제로 본 화면을 그대로 띄웁니다.
  - 반려할 때는 사유를 반드시 입력해야 하며, 자주 쓰는 문구 세 가지를 바로 고를 수 있습니다. attention check를 통과한 응답을 반려하려고 하면 경고가 표시됩니다.
  - MTurk는 응답을 반려해도 그 자리를 다시 열어 주지 않습니다. 그래서 반려를 확정하면 부족해진 만큼 다시 모집할지 곧바로 물어봅니다.
  - 반려한 응답은 30일 안에 승인으로 되돌릴 수 있습니다 (`Revert to approved…`).
- **`HITs`**: HIT별로 승인, 반려, 검수 대기, 남은 자리 수와 완료 여부를 보여 줍니다. 미완료 HIT만 골라 볼 수 있고, 선택한 HIT의 응답을 추가로 모집할 수 있습니다. 처음에 응답 수를 10개 미만으로 만든 HIT는 합계를 9개보다 늘릴 수 없다는 MTurk의 제약도 반영되어 있어, 이를 넘는 요청은 이유와 함께 건너뜁니다.
- **`Results`**: 문항별 투표와 majority, 만장일치 비율, Fleiss' κ, 라벨 분포를 보여 줍니다. MTurk 결과 CSV 형식이나 라벨 JSON으로 내보낼 수 있습니다.

결과 집계에는 승인된(Approved) 응답의 실제 문항만 들어가며, attention 문항은 제외합니다. κ와 만장일치 비율은 표 수가 목표(HIT당 응답 수)와 같은 문항만으로 계산합니다.
화면에 나오는 숫자를 읽는 방법은 [콘솔의 값 읽기](docs/reading-the-console.md)에 시작 데이터의 실제 값으로 정리되어 있습니다.

### Worker Pool: worker 품질 관리

오른쪽 위의 버튼으로 `Workers`와 `Pools` 화면을 오갑니다.

- **Worker 목록**: 모든 batch를 합산한 worker별 지표를 보여 줍니다. 제출, 승인, 반려 수와 반려율, attention 실패율, 작업 시간 중앙값, majority 일치율, 참여한 batch 수, 마지막 활동일을 볼 수 있습니다. 정렬, 검색, 필터를 지원하고, 여러 명을 선택해 pool에 넣거나 뺄 수 있습니다.
- **차단(`Block…`)**: worker를 차단하면 그 worker의 MTurk 계정에 불이익이 갈 수 있습니다. 그래서 차단 창의 기본 선택지는 "Excluded pool에 추가"이며, 그래도 차단하려면 사유를 입력해야 합니다.
- **Pools**: pool을 만들고 구성원을 확인하거나 뺄 수 있습니다. `Fill by criteria…`는 조건(최소 승인 수, 최대 attention 실패율, 최소 일치율 등)을 입력하면 **해당하는 worker가 몇 명인지 먼저 보여 주고**, 확인한 뒤에 추가합니다.
- **Worker 상세**: 지표 요약, batch별 참여 이력, 메모를 볼 수 있습니다. batch 이름을 누르면 그 worker의 응답만 걸러진 Review 화면으로 이동합니다.

pool은 Create의 `Settings` 단계에서 "이 pool의 worker만 참여" 또는 "이 pool의 worker는 제외"로 지정합니다. 실제 MTurk와 연동하면 pool 하나가 custom Qualification 하나에 대응합니다.

## 예시 파일로 mock 테스팅 해보기

Create 마법사는 **템플릿(`.html`) 하나와 데이터(`.csv`) 하나**를 받습니다. CSV의 한 행이 HIT 하나가 됩니다.
올려 볼 수 있는 파일은 모두 [example/](example/) 폴더에 준비되어 있습니다. 아래에 적은 결과는 이 파일들을 실제로 올려서 확인한 화면의 문구입니다.

```
example/
├─ 1-task-data/         template.html, data.csv              window.TASK_DATA 방식 (새 템플릿에 권장)
├─ 2-placeholder/       template.html, data.csv              ${컬럼명} 방식 (MTurk Requester 웹사이트와 동일)
│                       data-missing-column.csv              필요한 컬럼이 빠진 CSV
├─ 3-data-checks/       empty-cells.csv, excel-utf8-bom.csv, Data 단계의 검사를 하나씩 확인하는 CSV
│                       excel-cp949.csv, large-rows.csv
└─ 4-saved-templates/   chunk-fact-relevance-input.csv,      콘솔에 미리 저장된 템플릿에 넣을 입력
                        query-fact-coverage-input.csv
```

### 시나리오 1. 처음부터 끝까지 게시해 보기

가장 빠른 방법은 화면의 `Load sample template`과 `Load sample CSV` 버튼입니다. 두 버튼은 `1-task-data/`의 파일을 그대로 불러옵니다. 파일을 직접 올려도 결과는 같습니다.

| 단계 | 진행 방법 | 화면에 표시되는 내용 |
|---|---|---|
| 1. `Template` | `Upload or paste HTML`을 고른 뒤 `Upload .html`로 `1-task-data/template.html`을 올리고 `Save template`을 누릅니다. | `none (uses window.TASK_DATA)`. 이 방식의 템플릿에는 `${...}`가 없습니다. |
| 2. `Data` | `1-task-data/data.csv`를 끌어다 놓습니다. | `10 rows, 5 columns, UTF-8`. 맞춰 볼 placeholder가 없다는 `OK`와, 5개 컬럼을 `window.TASK_DATA`로 쓸 수 있다는 `INFO`가 표시됩니다. |
| 3. `Settings` | `Attention check`의 `Expected value`에 `not_grounded`를 입력합니다. 나머지는 기본값을 그대로 둡니다. | HIT당 응답 수 3, 보상 $0.10 |
| 4. `Preview & Cost` | 보기를 고르고 Submit을 눌러 봅니다. | 비용은 보상 $3.00 + 수수료 $0.60 = **$3.60**입니다. 문항 `general_1`, `attention_1`, `general_2`가 인식되고, `Submit intercepted: 3 answer(s)`가 표시됩니다. |
| 5. `Publish` | `Publish`를 누릅니다. | 새 batch의 Overview로 이동합니다. 잔액이 $500.00에서 $496.40으로 줄어듭니다. |

게시한 뒤 **Mock tools → Generate fake submissions…**로 가짜 응답을 만들면, Manage의 Review에서 검수까지 이어서 해 볼 수 있습니다.

### 시나리오 2. `${컬럼명}` 방식과 컬럼 누락 오류

MTurk Requester 웹사이트에서 쓰던 템플릿이 이 방식입니다. 템플릿의 `${passage}` 자리에 CSV의 `passage` 셀 내용이 **그대로** 들어갑니다.

| 올리는 파일 | 화면에 표시되는 내용 |
|---|---|
| 템플릿 `2-placeholder/template.html` | 이름 칸이 파일 이름으로 채워집니다. 저장하면 placeholder 5개가 표시됩니다: `${item_id}` `${passage}` `${sentence_1}` `${attention_sentence}` `${sentence_2}` |
| CSV `2-placeholder/data-missing-column.csv` | `ERROR` 1 placeholder(s) have no matching CSV column: `${sentence_2}`. **`Next` 버튼이 비활성화됩니다.** 치환되지 않은 `${...}`는 화면에 글자 그대로 남아 템플릿을 망가뜨리기 때문입니다. |
| CSV `2-placeholder/data.csv` | `8 rows, 6 columns`, `OK` 5/5 matched. 템플릿이 쓰지 않는 컬럼 `note`가 있다는 `WARN`이 표시되지만 진행할 수 있습니다. 쓰이지 않는 컬럼도 HIT에는 함께 저장됩니다. |

Settings의 `Expected value`에는 `not_grounded`를 입력합니다. Preview에서 `Item p01`과 문단이 치환되어 보이는 것을 확인할 수 있습니다.

### 시나리오 3. Data 단계의 검사 확인하기

시나리오 1의 템플릿을 고른 상태에서 CSV만 바꿔 가며 올려 봅니다 (`Drop another CSV here`).

| CSV | 상황 | 화면에 표시되는 내용 |
|---|---|---|
| `3-data-checks/empty-cells.csv` | 빈 셀이 있는 CSV | `WARN` 2 row(s) have empty cells: row 3, 5. 경고만 하고 진행은 막지 않습니다. |
| `3-data-checks/excel-utf8-bom.csv` | Excel에서 "CSV UTF-8"로 저장한 파일 (맨 앞에 BOM, 줄 끝은 CRLF) | `10 rows, 5 columns, UTF-8 (BOM removed)`. 정상적으로 처리됩니다. BOM을 그대로 두면 첫 컬럼 이름이 달라져 `${...}`와 맞지 않게 됩니다. |
| `3-data-checks/excel-cp949.csv` | 한국어 Excel에서 일반 "CSV"로 저장한 파일 (CP949) | **업로드가 거절됩니다.** `The file is not valid UTF-8. Save it again as "CSV UTF-8" and upload it again.` 그대로 읽으면 글자가 깨진 채 게시되기 때문입니다. 앞서 올린 CSV는 그대로 유지됩니다. |
| `3-data-checks/large-rows.csv` | 한 행의 입력이 64KB를 넘는 CSV | `WARN` max 70.2 KB. 1 row(s) exceed MTurk's 64 KB Question limit. 실제 연동에서는 ExternalQuestion 방식으로 게시해야 한다는 뜻입니다. mock에서는 그대로 진행됩니다. |

### 시나리오 4. 미리 저장된 템플릿 사용하기

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
- `${컬럼명}` 방식의 템플릿이라면, 템플릿에 쓰인 모든 placeholder가 CSV의 컬럼으로 있어야 합니다. 그 밖의 컬럼이 더 있는 것은 괜찮습니다.
- TASK_DATA 방식의 템플릿은 콘솔이 어떤 컬럼이 필요한지 알 수 없으므로 검사 없이 통과합니다. 템플릿이 읽는 키와 CSV의 컬럼 이름을 직접 맞춰 주세요.
- attention 문항을 쓰려면 템플릿에서 해당 문항의 `name`이 `attention_`으로 시작하도록 하고, Settings에 정답 값을 입력합니다.
- `3-data-checks/`와 `4-saved-templates/`의 CSV는 `python3 scripts/build_examples.py`로 다시 만들 수 있습니다.

## 시작 데이터 (`data/`)

콘솔이 처음 실행될 때 읽는 데이터는 [data/](data/) 폴더에 있습니다. 데이터는 JSON으로, 템플릿은 HTML 파일로 관리합니다. 폴더 구조와 수정 방법은 [data/README.md](data/README.md)에 정리되어 있습니다.

- 파일을 고친 뒤 **Reset to fixtures**를 누르면 반영됩니다. 파일끼리 맞지 않는 부분이 있으면 어느 파일의 무엇이 잘못되었는지 알려 줍니다.
- 콘솔에서 만든 상태는 **Mock tools → Export data (JSON)**으로 내려받을 수 있습니다. 이 파일을 다른 사람에게 전달해 **Import data**로 불러오게 하거나, `npm run data:unpack -- <파일>`로 `data/` 구조로 풀어 새로운 시작 상태로 삼을 수 있습니다.
- 들어 있는 batch 세 개는 실제 annotation 결과를 **익명화한 것**입니다. ID는 모두 새로 만들었고, 본문은 같은 길이의 합성 텍스트로 바꿨습니다. 응답 값, 검수 상태, 작업 시간은 그대로 두었기 때문에 진행률, worker 지표, Fleiss' κ는 원본과 같습니다.
- 익명화에 쓰는 salt(`scripts/.fixture_salt`)와 원본 파일 목록(`scripts/fixture_sources.json`)은 저장소와 Docker 이미지에 포함하지 않습니다.

## 동작 방식

화면 코드는 `src/api/client.ts`의 `api` 객체만 호출합니다. 그 뒤에서 실제로 무엇이 동작할지는 빌드할 때 `VITE_API_MODE`로 정하며, 어느 쪽이든 화면 코드는 동일합니다.
현재 어떤 방식으로 동작 중인지는 Mock tools 메뉴 맨 아래에 표시됩니다.

| | `http` (Docker 기본값) | `mock` |
|---|---|---|
| 동작하는 곳 | mock API 서버 (`server/`) | 브라우저 안 |
| 저장 위치 | SQLite | 해당 브라우저의 IndexedDB |
| 시작 데이터 | `data/` 폴더를 디스크에서 읽음 | `data/` 폴더가 빌드 결과에 포함됨 |
| 요청 처리와 계산 | 두 방식 모두 `src/api/mock/handlers.ts`와 `src/domain/`의 **같은 코드**를 사용 | |

REST 경로는 [src/api/http/routes.ts](src/api/http/routes.ts)의 표 하나에 정의되어 있고, 브라우저 쪽 코드와 서버가 이 표를 함께 사용합니다.
실제 MTurk와 연동할 때는 같은 경로를 구현한 백엔드(예: FastAPI + boto3)로 주소만 바꾸면 됩니다. `/mock/*` 경로는 mock 전용이므로 실제 백엔드에는 만들지 않습니다.

## Preview

전체 흐름을 한 번 따라가 보는 순서입니다. 시작하기 전에 **Reset to fixtures**를 눌러 두세요.
미리 저장된 템플릿의 미리보기는 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷 연결이 필요합니다.

1. **Manage 목록**: 익명화한 batch 세 개가 보입니다. 진행률, 반려율, 비용이 자동으로 계산되어 있고, `pilot close-ended chunk-fact`에는 `Needs review`가 붙어 있습니다.
2. **Review**: 그 batch의 `Review` 탭에서 Status를 Submitted로 거르면 6건이 나옵니다. 행을 눌러 다른 worker들의 답과 비교해 보고, `Open task`로 worker가 본 화면을 열어 봅니다.
3. **반려와 재모집**: 두 건을 골라 반려합니다. attention check를 통과한 응답이라는 경고가 표시되고, 반려를 확정하면 다시 모집할지 물어봅니다. 나머지 응답은 승인합니다.
4. **HITs**: `Incomplete only`를 켜고, HIT 하나에 큰 수를 추가해 봅니다. 9개를 넘을 수 없다는 이유와 함께 건너뛰는 것을 볼 수 있습니다.
5. **Results**: Fleiss' κ가 0.731로 표시됩니다. 이 값은 statsmodels의 `fleiss_kappa` 결과와 소수 여섯째 자리까지 일치하며, 테스트로 고정되어 있습니다. Export로 받는 CSV는 MTurk Requester 웹사이트의 결과 CSV와 컬럼이 같아서 기존 분석 스크립트를 그대로 쓸 수 있습니다.
6. **Create**: `Load sample template`과 `Load sample CSV`로 5단계를 끝까지 진행해 게시합니다 (시나리오 1). 잔액이 줄고 Manage 목록에 새 batch가 생깁니다.
7. **가짜 응답 만들기**: **Mock tools → Generate fake submissions…**로 방금 게시한 batch에 응답을 채우고, 다시 Review에서 검수합니다.
8. **Worker Pool**: `Rej%`를 내림차순으로 정렬해 상위 worker를 선택하고 `Block…`을 누른 뒤, 기본 선택지인 "Excluded pool에 추가"를 고릅니다. 이어서 Pools에서 `Fill by criteria…`로 Trusted pool을 채워 봅니다.
   기본 조건(승인 20건 이상, attention 실패 0%, 일치율 90% 이상)으로는 해당하는 worker가 없습니다. 예시 데이터에서는 승인이 가장 많은 worker가 20건이고 attention 실패율이 5%이기 때문입니다. **승인 기준을 5로 낮추면 7명**이 나옵니다.
   이렇게 만든 pool을 Create의 Settings에서 참여 또는 제외로 지정하면, 가짜 응답도 그 조건을 따릅니다.
9. **저장과 API 확인**: Mock tools 메뉴 맨 아래에 `API: http · Store: SQLite (server)`가 표시됩니다. 터미널에서 아래 명령으로 방금 한 검수가 DB에 저장된 것과 REST 응답을 확인할 수 있습니다.

   ```bash
   docker compose exec api npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY 1"
   curl localhost:8787/api/batches
   ```

   같은 화면은 API 서버 없이도 동작합니다: `docker compose --profile mock up web-mock` (http://localhost:8081)

## 폴더 구조

```
data/               시작 데이터 (JSON + 템플릿 HTML)
docs/               화면에 나오는 값을 읽는 방법
example/            Create에 올려 볼 예시 템플릿과 CSV
server/             mock API 서버 (HTTP 처리, SQLite 저장)
scripts/            데이터 변환과 예시 파일 생성, DB 조회 스크립트
src/
├─ api/
│  ├─ types.ts      데이터 모델
│  ├─ client.ts     화면이 호출하는 API 인터페이스와 동작 방식 선택
│  ├─ mock/         메모리 저장소, 요청 처리, 가짜 응답 생성, data/ 읽기와 쓰기
│  └─ http/         REST 경로 표와 HTTP 클라이언트
├─ domain/          계산 로직: 비용, attention 판정, 진행률, majority와 κ, worker 지표, 템플릿 렌더링
├─ features/        화면: create, manage, workers
└─ components/      공용 컴포넌트: 미리보기 프레임, 구성 막대, Mock tools 메뉴 등
Dockerfile, docker-compose.yml, docker/nginx.conf
```

- 계산 로직은 모두 `src/domain/`의 순수 함수로 작성했고 단위 테스트가 있습니다.
- `npm test`는 계산 로직 외에도 `data/`가 기대한 규모인지, κ가 statsmodels의 값과 같은지, REST 요청과 SQLite 저장이 제대로 되는지, `example/`의 파일이 위 시나리오대로 동작하는지를 확인합니다.