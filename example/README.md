# example/: Create에 올려 볼 예시 파일

콘솔의 **Create** 탭은 템플릿(`.html`) 하나와 데이터(`.csv`) 하나를 받습니다. 이 폴더에는 그 자리에 올려 볼 수 있는 파일이 들어 있습니다.
어떤 파일을 올리면 화면에 무엇이 표시되는지는 저장소 루트의 [README.md](../README.md#예시-파일로-직접-해-보기)에 시나리오별로 정리되어 있습니다.

| 폴더 | 파일 | 용도 |
|---|---|---|
| `1-task-data/` | `template.html`, `data.csv` (10행) | `window.TASK_DATA` 방식입니다. 새 템플릿에 권장합니다. 화면의 `Load sample template`과 `Load sample CSV` 버튼이 이 두 파일을 불러옵니다. |
| `2-placeholder/` | `template.html`, `data.csv` (8행) | `${컬럼명}` 방식입니다. MTurk Requester 웹사이트와 같은 방식으로 치환됩니다. |
| | `data-missing-column.csv` | 오류 예시: 템플릿이 쓰는 `sentence_2` 컬럼이 없습니다. |
| `3-data-checks/` | `empty-cells.csv` | 경고 예시: 빈 셀이 있는 행 |
| | `excel-utf8-bom.csv` | Excel에서 "CSV UTF-8"로 저장한 파일입니다 (BOM, CRLF). 정상적으로 처리됩니다. |
| | `excel-cp949.csv` | 오류 예시: 한국어 Excel의 일반 "CSV" 형식(CP949)입니다. UTF-8이 아니어서 업로드가 거절됩니다. |
| | `large-rows.csv` | 경고 예시: 입력이 64KB를 넘는 행 |
| `4-saved-templates/` | `chunk-fact-relevance-input.csv` (10행) | 콘솔에 미리 저장된 `Chunk-Fact Relevance` 템플릿에 넣을 입력 |
| | `query-fact-coverage-input.csv` (8행) | 콘솔에 미리 저장된 `Query-Fact Coverage` 템플릿에 넣을 입력 |

`3-data-checks/`의 CSV는 `1-task-data/template.html`과 함께 사용합니다.

`1-task-data/`와 `2-placeholder/`의 파일은 직접 작성한 것이고, 나머지는 `python3 scripts/build_examples.py`로 만듭니다.
`3-data-checks/`는 `1-task-data/data.csv`를 바탕으로, `4-saved-templates/`는 `data/` 폴더의 HIT 입력을 바탕으로 생성합니다.
본문은 모두 새로 지어낸 글이거나 익명화한 합성 텍스트입니다.
