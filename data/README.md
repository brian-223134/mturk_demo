# data/ — 콘솔의 시작 데이터

콘솔이 처음 뜰 때, 그리고 **Mock tools → Reset to fixtures**를 누를 때 읽는 데이터다. 데이터는 JSON으로, 템플릿은 HTML 파일로 관리한다.
서버 모드에서는 이 폴더의 내용이 SQLite로 올라가고, 이후의 변경(검수, 게시, pool)은 DB에 남는다. 이 폴더는 바뀌지 않는다.

```
data/
├─ account.json                  환경과 잔액            { "env": "mock", "AvailableBalance": "500.00" }
├─ pools.json                    worker pool 목록       [ { id, name, description, workerIds } ]
├─ workers.json                  worker에 붙인 정보     { "<WorkerId>": { blocked, note, blockReason? } }
├─ templates/
│  ├─ index.json                 템플릿 목록            [ { id, name, file, updatedAt } ]
│  └─ <file>.html                템플릿 본문 (index.json의 file)
└─ batches/<batchId>/            폴더 이름 = batch.json의 id
   ├─ batch.json                 이름, 설정(HitSettings), attentionRule, pool 조건, inputColumns ...
   ├─ template.html              게시 시점의 템플릿 사본. templates/를 고쳐도 이 batch는 바뀌지 않는다
   ├─ hits.json                  HIT 목록. 한 줄에 HIT 하나. input이 CSV 1행이다
   └─ assignments.json           응답 목록. 한 줄에 assignment 하나
```

필드의 뜻은 설계 명세 4장과 `src/api/types.ts`에 있다. PascalCase는 MTurk API와 같은 이름이고 camelCase는 콘솔이 추가한 것이다.
`placeholders`(템플릿)와 `attention`(assignment)은 파일에 쓰지 않는다. 올릴 때 HTML과 batch의 `attentionRule`에서 계산한다.

## 고치고 반영하기

1. 이 폴더의 JSON이나 HTML을 고친다.
2. 콘솔에서 **Mock tools → Reset to fixtures**를 누른다. (Docker의 api 서비스는 이 폴더를 mount하므로 이미지를 다시 빌드하지 않아도 된다.
   브라우저만으로 도는 mock 모드는 데이터가 번들에 들어 있어서 dev 서버는 바로, 빌드본은 다시 빌드해야 반영된다.)

파일이 서로 맞지 않으면 시작할 때 어느 파일의 무엇이 틀렸는지 알려준다. 예:
`data/batches/batch-1000001/assignments.json: assignment 3ABC... points to unknown HIT NO_SUCH_HIT`

자주 하는 수정:

| 하고 싶은 것 | 고칠 곳 |
|---|---|
| 템플릿 추가 | `templates/`에 `.html`을 넣고 `templates/index.json`에 한 줄 추가. 콘솔의 Create › Template에서 올려도 된다 |
| 잔액 바꾸기 | `account.json`의 `AvailableBalance` |
| pool을 미리 채워 두기 | `pools.json`의 `workerIds` |
| 검수할 건을 늘리기 | `assignments.json`에서 몇 건의 `AssignmentStatus`를 `"Submitted"`로 바꾸고 `ApprovalTime`을 지운다 |
| batch를 통째로 빼기 | `batches/<batchId>/` 폴더를 지운다 |

## 콘솔에서 만든 상태를 시작 데이터로 삼기

시연 전에 콘솔에서 상태를 만들어 두고(예: batch 게시, 가짜 제출 생성, pool 구성) 그것을 시작점으로 삼을 수 있다.

```bash
# 1. 콘솔: Mock tools → Export data (JSON)  →  mturk-console-data-<시각>.json 이 내려받아진다
# 2. 그 파일을 이 폴더 구조로 푼다 (templates/와 batches/를 지우고 다시 쓴다)
npm run data:unpack -- <내려받은 파일>.json
# 3. 콘솔: Mock tools → Reset to fixtures
```

내려받은 JSON 파일 하나를 그대로 주고받을 수도 있다. 받은 사람은 **Mock tools → Import data (JSON)**으로 올린다.

## 이 데이터는 익명화되어 있다

`batches/`의 세 batch는 실제 annotation 작업의 MTurk 결과 CSV를 `scripts/build_fixtures.py`로 변환한 것이고, 공개할 수 있게 익명화했다.

| 항목 | 처리 |
|---|---|
| WorkerId, HITId, AssignmentId | salt를 넣은 해시로 바꿨다. 실제 MTurk의 ID가 아니다 |
| batch id와 이름 | 임의로 붙였다 |
| 입력의 본문 (질문, 문단, fact, reasoning) | 같은 길이의 합성 텍스트(`Synthetic question: Lorem ipsum …`)로 바꿨다. 리스트의 모양과 `'Chunk 0'` 같은 구조용 라벨은 그대로라 템플릿이 그대로 렌더되고, 입력 크기의 분포도 원본과 같다 |
| `idx`, `qid` | 순번으로 바꿨다 |
| 시각 | 통째로 일정한 만큼 옮겼다. 작업시간 같은 간격은 그대로다 |
| HIT의 Title, Description, Keywords | 일반적인 문구로 바꿨다 |
| 응답 값, 검수 상태, 작업시간, 반려 사유 | **그대로다.** 그래서 진행률, 반려율, worker 지표, Fleiss κ가 원본과 같다 |

salt는 저장소에 없다(`scripts/.fixture_salt`, git 제외). salt 없이는 ID를 되돌리거나 대조할 수 없다.

## 자기 데이터로 다시 만들기

MTurk Requester 웹사이트에서 받은 결과 CSV와 템플릿이 있으면 같은 방식으로 `data/`를 만들 수 있다.

```bash
cp scripts/fixture_sources.example.json scripts/fixture_sources.json   # 읽을 CSV와 템플릿을 적는다 (git 제외)
python3 scripts/build_fixtures.py --source <원본 폴더>
npm test          # data/의 규모와 변환 규칙을 확인한다. 기대값은 src/api/mock/data.test.ts에 있다
```

입력 셀이 Python 리터럴(리스트, dict) 문자열이 아닌 CSV라면 `Anonymizer.cell`을 그 형식에 맞게 고쳐야 한다.
`account.json`, `pools.json`, `workers.json`은 사람이 관리하는 파일이라 스크립트가 덮어쓰지 않는다.
