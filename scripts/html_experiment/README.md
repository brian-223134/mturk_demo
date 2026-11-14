# Agent가 task 페이지 HTML을 직접 쓰는 실험

binding으로 콘솔이 만든 템플릿을 정답지(계약)로 두고, Agent가 Requester의 요청대로 페이지를 다시 썼을 때 그 약속을 지키는지 검사합니다.
검사(harness)는 [frontend/src/lib/html-harness.js](../../frontend/src/lib/html-harness.js), Agent 호출은 [agent/html_writer.py](../../agent/html_writer.py)와 설명서 [agent/html_reference.md](../../agent/html_reference.md)에 있습니다.

## 검사하는 것

- 정답지가 보여 주는 데이터 컬럼을 모두, 같은 자리(화면 글, 이미지·영상 주소, 항목 목록)로 보여 주는지 확인합니다.
- 정답지와 같은 문항을 같은 이름과 같은 요소로 묻는지 확인합니다.
- 대조 기준, attention 같은 정답 컬럼을 페이지에 쓰지 않는지 확인합니다. 이 컬럼은 Agent에게 보내는 요청에도 넣지 않습니다.
- `<ann-*>` 요소와 글·배치용 HTML만 쓰고, 스크립트, 이벤트 속성, 외부 주소를 쓰지 않는지 확인합니다.
- Chrome이 있으면 모든 HIT를 그려 답 칸 목록과 선택지가 정답지와 같은지, 데이터 값이 화면에 그대로 있는지 대조합니다.

검사에 걸리면 오류를 붙여 Agent에게 다시 묻습니다(기본 3번). 배치와 표현은 자유입니다.
harness는 약속을 지켰는지만 보므로, 요청대로 바뀌었는지는 결과 폴더의 화면 사진으로 확인합니다.

## 실행

```bash
# 정답지를 그대로 내는 가짜 Agent로 harness 자체를 점검합니다 (호출 없음)
node scripts/html_experiment/run.mjs --writer reference

# 실제 Agent를 부릅니다 (OpenRouter 유료 호출, environment/.env 의 키 사용)
node scripts/html_experiment/run.mjs --writer agent --allow-api
```

- 호스트에서 Agent를 부르려면 Python에 `pyyaml`이 있어야 합니다(`agent/requirements.txt`).
- `--only a,b`로 시나리오를 고르고, `--no-render`로 렌더 검사를 건너뜁니다. Chrome 경로는 `CHROME` 환경변수로 줄 수 있습니다.
- 결과는 `var/html-experiment/<시각>-<writer>/`에 남습니다(git에 넣지 않음). 시나리오마다 시도별 HTML, 요청과 응답, 첫 HIT의 화면 사진(넓은 화면, 휴대폰 폭)이 있고, `summary.md`에 결과 표가 있습니다.

## 시나리오

[scenarios.json](scenarios.json)에 있습니다. 데이터는 `example/6-rough-design`과 이 폴더의 `data/`에 있는 합성 데이터입니다.

| 종류 | 내용 |
|---|---|
| `layout` | 칸의 순서와 배치를 바꾸는 요청입니다. |
| `hint` | 안내 상자와 색을 더하는 요청입니다. Skillbook의 규칙을 worker에게 보여 주는 경우와 같습니다. |
| `format` | binding으로는 만들 수 없는 화면(탭 없애기)을 한국어로 요청합니다. |
| `trap` | 정답을 보여 달라거나 문항을 더해 달라는, 약속을 깨는 요청입니다. 거절하거나 약속을 지킨 페이지를 내야 성공입니다. |

## 자유 계약 실험 (가안 없이 prompt 하나로)

Requester가 무엇을 어디에 보이고 어떤 문항을 물을지 문장으로만 적고, 가안(rough design)은 고르지 않습니다.

1. 계약 Agent([agent/contract_writer.py](../../agent/contract_writer.py), 설명서 [agent/contract_reference.md](../../agent/contract_reference.md))가 prompt와 데이터 요약으로 계약을 씁니다. 계약에는 보여 줄 값, 문항(개수와 종류 제한 없음: choice, likert, checklist, item-choice, text), 문항별 대조 기준과 attention이 들어갑니다. 콘솔의 `Draft with AI`는 같은 Agent에 한 줄 목표와 단위 후보를 보내 annotation 단위와 페이지 문장(`layout`)까지 받습니다. 이 러너는 단위를 정하지 않는 예전 방식(`request`)으로 부릅니다.
2. 코드([frontend/src/lib/task-contract.js](../../frontend/src/lib/task-contract.js))가 계약을 검사하고, 기본 템플릿과 게시용 행을 만듭니다. 이 기본 템플릿이 harness의 정답지입니다.
3. HTML Agent가 같은 prompt의 배치와 표현대로 페이지를 쓰고, harness가 검사합니다.

계약 검사는 정답·attention 컬럼이나 정답처럼 보이는 컬럼(`gold`, `labels`, `attention`, `..._check` 등)을 화면 값으로 쓰는 것을 막습니다. 항목마다 다른 목록을 통째로 또는 고정 번호로 읽는 것도 모든 HIT를 세어 막습니다.

```bash
node scripts/html_experiment/run-free.mjs --writer reference            # fixtures/ 의 손으로 쓴 계약으로 흐름만 점검 (호출 없음)
node scripts/html_experiment/run-free.mjs --writer agent --allow-api    # 실제 호출 (유료)
```

시나리오는 [scenarios-free.json](scenarios-free.json)에 있고, `expect`에 적은 문항 종류와 수, 대조 기준·attention 유무, 항목마다 보일 값, 보이면 안 되는 컬럼, 탭 없음을 코드로 확인합니다.

`kind: draft` 시나리오는 콘솔의 `Draft with AI`와 같이 `request` 대신 한 줄 목표(`goal`, 비어도 됨)만 주고, 데이터는 [example/7-draft-with-ai/](../../example/7-draft-with-ai/)처럼 모양이 다른 JSON입니다. Agent가 annotation 단위까지 정해야 하며, `expect`의 `unit`(단위), `group_by`, `split_by`, `frame_at`(영상 frame 시각), `hits`(단위대로 만든 HIT 수의 범위)도 확인합니다. 페이지는 계약의 페이지 문장(`layout`)대로 다시 쓰고, 문장이 없으면 기본 페이지를 그대로 씁니다.

## 요청한 배치의 자동 확인 (`--judge`)

두 러너에 `--judge`를 주면, harness를 통과한 페이지를 Chrome으로 그려 칸의 위치·폭·탭·굵기·글자 크기·색·강조 상자를 재고([frontend/src/lib/layout-check.js](../../frontend/src/lib/layout-check.js)), 판정 Agent([agent/layout_judge.py](../../agent/layout_judge.py), 설명서 [agent/layout_reference.md](../../agent/layout_reference.md))가 요청의 배치·표현 요구를 하나씩 met / not_met / unclear로 판정합니다. not_met이 있으면 페이지 Agent에게 고쳐 달라고 다시 묻습니다. 기본 페이지(배치를 바꾸기 전)도 같은 요청으로 판정해 `summary.md`에 나란히 적으므로, 판정이 실제 차이를 가려내는지 볼 수 있습니다.
