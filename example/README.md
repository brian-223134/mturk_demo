# example/: Create에 올려 볼 예시 파일

콘솔의 **Create** 탭은 템플릿(`.html`) 하나와 데이터 하나를 받습니다. 데이터는 production 콘솔에서는 JSON(`.json`), 프로토타입 콘솔에서는 CSV(`.csv`)입니다. 이 폴더에는 그 자리에 올려 볼 수 있는 파일이 들어 있습니다.
어떤 파일을 올리면 화면에 무엇이 표시되는지는 저장소 루트의 [README.md](../README.md#예시-파일로-mock-테스팅-해보기)에 시나리오별로 정리되어 있습니다.

| 폴더 | 파일 | 용도 |
|---|---|---|
| `1-task-data/` | `template.html`, `data.csv` (10행) | `window.TASK_DATA` 방식입니다. 새 템플릿에 권장합니다. 프로토타입 콘솔의 `Load sample template`과 `Load sample CSV` 버튼이 이 두 파일을 불러옵니다. |
| `2-placeholder/` | `template.html`, `data.csv` (8행) | `${컬럼명}` 방식입니다. MTurk Requester 웹사이트와 같은 방식으로 치환됩니다. |
| | `data-missing-column.csv` | 오류 예시: 템플릿이 쓰는 `sentence_2` 컬럼이 없습니다. |
| `3-data-checks/` | `empty-cells.csv` | 경고 예시: 빈 셀이 있는 행 |
| | `excel-utf8-bom.csv` | Excel에서 "CSV UTF-8"로 저장한 파일입니다 (BOM, CRLF). 정상적으로 처리됩니다. |
| | `excel-cp949.csv` | 오류 예시: 한국어 Excel의 일반 "CSV" 형식(CP949)입니다. UTF-8이 아니어서 업로드가 거절됩니다. |
| | `large-rows.csv` | 경고 예시: 입력이 64KB를 넘는 행 |
| `4-saved-templates/` | `chunk-fact-relevance-input.csv` (10행) | 콘솔에 미리 저장된 `Chunk-Fact Relevance` 템플릿에 넣을 입력 |
| | `query-fact-coverage-input.csv` (8행) | 콘솔에 미리 저장된 `Query-Fact Coverage` 템플릿에 넣을 입력 |
| `5-project/` | `passage-relevance.json` (객체 8개) | production 콘솔에서 `Passage relevance` starter로 만든 Project에 올릴 입력입니다. attention 항목 2개와 기대 답 컬럼 `attention_expected`, 정답 컬럼 `gold`가 있습니다. 사용법은 [Project로 batch 게시하기](../docs/create-projects.md#따라-하기-starter로-attention-check가-있는-batch-게시하기)에 있습니다. |
| `6-rough-design/` | `chunk-fact-hits.json` (HIT 3개), `chunk-fact.binding.json` | New Project의 `HIT data` 단계에 올릴 합성 데이터와 손으로 쓴 binding입니다. 사용법은 [HIT 데이터를 가안에 넣어 보기](../docs/create-projects.md#hit-데이터를-가안에-넣어-보기)에 있습니다. |
| `7-draft-with-ai/` | `summaries-nested.json` (기록 4개) | New Project의 `Draft with AI`에 올릴 데이터입니다. 기록을 감싼 객체 안에 원문과 요약문이 있어, 요약문을 문장 단위로 나눠 보기에 맞습니다. 목표 예: "Is each summary sentence supported by the source?" |
| | `sentences.jsonl` (줄 12개) | 문장 하나가 한 줄인 JSON Lines입니다. 같은 `doc_id`의 문장을 HIT 하나로 묶고, `label`(fact, opinion)과 대조합니다. 목표 예: "Does each sentence state a fact or an opinion? The answers are in label." |
| | `clips-by-id.json` (클립 3개) | id로 묶인 영상과 장면 시각 목록입니다. frame 단위를 고를 수 있습니다. 영상 파일은 들어 있지 않아 미리보기에는 `This video could not be loaded.`가 나옵니다. 목표 예: "Is a person visible at each moment?" |

`3-data-checks/`의 CSV는 `1-task-data/template.html`과 함께 사용합니다.

`1-task-data/`, `2-placeholder/`, `5-project/`, `7-draft-with-ai/`의 파일과 `6-rough-design/`의 binding은 직접 작성한 것이고, `6-rough-design/`의 데이터는 `4-saved-templates/`의 앞 3행에서 컬럼 일부만 옮긴 것이며, 나머지는 `python3 scripts/build_examples.py`로 만듭니다.
`3-data-checks/`는 `1-task-data/data.csv`를 바탕으로, `4-saved-templates/`는 `data/` 폴더의 HIT 입력을 바탕으로 생성합니다.
본문은 모두 새로 지어낸 글이거나 익명화한 합성 텍스트입니다.
