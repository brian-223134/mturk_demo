# Project로 batch 게시하기 (production 콘솔)

production 콘솔(http://localhost:3000)의 Create는 MTurk의 Requester 화면처럼 **Project**를 만든 뒤, Project에 CSV를 올려 batch를 게시합니다.
Project는 worker에게 보일 화면(layout)과 작업 속성(제목, 보상, 인원, 기간, worker 조건)을 묶은 것입니다. 같은 Project로 batch를 여러 번 게시할 수 있습니다.
프로토타입(http://localhost:8080)의 Create는 이전과 같은 5단계 마법사이며, 그 설명은 [Create로 batch 게시하기](creating-a-batch.md)에 있습니다.

템플릿을 쓰는 요소와 속성은 [`<ann-*>` 요소로 템플릿 쓰기](annotation-elements.md)에 정리되어 있습니다.

## Create의 화면

Create 위쪽에는 MTurk와 같은 두 갈래가 있습니다.

- **`New Batch with an Existing Project`**: 저장된 Project 목록입니다. 여기서 batch를 게시합니다.
- **`New Project`**: 무엇으로 시작할지 고르는 화면입니다.

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
- **`Generate from raw data`**: 원본 데이터와 prompt로 agent job을 돌립니다 ([agent/README.md](../agent/README.md)). job이 성공하면 카드의 `Use this result`가 template.html과 settings.json을 job 이름의 Project로 저장하고(같은 이름이 있으면 덮어씁니다), hits.csv를 올린 상태로 그 Project의 Publish Batch를 엽니다. settings.json의 attention 규칙과 대조 기준 컬럼은 Project에 저장되어 `Review settings`에 미리 채워집니다.

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
