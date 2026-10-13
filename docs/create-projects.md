# Project로 batch 게시하기 (production 콘솔)

production 콘솔(http://localhost:3000)의 Create는 MTurk의 Requester 화면처럼 **Project**를 만든 뒤, Project에 CSV를 올려 batch를 게시합니다.
Project는 worker에게 보일 화면(layout)과 작업 속성(제목, 보상, 인원, 기간, worker 조건)을 묶은 것입니다. 같은 Project로 batch를 여러 번 게시할 수 있습니다.
프로토타입(http://localhost:8080)의 Create는 이전과 같은 5단계 마법사이며, 그 설명은 [Create로 batch 게시하기](creating-a-batch.md)에 있습니다.

템플릿을 쓰는 요소와 속성은 [`<ann-*>` 요소로 템플릿 쓰기](annotation-elements.md)에 정리되어 있습니다.

## Create의 화면: Project와 batch

Create 위쪽에는 MTurk와 같은 두 갈래가 있습니다. 둘의 차이는 **무엇을 만드느냐**입니다.
그 옆의 `Tutorial` 탭(`/create/tutorial`)은 이 문서의 내용을 따라 하기 순서로 줄인 한국어 안내이며, 단계마다 그 화면으로 바로 가는 버튼이 있습니다.

| | `New Project` | `New Batch with an Existing Project` |
|---|---|---|
| 만드는 것 | **Project**: 어떤 작업인지 정한 틀 | **batch**: 그 틀에 실제 데이터를 넣어 worker에게 내보낸 한 번의 게시 |
| 담는 것 | worker가 보는 화면(layout), 제목·설명, 보상, HIT당 응답 수, 기간, worker 조건, 검수 설정의 기본값, 미리보기용 표본 값 | CSV(한 행 = HIT 하나), 이번 게시의 검수 설정(attention, 자유 서술, 대조 기준), batch 이름 |
| 하는 일 | 갤러리에서 시작 방법을 고르고 Enter Properties, Design Layout, Preview and Finish로 만듭니다 | Project 목록에서 `Publish Batch`를 눌러 CSV를 올리고 게시합니다. Project를 고치거나(`Edit`) 복사·삭제도 여기서 합니다 |
| 횟수 | 작업 종류마다 한 번 | 같은 Project로 여러 번 (예: 파일럿 20개, 본 실험 400개) |
| 결과 | 저장된 Project. 아직 worker에게는 아무것도 나가지 않습니다 | Manage에 나타나는 batch와 HIT. 비용이 잔액에서 빠집니다 |

예를 들어 "passage가 fact를 지지하는지 판정하는 작업"은 Project 하나입니다. 그 Project로 이번 주 CSV를 올리면 batch 하나가 생기고, 다음 주에 다른 CSV를 올리면 batch가 하나 더 생깁니다.
Project를 고쳐도 이미 게시한 batch는 게시할 때의 layout 사본을 갖고 있어서 바뀌지 않습니다.

**원본 데이터에서 자동으로 만들 때**(`New Project` → `Generate from raw data`)는 두 단계가 이어집니다.

1. 모델만 다른 agent **job** 세 개(후보 A, B, C)가 동시에 돌며, 후보마다 layout(`template.html`), HIT CSV(`hits.csv`), 설정(`settings.json`)을 만듭니다. 후보는 Project가 아니며, `Generate from raw data`의 `Templates` 목록에만 있습니다.
2. 후보를 나란히 비교하고 `Choose this template`으로 하나를 고르면, 그 후보의 layout과 설정이 **Project**로 저장되고 CSV를 올린 **Publish Batch**가 열립니다. 그 뒤로는 일반 Project와 같습니다.

그래서 화면에 미리보기가 세 군데 있고, 보는 것이 다릅니다.

| 어디서 | 화면 | 보는 것 |
|---|---|---|
| 후보 묶음의 `Compare and choose` | New Project → Generate from raw data → `Templates` 목록 | 후보마다 LLM에 준 prompt, LLM이 쓴 명세(`Task spec`), HIT 한 행의 worker 화면, 평가 메모. 나란히 비교하고 Project로 쓸 후보를 고릅니다 |
| Project 편집기의 `Preview and Finish` | 목록의 `Edit` → 세 번째 탭 | Project의 속성 요약과, 표본 값으로 그린 worker 화면 |
| Publish Batch의 `Preview tasks` | 목록의 `Publish Batch` → 두 번째 단계 | 올린 CSV의 행을 하나씩 넣은 실제 worker 화면 |

자동 생성 결과로 만든 Project에는 후보 비교 화면이 없습니다. 그 Project의 명세와 prompt를 다시 보려면 Generate from raw data의 `Templates` 목록에서 같은 이름의 묶음을 찾습니다. 고른 후보에는 `Chosen`이 표시되어 있습니다.

## Project 목록

Project마다 이름, layout의 종류, worker에게 보일 제목, 보상, HIT당 응답 수, layout이 읽는 CSV 컬럼, 마지막 수정 시각이 보입니다.
layout의 종류는 `Elements`(`<ann-*>` 요소), `crowd-html`(MTurk의 crowd-html-elements를 외부에서 불러오는 템플릿), `HTML`(그 밖의 HTML) 중 하나로 표시됩니다.

행마다 버튼이 네 개 있습니다.

- `Publish Batch`: 이 Project에 CSV를 올려 batch를 게시합니다.
- `Edit`: Project 편집기를 엽니다.
- `Copy`: 이름 뒤에 `(copy)`를 붙인 사본을 만들고 그 편집기를 엽니다.
- `Delete`: Project를 지웁니다. 이미 게시한 batch는 게시할 때의 layout 사본을 따로 가지고 있으므로 영향을 받지 않습니다.

게시하다 만 batch가 있으면 목록 위에 `Continue publishing`이 표시됩니다.
시작 데이터의 두 템플릿(`Chunk-Fact Relevance`, `Query-Fact Coverage`)도 Project로 보입니다. 속성이 저장되어 있지 않으므로 제목 칸에 `Not set (defaults are used)`가 표시되고, 편집기를 열면 기본값이 채워져 있습니다.

## New Project

왼쪽에서 시작할 것을 고르면 오른쪽에 설명과 실제 미리보기가 나옵니다. 미리보기는 표본 데이터로 그린 worker 화면 그대로이며, `Submit`을 누르면 제출되었을 답을 보여 줍니다.
`Create Project`를 누르면 그 내용으로 새 Project 편집기가 열립니다.

starter 템플릿은 아홉 가지입니다. 모두 `<ann-*>` 요소로 쓴 수십 줄짜리 HTML입니다.

| 분류 | 이름 | CSV 컬럼 | 답 |
|---|---|---|---|
| Retrieval & grounding | `Passage relevance` | `query`, `passage` | `relevance`: relevant, partially_relevant, not_relevant |
| | `Statement support (checklist)` | `passage`, `facts`(JSON 배열) | 항목마다 `supported_<n>`: supported, not_supported |
| | `Several passages per HIT (tabs)` | `query`, `passage_1`~`passage_3` | 탭마다 `relevance_<n>`: relevant, not_relevant |
| Text | `Text classification` | `text` | `sentiment`: positive, negative, mixed, neutral |
| | `Multi-label tagging` | `text` | 태그마다 `topic_<태그>`: yes, no |
| | `Answer rating (scale)` | `question`, `answer` | `helpfulness`: 1~5, `comment`: 자유 서술(선택) |
| | `Pairwise comparison` | `prompt`, `response_a`, `response_b` | `preference`: a, b, same, `reason`: 자유 서술 |
| | `Free-text writing` | `passage` | `summary`: 자유 서술(30자 이상) |
| Other | `Blank layout` | `text` | `answer`: yes, no |

그 밖의 시작 방법이 두 가지 있습니다.

- **`Upload or paste HTML`**: 빈 layout으로 시작해 Design Layout에서 파일을 올리거나 HTML을 붙여 넣습니다. `${컬럼명}`이나 `window.TASK_DATA`를 쓰는 기존 템플릿, `<crowd-form>`을 쓰는 MTurk 템플릿도 그대로 동작합니다.
- **`Generate from raw data`**: 원본 데이터와 prompt로 agent가 layout과 HIT CSV를 만듭니다. 아래 [원본 데이터에서 자동으로 만들기](#원본-데이터에서-자동으로-만들기)에 정리되어 있습니다.

## 원본 데이터에서 자동으로 만들기

`New Project` → `Generate from raw data`는 원본 데이터(JSON, JSONL, CSV)와 "무엇을 판정하게 할지" 적은 prompt로 agent job을 돌립니다. `Generate`를 누르면 같은 원본과 prompt로 모델만 바꾼 후보 세 개가 동시에 돌고, 끝나면 비교해서 하나를 고릅니다.
job은 원본의 구조를 분석하고(`profile`), LLM이 작업 명세 `task_spec.json`을 쓰고(`plan`), 코드가 그 명세대로 데이터를 HIT로 자르고(`preprocess`), 템플릿을 그리고(`render`), 결과를 검사합니다(`validate`).
LLM이 쓰는 것은 명세 하나뿐이고, 데이터와 HTML은 코드가 만듭니다. 그래서 같은 명세로 다시 돌리면 결과가 똑같이 나옵니다. 파이프라인과 출력 파일은 [agent/README.md](../agent/README.md)에 있습니다.

### 입력

| 항목 | 설명 |
|---|---|
| `Name` | 후보 세 개가 함께 쓰는 이름입니다. 후보를 고르면 이 이름으로 Project가 저장되고, 같은 이름의 Project가 있으면 덮어씁니다. 시도마다 다른 이름을 씁니다. |
| `Raw data` | 원본 파일입니다. 구조를 미리 알려 줄 필요는 없습니다. |
| `Prompt text` | 무엇을 판정하게 할지 적습니다. 파일에 써 둔 prompt는 본문을 붙여 넣습니다. "chunk 하나를 보여주고 atomic fact 중 그 chunk가 지지하는 걸 전부 고르게 하자. BM25 top-10, HIT 20개" 같은 한 문장도 되고, 절을 나눈 markdown도 됩니다 ([prompt 쓰기](../agent/README.md#prompt-쓰기)). |
| `Models for the candidates` | 후보 A, B, C가 명세를 쓰게 할 모델 설정(`environment/models/`)입니다. 처음에는 서로 다른 세 개(`default`, 그다음 목록 순서)가 골라져 있습니다. 모든 설정이 temperature 0이라 같은 모델을 두 번 고르면 거의 같은 후보가 나오므로, 그렇게 고르면 화면이 알려 줍니다. |
| `Allow API calls (uses credits)` | LLM이 명세를 쓰게 하려면 실행할 때마다 체크합니다. 유료 호출이므로 서버 스위치도 켜져 있어야 하며, 그렇지 않으면 체크할 수 없습니다. 서버 스위치는 `environment/.env`에 `AGENT_ALLOW_API=1`을 적고 `docker compose restart backend`로 켭니다. |
| `Optional task spec · offline replay` | `task_spec.json`을 올리면 LLM 없이 그 명세로 돌립니다(`plan` 단계는 `skipped`). 모델이 쓰이지 않으므로 후보 없이 job 하나만 만들어집니다. `Reuse the saved task spec`은 `Reuse inputs`로 불러온 job의 명세를 그대로 씁니다. |
| `Example prompts` | 합성 예시 데이터와 예시 prompt 네 가지를 채웁니다 ([prompt 비교 실험](prompt-experiments.md)). |

### Templates 목록

`Generate 3 candidates`를 누르면 아래 `Templates` 목록에 후보 세 개를 묶은 카드가 생깁니다. 후보마다 칸이 하나씩 있고, 단계 다섯 개의 진행 상황, 모델, 걸린 시간이 표시됩니다. 셋이 함께 돌기 때문에 기다리는 시간은 가장 늦은 후보만큼입니다. 모두 끝나면 화면 오른쪽 위에 알림이 뜨고, 후보 칸에 HIT 수, 항목 수, attention 항목 수, LLM 비용이 보입니다. 실패한 후보는 이유가 함께 표시됩니다.

후보 칸의 `Details`를 펼치면 다음이 보입니다.

- `Summary`: 쓴 레코드 수, 항목 수, HIT 수, HIT당 항목 수, attention 항목 수, 정답 라벨의 분포
- `Validation`: 구조 검사 결과 (`OK`면 게시할 수 있는 형태입니다. 문구나 라벨 대응이 원하는 대로인지는 사람이 봐야 합니다)
- `LLM usage`: 호출 수, 토큰, 비용
- `Files`: `task_spec.json`, `template.html`, `hits.csv`, `settings.json`, LLM에 보낸 요청과 받은 응답 등. 눌러서 내려받을 수 있습니다.
- `Planner notes`: LLM이 명세를 그렇게 짠 이유

묶음 카드의 버튼은 두 가지입니다.

- `Compare and choose`: 모든 후보가 끝나고 하나 이상 성공하면 누를 수 있습니다. 성공한 후보만 나란히 여는 비교 창에서 결과 요약표와 함께 후보마다 `Requester prompt`, `Task spec`, HIT 한 행을 worker 화면으로 그린 미리보기를 보고, 평가 메모를 남길 수 있습니다. 공통 항목이 있으면 같은 항목을 모든 후보에서 함께 봅니다. 후보는 일부러 모델만 바꾼 것이므로 모델 차이는 경고하지 않고, 샘플링이나 HIT 구성이 다를 때만 알립니다.
- `Reuse inputs`: 묶음의 원본과 prompt를 입력 칸에 다시 채웁니다. 원본은 서버에 남아 있으므로 다시 올리지 않아도 됩니다.

비교 창에서 마음에 드는 후보의 `Choose this template`을 누르면 그 후보를 고른 것으로 기록하고, 그 후보의 결과로 Project를 저장한 뒤 hits.csv를 올린 상태로 Publish Batch를 엽니다. 이후는 [Publish Batch](#publish-batch)와 같습니다. settings.json의 attention 규칙과 대조 기준 컬럼은 `Review settings`에 미리 채워집니다. 고른 후보에는 `Chosen`이 표시되며, 다시 비교 창을 열어 다른 후보를 고르면 같은 이름의 Project를 덮어씁니다.

task spec으로 돌린 job은 후보 없이 job 카드 하나로 보이고, 카드에서 `Preview & evaluate`(결과 보기와 평가)와 `Use this result`(Project 저장과 Publish Batch)를 씁니다. 후보 묶음이 생기기 전에 만든 job도 같은 모양입니다.
서로 다른 실행의 결과를 함께 보고 싶으면 후보 칸이나 job 카드의 `Compare`를 2~3개 체크하고 목록 위쪽의 `Compare selected`를 누릅니다.

### 명세를 고쳐 다시 만들기

LLM이 요청과 다르게 명세를 쓰면, 명세를 고쳐 LLM 없이 다시 만듭니다. 비용이 들지 않고 몇 초면 끝납니다.

1. 후보 칸의 `Details` → `Files`에서 `task_spec.json`을 내려받아 고칩니다.
2. 묶음 카드의 `Reuse inputs`를 누르고 `Name`을 새 이름으로 바꿉니다.
3. `Optional task spec · offline replay`의 `Task spec`에 고친 파일을 올리고, `Allow API calls`는 끈 채로 `Generate`를 누릅니다. job 하나가 만들어지고, 그 카드의 `Use this result`로 Project를 만듭니다.

예를 들어 "BM25 top-10, HIT 20개"라고 요청했을 때 LLM이 레코드 20개를 고른 뒤 레코드마다 passage 10개를 5개씩 두 HIT로 나눠(`"items_per_hit": 5`) HIT가 40개가 된 적이 있습니다.
`hit.items_per_hit`만 10으로 고쳐 다시 만들면, 같은 항목 200개와 같은 정답 라벨로 HIT 20개가 됩니다.

### 걸리는 시간과 실패

실제 RAG 평가 원본(레코드 400개, 약 28MB)에 한 문장 prompt와 `default` 모델로 돌렸을 때, 성공한 job은 140초 동안 호출 3번에 $0.0036이 들었습니다. 명세가 검사에 걸리면 오류를 LLM에 돌려주고 다시 묻기 때문에 호출이 여러 번이 됩니다.
후보 세 개는 각자 LLM을 부르므로 비용은 후보 수만큼 들고, 시간은 가장 늦은 후보만큼 걸립니다.
LLM 호출은 실패할 수 있습니다. 같은 입력의 다른 시도는 응답이 공백으로 채워져 출력 상한에 닿아 217초 뒤에 실패했습니다($0.0083). 실패한 후보도 칸에 이유와 비용이 남고, 나머지 후보가 성공했으면 그 후보들로 비교하고 고를 수 있습니다.
모두 실패하면 같은 입력으로 다시 돌리거나 다른 모델을 고릅니다. 발표처럼 결과가 꼭 필요한 자리에서는 미리 만들어 둔 결과를 씁니다.

### Templates 목록 관리

후보 하나하나가 job이며, 입력과 결과는 `output/jobs/<job id>/`(gitignore)에 저장됩니다. 묶음은 각 job의 `job.json`에 적힌 `group`으로 다시 묶이므로 따로 저장하는 파일이 없습니다. backend는 시작할 때 이 폴더를 읽어 목록을 만듭니다. 화면에는 지우는 버튼이 없습니다.
목록에서 빼려면 job 폴더를 `output/jobs/` 밖(예: `output/jobs-archive/`)으로 옮기고 `docker compose restart backend`를 실행합니다. 묶음 전체를 빼려면 그 묶음의 job 폴더 세 개를 함께 옮깁니다. 다시 보이게 하려면 폴더를 되돌리고 같은 명령을 실행합니다.
backend는 job을 기본으로 세 개까지 동시에 돌립니다. 이 수는 `environment/.env`의 `AGENT_JOB_WORKERS`로 바꿀 수 있으며, 3보다 작게 하면 후보가 차례를 기다립니다.

## Project 편집기

위쪽의 탭 세 개를 자유롭게 오갈 수 있습니다. 저장하지 않은 편집은 Project마다 브라우저에 임시 저장되므로, 새로고침하거나 다른 화면에 다녀와도 이어서 고칠 수 있습니다.
오른쪽 위에 `Not saved yet`, `Unsaved changes`, `Saved …` 중 하나가 표시되고, `Save`로 언제든 저장합니다. 저장된 Project를 고치던 중이면 `Discard changes`로 저장본으로 되돌릴 수 있습니다.
저장할 때 이름, 속성, layout을 검사하며, 문제가 있으면 그 탭으로 이동해 알려 줍니다.

### 1. `Enter Properties`

| 묶음 | 항목 |
|---|---|
| (맨 위) | `Project name`: 목록에서 구별하기 위한 이름입니다. worker에게는 보이지 않습니다. |
| `Describe your task to workers` | `Title`, `Description`, `Keywords`: worker가 작업 목록에서 보는 설명입니다. |
| `Setting up your task` | `Reward per assignment`, `Number of assignments per task`(HIT당 응답 수), `Time allotted per assignment`(분), `Task expires in`(일), `Auto-approve and pay workers in`(일, 최대 30일). 아래에 HIT 하나의 비용이 계산되어 보입니다. |
| `Worker requirements` | 승인율, 승인된 HIT 수, 국가 조건과, 참여시키거나 제외할 worker pool입니다. |

### 2. `Design Layout`

왼쪽은 layout의 HTML 편집기, 오른쪽은 worker 화면 미리보기입니다. 입력을 멈추면 미리보기가 다시 그려집니다.

- `Insert element…`: 커서 자리에 `<ann-*>` 요소의 예시를 넣습니다. `Insert script tag`는 요소를 불러오는 `<script>` 줄을 맨 위에 넣습니다.
- `Upload .html`: 파일 내용으로 layout을 바꿉니다 (`.html`, `.htm`, `.txt`, `.py`).
- `Element reference`: 요소와 속성의 요약입니다.
- `Checks`: layout을 저장하기 전에 알 수 있는 문제를 보여 줍니다. 오류(`ERROR`)가 있으면 저장할 수 없습니다. 요소를 불러오는 `<script>`가 없는 경우, 문항에 `name`이 없거나 겹치는 경우, 선택지가 없는 경우, 문항이 `<ann-form>` 밖에 있는 경우가 오류입니다. 모르는 `<ann-…>` 요소는 경고(`WARN`), crowd-html-elements를 외부에서 불러오는 템플릿은 안내(`INFO`)로 표시됩니다.
- `Variables`: layout이 읽는 `${컬럼}`마다 미리보기에 넣을 표본 값을 적습니다. 표본 값은 Project와 함께 저장되며, 게시할 때는 CSV의 값이 들어갑니다. 비워 둔 변수는 미리보기에 `${컬럼}` 그대로 보입니다.
- `Answer fields`: 미리보기가 보고한 답 칸 목록입니다. 이름과 종류(choice, scale, checkbox, text), 필수 여부가 보입니다.

### 3. `Preview and Finish`

Project의 요약, 표본 값으로 그린 worker 화면 전체, 답 칸 목록이 나옵니다.

- `Download CSV template`: layout이 읽는 컬럼을 머리줄로, 표본 값을 첫 행으로 둔 CSV를 내려받습니다. 이 형식대로 행을 늘려 Publish Batch에 올립니다.
- `Finish`: 저장하고 Project 목록으로 갑니다.
- `Finish and publish a batch`: 저장하고 바로 그 Project의 Publish Batch를 엽니다.

## Publish Batch

Project의 `Publish Batch`를 누르면 네 단계로 게시합니다. 보상, 인원, 기간, worker 조건은 Project의 속성을 그대로 쓰며, 바꾸려면 위쪽의 `Edit project`로 Project를 고칩니다.
입력은 올린 CSV까지 브라우저에 임시 저장됩니다. 한 번에 하나만 저장되므로, 다른 Project의 Publish Batch를 열면 이전 것은 바뀝니다. `Start over`는 CSV와 검수 설정을 버립니다.

| 단계 | 내용 |
|---|---|
| 1. `Upload CSV` | CSV를 올리면 layout이 읽는 컬럼이 모두 있는지 검사합니다. 빠진 컬럼이 있으면 다음으로 갈 수 없습니다. `Download CSV template`으로 양식을 받을 수 있고, `Use the sample row`는 Project의 표본 값으로 HIT 1개짜리 데이터를 만듭니다. |
| 2. `Preview tasks` | CSV의 행을 하나씩 골라 worker 화면을 그대로 미리 봅니다. 답 칸 목록은 batch의 `answerSchema`로 저장됩니다. |
| 3. `Review settings` | attention 규칙, 자유 서술 답, Review의 대조 기준을 정합니다. CSV의 컬럼에 달린 설정이라 batch마다 정하며, 처음 값은 Project에 저장된 값입니다. layout에 자유 서술 문항(`ann-textarea`)이 있으면 그 이름이 자유 서술 답으로 미리 채워집니다. |
| 4. `Confirm and publish` | 비용 견적(보상 + 수수료)과 잔액, 전체 요약을 확인하고 batch 이름을 정해 게시합니다. 게시가 끝나면 그 batch의 Overview로 갑니다. |

Overview의 `Project` 칸에서 batch를 게시한 Project의 편집기로 갈 수 있습니다.

## 따라 하기: starter로 attention check가 있는 batch 게시하기

1. `New Project`에서 `Passage relevance`를 고르고 `Create Project`를 누릅니다.
2. `Enter Properties`에는 starter의 값이 채워져 있습니다 (`Reward per assignment` $0.05, `Number of assignments per task` 3). 비용 줄에 `$0.18`이 보입니다.
3. `Design Layout`에서 문항을 바꾸거나 `Insert element…`로 `<ann-textarea>`를 `</ann-form>` 앞에 넣어 봅니다. 미리보기와 `Answer fields`가 함께 바뀝니다.
4. `Preview and Finish`에서 `Finish and publish a batch`를 누릅니다.
5. `Upload CSV`에 [example/5-project/passage-relevance.csv](../example/5-project/passage-relevance.csv)를 올립니다. `2/2 matched`가 표시되고, 쓰이지 않는 컬럼 `gold`, `attention_expected`와 빈 셀이 있는 6행이 경고로 보입니다. 빈 셀은 attention 행이 아닌 행의 `attention_expected`이므로 정상입니다.
6. `Preview tasks`에서 행을 넘겨 봅니다. 5행과 8행이 질문과 상관없는 passage를 붙인 attention 행입니다.
7. `Review settings`에서 `Attention check`를 켜고 `Expected answers column`, `attention_expected`를 고릅니다. `Compare answers with`에서는 `Input column: gold`를 고릅니다.
8. `Confirm and publish`에서 비용이 `8 HITs × 3 assignments × $0.05` = $1.20, 수수료 $0.24, 합계 $1.44인 것을 확인하고 게시합니다.

## 서버에 저장되는 모양

서버에는 Project가 템플릿 레코드 하나로 저장됩니다 (`POST /api/templates`). REST 경로는 이전과 같고, 레코드에 선택 필드 두 개가 더해졌습니다.

- `properties`: Enter Properties와 검수 설정의 폼 값입니다. 서버는 객체인지만 확인하며, batch를 게시할 때 `POST /api/batches`가 값을 다시 검사합니다.
- `sampleRow`: Design Layout 미리보기의 표본 값 `{컬럼: 문자열}`입니다.

두 필드 모두 64KB를 넘을 수 없습니다. 기존 템플릿을 고칠 때 필드를 보내지 않으면 저장된 값이 유지되고, `null`을 보내면 지워집니다.
프로토타입의 mock API는 이 두 필드를 저장하지 않습니다.
