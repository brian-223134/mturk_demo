# `<ann-*>` 요소로 템플릿 쓰기

production 콘솔(http://localhost:3000)의 템플릿은 `<ann-*>` 요소로 짧게 쓸 수 있습니다.
MTurk가 `<crowd-form>`, `<crowd-classifier>` 같은 crowd-html-elements를 제공하던 자리를 이 콘솔이 직접 맡은 것입니다.
요소가 문항을 그리고, 필수 문항을 검사하고, 답을 Review가 읽는 형식으로 모아 제출합니다. 그래서 템플릿에는 안내문, 보여 줄 값, 문항만 적으면 됩니다.

요소는 콘솔의 frontend가 `/elements/ann-elements.js`로 제공합니다. 외부 CDN에 의존하지 않습니다.
Create의 New Project에서 고르는 starter 템플릿 9종이 모두 이 요소로 쓰여 있으므로, 그대로 고쳐 쓰는 것이 가장 빠릅니다 ([frontend/src/elements/starters/](../frontend/src/elements/starters/)).

## 가장 짧은 예

```html
<script src="/elements/ann-elements.js"></script>

<ann-form>
  <ann-instructions>
    <p>Read the query and the passage. Decide whether the passage helps answer the query.</p>
  </ann-instructions>

  <ann-text label="Query">${query}</ann-text>
  <ann-text label="Passage">${passage}</ann-text>

  <ann-choice name="relevance" header="Does the passage help answer the query?" required>
    <ann-option value="relevant">Relevant</ann-option>
    <ann-option value="not_relevant">Not relevant</ann-option>
  </ann-choice>
</ann-form>
```

- 맨 위의 `<script>` 한 줄이 요소를 불러옵니다. 빠지면 Design Layout의 Checks가 오류로 알려 줍니다.
- `${query}`, `${passage}`는 batch를 게시할 때 CSV의 같은 이름 컬럼 값으로 바뀝니다. 바꿀 때 escape하지 않으므로 값에 든 HTML은 그대로 그려집니다.
- 문항은 모두 `<ann-form>` 안에 둡니다. 폼이 맨 아래에 진행 상황과 `Submit` 버튼을 붙입니다.
- 이 템플릿의 답은 `relevance` 하나이며, 값은 `relevant` 또는 `not_relevant`입니다.

## 요소

### `ann-form`

모든 문항을 감싸는 제출 폼입니다. 문항을 바꿀 때마다 `2 of 3 required answers done.`처럼 진행 상황을 보여 줍니다.
`Submit`을 누르면 필수 문항을 검사하고, 답하지 않은 문항을 빨간 테두리로 표시한 뒤 첫 문항으로 이동합니다. 숨은 탭에 있는 문항이면 그 탭을 엽니다.

| 속성 | 설명 |
|---|---|
| `submit-label` | Submit 버튼의 글자입니다 (기본 `Submit`). |

### `ann-instructions`

worker가 접고 펼 수 있는 안내 패널입니다. 안에는 어떤 HTML이든 씁니다.

| 속성 | 설명 |
|---|---|
| `header` | 패널 제목입니다 (기본 `Instructions`). |
| `collapsed` | 접힌 채로 시작합니다. |

### `ann-text`

CSV의 값을 보여 주는 카드입니다. 값에 든 줄바꿈은 그대로 보입니다.

| 속성 | 설명 |
|---|---|
| `label` | 카드 위의 작은 제목입니다. |

### `ann-choice`

선택지 중 하나를 고르는 문항입니다(라디오 버튼). 답 이름은 `name`, 값은 고른 선택지의 `value`입니다.
선택지는 `<ann-option value="…">화면 글자</ann-option>`로 적습니다. 값과 화면 글자가 같으면 `options="yes, no"`로 줄여 쓸 수 있습니다.
`<ann-option>`이 아닌 내용을 안에 적으면 문항 제목 아래의 설명으로 보입니다.

| 속성 | 설명 |
|---|---|
| `name` | 답 이름입니다. 반드시 적어야 하고, 템플릿 안에서 겹치면 안 됩니다. |
| `header` | 문항입니다. |
| `required` | 답해야 제출할 수 있습니다. |
| `options` | 선택지를 쉼표로 나눠 적는 짧은 형식입니다. |
| `layout` | `horizontal`이면 선택지를 한 줄에 놓습니다. |

### `ann-likert`

`min`부터 `max`까지의 점수 하나를 고르는 문항입니다. 값은 숫자를 글자로 쓴 것입니다(`"1"` … `"5"`).

| 속성 | 설명 |
|---|---|
| `name`, `header`, `required` | `ann-choice`와 같습니다. |
| `min`, `max` | 점수 범위입니다 (기본 1~5). |
| `min-label`, `max-label` | 양 끝에 붙는 말입니다. |

### `ann-checklist`

여러 항목 중 해당하는 것을 모두 체크하는 문항입니다. 맨 아래에 "해당 없음" 칸이 붙으며, 그 칸과 다른 칸은 함께 체크할 수 없습니다.
**답은 항목마다 하나씩** 나옵니다. 이름은 `<name>_<key>`이고, 값은 체크했으면 `checked-value`, 아니면 `unchecked-value`입니다.
그래서 항목별로 κ와 majority를 계산할 수 있습니다 (agent가 만드는 다중 선택 문항과 같은 방식입니다).

항목을 적는 방법은 두 가지입니다.

- 정해진 항목: `<ann-item key="price">Price or billing</ann-item>`. `key`를 빼면 1부터 센 순번입니다.
- CSV 컬럼에 든 목록: 컬럼 값이 `["…", "…"]` 같은 JSON 배열이면 아래처럼 `<script type="application/json">` 안에 넣습니다. 원소는 문자열이거나 `{"text": "…", "key": "…"}`입니다.

```html
<ann-checklist name="supported" header="Which statements does the passage support?" required
               checked-value="supported" unchecked-value="not_supported">
  <script type="application/json">${facts}</script>
</ann-checklist>
```

| 속성 | 설명 |
|---|---|
| `name`, `header` | `ann-choice`와 같습니다. `name`은 답 이름의 앞부분이 됩니다. |
| `required` | 칸을 하나 이상(또는 "해당 없음") 체크해야 제출할 수 있습니다. |
| `checked-value`, `unchecked-value` | 항목마다 내는 값입니다 (기본 `yes`, `no`). |
| `none-label` | "해당 없음" 칸의 글자입니다 (기본 `None of the above`). `no-none`을 적으면 이 칸을 숨깁니다. |
| `numbered` | 항목 앞에 번호를 붙입니다. |

### `ann-textarea`

자유 서술 문항입니다. 앞뒤 공백을 뺀 글을 내고, 필수가 아닌 문항을 비워 두면 답에서 빠집니다.
Publish Batch의 `Review settings`가 이 문항의 이름을 자유 서술 답으로 미리 채우므로, Review에서는 글로 보이고 κ, majority, 일치율, 대조 기준에서는 빠집니다.

| 속성 | 설명 |
|---|---|
| `name`, `header`, `required` | `ann-choice`와 같습니다. |
| `minlength` | 최소 글자 수입니다. 필수가 아니어도, 쓰기 시작했으면 이보다 짧게는 제출할 수 없습니다. |
| `rows`, `placeholder` | 입력 칸의 높이와 안내 글자입니다. |

### `ann-tabs`, `ann-tab`

한 HIT에 항목이 여러 개일 때 탭으로 나눕니다. 탭 제목 옆에 그 탭에서 남은 필수 답의 수가 보이고, 다 답하면 체크 표시로 바뀝니다.
항목마다 CSV 컬럼을 하나씩 두는 방식입니다 (`${passage_1}`, `${passage_2}` …). starter의 `Several passages per HIT (tabs)`가 이 형식입니다.

| 속성 | 설명 |
|---|---|
| `ann-tab`의 `header` | 탭 제목입니다 (기본 `Item n`). |

## attention check와 대조 기준

`<ann-*>` 템플릿에는 attention 문항을 따로 표시하지 않습니다. 대신 **CSV에 attention 행을 섞고, 그 행의 기대 답을 컬럼에 적습니다.**
예를 들어 [example/5-project/passage-relevance.csv](../example/5-project/passage-relevance.csv)에는 질문과 상관없는 passage를 붙인 행이 두 개 있고, 그 행의 `attention_expected` 컬럼에 `{"relevance": "not_relevant"}`가 적혀 있습니다. 다른 행의 이 컬럼은 비어 있습니다.

게시할 때 `Review settings`에서 다음과 같이 고릅니다.

- `Attention check`를 켜고 `Expected answers column` 방식에서 `attention_expected`를 고릅니다. 그 행의 `relevance` 답이 `not_relevant`가 아니면 attention 실패로 판정됩니다.
- `Compare answers with`에서 정답이 든 컬럼(이 예시에서는 `gold`)을 고르면, Review의 `Answers` 열이 worker의 답 옆에 그 값을 보여 줍니다. 고르지 않으면 같은 HIT를 수행한 다른 worker들의 majority와 비교합니다.

worker 화면에는 `gold`와 `attention_expected`가 보이지 않습니다. 템플릿이 그 컬럼을 `${…}`로 쓰지 않기 때문입니다.
worker의 작업 화면에는 서버가 템플릿이 쓰는 컬럼만 보내므로, 정답은 `window.TASK_DATA`나 페이지 소스에도 남지 않습니다. `${…}`가 없는 템플릿(행 전체를 `window.TASK_DATA`로 읽는 템플릿)이면 attention 기대 답 컬럼과 대조 기준 컬럼을 뺀 나머지를 보냅니다. 어떤 컬럼이 가는지는 게시할 때 `Confirm and publish`의 `Workers receive`에 표시됩니다. Requester의 미리보기는 지금처럼 행 전체를 씁니다.

## 콘솔과 주고받는 것

요소를 쓰지 않고 HTML을 직접 쓸 때도 아래 두 가지를 지키면 Review와 Results가 같은 방식으로 읽습니다. agent가 만드는 템플릿도 같은 약속을 따릅니다.

- 제출: 숨은 `input_answers` 필드에 `[{"name": "…", "value": "…"}]` JSON 배열을 넣고 폼을 제출합니다. 값은 모두 문자열입니다.
- 문항 목록: `window.TASK_ANSWER_SCHEMA`에 `[{name, type, values, required}]`를 화면 순서대로 둡니다. `type`은 `choice`, `likert`, `multi_select`, `text` 중 하나입니다. 미리보기가 이 목록으로 답 칸을 알고, 게시할 때 batch의 `answerSchema`로 저장됩니다.

`<ann-form>`은 제출하기 직전에 취소할 수 있는 `ann-submit` 이벤트(`event.detail.answers`)를 냅니다. 템플릿의 스크립트에서 답을 더 검사하려면 이 이벤트를 듣고, 막을 때 `event.preventDefault()`를 부릅니다.

## 모양 바꾸기

요소는 shadow DOM을 쓰지 않으므로 템플릿의 `<style>`로 모양을 바꿀 수 있습니다. 요소가 만드는 클래스 이름은 모두 `ann-`로 시작하고, 색은 CSS 변수로 바꿉니다.

```html
<style>
  :root { --ann-accent: #0b7a5a; }
  .ann-text-card { font-size: 16px; }
</style>
```

`Pairwise comparison` starter는 두 응답을 나란히 놓기 위해 `<div class="side-by-side">`와 짧은 CSS를 씁니다. 요소 사이에 일반 HTML을 섞어도 됩니다.
