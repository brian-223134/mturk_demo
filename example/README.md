# example/ — Create에 올려 볼 예시 파일

콘솔의 **Create** 탭은 템플릿(`.html`) 하나와 데이터(`.csv`) 하나를 받는다. 이 폴더에는 그 자리에 올려 볼 파일이 있다.
무엇을 올리면 화면에 무엇이 나오는지는 저장소 루트의 [README.md](../README.md#업로드-시나리오-create에-무엇을-올리나)에 시나리오별로 정리되어 있다.

| 폴더 | 파일 | 용도 |
|---|---|---|
| `1-task-data/` | `template.html`, `data.csv` (10행) | `window.TASK_DATA` 방식. 새 템플릿에 권장. 화면의 `Load sample template`, `Load sample CSV` 버튼이 이 두 파일을 쓴다 |
| `2-placeholder/` | `template.html`, `data.csv` (8행) | `${컬럼명}` 방식. MTurk Requester 웹사이트와 같은 치환 |
| | `data-missing-column.csv` | 오류 예: 템플릿이 쓰는 `sentence_2` 컬럼이 없다 |
| `3-data-checks/` | `empty-cells.csv` | 경고 예: 빈 셀이 있는 행 |
| | `excel-utf8-bom.csv` | Excel의 "CSV UTF-8" (BOM, CRLF). 정상 처리된다 |
| | `excel-cp949.csv` | 오류 예: 한국어 Excel의 기본 "CSV" (CP949). UTF-8이 아니라 거절된다 |
| | `large-rows.csv` | 경고 예: 입력이 64KB를 넘는 행 |
| `4-saved-templates/` | `chunk-fact-relevance-input.csv` (10행) | 콘솔에 저장돼 있는 `Chunk-Fact Relevance` 템플릿의 입력 |
| | `query-fact-coverage-input.csv` (8행) | 콘솔에 저장돼 있는 `Query-Fact Coverage` 템플릿의 입력 |

`3-data-checks/`의 CSV는 `1-task-data/template.html`과 함께 쓴다.

`1-task-data/`와 `2-placeholder/`는 손으로 쓴 파일이고, 나머지는 `python3 scripts/build_examples.py`가 만든다
(`3-data-checks/`는 `1-task-data/data.csv`에서, `4-saved-templates/`는 `data/`의 HIT 입력에서). 본문은 전부 지어낸 글이거나 익명화한 합성 텍스트다.
