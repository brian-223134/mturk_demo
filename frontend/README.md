# frontend: vanilla JavaScript 콘솔

`frontend/`는 MTurk Console의 production 화면입니다. 빌드 도구와 npm 의존성 없이 현재 Chrome에서 그대로 동작하는 ES module로 만들었고, nginx가 `src/`를 정적 파일로 서빙하면서 `/api/`를 backend(FastAPI)로 넘깁니다. React + antd 프로토타입(`prototype/`)과 같은 정보를 같은 용어로 보여 주되, React 코드를 옮기지는 않았습니다.

## 실행

저장소 루트에서 실행합니다. `frontend`는 `backend`가 healthy가 된 뒤에 뜹니다.

```
docker compose up --build frontend backend      # http://localhost:3000
```

`src/`는 컨테이너에 bind mount되므로 파일을 고친 뒤 새로고침만 하면 반영됩니다. 이미지를 다시 빌드할 필요는 없습니다. html, js, css 모두 `Cache-Control: no-cache`로 내려가므로 파일 이름에 해시를 붙이지 않아도 옛 파일이 남지 않습니다.

backend 없이 화면만 보려면 프로토타입의 mock API 서버(`api`, 포트 8787)에 붙일 수 있습니다. 경로 표가 같으므로 콘솔 화면은 그대로 동작하고, agent job API만 없어 Create 화면에 안내가 표시됩니다.

```
API_UPSTREAM=http://api:8787 docker compose up --no-deps frontend api
```

`API_UPSTREAM`은 nginx가 `/api/`를 넘길 주소입니다. 기본값은 `http://backend:8000`입니다.

`Load sample template`과 `Load sample CSV`는 저장소의 `example/`을 `/example/…`로 읽습니다. compose는 `./example`을 `/usr/share/nginx/example`에 mount하고 Dockerfile도 같은 자리에 복사하며, nginx가 `alias`로 `/example/`에 잇습니다. `frontend/src`는 읽기 전용 mount라 그 안에는 mount할 수 없습니다.

## 폴더 구성

```
frontend/
├─ Dockerfile              nginx:stable-alpine. nginx.conf.template 과 src/ 를 복사합니다 (빌드 컨텍스트는 저장소 루트)
├─ nginx.conf.template     listen 80, /api/ 프록시(${API_UPSTREAM}), SPA fallback, no-cache
├─ README.md
├─ tests/                 node --test 로 도는 단위 테스트 (아래 "테스트")
│  ├─ helpers/routes-ts.js  routes.ts 의 경로 표를 정규식으로 읽는 도우미
│  ├─ routes.test.js      경로 표 대조와 encodeRequest
│  ├─ client.test.js      fetch 를 가짜로 바꾼 API 클라이언트 검사
│  ├─ format.test.js      표시 도우미
│  ├─ dom.test.js         escapeHtml, join, el
│  └─ router.test.js      경로 패턴 매칭
└─ src/
   ├─ index.html           루트 요소 하나와 <script type="module" src="/main.js">
   ├─ main.js              레이아웃을 그리고 라우터에 페이지를 등록합니다
   ├─ router.js            history API 라우터. /create, /manage, /manage/:batchId(/:tab), /workers, /workers/pools, /workers/:workerId. / 는 /create 로 보냅니다
   ├─ router-match.js      경로 패턴 → 정규식(compilePattern), 경로에 맞는 route 찾기(matchRoute). DOM 을 쓰지 않아 Node 에서 테스트합니다
   ├─ styles.css           밝은 테마. 배지 색은 mock 회색, sandbox 파랑, production 빨강
   ├─ styles-create.css     Create 마법사의 스타일 (단계 표시줄, 검사 줄, 폼, 미리보기)
   ├─ styles-review.css     Manage 의 Review·HITs·Results 와 Worker Pool 의 스타일
   ├─ api-client/          (api/ 가 아닌 이유: /api/ 는 nginx 가 backend 로 넘기는 경로라 정적 파일과 겹칩니다)
   │  ├─ routes.js         REST 경로 표(API_ROUTES)와 agent job 경로(AGENT_ROUTES), 요청 인코딩(encodeRequest)
   │  └─ client.js         call(routeName, args), api.<route>(…), ApiError { code, message, status }, createJob, fileUrl
   ├─ lib/                  DOM 을 쓰지 않는 순수 로직. Node 테스트에서 그대로 import 합니다
   │  ├─ csv.js             RFC 4180 파서(따옴표, 겹따옴표, 줄바꿈, CRLF, BOM)와 UTF-8 검사. papaparse 를 쓰지 않습니다
   │  ├─ template.js        placeholder 추출, 치환, window.TASK_DATA 주입, 미리보기 제출 가로채기 스크립트
   │  ├─ data-check.js      placeholder 와 컬럼 대조, 빈 셀, 행 크기, Data 단계의 ERROR / OK / WARN / INFO 문구
   │  ├─ cost.js            보상, 수수료(20%, MaxAssignments 10 이상은 40%), 견적
   │  ├─ reference.js       대조 기준 컬럼의 셀 읽기 (JSON, Python repr, 평문)
   │  ├─ settings.js        Settings 기본값, 검증, MTurk 구조로 변환, agent settings.json 반영, 게시 요청 조립
   │  └─ draft.js           임시 저장 (IndexedDB). 저장소를 못 써도 마법사는 동작합니다
   ├─ components/
   │  ├─ dom.js            el() 도우미와 escapeHtml. 데이터는 항상 textContent 로 넣습니다
   │  ├─ layout.js         제목 줄(환경 배지, 잔액), 세 탭, 오류 띠
   │  ├─ table.js          표, 정렬 머리글(sortKey), 체크박스 선택(selection), 행 클릭, 페이지 이동(페이지 크기 선택)
   │  ├─ format.js         금액($0.00), 비율(%), 시각(YYYY-MM-DD HH:mm), 기간, 경과 시간
   │  ├─ badges.js         환경 배지, 상태 태그, attention 판정, job 과 step 의 상태 칩
   │  ├─ notice.js         안내 상자. API 오류를 code 별 제목으로 보여 줍니다
   │  ├─ stackedBar.js     구성비 막대와 범례
   │  ├─ modal.js          모달 창(openModal, confirmModal, infoModal). 버튼의 onClick 이 Promise 면 끝날 때까지 잠급니다
   │  ├─ drawer.js         오른쪽 상세 창. overlay.js 가 모달과 함께 Escape 와 페이지 이동 시 정리를 맡습니다
   │  ├─ toast.js          짧은 알림(success, info, warning, error)
   │  ├─ menu.js           눌러서 여는 메뉴 버튼(Export, Add to pool)
   │  ├─ selection.js      페이지를 넘겨도 유지되는 행 선택 (DOM 없이 테스트합니다)
   │  ├─ filters.js        도구줄의 select, 검색, 숫자, 체크 입력
   │  ├─ download.js       ExportFile 을 브라우저 다운로드로 (CSV 는 BOM 을 붙입니다)
   │  ├─ account.js        동작 뒤 제목 줄의 잔액을 다시 받습니다
   │  ├─ render.js         null 과 배열을 받는 replace(node, …children)
   │  └─ preview-frame.js   sandbox iframe 미리보기. Submit 을 가로채 답을 보여 줍니다
   └─ pages/
      ├─ create.js         5단계 마법사의 뼈대: draft, 자동 저장, 단계 이동 조건, Start over
      ├─ create/           template-step, data-step, settings-step, preview-step, publish-step, generate(agent job 패널), common
      ├─ manage.js         batch 목록
      ├─ batch.js          batch 상세의 틀. 제목 줄과 네 탭, 동작 뒤 상태 다시 맞추기(refreshDetail)
      ├─ manage/
      │  ├─ overviewTab.js   진행률, 비용, 설정과 Top up incomplete HITs, Expire now, Export
      │  ├─ reviewTab.js     검수 표(필터, 정렬, 선택, 승인/반려/번복), 답 열의 W/R 토큰
      │  ├─ reviewActionModal.js  승인·반려·번복 창 (반려 사유 프리셋, attention 통과 경고)
      │  ├─ assignmentDrawer.js   응답 상세(문항별 이 worker, 대조 기준, 같은 HIT 의 다른 worker)
      │  ├─ taskPreview.js   HIT 입력으로 템플릿을 렌더한 sandbox iframe 모달 (제출 가로채기)
      │  ├─ hitsTab.js       HIT 별 진행률, Incomplete only, Add assignments…, Input(getHit), Open task
      │  ├─ resultsTab.js    κ, 만장일치, 라벨 분포, 문항 표와 필터, Export
      │  ├─ answerTokens.js  답 값 약어(순수 함수), topUp.js  재모집 계산(9/10 규칙, 비용, 결과 문구)
      │  └─ shared.js
      ├─ workers.js        Worker Pool 의 틀. /workers, /workers/pools, /workers/:workerId
      └─ workers/
         ├─ list.js          worker 목록(정렬, 검색, pool 과 차단 필터, 선택 → pool 추가/제거, 차단/해제)
         ├─ detail.js        worker 상세(지표, batch 별 이력과 Review 링크, 메모, assignment 이력)
         ├─ pools.js         pool 목록, 인원 보기/빼기, New pool, Fill by criteria…
         └─ blockModal.js, createPoolModal.js, fillByCriteria.js(조건 판정은 순수 함수), poolMenu.js, shared.js
```

## API 클라이언트가 경로 표를 따르는 방법

`src/api-client/routes.js`의 `API_ROUTES`는 `prototype/src/api/http/routes.ts`의 표를 키, 메서드, 경로, 인자 순서까지 그대로 옮긴 것입니다. backend가 같은 표를 구현하므로 이 파일이 frontend 쪽의 계약입니다. 프로토타입에만 있는 `/api/mock/*`는 옮기지 않았습니다.

`src/api-client/client.js`의 `call(routeName, args)`는 인자 목록을 표의 규칙대로 요청에 싣습니다.

- 경로의 `:이름`과 같은 이름의 인자는 경로에 넣습니다.
- GET과 DELETE의 나머지 인자는 query string에 넣습니다. `q`(목록 조회 조건)는 `page`, `pageSize`, `sort=필드:방향`, `filters=<JSON>`으로 폅니다.
- POST와 PUT의 나머지 인자는 인자 이름을 키로 한 JSON body에 넣습니다. 인자 이름이 `body`면 그 값 자체가 body입니다.

`api.getBatch(id)`, `api.listHits(batchId, { page: 1, pageSize: 25 })`처럼 메서드로도 부를 수 있습니다. 오류는 항상 `ApiError { code, message, status }`입니다. `code`는 backend의 오류 봉투 `{ "error": { "code", "message" } }`에서 오고(`INVALID_REQUEST`, `NOT_FOUND`, `NOT_IMPLEMENTED`, `UNKNOWN`), 서버에 닿지 못했거나 JSON이 아닌 응답이 오면 `NETWORK`입니다. 화면은 `NOT_IMPLEMENTED`(501)를 "Not implemented in the backend yet" 안내로 보여 주고 나머지 부분은 계속 동작합니다.

agent job API(`/api/agent/models`, `/api/agent/jobs`, `/api/agent/jobs/{id}`, `/api/agent/jobs/{id}/files/{name}`)는 `AGENT_ROUTES`에 있습니다. job 생성만 multipart/form-data라서 `createJob(formData)`로 따로 보냅니다.

## 화면

- **Create**: 템플릿과 CSV로 batch를 게시하는 5단계 마법사입니다 (`Template` → `Data` → `Settings` → `Preview & Cost` → `Publish`). 각 단계의 선택지와 기본값, 다음 단계로 가는 조건은 [Create로 batch 게시하기](../docs/creating-a-batch.md)와 같습니다. `Template`에서는 저장된 템플릿을 고르거나(`Use a saved template`), HTML을 올리거나 붙여 넣어 저장하거나(`Upload or paste HTML`), 원본 데이터와 prompt로 agent job을 돌려 만듭니다(`Generate from raw data`). job이 성공하면 카드의 `Use this result`가 template.html을 job 이름으로 저장하고, hits.csv를 올린 것처럼 읽고, settings.json의 제목·설명·키워드·attention 규칙·대조 기준 컬럼을 Settings에 채운 뒤 `Data` 단계로 갑니다. `Data`는 CSV를 브라우저에서 읽어 placeholder를 검사하고 처음 5행을 보여 줍니다. `Settings`는 HIT 설정, Qualification 세 가지, pool 포함·제외, attention 규칙, Review의 대조 기준을 받고 아래에 비용을 미리 보여 줍니다. `Preview & Cost`는 고른 행으로 템플릿을 격리된 iframe에 그려 Submit을 가로채고, `Publish`는 요약을 확인한 뒤 `Publish N HITs`로 게시하고 새 batch의 Overview로 이동합니다. 입력은 CSV까지 브라우저(IndexedDB)에 임시 저장되어 새로고침해도 이어지고, `Start over`로 비웁니다.
- **Manage**: batch 목록과 batch 상세입니다. 상세의 `Overview`는 진행률, 응답 현황, 비용, 설정을 보여 주고, `Top up incomplete HITs`(부족한 HIT 수와 예상 비용을 확인한 뒤 재모집), `Expire now`(진행 중일 때만), `Export`(MTurk 결과 CSV, 라벨 JSON)를 제공합니다. `Review`는 응답 표에서 상태, attention 판정, WorkerId, 작업 시간으로 거르고 머리글로 정렬하며, 체크박스로 여러 건을 골라 `Approve selected`, `Reject selected…`(사유 필수, 프리셋 세 개, attention을 통과한 응답이 섞이면 경고), 반려된 건만 골랐을 때는 `Revert to approved…`를 실행합니다. `Select attention-failed`와 `Invert selection`(현재 페이지만 반전)도 있습니다. `Answers` 열은 worker의 답(W)과 대조 기준(R)을 약어 토큰으로 두 줄에 보여 주고, 행을 누르면 응답 상세가 열려 문항마다 이 worker의 답, 대조 기준, 같은 HIT의 다른 worker 답을 견주며 `Open task`로 worker가 본 화면을 sandbox iframe에 띄웁니다. 반려를 확정하면 부족해진 HIT를 재모집할지 곧바로 묻습니다. worker 상세에서 `?worker=<id>`로 넘어오면 그 worker의 응답만 보입니다. `HITs`는 HIT별 승인, 반려, 검수 대기, 남은 자리와 완료 여부를 보여 주고 `Incomplete only`로 거르며, 선택한 HIT에 `Add assignments…`(목표까지 채우기 또는 고정 수, 최대 8)로 응답을 더 모집합니다. 처음에 10개 미만으로 만든 HIT는 합계 9를 넘을 수 없으므로 넘는 요청은 이유와 함께 건너뜁니다. `Input`은 HIT의 전체 입력을, `Open task`는 task 화면을 엽니다. `Results`는 Fleiss' κ, 만장일치 비율, 투표가 있는 문항 수, 라벨 분포와 문항별 투표·majority 표(전체, 만장일치 아님, 동률, 표 부족 필터)를 보여 주고 `Export`로 내보냅니다.
- **Worker Pool**: 오른쪽 위의 `Workers` / `Pools`로 화면을 오갑니다. worker 목록은 모든 batch를 합산한 지표를 머리글로 정렬하고, WorkerId 검색, pool 필터, `Blocked only`로 거르며, 여러 명을 골라 `Add to pool`, `Remove from pool`, `Block…`(기본 선택지는 "Add to Excluded pool instead", 차단하려면 사유 필수), `Unblock`을 실행합니다. worker 상세(`/workers/<WorkerId>`)는 지표 요약, batch별 이력(누르면 그 worker로 걸러진 Review), 메모(`Save`), assignment 이력을 보여 줍니다. `Pools`(`/workers/pools`)는 pool을 만들고(`New pool`), 인원을 보거나 빼고, `Fill by criteria…`로 조건(최소 승인 수, 최대 attention 실패율, 최소 일치율, 최대 반려율)에 맞는 worker 수를 먼저 보여 준 뒤 확인하면 추가합니다. 조건 판정은 listWorkers로 받은 목록에 대해 화면에서 합니다.

숫자의 뜻은 [콘솔의 값 읽기](../docs/reading-the-console.md)에 정리되어 있습니다.

## 되는 것과 아직 없는 것

backend가 경로 표의 27개 경로를 모두 구현하므로, 프로토타입에서 되던 콘솔 기능은 이 화면에서도 모두 됩니다. Create의 세 가지 템플릿 방식과 게시, Manage의 검수·재모집·만료·export·결과, Worker Pool의 pool 편집·차단·worker 상세입니다. `API_UPSTREAM`을 프로토타입의 mock API로 바꾸면 Generate 패널만 잠기고 나머지는 같습니다.

아직 없는 것은 worker가 HIT를 푸는 화면입니다. MTurk에 연동하지 않으므로 새로 게시한 batch에는 응답이 들어오지 않고, Review와 Results는 시작 데이터의 batch 세 개로 확인합니다. 프로토타입의 Mock tools(가짜 응답 생성, Reset to fixtures)는 mock 전용이라 backend에 없습니다. 템플릿이 `assets.crowd.aws`의 스크립트를 불러오는 점도 그대로입니다.

## 테스트

`frontend/tests/`는 Node의 내장 test runner(`node --test`)와 `node:assert`만 씁니다. npm 의존성과 package.json이 없고, compose의 `frontend-test` 서비스가 `node:24-slim` 이미지에 `frontend/`와 프로토타입의 경로 표(`prototype/src/api/http/routes.ts`)를 읽기 전용으로 mount해 실행합니다. 이미지를 빌드하지 않으므로 파일을 고친 뒤 바로 다시 돌리면 됩니다.

```
docker compose run --rm frontend-test
```

테스트는 `src/`의 모듈을 그대로 import합니다. 부를 때 `document`나 `window`가 필요한 모듈(`pages/`, `layout.js`, `router.js`의 이동 부분)은 여기서 다루지 않고 브라우저로 확인합니다.

- `routes.test.js`: `API_ROUTES`가 `routes.ts`의 표와 키 순서, 메서드, 경로, 인자 순서까지 같은지, mock 전용 경로가 없는지, `AGENT_ROUTES`의 다섯 경로가 맞는지, 그리고 `encodeRequest`가 경로 인자, `q`(page, pageSize, sort, filters), 이름 있는 인자의 JSON body, `body` 인자, DELETE, multipart를 규칙대로 싣는지 확인합니다. `helpers/routes-ts.js`가 TS 파일을 컴파일하지 않고 정규식으로 표를 읽습니다.
- `client.test.js`: `globalThis.fetch`를 가짜로 바꿔 `call()`과 `api.<route>()`가 보내는 메서드, URL, 헤더, body를 확인하고, 200 JSON, 204, 오류 봉투(501 `NOT_IMPLEMENTED`, 404 `NOT_FOUND`, 모르는 code), JSON이 아닌 502, fetch 자체의 실패가 각각 어떤 값이나 `ApiError`가 되는지 봅니다. `isApiError`, `createJob(formData)`(multipart, JSON Content-Type 없음), `fileUrl`도 확인합니다.
- `format.test.js`: `formatCents`, `formatPercent`, `formatDateTime`/`formatDate`(TZ를 UTC로 고정), `formatDurationSeconds`, `formatElapsed`, `EMPTY` 등 표시 도우미를 확인합니다.
- `dom.test.js`: `escapeHtml`, `join`과, 아주 작은 가짜 `document`를 넣은 `el`/`append`/`clear`의 속성과 자식 처리를 확인합니다.
- `router.test.js`: `router-match.js`의 `compilePattern`과 `matchRoute`가 main.js의 패턴(`/manage/:batchId/:tab` 등)에 경로를 맞추고 params를 뽑는지, 맞지 않는 경로는 null인지 확인합니다.
- `manage-answerTokens.test.js`: `abbreviate`(첫 글자 약어, 겹치면 글자 늘리기, 값 전체, 표기 차이 묶기, 빈 값), `legendEntries`, `tokenWidthOf`, `normalizeLabel`을 확인합니다.
- `manage-topup.test.js`: `planTopUp`의 9/10 규칙과 건너뜀 사유, `roomOf`/`maxAddable`, 수수료율과 `unitCostCents`, `planBatchTopUp`, `describeTopUp` 문구를 확인합니다.
- `workers-criteria.test.js`: `matchesCriteria`(null 값은 불일치, % 비교), `eligibleWorkers`(pool 소속 제외, 차단 따로 집계, 승인 순), `createSelection`을 확인합니다.
- `lib-csv.test.js`: 파서의 따옴표, 겹따옴표, 줄바꿈, CRLF, BOM, 빈 줄, 모자라거나 넘치는 셀, 빈 헤더, 중복 헤더, 따옴표 문제, 그리고 example/의 CSV(BOM 파일은 정상, CP949 파일은 "not valid UTF-8"로 거절)를 확인합니다.
- `lib-template.test.js`: placeholder 추출 규칙, `${}` 치환(escape 없음, `$&` 안전), TASK_DATA 주입 위치, 미리보기 스크립트 포함 여부를 확인합니다.
- `lib-data-check.test.js`: README의 시나리오 1~4를 example/과 data/templates의 파일로 그대로 재현합니다 (`12/12 matched`, `WARN max 70.2 KB`, `row 3, 5`, 행 크기 중앙값·최대값 문구).
- `lib-cost.test.js`, `lib-settings.test.js`: 견적과 수수료, 기본값의 MTurk 변환, Qualification, attention 규칙, 대조 기준 문구, 폼 검증 문구, agent settings.json 반영, 게시 요청 조립을 확인합니다.
- `lib-draft.test.js`: 저장 형식과 복원, 가짜 store로 CSV가 바뀔 때만 쓰는지, 저장소가 깨져도 오류를 던지지 않는지 확인합니다.

compose의 `frontend-test`는 이 테스트를 위해 `example/`과 `data/templates/`도 읽기 전용으로 mount합니다.
