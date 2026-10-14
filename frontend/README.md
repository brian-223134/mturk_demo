# frontend: vanilla JavaScript 콘솔

`frontend/`는 MTurk Console의 production 화면입니다. 빌드 도구와 npm 의존성 없이 현재 Chrome에서 그대로 동작하는 ES module로 만들었고, nginx가 `src/`를 정적 파일로 서빙하면서 `/api/`를 backend(FastAPI)로 넘깁니다. React + antd 프로토타입(`prototype/`)과 같은 정보를 같은 용어로 보여 주되, React 코드를 옮기지는 않았습니다.

## 실행

저장소 루트에서 실행합니다. `frontend`는 `backend`가 healthy가 된 뒤에 뜹니다.

```
docker compose up --build frontend backend      # http://localhost:3000
```

`src/`는 컨테이너에 bind mount되므로 파일을 고친 뒤 새로고침만 하면 반영됩니다. 이미지를 다시 빌드할 필요는 없습니다. html, js, css 모두 `Cache-Control: no-cache`로 내려가므로 파일 이름에 해시를 붙이지 않아도 옛 파일이 남지 않습니다.

backend 없이 화면만 보려면 프로토타입의 mock API 서버(`api`, 포트 8787)에 붙일 수 있습니다. 경로 표가 같으므로 콘솔 화면은 그대로 동작하고, agent job API가 없어 Generate 패널에 안내가 표시됩니다. 프로토타입의 API는 Project의 속성(`properties`)과 표본 행(`sampleRow`)을 저장하지 않으므로, 저장한 Project를 다시 열면 기본값이 보입니다.

```
API_UPSTREAM=http://api:8787 docker compose up --no-deps frontend api
```

`API_UPSTREAM`은 nginx가 `/api/`를 넘길 주소입니다. 기본값은 `http://backend:8000`입니다.

템플릿이 불러오는 `<ann-*>` 요소(`/elements/ann-elements.js`)와 New Project의 starter 템플릿(`/elements/starters/*.html`)은 `src/elements/`에 있고, 다른 정적 파일과 함께 서빙됩니다. 미리보기 iframe의 문서(`srcdoc`)도 콘솔과 같은 주소에서 이 파일을 읽으므로 외부 CDN이 필요 없습니다.

저장소의 `example/`은 `/example/…`로 내려받을 수 있습니다. compose는 `./example`을 `/usr/share/nginx/example`에 mount하고 Dockerfile도 같은 자리에 복사하며, nginx가 `alias`로 `/example/`에 잇습니다. `frontend/src`는 읽기 전용 mount라 그 안에는 mount할 수 없습니다.

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
│  ├─ router.test.js      경로 패턴 매칭
│  ├─ elements.test.js    <ann-*> 요소의 core (답 이름, 문항 목록, 제출할 답, 막는 문구)
│  ├─ layout-lint.test.js  Design Layout 의 검사
│  ├─ job-groups.test.js  Generate 의 후보 묶음
│  └─ starters.test.js    starter 템플릿과 example/5-project
└─ src/
   ├─ index.html           루트 요소 하나와 <script type="module" src="/main.js">
   ├─ main.js              로그인 상태(GET /api/auth/me)를 보고 역할에 맞는 레이아웃과 경로를 등록합니다 (아래 "로그인과 역할")
   ├─ router.js            history API 라우터. 경로는 main.js 에서 등록합니다 (/create, /create/new, /create/tutorial, /create/project/:projectId(/:tab),
   │                       /create/publish/:projectId, /manage, /manage/:batchId(/:tab), /workers, /workers/pools, /workers/:workerId,
   │                       /admin/users, /worker, /login, /signup). / 는 역할의 첫 화면으로 보내고, onNotFound 로 등록하지 않은 경로를 돌려보냅니다
   ├─ router-match.js      경로 패턴 → 정규식(compilePattern), 경로에 맞는 route 찾기(matchRoute). DOM 을 쓰지 않아 Node 에서 테스트합니다
   ├─ styles.css           밝은 테마. 배지 색은 mock 회색, sandbox 파랑, production 빨강
   ├─ styles-create.css     Create 의 스타일 (Project 목록, 갤러리, 편집기와 미리보기, 단계 표시줄, 검사 줄, 폼)
   ├─ elements/            템플릿이 불러오는 파일 (frontend 가 그대로 서빙합니다)
   │  ├─ ann-elements.js   <ann-form>, <ann-choice> 등 annotation 요소. 문항 그리기, 필수 검사, input_answers 제출, TASK_ANSWER_SCHEMA
   │  └─ starters/         New Project 의 starter 템플릿 9종 (<ann-*> 로 쓴 HTML)
   ├─ styles-review.css     Manage 의 Review·HITs·Results 와 Worker Pool 의 스타일
   ├─ api-client/          (api/ 가 아닌 이유: /api/ 는 nginx 가 backend 로 넘기는 경로라 정적 파일과 겹칩니다)
   │  ├─ routes.js         REST 경로 표(API_ROUTES), agent job 경로(AGENT_ROUTES), 계정 경로(ACCOUNT_ROUTES), 요청 인코딩(encodeRequest)
   │  └─ client.js         call(routeName, args), api.<route>(…), auth, admin, ApiError { code, message, status }, createJob, createJobGroup, fileUrl
   ├─ lib/                  DOM 을 쓰지 않는 순수 로직. Node 테스트에서 그대로 import 합니다
   │  ├─ csv.js             RFC 4180 파서(따옴표, 겹따옴표, 줄바꿈, CRLF, BOM)와 UTF-8 검사. papaparse 를 쓰지 않습니다
   │  ├─ template.js        placeholder 추출, 치환, window.TASK_DATA 주입, 미리보기 스크립트(제출 가로채기, 문항 목록 보고)
   │  ├─ data-check.js      placeholder 와 컬럼 대조, 빈 셀, 행 크기, Data 단계의 ERROR / OK / WARN / INFO 문구
   │  ├─ cost.js            보상, 수수료(20%, MaxAssignments 10 이상은 40%), 견적
   │  ├─ reference.js       대조 기준 컬럼의 셀 읽기 (JSON, Python repr, 평문)
   │  ├─ settings.js        폼 기본값, Project 속성과 검수 설정의 구분, 검증, MTurk 구조로 변환, attention 규칙 두 모양, agent settings.json 반영, 게시 요청 조립
   │  ├─ answer-fields.js   Preview 의 문항 목록을 attention 규칙, 자유 서술 접미어와 맞춰 보는 경고
   │  ├─ draft.js           Publish Batch 의 임시 저장 (IndexedDB). 저장소를 못 써도 화면은 동작합니다
   │  ├─ project-draft.js   Project 편집기의 임시 저장, 저장본과의 비교, 저장 요청
   │  ├─ starters.js        starter 템플릿 목록 (설명, 표본 행, 미리 채울 속성)
   │  ├─ layout-lint.js     Design Layout 의 검사 (<ann-*> 를 잘못 쓴 곳)
   │  ├─ job-groups.js      Generate 의 후보 묶음: job 목록을 묶음과 단독 job 으로 나누기, 묶음 상태와 안내, 후보마다 고를 기본 모델
   │  ├─ session.js         역할별 첫 화면과 열 수 있는 경로, 로그인 뒤 돌아갈 곳(safeNext), 가입 조건과 검사 문구 (backend 와 같은 문구)
   │  ├─ worker-tasks.js    worker 에게 보낼 입력 컬럼(backend 와 같은 규칙, Publish Batch 의 확인 단계가 보여 줌), 남은 시간, 기간과 상태 글
   │  └─ element-reference.js  Insert element 메뉴와 Element reference 패널의 요소 설명
   ├─ components/
   │  ├─ dom.js            el() 도우미와 escapeHtml. 데이터는 항상 textContent 로 넣습니다
   │  ├─ layout.js         콘솔 레이아웃(제목 줄의 환경 배지·잔액·계정 메뉴, 탭, admin 의 Users 탭, 오류 띠), worker 레이아웃, 로그인 화면 레이아웃
   │  ├─ table.js          표, 정렬 머리글(sortKey), 체크박스 선택(selection), 여러 행을 덮는 칸(span), 행 클릭, 페이지 이동(페이지 크기 선택)
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
      ├─ auth.js           /login(로그인, next 로 돌아가기), /signup(계정 종류, 초대 코드, 가입 조건은 GET /api/auth/options)
      ├─ worker.js         worker 화면: /worker(HITs, Accept & Work), /worker/assignments/:assignmentId(작업 화면: 남은 시간, sandbox iframe,
      │                    제출, Return HIT, 다음 HIT 이어 받기), /worker/history(Your HITs: 상태, 금액, 반려 사유)
      ├─ admin.js          /admin/users: 초대 코드 만들기(코드는 한 번만 표시)와 지우기, 계정 목록과 정지·해제
      ├─ create.js         Create 의 경로별 진입점
      ├─ create/
      │  ├─ projects.js      Project 목록 (Publish Batch, Edit, Copy, Delete)
      │  ├─ new-project.js   New Project 갤러리 (starter, HTML 올리기, Generate from raw data 와 고른 결과로 Project 만들기)
      │  ├─ project-editor.js  Project 편집기의 틀: 세 탭, 임시 저장, Save, Discard changes, Preview and Finish
      │  ├─ properties-form.js  Enter Properties 의 폼
      │  ├─ layout-tab.js    Design Layout: 편집기, Insert element, 검사, 표본 값, 미리보기, 답 칸
      │  ├─ publish-batch.js  Publish Batch 의 틀: draft, 자동 저장, 단계 이동 조건, Start over
      │  ├─ tutorial.js      /create/tutorial: 처음 쓰는 사람을 위한 한국어 따라 하기 안내 (화면으로 바로 가는 버튼)
      │  ├─ data-step.js, preview-step.js, quality-step.js, publish-step.js  Upload CSV, Preview tasks, Review settings, Confirm and publish
      │  └─ generate.js, generate-form.js, job-results.js, common.js  agent job 패널과 공용 조각
      ├─ manage.js         batch 목록
      ├─ batch.js          batch 상세의 틀. 제목 줄과 네 탭, 동작 뒤 상태 다시 맞추기(refreshDetail)
      ├─ manage/
      │  ├─ overviewTab.js   진행률, 비용, 설정과 Top up incomplete HITs, Expire now, Export
      │  ├─ reviewTab.js     검수 표(필터, 정렬, HIT 묶음, 응답·HIT 단위 결정 라디오, 제출, 번복), 답 열의 W/R 토큰
      │  ├─ reviewDecisions.js  검수 결정 저장과 HIT 묶기 (DOM 없이 테스트합니다)
      │  ├─ reviewActionModal.js  결정 제출 창과 승인·반려·번복 창 (반려 사유 프리셋, attention 통과 경고)
      │  ├─ assignmentDrawer.js   응답 상세(문항별 이 worker, 대조 기준, 같은 HIT 의 다른 worker)
      │  ├─ taskPreview.js   HIT 입력으로 템플릿을 렌더한 sandbox iframe 모달 (Create 의 미리보기와 같은 lib/template.js 스크립트)
      │  ├─ hitsTab.js       HIT 별 진행률, Incomplete only, Add assignments…, Input(getHit), Open task
      │  ├─ resultsTab.js    IAA 표(승인, 검수 대기, 검수 대기 + 승인의 κ, α), 만장일치, 라벨 분포, 문항 표와 필터, Export
      │  ├─ iaa.js           IAA 표의 세 범위, 행 글과 해석 구간 (DOM 없이 테스트합니다)
      │  ├─ answerTokens.js  답 값 약어와 자유 서술 답 줄이기(순수 함수), topUp.js  재모집 계산(9/10 규칙, 비용, 결과 문구)
      │  └─ shared.js        attention 답과 자유 서술 답 판별(answerKindsOf), 대조 기준 문구, 반려 사유 프리셋
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

`api.getBatch(id)`, `api.listHits(batchId, { page: 1, pageSize: 25 })`처럼 메서드로도 부를 수 있습니다. 오류는 항상 `ApiError { code, message, status }`입니다. `code`는 backend의 오류 봉투 `{ "error": { "code", "message" } }`에서 오고(`INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `NOT_IMPLEMENTED`, `UNKNOWN`), 서버에 닿지 못했거나 JSON이 아닌 응답이 오면 `NETWORK`입니다. 콘솔 REST나 agent API가 `UNAUTHORIZED`(세션이 끝남)를 돌려주면 `window`에 `auth:required` 이벤트를 보내고, main.js가 로그인 화면으로 보냅니다. 계정 API(`ACCOUNT_ROUTES`, `auth`와 `admin` 객체)의 401은 틀린 비밀번호처럼 화면이 직접 다루므로 이벤트를 보내지 않습니다. 화면은 `NOT_IMPLEMENTED`(501)를 "Not implemented in the backend yet" 안내로 보여 주고 나머지 부분은 계속 동작합니다.

worker의 작업 API(`/api/worker/*`)는 `WORKER_ROUTES`에 있고 `worker` 객체로 부릅니다. 콘솔 REST처럼 401이면 `auth:required` 이벤트를 보냅니다.

agent job API(`/api/agent/models`, `/api/agent/jobs`, `/api/agent/jobs/{id}`, `/api/agent/jobs/{id}/files/{name}`, `/api/agent/job-groups`, `/api/agent/job-groups/{id}/choice`)는 `AGENT_ROUTES`에 있습니다. job과 후보 묶음의 생성은 multipart/form-data라서 `createJob(formData)`, `createJobGroup(formData)`로 따로 보냅니다.

## 로그인과 역할

main.js는 시작할 때 `GET /api/auth/me`로 로그인 상태를 확인하고 역할에 맞는 레이아웃과 경로만 등록합니다.

- **로그인하지 않음**: `/login`과 `/signup`만 있고, 다른 경로는 `/login?next=<경로>`로 보냅니다. 로그인하면 `next`(같은 사이트이고 그 역할로 열 수 있는 경로일 때만)로, 가입하면 역할의 첫 화면으로 페이지를 새로 불러 시작합니다.
- **requester, admin**: 아래의 콘솔입니다. 제목 줄 오른쪽에 계정 메뉴(이메일, `Sign out`)가 있고, admin에게는 `Users` 탭(`/admin/users`)이 더 있습니다.
- **worker**: `/worker`(HITs), `/worker/assignments/<id>`(작업 화면), `/worker/history`(Your HITs)만 있고 다른 경로는 `/worker`로 보냅니다.
- **계정 API가 없는 서버**: `/api/auth/me`가 404면(프로토타입의 mock API에 붙인 경우) 예전처럼 로그인 없이 콘솔을 그리고 계정 메뉴를 빼고 보여 줍니다.

가입 화면의 초대 코드 칸은 `GET /api/auth/options`의 `workerSignup`과 고른 계정 종류(Requester는 언제나 필요)에 따라 보이거나 숨습니다.

## 화면

- **Create**: MTurk의 Requester 화면처럼 Project를 만들고 그 Project에 CSV를 올려 batch를 게시합니다. 위쪽의 `New Batch with an Existing Project`는 Project 목록(`Publish Batch`, `Edit`, `Copy`, `Delete`)이고, `Tutorial`은 한국어 따라 하기 안내이며, `New Project`는 starter 템플릿 9종, `Upload or paste HTML`, `Generate from raw data` 중에서 시작할 것을 고르는 화면입니다. Project 편집기는 `Enter Properties`(제목, 보상, 인원, 기간, worker 조건), `Design Layout`(HTML 편집기, `Insert element…`, 검사, 변수별 표본 값, 실시간 미리보기와 답 칸 목록), `Preview and Finish`(요약, `Download CSV template`, `Finish`) 세 탭이며, 저장하지 않은 편집은 Project마다 브라우저에 임시 저장됩니다. batch는 `Upload CSV` → `Preview tasks` → `Review settings`(attention 규칙, 자유 서술 답, 대조 기준) → `Confirm and publish`(요약의 `Workers receive`에 worker에게 보낼 입력 컬럼)로 게시하고, 보상과 인원 같은 속성은 Project의 값을 그대로 씁니다. `Generate from raw data`는 모델만 다른 후보 세 개를 동시에 만들고, `Templates` 목록에서 한 카드로 묶어 보여 줍니다. 모두 끝나면 `Compare and choose`로 나란히 비교하고 `Choose this template`으로 하나를 고르며, 고른 후보의 template.html과 settings.json을 그 이름의 Project로 저장하고 hits.csv를 올린 상태로 Publish Batch를 엽니다. task spec으로 돌린 job 하나는 카드의 `Use this result`로 같은 일을 합니다. 화면별 선택지와 조건은 [Project로 batch 게시하기](../docs/create-projects.md)에, 템플릿 요소는 [`<ann-*>` 요소로 템플릿 쓰기](../docs/annotation-elements.md)에 정리되어 있습니다. 서버에서는 템플릿 레코드 하나가 Project 하나이며, 레코드의 선택 필드 `properties`와 `sampleRow`에 속성과 표본 값을 둡니다.
- **Manage**: batch 목록과 batch 상세입니다. 상세의 `Overview`는 진행률, 응답 현황(worker가 푸는 중인 `In progress` 포함), 비용, 설정을 보여 주고, `Top up incomplete HITs`(부족한 HIT 수와 예상 비용을 확인한 뒤 재모집), `Expire now`(진행 중일 때만), `Export`(MTurk 결과 CSV, 라벨 JSON)를 제공합니다. `Review`는 응답 표에서 상태, attention 판정, WorkerId, 작업 시간으로 거르고 머리글로 정렬하며, 검수를 두 단계의 라디오로 합니다. 검수 대기 응답마다 `Approve` / `Reject`(고른 칸을 다시 누르면 지움)가 있고, Row 순일 때는 같은 HIT의 응답 행을 덮는 HIT 칸에 `Approve all` / `Reject all`이 있어 그 HIT의 응답 전부에 같은 결정을 넣습니다(worker마다 다르면 `Mixed decisions`). 페이지 경계에 걸린 HIT는 앞뒤 페이지를 같은 조건으로 받아 그 응답까지 함께 정합니다. `Answers`는 줄을 바꾸지 않아 W/R 두 줄이 문항별로 맞고, 넓으면 표가 좌우로 넘어가며 `Row`와 `Decision` 열은 왼쪽에 고정됩니다(`position: sticky`, 둘째 열의 left 는 첫 열의 실제 폭으로 맞춤). 결정은 페이지를 넘겨도 남고(`reviewDecisions.js`), 표 위에 고정된 막대의 `Submit … decisions…`로 한 번에 제출합니다. 제출 창은 반려(사유 필수, 프리셋 세 개, attention을 통과한 응답이 섞이면 경고)와 승인(메시지 선택)을 함께 받으며, 반려를 먼저 보냅니다. `Reject attention-failed`는 attention 실패 응답을 모두 `Reject`로 골라 두고, 반려된 행에는 `Revert…`(반려 번복)가 있습니다. 제출하지 않은 결정이 있으면 창을 닫거나 새로고침할 때 브라우저가 묻습니다. `Answers` 열은 worker의 답(W)과 대조 기준(R)을 약어 토큰으로 두 줄에 보여 주고(attention 답은 보라 테두리, 자유 서술 답은 짧게 자른 글이며 전문은 마우스를 올리면 보입니다. 어느 답이 attention인지는 서버가 준 `attentionNames`로 판단합니다), 행을 누르면 응답 상세가 열려 문항마다 이 worker의 답, 대조 기준, 같은 HIT의 다른 worker 답을 견주며 `Open task`로 worker가 본 화면을 sandbox iframe에 띄웁니다. 반려를 확정하면 부족해진 HIT를 재모집할지 곧바로 묻습니다. worker 상세에서 `?worker=<id>`로 넘어오면 그 worker의 응답만 보입니다. `HITs`는 HIT별 승인, 반려, 검수 대기, 남은 자리와 완료 여부를 보여 주고 `Incomplete only`로 거르며, 선택한 HIT에 `Add assignments…`(목표까지 채우기 또는 고정 수, 최대 8)로 응답을 더 모집합니다. 처음에 10개 미만으로 만든 HIT는 합계 9를 넘을 수 없으므로 넘는 요청은 이유와 함께 건너뜁니다. `Input`은 HIT의 전체 입력을, `Open task`는 task 화면을 엽니다. `Results`는 annotator 간 일치도 표(승인, 승인하지 않은 제출, 둘을 합친 것의 세 범위마다 Fleiss' κ, Krippendorff's α와 각 지표가 쓴 문항 수. 반려된 응답은 어디에도 넣지 않음), 만장일치 비율, 투표가 있는 문항 수, 라벨 분포와 문항별 투표·majority 표(전체, 만장일치 아님, 동률, 표 부족 필터)를 보여 주고 `Export`로 내보냅니다.
- **Worker Pool**: 오른쪽 위의 `Workers` / `Pools`로 화면을 오갑니다. worker 목록은 모든 batch를 합산한 지표를 머리글로 정렬하고, WorkerId 검색, pool 필터, `Blocked only`로 거르며, 여러 명을 골라 `Add to pool`, `Remove from pool`, `Block…`(기본 선택지는 "Add to Excluded pool instead", 차단하려면 사유 필수), `Unblock`을 실행합니다. worker 상세(`/workers/<WorkerId>`)는 지표 요약, batch별 이력(누르면 그 worker로 걸러진 Review), 메모(`Save`), assignment 이력을 보여 줍니다. `Pools`(`/workers/pools`)는 pool을 만들고(`New pool`), 인원을 보거나 빼고, `Fill by criteria…`로 조건(최소 승인 수, 최대 attention 실패율, 최소 일치율, 최대 반려율)에 맞는 worker 수를 먼저 보여 준 뒤 확인하면 추가합니다. 조건 판정은 listWorkers로 받은 목록에 대해 화면에서 합니다.
- **Worker**(worker 계정): `HITs`는 받을 수 있는 HIT가 남은 batch 목록(제목, Requester, 보상, 제한 시간, 남은 HIT 수)이고, `Accept & Work`로 HIT 하나를 받아 작업 화면으로 갑니다(같은 batch에서 푸는 중이면 `Continue`). 작업 화면은 Requester 미리보기와 같은 sandbox iframe(`previewFrame`의 `showSubmitted: false`)에 템플릿을 그리고, 가로챈 제출 답을 `submitAssignment`로 보냅니다. 위쪽에 보상, 1초마다 줄어드는 남은 시간, `Return HIT`, "제출 뒤 같은 batch의 다음 HIT 이어 받기"(기본 켜짐, 브라우저에 기억)가 있습니다. 행 데이터는 backend가 정답 컬럼을 뺀 것만 줍니다. `Your HITs`는 승인·검수 대기·반려·푸는 중의 수와 금액, HIT별 상태와 반려 사유입니다.

숫자의 뜻은 [콘솔의 값 읽기](../docs/reading-the-console.md)에 정리되어 있습니다.

## 되는 것과 아직 없는 것

### Prompt 반복 실험

예시 prompt(기준형·데이터 명확화형·안내 강화형·결합형)는 Tutorial의 `Example prompts`에서 고릅니다. `Load prompt`는 본문과 이름만, `Load prompt + example data`는 합성 raw도 함께 채운 채로 Generate from raw data를 엽니다. Tutorial은 Generate 초안(localStorage)에 prompt를 쓰고 sessionStorage에 한 번만 읽히는 표시를 남기며, 폼은 열릴 때 그 표시를 읽어 합성 raw를 받아 옵니다(`lib/experiments.js`). API 호출은 Generate를 누를 때 수행합니다. [비교 조건과 평가 기준](../docs/prompt-experiments.md)을 참고합니다.

Create의 Generate 패널은 prompt 본문, 이름, 후보마다 고른 모델과 이전 raw 참조를 브라우저에 보존합니다. Prompt는 `Prompt text`에 직접 쓰거나 붙여 넣습니다. 후보의 모델은 처음에 서로 다른 세 개(서버 기본 설정이 먼저)가 골라져 있고, 같은 모델을 두 번 고르면 후보가 거의 같아진다고 알립니다. 아직 제출하지 않은 로컬 파일은 새로고침 뒤 다시 선택해야 하며, 제출한 raw는 서버에 남아 재사용할 수 있습니다. `Reuse inputs`는 이전 job의 raw와 prompt를 복원합니다. API 호출 허용과 이전 spec 재사용은 자동으로 켜지지 않습니다. Spec을 올리거나 재사용하면 prompt 변경이 결과에 반영되지 않는다는 안내가 표시됩니다.

성공한 job의 `Preview & evaluate`는 Project를 만들거나 Publish Batch의 입력을 바꾸지 않고 결과를 엽니다. Prompt, spec, 행별 annotation 화면을 보고 데이터·라벨, 안내문, attention에 대한 평가와 메모를 서버에 저장합니다. 이 평가는 구조 검증과 별개입니다.

후보 묶음의 `Compare and choose`는 성공한 후보만 같은 비교 창으로 열고, 후보마다 `Choose this template`을 둡니다. 묶음의 후보는 일부러 모델만 바꾼 것이라 모델 차이는 경고하지 않습니다. 다른 실행의 결과를 함께 보려면 성공한 job 2~3개의 `Compare`를 체크하고 `Compare selected`를 누릅니다. 이 비교는 처리량, 누락, 샘플링·attention 조건과 비용을 비교합니다. 공통 일반 항목이 있으면 record/item ID로 같은 그룹의 미리보기를 맞추며, raw·모델·처리 조건이 다르면 알립니다. `Export comparison JSON`은 prompt, spec, 요약, 저장한 평가를 함께 내려받습니다. 내보내기 전에 편집한 평가를 저장해야 합니다.

backend가 경로 표의 27개 경로를 모두 구현하므로, 프로토타입에서 되던 콘솔 기능은 이 화면에서도 모두 됩니다. Create의 Project 만들기와 게시, Manage의 검수·재모집·만료·export·결과, Worker Pool의 pool 편집·차단·worker 상세입니다. `API_UPSTREAM`을 프로토타입의 mock API로 바꾸면 Generate 패널만 잠기고 나머지는 같습니다.

worker 계정으로 로그인하면 게시된 batch의 HIT를 받아 풀고 제출할 수 있어, 새로 게시한 batch의 응답도 Review와 Results에서 확인할 수 있습니다. 시작 데이터의 batch 세 개는 모두 만료되어 worker 화면에는 보이지 않습니다. 프로토타입의 Mock tools(가짜 응답 생성, Reset to fixtures)는 mock 전용이라 backend에 없습니다. 시작 데이터의 템플릿과 agent가 만드는 템플릿이 `assets.crowd.aws`의 스크립트를 불러오는 점도 그대로입니다. starter와 `<ann-*>` 요소로 쓴 템플릿은 이 스크립트에 의존하지 않습니다.

## 테스트

`frontend/tests/`는 Node의 내장 test runner(`node --test`)와 `node:assert`만 씁니다. npm 의존성과 package.json이 없고, compose의 `frontend-test` 서비스가 `node:24-slim` 이미지에 `frontend/`와 프로토타입의 경로 표(`prototype/src/api/http/routes.ts`)를 읽기 전용으로 mount해 실행합니다. 이미지를 빌드하지 않으므로 파일을 고친 뒤 바로 다시 돌리면 됩니다.

```
docker compose run --rm frontend-test
```

테스트는 `src/`의 모듈을 그대로 import합니다. 부를 때 `document`나 `window`가 필요한 모듈(`pages/`, `layout.js`, `router.js`의 이동 부분)은 여기서 다루지 않고 브라우저로 확인합니다.

- `routes.test.js`: `API_ROUTES`가 `routes.ts`의 표와 키 순서, 메서드, 경로, 인자 순서까지 같은지, mock 전용 경로가 없는지, `AGENT_ROUTES`의 열 경로가 맞는지, `ACCOUNT_ROUTES`가 `/auth`와 `/admin` 아래에, `WORKER_ROUTES`가 `/worker` 아래에 있고 다른 표와 이름이 겹치지 않는지(backend 의 표와의 대조는 backend 테스트가 합니다), 그리고 `encodeRequest`가 경로 인자, `q`(page, pageSize, sort, filters), 이름 있는 인자의 JSON body, `body` 인자, DELETE, multipart를 규칙대로 싣는지 확인합니다. `helpers/routes-ts.js`가 TS 파일을 컴파일하지 않고 정규식으로 표를 읽습니다.
- `lib-session.test.js`: 역할별 첫 화면과 열 수 있는 경로, `safeNext`가 다른 사이트(`//…`, `https://…`)나 `/api/`, 로그인 화면, 그 역할로 열 수 없는 경로를 버리는 것, `loginPath`, 가입 조건(`workerSignup` 세 값, Requester 의 초대 코드)과 검사 문구가 backend 와 같은지, 이메일 도메인 제한을 확인합니다.
- `client.test.js`: `globalThis.fetch`를 가짜로 바꿔 `call()`과 `api.<route>()`가 보내는 메서드, URL, 헤더, body를 확인하고, 200 JSON, 204, 오류 봉투(501 `NOT_IMPLEMENTED`, 404 `NOT_FOUND`, 모르는 code), JSON이 아닌 502, fetch 자체의 실패가 각각 어떤 값이나 `ApiError`가 되는지 봅니다. `isApiError`, `createJob(formData)`·`createJobGroup(formData)`(multipart, JSON Content-Type 없음), `chooseCandidate`(`{job_id}` JSON), `fileUrl`도 확인합니다. 콘솔 REST 의 401 이 `auth:required` 이벤트를 보내고 계정 API 의 401 과 403 은 보내지 않는 것, `auth`, `admin`, `worker`가 보내는 요청도 봅니다.
- `format.test.js`: `formatCents`, `formatPercent`, `formatDateTime`/`formatDate`(TZ를 UTC로 고정), `formatDurationSeconds`, `formatElapsed`, `EMPTY` 등 표시 도우미를 확인합니다.
- `dom.test.js`: `escapeHtml`, `join`과, 아주 작은 가짜 `document`를 넣은 `el`/`append`/`clear`의 속성과 자식 처리를 확인합니다.
- `router.test.js`: `router-match.js`의 `compilePattern`과 `matchRoute`가 main.js의 패턴(`/manage/:batchId/:tab`, Create 의 `/create/project/:projectId/:tab` 등)에 경로를 맞추고 params를 뽑는지, 맞지 않는 경로는 null인지 확인합니다.
- `manage-answerTokens.test.js`: `abbreviate`(첫 글자 약어, 겹치면 글자 늘리기, 값 전체, 표기 차이 묶기, 빈 값), `legendEntries`, `tokenWidthOf`, `normalizeLabel`을 확인합니다.
- `manage-topup.test.js`: `planTopUp`의 9/10 규칙과 건너뜀 사유, `roomOf`/`maxAddable`, 수수료율과 `unitCostCents`, `planBatchTopUp`, `describeTopUp` 문구를 확인합니다.
- `workers-criteria.test.js`: `matchesCriteria`(null 값은 불일치, % 비교), `eligibleWorkers`(pool 소속 제외, 차단 따로 집계, 승인 순), `createSelection`을 확인합니다.
- `lib-csv.test.js`: 파서의 따옴표, 겹따옴표, 줄바꿈, CRLF, BOM, 빈 줄, 모자라거나 넘치는 셀, 빈 헤더, 중복 헤더, 따옴표 문제, 그리고 example/의 CSV(BOM 파일은 정상, CP949 파일은 "not valid UTF-8"로 거절)를 확인합니다. `Download CSV template`이 쓰는 `formatCsv`가 파서로 다시 읽어 같은 행이 되는지도 봅니다.
- `lib-template.test.js`: placeholder 추출 규칙, `${}` 치환(escape 없음, `$&` 안전), TASK_DATA 주입 위치, 미리보기 스크립트 포함 여부, `window.TASK_ANSWER_SCHEMA`를 문항 목록으로 옮기는 `declaredAnswerSchema`와 그 함수가 미리보기 스크립트에 그대로 들어가는 것을 확인합니다.
- `lib-answer-fields.test.js`: Preview의 문항 목록 검사(기대 답 컬럼의 키와 값, 접두어 방식의 경고, text 문항과 자유 서술 접미어)를 확인합니다.
- `manage-iaa.test.js`: Results의 IAA 표입니다. 세 범위의 순서, κ(Landis & Koch)와 α(Krippendorff)의 해석 구간, 값이 없을 때(검수 대기만으로는 κ 를 계산할 수 없는 경우), 행의 글(값, 해석, 계산에 쓴 문항, 응답 수)을 확인합니다.
- `worker-tasks.test.js`: worker 에게 보낼 입력 컬럼(placeholder 가 있으면 그 컬럼만, 없으면 정답 컬럼을 뺀 나머지. backend 와 같은 경우), 남은 시간과 기간 글, 상태 글을 확인합니다.
- `manage-review-decisions.test.js`: Review의 검수 결정(Submitted 응답에만, 고른 값을 다시 누르면 지움, 일괄 지정과 바뀐 수, 결정별 목록과 요약 문구), HIT 묶음의 결정(같은 값, mixed, none, done), 이어진 같은 HIT 묶기와 페이지 경계에 걸린 HIT에 앞뒤 페이지의 응답을 붙이는 것을 확인합니다.
- `manage-shared.test.js`: Review가 attention 답과 자유 서술 답을 가리는 `answerKindsOf`(서버의 목록 우선, 없으면 접두어와 접미어)와 자유 서술 답을 줄이는 `freeTextPreview`를 확인합니다.
- `lib-data-check.test.js`: README의 시나리오 1~4를 example/과 data/templates의 파일로 그대로 재현합니다 (`12/12 matched`, `WARN max 70.2 KB`, `row 3, 5`, 행 크기 중앙값·최대값 문구).
- `lib-cost.test.js`, `lib-settings.test.js`: 견적과 수수료, 기본값의 MTurk 변환, Qualification, attention 규칙 두 모양, 자유 서술 접미어, 대조 기준 문구, 폼 검증 문구, agent settings.json 반영(옛 모양과 기대 답 컬럼 모양), 게시 요청 조립, Project 속성과 검수 설정의 구분(`settingsFromProperties`, `validateProperties`, `validateQuality`)을 확인합니다.
- `lib-draft.test.js`: Publish Batch의 네 단계, 저장 형식과 복원(Project 구조 이전의 저장본은 버림), 가짜 store로 CSV가 바뀔 때만 쓰는지, 저장소가 깨지거나 응답하지 않아도 오류를 던지지 않고 같은 탭에서는 메모리의 draft를 돌려주는지 확인합니다.
- `lib-project-draft.test.js`: 저장된 Project와 starter에서 편집 값을 만드는 규칙, 표본 행을 layout이 읽는 컬럼으로 줄이는 것, 저장본과의 비교, 저장 요청, Project별 임시 저장을 확인합니다.
- `elements.test.js`: `<ann-*>` 요소의 DOM 없는 부분(`core`)입니다. checklist 항목 읽기(JSON 배열, 줄 단위), 답 이름, `TASK_ANSWER_SCHEMA`의 모양, 제출할 `[{name, value}]`와 필수 문항·최소 글자 수로 막는 문구, 진행률을 확인합니다. 요소 자체의 동작은 브라우저에서 확인합니다.
- `job-groups.test.js`: 후보마다 처음 고를 모델(서버 기본 설정 먼저, 서로 다르게, 모자라면 다시 돌기), 저장해 둔 선택 되살리기, 같은 모델을 두 번 고른 경고, job 목록을 묶음과 단독 job 으로 나누는 순서, 묶음 상태(running, ready, failed)와 안내 문구, 고른 후보, 후보 이름을 확인합니다.
- `layout-lint.test.js`: Design Layout의 검사입니다. 태그와 속성 읽기, script 누락, 이름 없음·겹침, 선택지 없음, `<ann-form>` 밖의 문항, 모르는 요소, crowd 템플릿 안내를 확인합니다.
- `starters.test.js`: starter 목록과 파일이 맞는지, 모든 starter가 검사에 오류·경고 없이 통과하는지, 표본 행이 placeholder를 모두 채우는지, 미리 채우는 속성이 폼의 키인지, 그리고 `example/5-project/passage-relevance.csv`가 `Passage relevance` starter와 맞는지(attention 행의 기대 답, gold 컬럼) 확인합니다.

compose의 `frontend-test`는 이 테스트를 위해 `example/`과 `data/templates/`도 읽기 전용으로 mount합니다.
