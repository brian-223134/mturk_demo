# 콘솔의 값 읽기

Manage 화면에 나오는 숫자와 표시가 무엇을 뜻하는지를 시작 데이터의 실제 값으로 설명합니다.
화면의 구성은 [README의 화면 둘러보기](../README.md#화면-둘러보기)에 정리되어 있습니다.

이 문서의 값은 모두 **Mock tools → Reset to fixtures**를 누른 직후의 것입니다. 응답을 검수하거나 batch를 게시하면 값이 달라집니다.
화면은 비율을 정수 %로 반올림해서 표시합니다.

## 용어와 ID

```
batch               한 번에 게시한 HIT 묶음
 └─ HIT             문제지 한 장 (템플릿 + CSV의 한 행)
     └─ assignment  worker 한 명이 그 HIT를 한 번 수행한 응답
```

| ID | 발급하는 곳 | 가리키는 대상 |
|---|---|---|
| batch ID | 콘솔 | 한 번에 게시한 HIT 묶음입니다. MTurk API에는 batch가 없어서 콘솔이 DB에서 관리합니다. |
| `HITId` | MTurk | HIT 하나입니다. 30자 문자열입니다. |
| `AssignmentId` | MTurk | 응답 하나입니다. HIT 하나에 HIT당 응답 수(`MaxAssignments`)만큼 생깁니다. |
| `WorkerId` | MTurk | worker 계정입니다. batch가 달라도 같은 값이어서 Worker Pool에서 이력을 합산할 수 있습니다. |

시작 데이터의 ID는 실제 값이 아니라 익명화하면서 새로 만든 값입니다.

응답의 상태는 세 가지입니다.

- `Submitted`: 제출되었고 아직 검수하지 않은 응답입니다.
- `Approved`: 승인한 응답입니다. 보상이 지급되고 Results에 집계됩니다.
- `Rejected`: 반려한 응답입니다. 보상이 지급되지 않고 집계에서 빠집니다.

상태는 `Submitted → Approved`, `Submitted → Rejected`, `Rejected → Approved`(30일 이내)로만 바꿀 수 있습니다.
승인하면 보상이 곧바로 지급되므로, MTurk는 승인한 응답을 반려로 바꾸는 것을 허용하지 않습니다.

## attention check

attention check는 worker가 문항을 읽고 답했는지 확인하려고 실제 문항 사이에 넣는 문항입니다. 정답이 정해져 있고, 읽기만 하면 맞힐 수 있게 만듭니다.
예시 CSV의 attention 문장은 `This is an attention check. Please select "Not grounded" for this sentence.`입니다.

- batch마다 규칙 하나로 판정합니다. `pilot close-ended chunk-fact`의 규칙은 "이름이 `attention_`으로 시작하는 문항의 답이 모두 `not_grounded`이면 통과"입니다.
- 판정 결과는 Review에 `1/1 PASS`, `0/1 FAIL`처럼 표시됩니다.
- attention 문항은 연구 데이터가 아니므로 Results의 집계에서 제외합니다.
- 읽지 않고 답한 응답을 걸러 낼 뿐이고, 판단이 정확한지는 알려 주지 않습니다. 그래서 Review는 일치율(`Agreement`)과 작업 시간을 함께 보여 줍니다. 두 값이 어긋나는 사례가 아래의 [Review의 응답 상세 읽기](#review의-응답-상세-읽기)에 있습니다.

## Batch 목록 읽기

| batch | `HITs` | `Assignments (S / A / R)` | `Reject rate` | `Cost` | `Status` |
|---|---|---|---|---|---|
| `pilot close-ended chunk-fact` | 36 / 40 | 6 / 108 / 18 | 14% | $6.48 / $7.20 | `Expired` |
| `open-ended query-fact coverage (model B)` | 16 / 16 | 0 / 48 / 3 | 6% | $2.88 / $2.88 | `Completed` |
| `close-ended query-fact coverage (model A)` | 16 / 16 | 0 / 48 / 0 | 0% | $5.76 / $5.76 | `Completed` |

- **`HITs`**는 완료된 HIT 수와 전체 HIT 수입니다. 승인된 응답이 HIT당 응답 수(3)에 도달해야 완료입니다. 제출만 된 응답은 세지 않습니다.
- **`Assignments (S / A / R)`**는 Submitted, Approved, Rejected 응답의 수입니다. S가 1 이상이면 숫자가 주황색으로 바뀌고 batch 이름 옆에 `Needs review`가 붙습니다.
  아직 아무도 제출하지 않은 자리는 여기에 들어 있지 않습니다. pilot batch에는 빈 자리가 6개 더 있고, Overview의 막대에 `Open`으로 표시됩니다.
- **`Reject rate`**는 반려 / (승인 + 반려)입니다. pilot batch는 18 / (108 + 18) = 14%입니다. 검수 대기 응답은 분모에 넣지 않습니다.
- **`Cost`**는 지출과 예상 총액입니다. 계산 방법은 다음 절에 있습니다.
- **`Status`**에서 pilot batch가 `Expired`인 것은 완료되지 않은 HIT가 남았는데 게시 기간이 지났기 때문입니다. 시작 데이터의 시각이 과거여서 그렇습니다.
  Overview의 `Top up incomplete HITs`를 누르면 게시 기간이 연장되어 `In progress`가 됩니다.

## Overview의 Cost 읽기

```
1건당 단가             = Reward + 수수료        (수수료 = Reward × 수수료율, 최소 $0.01)
Spent on approved work = 승인된 응답 수 × 단가
Estimated total        = (자리 수 − 반려된 응답 수) × 단가
```

- 수수료율은 HIT당 응답 수가 10 미만이면 20%, 10 이상이면 40%입니다. HIT마다 계산해서 더합니다.
- 자리 수는 HIT들의 `MaxAssignments`를 더한 값입니다. 응답을 다시 모집하면 늘어납니다.
- `Spent`는 승인된 응답만 셉니다. 반려한 응답은 과금되지 않고, 검수 대기 응답은 아직 지급 전입니다.
- `Estimated total`은 반려를 뺀 나머지 자리가 모두 승인된다고 볼 때의 총액입니다. 모든 작업이 끝나면 `Spent`와 같아집니다.

| batch | Reward | 단가 | 승인 | 자리 수 − 반려 | `Spent` | `Estimated total` |
|---|---|---|---|---|---|---|
| `pilot close-ended chunk-fact` | $0.05 | $0.06 | 108 | 138 − 18 = 120 | 108 × $0.06 = $6.48 | 120 × $0.06 = $7.20 |
| `open-ended query-fact coverage (model B)` | $0.05 | $0.06 | 48 | 51 − 3 = 48 | $2.88 | $2.88 |
| `close-ended query-fact coverage (model A)` | $0.10 | $0.12 | 48 | 48 − 0 = 48 | $5.76 | $5.76 |

pilot batch는 처음에 120자리(40 HITs × 3)였고, 18건을 반려한 뒤 그만큼 다시 모집해서 138자리가 되었습니다.
반려한 응답은 과금되지 않으므로, 반려하고 같은 수를 다시 모집하면 예상 총액은 그대로입니다.

상단 바의 `Balance`는 움직이는 시점이 다릅니다. batch를 게시하거나 응답을 다시 모집할 때 예상 금액 전체가 미리 차감되고, 반려하면 그만큼 돌아옵니다.
그래서 새로 게시한 batch는 `Spent`가 $0.00이어도 `Balance`는 이미 줄어 있습니다.

## Review 표의 Answers 열 읽기

Review 표의 `Answers` 열에는 응답마다 답이 두 줄로 항상 보입니다. 윗줄 `W`는 이 worker의 답이고, 아랫줄 `R`은 대조 기준입니다. 행을 열거나 마우스를 올리지 않아도 한 페이지를 훑으며 어긋난 응답을 고를 수 있게 한 것입니다.

- 칸 하나가 문항 하나이고, 순서는 worker가 제출한 순서(템플릿의 화면 순서)입니다.
- 값은 약어로 표시합니다. 값을 단어로 나누어 첫 글자를 대문자로 이은 것입니다: `G`는 grounded, `NG`는 not_grounded, `C`는 Covered, `NC`는 Not Covered입니다. 약어가 겹치면 글자를 늘려 구분합니다.
- worker의 답이 대조 기준과 다르면 빨간색으로 표시됩니다. attention 문항은 보라색 테두리가 있습니다. 대조 기준이 없는 문항의 아랫줄은 회색 `·`입니다.
- 칸에 마우스를 올리면 문항 이름과 두 값의 원래 문자열이 표시됩니다.
- 표 위의 범례 한 줄에 이 batch의 대조 기준 출처와 약어의 뜻이 적혀 있습니다.
- 기본 정렬은 `Row`이므로 같은 HIT의 응답 3건이 위아래로 붙어 있고, 세 줄을 나란히 견주어 볼 수 있습니다.
- `Invert selection`은 현재 페이지에서 선택을 반전합니다. 정상으로 보이는 몇 건만 체크한 뒤 반전해서 나머지를 한 번에 반려하는 식으로 씁니다.

### 대조 기준의 출처

대조 기준은 batch를 게시할 때 Create의 `Settings`에서 정하며, 두 가지가 있습니다. 시작 데이터에는 둘 다 들어 있습니다.

| batch | 대조 기준 | 설명 |
|---|---|---|
| `pilot close-ended chunk-fact` | 같은 HIT를 수행한 다른 worker들의 majority | 정답 컬럼이 없는 batch입니다. 이 worker를 빼고 반려된 응답도 빼고 센 다수 값이며, 동률이거나 다른 worker가 없으면 기준이 없습니다. |
| `open-ended query-fact coverage (model B)` | 입력 컬럼 `query_fact_coverage_check` | LLM이 매긴 라벨입니다. 문항 이름을 키로 하는 객체이며, 답 이름 `general_0_1_coverage`는 키 `general_0_1`에 접두어로 대응됩니다. |
| `close-ended query-fact coverage (model A)` | 입력 컬럼 `query_fact_coverage_check` | 위와 같습니다. |

값을 비교할 때 대소문자와 앞뒤 공백은 무시합니다. 라벨 컬럼의 `Not covered`와 worker 답 `Not Covered`는 같은 값으로 봅니다.
attention 문항의 기준은 출처와 관계없이 batch의 attention 규칙에 정해 둔 기대값입니다.

## Review의 응답 상세 읽기

Review에서 행을 누르면 열리는 화면입니다. `Answers` 표의 한 행이 문항 하나입니다. 표 위에는 이 batch의 대조 기준 출처가 표시됩니다.

- **`Item`**은 문항의 이름입니다. 기존 템플릿에서 `general_3_1`은 네 번째 탭(0부터 셉니다)의 첫 문항입니다. attention 문항에는 보라색 `attention` 태그가 붙습니다.
- **`This worker`**는 이 worker의 답입니다. 비교 기준과 다르면 빨간색으로 표시됩니다.
- **`Other workers on this HIT`**는 같은 HIT를 수행한 다른 worker들의 답입니다. 취소선이 그어진 값은 반려된 응답의 것이고, majority를 계산할 때 제외합니다.
- **`Reference`**는 대조 기준입니다. attention 문항이면 batch에 정해 둔 기대값이고, 일반 문항이면 위의 [대조 기준의 출처](#대조-기준의-출처)에 따라 다른 worker들의 majority 또는 입력 컬럼의 값입니다. 기준이 없는 문항(동률, 다른 worker 없음, 컬럼에 대응하는 값 없음)은 `–`로 표시됩니다.
  majority에는 이 worker 자신의 답을 넣지 않습니다. 자기 답이 기준에 섞이면 다른 사람들과 얼마나 같은지를 볼 수 없기 때문입니다.

표 위의 `Answers (11), 7 differ`는 전체 문항 수와 빨간색 문항 수입니다. `Only differences`를 활성화하면 어긋난 문항만 남습니다.
`Agreement`는 attention을 뺀 문항 중 대조 기준과 같은 답의 비율입니다. 기준이 없는 문항은 분모에 넣지 않습니다. Review 표의 `Agree` 열도 같은 값입니다.

### 예시: attention은 통과했지만 일치율이 낮은 응답

`pilot close-ended chunk-fact`의 Review에서 Status를 Rejected로 거르면 Row 32에 worker `Wb49e89b85e8e`의 응답이 있습니다.
위쪽에 `Attention` `1/1 PASS`, `Agreement` 30%, `Answers (11), 7 differ`가 표시됩니다.

| `Item` | `This worker` | `Other workers on this HIT` | `Reference` |
|---|---|---|---|
| `general_0_1`, `general_1_1` | grounded | grounded, grounded, not_grounded | grounded |
| `general_2_1` | grounded | grounded, grounded, grounded | grounded |
| `general_3_1` ~ `general_6_1` | **not_grounded** | grounded, grounded, grounded | grounded |
| `attention_7_1` | not_grounded | grounded, not_grounded, not_grounded | not_grounded (기대값) |
| `general_8_1` ~ `general_10_1` | **not_grounded** | grounded, grounded, grounded | grounded |

- 문항 11개는 일반 문항 10개와 attention 문항 1개입니다. 굵게 표시한 7개가 `7 differ`이고, 일반 문항 10개 중 3개가 대조 기준(이 batch에서는 다른 worker들의 majority)과 같으므로 `Agreement`는 30%입니다.
- 이 worker는 네 번째 문항부터 끝까지 not_grounded로 답했습니다. 기대값도 not_grounded이므로 attention 문항은 맞은 것으로 판정됩니다. attention check만으로는 한 값으로 몰아서 답한 응답을 걸러 낼 수 없다는 것을 보여 줍니다.
- 응답 한 건만으로 worker를 판단하기는 어렵습니다. `Worker`의 ID를 누르면 열리는 Worker 상세에서 이 worker는 제출 21건 중 20건이 승인되었고 전체 일치율은 96%입니다.
- 시작 데이터의 검수 상태와 반려 사유는 원본을 그대로 옮긴 것이고, attention 판정은 콘솔이 batch의 규칙으로 새로 계산한 것입니다. 그래서 이 응답처럼 둘이 일치하지 않는 경우가 있습니다.

## Results 읽기

Results는 **승인된 응답의 실제 문항**만 집계합니다. attention 문항은 제외합니다. 문항 하나는 "행(HIT) × 문항 이름"입니다.
`Fleiss' κ`와 `Unanimous items`는 표 수가 HIT당 응답 수(3)와 정확히 같은 문항만으로 계산합니다.

| batch | `Fleiss' κ` | 계산에 쓴 문항 | `Unanimous items` | `Label distribution` (표 수) |
|---|---|---|---|---|
| `pilot close-ended chunk-fact` | 0.731 (substantial) | 420 items × 3 raters | 85% | not_grounded 957, grounded 303 |
| `open-ended query-fact coverage (model B)` | 0.857 (almost perfect) | 326 items × 3 raters | 89% | Covered 476, Not Covered 502 |
| `close-ended query-fact coverage (model A)` | 0.938 (almost perfect) | 241 items × 3 raters | 95% | Covered 401, Not Covered 322 |

- **`Fleiss' κ`**는 worker들의 답이 얼마나 일치하는지를 우연히 일치할 확률을 빼고 나타낸 값입니다. statsmodels의 `fleiss_kappa`와 소수 여섯째 자리까지 같고, 테스트로 고정되어 있습니다.
  옆의 구간 이름은 Landis & Koch의 관례입니다: 0.2 이하 slight, 0.4 이하 fair, 0.6 이하 moderate, 0.8 이하 substantial, 그 위는 almost perfect. 해석을 돕는 표시일 뿐이고 합격 기준은 아닙니다.
- **`Unanimous items`**는 3표가 모인 문항 중 세 명의 답이 모두 같은 문항의 비율입니다.
- **`Items with votes`**는 승인된 표가 하나라도 있는 문항의 수입니다. 아래의 작은 글자는 3표가 아닌 문항 수와 동률인 문항 수입니다. 시작 데이터에서는 둘 다 0입니다.
- **`Label distribution`**은 라벨별 표 수입니다. 문항 수가 아닙니다.

pilot batch는 만장일치가 85%인데 κ는 0.731이고, model A batch는 95%에 0.938입니다. pilot batch의 차이가 더 큰 것은 표의 76%가 not_grounded로 쏠려 있기 때문입니다.
라벨이 한쪽으로 쏠리면 우연히 일치할 확률이 높아지고, κ는 그만큼을 빼고 계산합니다. κ를 읽을 때 `Label distribution`을 함께 보는 이유입니다.

문항 표의 `Majority`는 승인된 응답 전체에서 가장 많은 값입니다. Review의 대조 기준이 majority인 batch에서는 그 worker를 빼고 검수 대기 응답을 포함해(반려된 응답은 제외) 계산하므로, 같은 문항이라도 두 화면의 값이 다를 수 있습니다.
질의 단위로 다시 묶는 분석은 `Export`로 받은 CSV로 합니다. 이 CSV는 MTurk Requester 웹사이트의 결과 CSV와 컬럼이 같습니다.

## 입력 데이터의 구조

MTurk의 CSV는 한 행이 HIT 하나이고, 컬럼 하나에는 셀 하나만 들어갑니다. 기존 템플릿 두 개는 HIT 하나에 항목 11개(실제 10개 + attention 1개)를 탭으로 보여 주므로, 모든 컬럼이 길이 11의 리스트를 문자열로 담고 있습니다.
리스트의 순서가 탭의 순서입니다. `qid[3]`, `query[3]`, `attention_check[3]`은 모두 네 번째 탭의 값입니다.

```
qid             ['q0002', 'q0002', 'q0002', 'q0002', 'q0002', 'q0002', 'attention', 'q0002', 'q0002', 'q0002', 'q0002']
attention_check ['0',     '0',     '0',     '0',     '0',     '0',     '1',         '0',     '0',     '0',     '0']
```

- `qid`는 그 탭이 다루는 질의의 ID입니다. `'attention'`은 attention 탭의 자리라는 표시이고, 같은 위치의 `attention_check`가 `'1'`입니다. attention 탭의 위치는 HIT마다 다릅니다.
- `Chunk-Fact Relevance` 템플릿의 HIT는 질의 하나에 검색된 chunk 10개를 보여 주므로 같은 `qid`가 10번 반복됩니다. `Query-Fact Coverage` 템플릿의 HIT는 서로 다른 질의 10개를 보여 주므로 `qid`도 10개가 모두 다릅니다.
- `q0002` 같은 값은 익명화하면서 새로 매긴 순번입니다. 같은 원본은 같은 순번이 되므로, 서로 다른 batch에 같은 `qid`가 있으면 같은 질의입니다.
- 콘솔은 이 값을 해석하지 않습니다. 셀을 문자열 그대로 HIT에 저장해서 템플릿에 넘기고, 리스트로 풀어 쓰는 것은 템플릿이 합니다. 응답의 문항 이름에 들어 있는 탭 번호(`general_3_1`의 `3`)가 이 리스트의 인덱스입니다.
