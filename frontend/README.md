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
   ├─ router.js            history API 라우터. /create, /manage, /manage/:batchId(/:tab), /workers. / 는 /create 로 보냅니다
   ├─ router-match.js      경로 패턴 → 정규식(compilePattern), 경로에 맞는 route 찾기(matchRoute). DOM 을 쓰지 않아 Node 에서 테스트합니다
   ├─ styles.css           밝은 테마. 배지 색은 mock 회색, sandbox 파랑, production 빨강
   ├─ api-client/          (api/ 가 아닌 이유: /api/ 는 nginx 가 backend 로 넘기는 경로라 정적 파일과 겹칩니다)
   │  ├─ routes.js         REST 경로 표(API_ROUTES)와 agent job 경로(AGENT_ROUTES), 요청 인코딩(encodeRequest)
   │  └─ client.js         call(routeName, args), api.<route>(…), ApiError { code, message, status }, createJob, fileUrl
   ├─ components/
   │  ├─ dom.js            el() 도우미와 escapeHtml. 데이터는 항상 textContent 로 넣습니다
   │  ├─ layout.js         제목 줄(환경 배지, 잔액), 세 탭, 오류 띠
   │  ├─ table.js          표와 페이지 이동 버튼
   │  ├─ format.js         금액($0.00), 비율(%), 시각(YYYY-MM-DD HH:mm), 기간, 경과 시간
   │  ├─ badges.js         환경 배지, 상태 태그, attention 판정, job 과 step 의 상태 칩
   │  ├─ notice.js         안내 상자. API 오류를 code 별 제목으로 보여 줍니다
   │  └─ stackedBar.js     구성비 막대와 범례
   └─ pages/
      ├─ create.js         Generate from raw data(agent job 폼, job 목록과 카드), Saved templates
      ├─ manage.js         batch 목록
      ├─ batch.js          batch 상세. Overview 와 Review / HITs / Results 탭
      └─ workers.js        worker 목록과 pool 목록
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

- **Create**: `Generate from raw data` 폼(원본 파일, prompt 파일 또는 텍스트, 선택한 task_spec.json, 모델 설정, OpenRouter 허용 여부, 이름)으로 agent job을 만들고, job 목록에서 단계별 상태, 경과 시간, 로그 끝부분, planner 메모, 요약 수치, 검증 결과, 토큰 사용량과 비용, 결과 파일 링크를 봅니다. 진행 중인 job은 2초마다 다시 받습니다. 아래에는 저장된 템플릿 목록(이름, placeholder, 수정 시각)이 있습니다.
- **Manage**: batch 목록(이름, 환경, 생성 시각, 완료 HIT / 전체, Submitted / Approved / Rejected, 반려율, 지출 / 예상 비용, 상태)과 batch 상세입니다. 상세의 `Overview`는 진행률, 응답 현황, 비용, 설정(제목, 보상, MaxAssignments, 제한 시간, attention 규칙, 대조 기준, 자격 조건, pool)을 보여 주고, `Review`, `HITs`, `Results` 탭은 각 경로를 불러 표를 그립니다.
- **Worker Pool**: worker 목록(제출, 승인, 반려, 반려율, attention 실패율, 작업 시간 중앙값, 일치율, batch 수, pool, 마지막 활동일)과 pool 목록입니다.

숫자의 뜻은 [콘솔의 값 읽기](../docs/reading-the-console.md)에 정리되어 있습니다.

## 이 단계에서 되는 것과 안 되는 것

이 단계의 backend는 `health`, `listTemplates`, `getTemplate`, `listBatches`, `getBatch`, `getAccount`와 agent job API만 실제로 구현하고, 나머지 경로는 501 `NOT_IMPLEMENTED`로 답합니다. 그래서 backend에 붙이면 Manage 목록과 Overview, Create의 Generate와 템플릿 목록은 동작하고, Review / HITs / Results 탭과 Worker Pool 화면에는 "Not implemented in the backend yet" 안내가 보입니다. 프로토타입의 mock API에 붙이면 반대로 콘솔 화면은 모두 동작하고 Generate 패널만 잠깁니다.

아직 없는 것은 다음과 같습니다. batch 게시 마법사(템플릿 편집, CSV 검사, 미리보기), 검수(승인, 반려, 재모집), 만료와 export, worker 선택과 pool 편집, 차단, worker 상세입니다. 화면의 해당 자리에 "come in a later phase"로 표시해 두었습니다.

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
