# Create로 batch 게시하기

Create의 5단계에서 고를 수 있는 것과 기본값, 다음 단계로 넘어가는 조건을 정리했습니다.
단계별 요약과 예시 파일로 따라 하는 방법은 [README의 Create: batch 게시](../README.md#create-batch-게시)와 [예시 파일로 mock 테스팅 해보기](../README.md#예시-파일로-mock-테스팅-해보기)에 있습니다.

## 다섯 단계에 공통인 것

- 위쪽의 단계 표시줄에서는 이미 지나온 단계로만 돌아갈 수 있습니다. 앞으로 가는 것은 각 단계의 `Next`로만 합니다.
- `Next`가 비활성화되어 있으면 버튼 옆에 이유가 표시됩니다 (예: `Save the template to continue.`).
- 입력한 내용은 올린 CSV까지 포함해 **브라우저에 임시로 저장됩니다.** 새로고침하거나 다른 탭에 다녀오면 `Draft restored (saved …)`와 함께 이어집니다. 서버가 아니라 브라우저에 저장되므로 다른 브라우저에서는 보이지 않습니다.
- `Start over`는 고른 템플릿, 올린 CSV, 설정을 모두 버립니다. 저장해 둔 템플릿은 지워지지 않습니다. batch를 게시하면 입력은 자동으로 비워집니다.
- 앞 단계의 조건이 깨지면 그 단계로 돌아갑니다. 예를 들어 **Reset to fixtures**로 고른 템플릿이 사라지면 `Template` 단계로 돌아갑니다.

## 1. `Template`

worker에게 보일 화면인 HTML 템플릿을 정합니다. 방법은 세 가지입니다.

- **`Use a saved template`**: 저장된 템플릿의 표에서 행을 눌러 고릅니다. 표에는 이름과 ID, placeholder, 크기, 수정한 시각이 표시됩니다. 행의 `Edit`을 누르면 그 템플릿의 HTML이 편집 화면에 열립니다.
- **`Upload or paste HTML`**: `Template name`을 입력하고, `Upload .html`로 파일을 올리거나 `Template HTML` 칸에 HTML을 붙여 넣은 뒤 `Save template`을 누릅니다. 파일은 `.html`, `.htm`, `.txt`, `.py`를 받으며 내용이 HTML이면 됩니다. 이름 칸이 비어 있으면 파일 이름으로 채워집니다.
- **`Load sample template`**: [example/1-task-data/template.html](../example/1-task-data/template.html)을 `Sentence-passage relevance (sample)`이라는 이름으로 편집 화면에 채웁니다. 같은 내용이 이미 저장되어 있으면 저장 없이 바로 선택됩니다.

저장 버튼의 이름은 상황에 따라 바뀝니다. 새 템플릿이면 `Save template`, 저장된 템플릿을 고쳤으면 `Save changes`, 고친 것이 없으면 `Use this template`입니다.

- 저장된 템플릿을 고쳐서 저장하면 그 템플릿을 덮어씁니다. 원본을 두고 싶으면 안내 상자의 `Save as a new template instead`를 누릅니다.
- 이미 게시한 batch는 게시할 때의 템플릿 사본을 따로 가지고 있으므로, 템플릿을 고쳐도 영향을 받지 않습니다.
- 같은 이름의 템플릿을 여러 개 저장할 수 있습니다. 파일 이름이 `template.html`인 파일을 연달아 올리면 이름이 모두 `template`이 되므로, 구분되는 이름으로 바꿔서 저장하는 것이 좋습니다.

### `Placeholders (N)`의 의미

템플릿의 HTML에 쓰인 **`${컬럼명}`의 서로 다른 이름이 몇 개인지**입니다. 템플릿을 저장할 때 HTML에서 찾아내며, 같은 이름이 여러 번 나와도 한 번만 셉니다.
이 목록이 곧 **이 템플릿이 CSV에 요구하는 컬럼**입니다. HIT를 만들 때 `${passage}` 자리에는 그 행의 `passage` 셀이 그대로 들어갑니다.

| 템플릿 | `Placeholders` | 설명 |
|---|---|---|
| `Chunk-Fact Relevance` | 12 | `var qid = ${qid};`처럼 셀의 내용을 JavaScript의 값으로 받습니다. 그래서 이 템플릿에 넣는 CSV의 셀은 리스트 모양의 문자열입니다. |
| `Query-Fact Coverage` | 12 | 위와 같은 12개입니다. |
| [example/2-placeholder/template.html](../example/2-placeholder/template.html) | 5 | `<p>${sentence_1}</p>`처럼 셀의 내용을 화면의 글자로 넣습니다. |
| [example/1-task-data/template.html](../example/1-task-data/template.html) | 0 | `${...}`를 쓰지 않고 `window.TASK_DATA`에서 행 전체를 읽습니다. 콘솔은 이 템플릿이 어떤 컬럼을 쓰는지 알 수 없습니다. |

- 이름에는 영문자, 숫자, 밑줄만 쓸 수 있고 숫자로 시작할 수 없습니다. `${my-column}`이나 `${column name}`은 placeholder로 인식되지 않습니다.
- 템플릿의 JavaScript에 같은 모양의 글자가 있으면 그것도 placeholder로 셉니다. 템플릿 리터럴(`` `${name}` ``)을 쓰면 `name`이 CSV에 있어야 하는 컬럼이 되므로, 템플릿 안에서는 문자열을 `+`로 이어 붙이는 편이 안전합니다.
- 셀의 내용은 가공 없이 그대로 들어갑니다. MTurk Requester 웹사이트와 같은 동작입니다.
- `window.TASK_DATA`는 placeholder가 있는 템플릿에도 항상 함께 주입됩니다.

템플릿을 고르거나 저장해서 아래에 `Selected template` 요약이 표시되면 `Next`가 활성화됩니다.

## 2. `Data`

CSV를 올립니다. 한 행이 HIT 하나가 됩니다.

- 파일을 끌어다 놓거나 영역을 눌러 고릅니다. `Load sample CSV`는 [example/1-task-data/data.csv](../example/1-task-data/data.csv)를 불러옵니다.
- 올린 뒤에 다른 파일을 놓으면 교체되고, `Remove`를 누르면 비워집니다.
- 파일은 서버로 보내지 않고 브라우저에서 읽습니다. 서버에는 게시할 때 전달됩니다.

### CSV를 읽는 규칙

- 첫 줄은 컬럼 이름이고, 빈 줄은 건너뜁니다. 셀은 모두 문자열로 읽습니다.
- 인코딩은 UTF-8이어야 합니다. UTF-8이 아닌 파일(한국어 Excel의 일반 "CSV")은 거절하고, 앞서 올린 CSV를 그대로 둡니다. 맨 앞의 BOM은 지우고 `UTF-8 (BOM removed)`로 알려 줍니다.
- 헤더가 없거나 데이터 행이 하나도 없으면 거절합니다.
- 읽기는 했지만 확인이 필요한 것은 `The file was read with warnings`에 표시됩니다: 이름이 빈 컬럼을 버린 경우, 중복된 컬럼 이름을 바꾼 경우, 셀 수가 헤더와 다른 행(모자란 셀은 빈 값으로, 넘치는 셀은 버립니다), 따옴표가 맞지 않는 경우입니다.

### `Placeholder check`

| 표시 | 상황 | 진행 |
|---|---|---|
| `ERROR` | 템플릿의 placeholder에 맞는 컬럼이 CSV에 없습니다. 치환되지 않은 `${...}`가 화면에 남아 템플릿을 망가뜨립니다. | **`Next`가 비활성화됩니다.** |
| `OK` | placeholder가 모두 맞았습니다 (`12/12 matched`). placeholder가 없는 템플릿이면 맞춰 볼 것이 없다고 표시됩니다. | 진행할 수 있습니다. |
| `WARN` 또는 `INFO` | 템플릿이 쓰지 않는 컬럼이 있습니다. HIT에는 함께 저장됩니다. `window.TASK_DATA` 방식이면 모든 컬럼이 여기에 `INFO`로 표시됩니다. | 진행할 수 있습니다. |
| `WARN` | 빈 셀이 있는 행이 있습니다. 행 번호가 표시됩니다. | 진행할 수 있습니다. |
| `INFO` 또는 `WARN` | 행 크기의 중앙값과 최대값입니다. 64 KB를 넘는 행이 있으면 `WARN`입니다. 실제 MTurk에서는 ExternalQuestion 방식으로 게시해야 한다는 뜻입니다. | 진행할 수 있습니다. |

그 아래의 `Preview`는 처음 5행입니다. 긴 셀은 잘라서 표시하고, 마우스를 올리면 더 보여 줍니다.

## 3. `Settings`

값은 다섯 구역으로 나뉩니다. 대문자로 시작하는 이름은 MTurk API의 HIT 속성과 같습니다.

### `What workers see in the HIT list`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `Title` | `Sentence and passage relevance quiz` | 필수이며 128자까지입니다. worker가 HIT 목록에서 보는 제목입니다. |
| `Description` | `Read a sentence and a passage, then assess their relevance.` | 필수입니다. |
| `Keywords` | `English, Reading, Sentence, Passage, Quiz` | 쉼표로 구분합니다. |

### `Payment and timing`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `Reward per assignment` | $0.10 | 응답 한 건의 보상입니다. 최소 $0.01입니다. |
| `MaxAssignments` | 3 | HIT 하나를 몇 명에게 맡길지입니다. 10 이상이면 수수료가 20%에서 40%로 오른다는 안내가 표시됩니다. |
| `Time allotted` | 30 minutes | worker가 응답 한 건을 끝내야 하는 시간입니다. |
| `HIT lifetime` | 30 days | HIT가 worker에게 보이는 기간입니다. 완료되지 않은 HIT를 남긴 채 이 기간이 지나면 batch가 `Expired`가 됩니다. |
| `Auto-approval delay` | 30 days | 이 기간 안에 검수하지 않은 응답은 자동으로 승인됩니다. MTurk의 상한인 30일까지 넣을 수 있습니다. |

### `Qualification requirements`

세 조건은 모두 비활성화되어 있습니다. 체크하면 옆의 값이 활성화됩니다.

| 항목 | 기본값 | 설명 |
|---|---|---|
| `HIT approval rate (%) is at least` | 95 | worker의 누적 승인율입니다. |
| `Number of approved HITs is at least` | 1000 | worker의 누적 승인 수입니다. |
| `Worker location is one of` | US | 목록에서 고르거나 두 글자 국가 코드를 직접 입력합니다. 쉼표나 공백으로 여러 개를 넣습니다. |

이 세 조건은 게시할 때 MTurk의 시스템 Qualification으로 바뀌어 batch에 저장됩니다. mock에서는 저장되고 표시될 뿐이고, 가짜 응답을 만들 때 worker를 걸러 내지는 않습니다.

### `Worker pools`

- **`Only workers in`**: 고른 pool에 속한 worker만 참여합니다. 비워 두면 조건을 만족하는 누구나 참여합니다.
- **`Exclude workers in`**: 고른 pool에 속한 worker는 참여할 수 없습니다.
- 같은 pool을 양쪽에 동시에 넣을 수는 없습니다. 한쪽에서 고른 pool은 다른 쪽에서 고를 수 없게 표시됩니다.
- pool은 Worker Pool 탭에서 만듭니다. mock의 가짜 응답도 이 조건을 따르고, 차단한 worker는 제외됩니다.

### `Attention check`

`This template has attention checks` 스위치는 **기본값이 비활성화**입니다. 활성화하면 세 항목이 나타납니다.

| 항목 | 기본값 | 설명 |
|---|---|---|
| `Answer name prefix` | `attention_` | 이름이 이 글자로 시작하는 문항을 attention 문항으로 봅니다. |
| `Expected value` | (비어 있음) | 정답으로 볼 값이며 필수입니다. 템플릿마다 다릅니다: 예시 템플릿 두 개와 `Chunk-Fact Relevance`는 `not_grounded`, `Query-Fact Coverage`는 `Not Covered`입니다. |
| `Minimum correct ratio` | 1 | 맞힌 attention 문항의 비율이 이 값 이상이면 통과입니다. 1은 전부 맞혀야 한다는 뜻입니다. |

스위치를 비활성화한 채 게시하면 Review에 attention 결과가 표시되지 않고 `Select attention-failed`도 쓸 수 없습니다. 게시한 뒤에는 규칙을 바꿀 수 없습니다.

`Next`를 누르면 값을 검사합니다. 문제가 있으면 그 항목으로 화면이 이동하고 이유가 표시됩니다.

## 4. `Preview & Cost`

### `Cost estimate`

보상 합계, 수수료, 합계와 게시한 뒤의 잔액을 보여 줍니다. 예시 파일(10행)과 기본 설정이면 다음과 같습니다.

```
Reward subtotal      10 HITs × 3 assignments × $0.10                              $3.00
MTurk fee (20%)      30 assignments × 20% of the reward (at least $0.01 each)     $0.60
Total                Held from the balance when the batch is published            $3.60
Available balance    $496.40 left after publishing                              $500.00
```

- 반려한 뒤 다시 모집하는 비용은 들어 있지 않습니다.
- 합계가 잔액을 넘으면 오류가 표시되고 `Next`가 비활성화됩니다. 보상이나 `MaxAssignments`를 낮추거나 행을 줄여야 합니다.

### `Answer fields found in this row`

아래 미리보기의 라디오 버튼, 체크박스, select에서 읽어 낸 문항의 이름과 선택지입니다.

- attention 문항은 금색으로 표시됩니다. `3 field(s), 1 of them attention checks`처럼 개수도 알려 줍니다.
- `Settings`의 attention 규칙이 템플릿과 맞지 않으면 여기서 경고합니다: 접두어로 시작하는 문항이 없을 때, 그리고 `Expected value`가 그 문항의 선택지에 없을 때입니다. 오타를 게시 전에 잡을 수 있습니다.
- 문항을 한 번에 하나씩 그리는 템플릿(저장된 템플릿 두 개)은 탭을 눌러 본 만큼만 목록에 모입니다.
- 이 목록은 mock에서 가짜 응답을 만들 때 쓰입니다. 비어 있어도 게시할 수 있습니다.

### `Task preview`

고른 행의 데이터로 worker가 보게 될 화면을 그대로 보여 줍니다. `Prev row`, `Next row`나 행 번호로 다른 행을 볼 수 있습니다.

- 화면은 격리된 iframe 안에서 실행됩니다. Submit을 누르면 제출을 가로채서 `Submit intercepted: 3 answer(s). Nothing was sent to MTurk.`와 제출되었을 응답을 보여 줍니다.
- 템플릿이 스스로 제출을 막은 경우(답하지 않은 문항이 있을 때 등)에는 아무것도 표시되지 않습니다.
- 저장된 템플릿 두 개는 `assets.crowd.aws`의 스크립트를 불러오므로 인터넷 연결이 필요합니다.

## 5. `Publish`

- **`Batch name`**은 `<템플릿 이름> <오늘 날짜>`로 채워져 있고 고칠 수 있습니다. Manage 목록에 표시되는 이름이며 worker에게는 보이지 않습니다.
- 요약 표에서 환경(`MOCK`), 템플릿, 데이터(행 수 = HIT 수), 설정, Qualification, pool 조건, attention 규칙, 합계 비용을 확인합니다.
- 게시 버튼의 이름은 `Publish 10 HITs`처럼 HIT 수가 들어갑니다. 이름이 비어 있거나 합계가 잔액을 넘으면 게시할 수 없습니다.
- production 환경에서는 batch 이름을 한 번 더 입력해야 버튼이 활성화됩니다. mock에서는 이 입력란이 나타나지 않습니다.

게시하면 서버가 값을 다시 검사합니다: 템플릿이 요구하는 컬럼, `Title`, `MaxAssignments`, 기간, 자동 승인 30일 상한, 최소 보상, pool이 실제로 있는지, 잔액입니다.
문제가 있으면 `Could not publish the batch` 알림에 이유가 표시되고 입력은 그대로 남습니다.

게시가 끝나면 행마다 HIT가 하나씩 만들어지고, 합계 금액이 `Balance`에서 미리 차감되며, 새 batch의 Overview로 이동합니다.

## 게시한 뒤

새 batch에는 응답이 없습니다. **Mock tools → Generate fake submissions…**로 검수 대기 응답을 만들면 Manage의 Review에서 검수를 이어 갈 수 있습니다.
Manage 화면의 값을 읽는 방법은 [콘솔의 값 읽기](reading-the-console.md)에 있습니다.
