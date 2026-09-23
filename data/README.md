# data/: 콘솔의 시작 데이터

콘솔이 처음 실행될 때, 그리고 **Mock tools → Reset to fixtures**를 누를 때 읽는 데이터입니다. 데이터는 JSON으로, 템플릿은 HTML 파일로 관리합니다.
API 서버를 사용하는 방식에서는 이 폴더의 내용이 SQLite에 채워지고, 이후의 변경 사항(검수, 게시, pool 편집)은 DB에만 저장됩니다. 이 폴더의 파일은 바뀌지 않습니다.

```
data/
├─ account.json                  환경과 잔액             { "env": "mock", "AvailableBalance": "500.00" }
├─ pools.json                    worker pool 목록        [ { id, name, description, workerIds } ]
├─ workers.json                  worker에 붙인 정보      { "<WorkerId>": { blocked, note, blockReason? } }
├─ templates/
│  ├─ index.json                 템플릿 목록             [ { id, name, file, updatedAt } ]
│  └─ <file>.html                템플릿 본문 (index.json의 file에 적은 이름)
└─ batches/<batchId>/            폴더 이름은 batch.json의 id와 같아야 합니다
   ├─ batch.json                 이름, 설정(HitSettings), attentionRule, pool 조건, inputColumns 등
   ├─ template.html              게시 시점의 템플릿 사본. templates/를 고쳐도 이 batch에는 영향이 없습니다
   ├─ hits.json                  HIT 목록. 한 줄에 HIT 하나이며, input이 CSV의 한 행에 해당합니다
   └─ assignments.json           응답 목록. 한 줄에 assignment 하나
```

각 필드의 의미는 `src/api/types.ts`에 정리되어 있습니다. PascalCase 필드는 MTurk API와 같은 이름이고, camelCase 필드는 콘솔이 추가한 것입니다.
템플릿의 `placeholders`와 assignment의 `attention`은 파일에 적지 않습니다. 데이터를 읽어 들일 때 HTML과 batch의 `attentionRule`로부터 계산합니다.
batch.json의 `reference`는 Review에서 답을 대조하는 기준입니다. `{ "source": "majority" }`이면 같은 HIT의 다른 worker들 majority와, `{ "source": "column", "column": "<입력 컬럼>" }`이면 그 컬럼의 값(GT 또는 LLM 라벨)과 대조하며, 없으면 majority로 봅니다.

## 수정하고 반영하기

1. 이 폴더의 JSON이나 HTML을 고칩니다.
2. 콘솔에서 **Mock tools → Reset to fixtures**를 누릅니다.

Docker의 `api` 서비스는 이 폴더를 직접 읽으므로 이미지를 다시 빌드할 필요가 없습니다.
브라우저만으로 동작하는 방식에서는 데이터가 빌드 결과에 포함되므로, 개발용 서버에서는 바로 반영되지만 빌드본은 다시 빌드해야 합니다.

파일끼리 맞지 않는 부분이 있으면, 실행할 때 어느 파일의 무엇이 잘못되었는지 알려 줍니다. 예를 들면 다음과 같습니다.

```
data/batches/batch-1000001/assignments.json: assignment 3ABC... points to unknown HIT NO_SUCH_HIT
```

자주 하는 수정은 다음과 같습니다.

| 하고 싶은 것 | 고칠 곳 |
|---|---|
| 템플릿 추가 | `templates/`에 `.html` 파일을 넣고 `templates/index.json`에 한 줄을 추가합니다. 콘솔의 Create › Template에서 올려도 됩니다. |
| 잔액 변경 | `account.json`의 `AvailableBalance` |
| pool을 미리 채워 두기 | `pools.json`의 `workerIds` |
| 검수할 응답 늘리기 | `assignments.json`에서 몇 건의 `AssignmentStatus`를 `"Submitted"`로 바꾸고 `ApprovalTime`을 지웁니다. |
| batch 통째로 빼기 | `batches/<batchId>/` 폴더를 지웁니다. |

## 콘솔에서 만든 상태를 시작 데이터로 삼기

콘솔에서 미리 상태를 만들어 둔 뒤(예: batch 게시, 가짜 응답 생성, pool 구성) 그것을 새로운 시작 상태로 삼을 수 있습니다.

```bash
# 1. 콘솔에서 Mock tools → Export data (JSON)을 누르면 mturk-console-data-<시각>.json 파일이 내려받아집니다.
# 2. 그 파일을 이 폴더의 구조로 풉니다 (templates/와 batches/를 지우고 다시 씁니다).
npm run data:unpack -- <내려받은 파일>.json
# 3. 콘솔에서 Mock tools → Reset to fixtures를 누릅니다.
```

내려받은 JSON 파일 하나를 그대로 주고받을 수도 있습니다. 받은 사람은 **Mock tools → Import data (JSON)…**으로 불러오면 됩니다.

## 이 데이터는 익명화되어 있습니다

`batches/`의 batch 세 개는 실제 annotation 작업의 MTurk 결과 CSV를 `scripts/build_fixtures.py`로 변환한 것이며, 공개할 수 있도록 익명화했습니다.

| 항목 | 처리 방법 |
|---|---|
| WorkerId, HITId, AssignmentId | salt를 넣은 해시로 바꿨습니다. 실제 MTurk의 ID가 아닙니다. |
| batch id와 이름 | 임의로 새로 붙였습니다. |
| 입력의 본문 (질문, 문단, fact, reasoning) | 같은 길이의 합성 텍스트(`Synthetic question: Lorem ipsum …`)로 바꿨습니다. 리스트의 모양과 `'Chunk 0'` 같은 구조용 라벨은 그대로 두었기 때문에 템플릿이 그대로 렌더링되고, 입력 크기의 분포도 원본과 같습니다. |
| `idx`, `qid` | 순번으로 바꿨습니다. |
| 시각 | 전체를 일정한 만큼 옮겼습니다. 작업 시간 같은 간격은 그대로입니다. |
| HIT의 Title, Description, Keywords | 일반적인 문구로 바꿨습니다. |
| 응답 값, 검수 상태, 작업 시간, 반려 사유 | **그대로 두었습니다.** 그래서 진행률, 반려율, worker 지표, Fleiss' κ가 원본과 같습니다. |

salt(`scripts/.fixture_salt`)는 저장소에 포함하지 않습니다. salt 없이는 ID를 원래대로 되돌리거나 대조해 볼 수 없습니다.

## 내 데이터로 다시 만들기

MTurk Requester 웹사이트에서 내려받은 결과 CSV와 템플릿이 있다면 같은 방식으로 `data/`를 만들 수 있습니다.

```bash
cp scripts/fixture_sources.example.json scripts/fixture_sources.json   # 읽을 CSV와 템플릿을 적습니다 (git에서 제외되는 파일)
python3 scripts/build_fixtures.py --source <원본 폴더>
npm test          # data/의 규모와 변환 규칙을 확인합니다. 기대값은 src/api/mock/data.test.ts에 있습니다
```

- 입력 셀이 Python 리터럴(리스트, dict) 문자열이 아닌 CSV라면, `build_fixtures.py`의 `Anonymizer.cell`을 그 형식에 맞게 고쳐야 합니다.
- `account.json`, `pools.json`, `workers.json`은 사람이 직접 관리하는 파일이므로 스크립트가 덮어쓰지 않습니다.
- `data/`를 다시 만들었다면 `python3 scripts/build_examples.py`도 다시 실행해 `example/4-saved-templates/`를 맞춰 주세요.
