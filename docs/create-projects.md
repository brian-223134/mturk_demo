# Project로 batch 게시하기 (production 콘솔)

production 콘솔(http://localhost:3000)의 Create는 MTurk의 Requester 화면처럼 **Project**를 만든 뒤, Project에 JSON 데이터를 올려 batch를 게시합니다.
Project는 worker에게 보일 화면(layout)과 작업 속성(제목, 보상, 인원, 기간, worker 조건)을 묶은 것입니다. 같은 Project로 batch를 여러 번 게시할 수 있습니다.
프로토타입(http://localhost:8080)의 Create는 이전과 같은 5단계 마법사이며, 그 설명은 [Create로 batch 게시하기](creating-a-batch.md)에 있습니다.

템플릿을 쓰는 요소와 속성은 [`<ann-*>` 요소로 템플릿 쓰기](annotation-elements.md)에 정리되어 있습니다.

## Create의 화면: Project와 batch

Create 위쪽에는 MTurk와 같은 두 갈래가 있습니다. 둘의 차이는 **무엇을 만드느냐**입니다.
그 옆의 `Tutorial` 탭(`/create/tutorial`)은 이 문서의 내용을 따라 하기 순서로 줄인 안내이며, 오른쪽 위에서 한국어(`KR`)와 영어(`EN`)를 고릅니다. 단계마다 그 화면으로 바로 가는 버튼이 있습니다.

| | `New Project` | `New Batch with an Existing Project` |
|---|---|---|
| 만드는 것 | **Project**: 어떤 작업인지 정한 틀 | **batch**: 그 틀에 실제 데이터를 넣어 worker에게 내보낸 한 번의 게시 |
| 담는 것 | worker가 보는 화면(layout), 제목·설명, 보상, HIT당 응답 수, 기간, worker 조건, 검수 설정의 기본값, 미리보기용 표본 값 | HIT 데이터(JSON 객체 하나 = HIT 하나), 이번 게시의 검수 설정(attention, 자유 서술, 대조 기준), batch 이름 |
| 하는 일 | 갤러리에서 시작 방법을 고르고 Enter Properties, Design Layout, Preview and Finish로 만듭니다 | Project 목록에서 `Publish Batch`를 눌러 JSON을 올리고 게시합니다. Project를 고치거나(`Edit`) 복사·삭제도 여기서 합니다 |
| 횟수 | 작업 종류마다 한 번 | 같은 Project로 여러 번 (예: 파일럿 20개, 본 실험 400개) |
| 결과 | 저장된 Project. 아직 worker에게는 아무것도 나가지 않습니다 | Manage에 나타나는 batch와 HIT. 비용이 잔액에서 빠집니다 |

예를 들어 "passage가 fact를 지지하는지 판정하는 작업"은 Project 하나입니다. 그 Project로 이번 주 데이터를 올리면 batch 하나가 생기고, 다음 주에 다른 데이터를 올리면 batch가 하나 더 생깁니다.
Project를 고쳐도 이미 게시한 batch는 게시할 때의 layout 사본을 갖고 있어서 바뀌지 않습니다.

**원본 데이터에서 자동으로 만들 때**(`New Project` → `Generate from raw data`)는 두 단계가 이어집니다.

1. 모델만 다른 agent **job** 세 개(후보 A, B, C)가 동시에 돌며, 후보마다 layout(`template.html`), HIT 데이터(`hits.json`), 설정(`settings.json`)을 만듭니다. 후보는 Project가 아니며, `Generate from raw data`의 `Templates` 목록에만 있습니다.
2. 후보를 나란히 비교하고 `Choose this template`으로 하나를 고르면, 그 후보의 layout과 설정이 **Project**로 저장되고 `hits.json`의 HIT 데이터가 올라간 **Publish Batch**가 열립니다. 그 뒤로는 일반 Project와 같습니다.

그래서 화면에 미리보기가 세 군데 있고, 보는 것이 다릅니다.

| 어디서 | 화면 | 보는 것 |
|---|---|---|
| 후보 묶음의 `Compare and choose` | New Project → Generate from raw data → `Templates` 목록 | 후보마다 LLM에 준 prompt, LLM이 쓴 명세(`Task spec`), HIT 한 행의 worker 화면, 평가 메모. 나란히 비교하고 Project로 쓸 후보를 고릅니다 |
| Project 편집기의 `Preview and Finish` | 목록의 `Edit` → 세 번째 탭 | Project의 속성 요약과, 표본 값으로 그린 worker 화면 |
| Publish Batch의 `Preview tasks` | 목록의 `Publish Batch` → 두 번째 단계 | 올린 데이터의 HIT를 하나씩 넣은 실제 worker 화면 |

자동 생성 결과로 만든 Project에는 후보 비교 화면이 없습니다. 그 Project의 명세와 prompt를 다시 보려면 Generate from raw data의 `Templates` 목록에서 같은 이름의 묶음을 찾습니다. 고른 후보에는 `Chosen`이 표시되어 있습니다.

## Project 목록

Project마다 이름, layout의 종류, worker에게 보일 제목, 보상, HIT당 응답 수, layout이 읽는 데이터 컬럼, 마지막 수정 시각이 보입니다.
layout의 종류는 `Elements`(`<ann-*>` 요소), `crowd-html`(MTurk의 crowd-html-elements를 외부에서 불러오는 템플릿), `HTML`(그 밖의 HTML) 중 하나로 표시됩니다.

행마다 버튼이 네 개 있습니다.

- `Publish Batch`: 이 Project에 JSON 데이터를 올려 batch를 게시합니다.
- `Edit`: Project 편집기를 엽니다.
- `Copy`: 이름 뒤에 `(copy)`를 붙인 사본을 만들고 그 편집기를 엽니다.
- `Delete`: Project를 지웁니다. 이미 게시한 batch는 게시할 때의 layout 사본을 따로 가지고 있으므로 영향을 받지 않습니다.

게시하다 만 batch가 있으면 목록 위에 `Continue publishing`이 표시됩니다.
시작 데이터의 두 템플릿(`Chunk-Fact Relevance`, `Query-Fact Coverage`)도 Project로 보입니다. 속성이 저장되어 있지 않으므로 제목 칸에 `Not set (defaults are used)`가 표시되고, 편집기를 열면 기본값이 채워져 있습니다.

## New Project

`New Project`의 첫 카드는 `Draft with AI`입니다. 데이터와 한 줄 목표를 주면 AI가 annotation 단위(sentence, chunk, document, full video, frame), 문항, 페이지를 먼저 정하고, 사람은 대화 한 곳에서 고칩니다([AI로 초안 만들기](#ai로-초안-만들기-draft-with-ai)). 화면 배치를 직접 고르려면 그 뒤의 가안(rough design) 5개 중 하나를 고르고, 맞는 가안이 없으면 `F. Others`를 고르고 원하는 화면을 문장으로 설명합니다. 다른 방법으로 시작하려면 같은 화면 아래의 `Other ways to start`를 씁니다.

### rough design으로 시작하기

1. **`Rough design`**: 도형으로 그린 가안 5개와 `Others` 중 하나를 고르고 `Next`를 누릅니다. 이 단계에서는 칸의 자리만 보입니다.
2. **`Task type and preview`**: `Vision`, `Video`, `Text` 중 하나를 고르면 고른 가안에 예시 자료를 넣은 worker 화면이 아래에 나옵니다. 종류를 바꾸면 미리보기도 바로 바뀌고, `Submit`을 누르면 제출되었을 답을 보여 줍니다.
3. **`HIT data`**: 이미 HIT로 묶인 JSON을 올려 실제 데이터로 미리 봅니다. 아래 [HIT 데이터를 가안에 넣어 보기](#hit-데이터를-가안에-넣어-보기)에 정리되어 있습니다. `Use this design`을 누르면 Project가 저장되고, 정렬한 데이터가 올라간 Publish Batch가 열립니다. 이름과 layout이 모두 같은 Project가 이미 있으면 새로 만들지 않고 그 Project를 씁니다. 데이터 없이 예시 layout만 저장하려면 `Save the sample layout without data`를 누릅니다.

| 가안 | 이름 | 배치 | 답 |
|---|---|---|---|
| A | `Side by side` | 왼쪽 위 데이터, 오른쪽 위 HIT, 아래 넓은 약술형 칸 | 객관식, 약술형(선택) |
| B | `Stacked` | 위 데이터, 아래 왼쪽 객관식, 아래 오른쪽 약술형 | 객관식, 약술형(선택) |
| C | `Comparison` | 위에 데이터 두 칸, 아래 고르는 문항 | 둘 중 하나 또는 비슷함 |
| D | `Tabs` | 탭 3개, 탭마다 데이터와 객관식 | 탭마다 객관식 |
| E | `Item by item` | 왼쪽 데이터, 오른쪽 항목 목록 | 항목마다 라디오로 하나 고르기 |
| F | `Others` | 정해진 배치 없음. 데이터를 올린 뒤 문장으로 설명 | 요청에 따라 LLM이 고름 |

`Others`는 2단계에 예시 미리보기가 없고, `Save the sample layout without data`도 없습니다. 3단계의 칸이 `What should workers judge, and how should the page look?`로 바뀌며, 요청 전에 보이는 배치는 임시입니다. LLM이 요청과 데이터를 보고 칸과 자리를 정해 `layout`을 씁니다. 그 뒤로는 [칸의 배치 바꾸기](#칸의-배치-바꾸기)와 같습니다. 다른 가안에서 `F. Others`로 넘어오면 지금 배치에서 출발합니다. 만든 배치는 그 Project에만 저장되며, 다음 Project의 가안 목록에는 나오지 않습니다.

`Save the sample layout without data`로 저장한 Project의 데이터 컬럼은 task 종류와 가안에 따라 정해지며, 2단계 미리보기 위의 `Sample data columns`에 나옵니다.

| task 종류 | 데이터 컬럼 | 값 |
|---|---|---|
| `Vision` | `image_url` | 이미지 주소 |
| `Video` | `video_url` | 영상 주소 |
| `Text` | `text` | 보여 줄 글 |

`Comparison`은 컬럼 이름 뒤에 `_a`, `_b`가, `Tabs`는 `_1`~`_3`이 붙습니다. `Item by item`에는 항목 목록을 배열로 적는 `items` 컬럼이 더 있습니다.

2단계 미리보기의 자료와 문항은 예시입니다. `Video` 미리보기에는 영상 파일 대신 표본 그림을 플레이어 모양으로 보여 주며, 데이터에 영상 주소를 넣으면 실제 플레이어가 나옵니다.

### HIT 데이터를 가안에 넣어 보기

`HIT data` 단계에서는 객체 하나가 HIT 하나인 JSON 배열을 올립니다. 파일은 서버로 보내지 않고 브라우저 탭에만 둡니다. 새로고침하면 다시 올려야 하지만, 같은 탭에서 앞 단계에 다녀오면 남아 있습니다.

파일을 올리면 첫 binding이 채워지고 오른쪽에 첫 HIT의 worker 화면이 나옵니다. binding은 **어떤 값이 어느 칸에 들어갈지** 적은 JSON입니다. 첫 binding은 글이 가장 긴 컬럼만 데이터 칸에 넣은 출발점이므로, 왼쪽 폼에서 고치거나 `Upload binding`으로 파일을 올리거나 [LLM에게 쓰게 합니다](#llm에게-binding-쓰게-하기). 위쪽에서 가안이나 task 종류를 바꾸면 값이 새 칸으로 옮겨지고, LLM을 부르지 않으므로 바로 다시 그려집니다.

폼은 칸마다 무엇을 넣을지 드롭다운으로 고릅니다. 목록은 올린 파일의 구조에서 만들며, 탭이 있으면 목록 컬럼이 `column[i]`로 나오고 `qid`나 `*_check`처럼 worker에게 보이지 않을 법한 값은 뒤로 갑니다. 문항, 선택지, 대조 기준, attention도 여기서 고칩니다. 폼과 `Edit as JSON (advanced)`의 편집기는 같은 binding을 고치므로 한쪽을 고치면 다른 쪽이 따라옵니다. 사람이나 LLM이 쓴 경로가 목록에 없어도 지우지 않고 그대로 보입니다.

```json
{
  "design": "item-list",
  "task_type": "text",
  "repeat": {
    "over": "retrieved_chunk",
    "label": "Chunk"
  },
  "slots": {
    "data": [
      {
        "label": "Query",
        "from": "query[i]"
      },
      {
        "label": "Chunk",
        "from": "retrieved_chunk[i]"
      }
    ],
    "item-choice": {
      "name": "supported",
      "header": "Does this chunk support each atomic fact?",
      "items": "atomic_facts[i]",
      "options": [
        [
          "grounded",
          "Grounded"
        ],
        [
          "not_grounded",
          "Not grounded"
        ]
      ]
    }
  },
  "reference": {
    "selected": "chunk_fact_relevance_check",
    "key": "Chunk {i}",
    "item": "Atomic fact{n}",
    "yes": "grounded",
    "no": "not_grounded"
  },
  "attention": {
    "flag": "attention_check[i]",
    "expected": "not_grounded"
  },
  "instructions": "For each chunk, read the query and the chunk, then decide whether the chunk supports each atomic fact."
}
```

| 키 | 설명 |
|---|---|
| `design`, `task_type` | 가안(`side-by-side`, `stacked`, `compare`, `tabs`, `item-list`)과 종류(`vision`, `video`, `text`)입니다. |
| `repeat` | HIT 안의 항목마다 탭을 하나씩 만듭니다. `over`는 목록을 가리키는 경로, `label`은 탭 제목입니다. `Tabs` 가안에는 필수입니다. |
| `slots.data` (`Comparison`은 `data-a`, `data-b`) | 데이터 칸입니다. `{ "label", "from" }`이며, 여러 값을 보이려면 배열로 씁니다. `kind`(`image`, `video`, `text`)를 주면 값을 그 모양으로 보입니다. 기본은 task 종류를 따르므로, Vision·Video에서 글을 함께 보이려면 그 값에 `"kind": "text"`를 줍니다. |
| `slots.choice`, `slots.compare` | 객관식입니다. `header`, `name`, `options`(`["yes", "no"]` 또는 `[["yes", "Yes"], …]`)를 씁니다. |
| `slots.item-choice` | 항목마다 라디오로 하나를 고릅니다. `header`, `name`, `options`, `items`(경로나 글 목록)를 씁니다. 모든 항목에 답해야 제출할 수 있습니다. |
| `slots.free-text` | 약술형입니다. `header`, `name`, `placeholder`를 씁니다. |
| `context` | 어느 칸에도 맞지 않지만 worker가 읽어야 하는 값입니다. 데이터 칸과 같은 모양이고, 칸들 위에 글로 보입니다. 예를 들어 비교할 두 답의 질문입니다. |
| `reference` | 데이터의 기존 라벨로 Review의 대조 기준을 만듭니다. 아래 표를 봅니다. |
| `attention` | `flag`는 항목이 attention인지 가리키는 경로이고, `expected`는 그 항목에 와야 할 답입니다. `expected`가 있으면 게시할 때 판정합니다. |
| `instructions` | worker에게 보일 안내문입니다. 없으면 task 종류의 예시 안내문을 씁니다. |
| `layout` | 가안과 다른 배치입니다. 없으면 가안의 배치를 씁니다. 아래 [칸의 배치 바꾸기](#칸의-배치-바꾸기)에 정리되어 있습니다. |
| `unused` | 가안을 바꿀 때 새 가안에 없는 문항을 보관하는 자리입니다. 직접 쓰지 않아도 됩니다. |

경로는 컬럼 이름 뒤에 `[i]`(지금 탭의 항목), `[0]`(번호), `.key`(객체의 키)를 붙입니다. 셀이 `"['a', 'b']"` 같은 Python 리스트 문자열이어도 구조로 읽습니다.

`reference`는 라벨의 모양에 따라 셋 중 하나로 씁니다. 키의 `{i}`는 0부터 세는 탭 번호, `{n}`은 1부터 세는 항목 번호입니다.

| 모양 | 쓰는 경우 |
|---|---|
| `{"value": "<경로>"}` | 칸마다 라벨이 있을 때입니다. `item-choice`면 항목 순서의 목록입니다. |
| `{"map": "<경로>", "key": "general_{i}_{n}"}` | 키에 번호가 든 객체일 때입니다. |
| `{"selected": "<경로>", "key": "Chunk {i}", "item": "Atomic fact{n}", "yes": "…", "no": "…"}` | 긍정인 항목만 적힌 목록일 때입니다. 적히지 않은 항목은 `no`입니다. |

라벨이 문항의 선택지에 없거나 앞쪽 HIT에서 라벨을 찾지 못하면 오류로 알립니다. attention 항목은 대조 기준에서 빠집니다.

- 잘못된 binding은 이유를 알리고 미리보기와 `Use this design`을 막습니다. 예를 들어 없는 컬럼, 가안에 없는 칸, `repeat` 없이 쓴 `[i]`가 그렇습니다.
- Vision·Video의 칸에 주소가 아닌 값이 들어가면 오류로 알립니다.
- worker에게 보일 글(안내문, 문항, 라벨, 선택지)은 영어로 씁니다. 한글이나 한자, 가나가 있으면 오류로 알리고, LLM이 쓴 답이면 다시 쓰게 합니다. 데이터의 값은 검사하지 않습니다.
- binding에 없는 문항 칸은 예시 문항으로 보이고 경고합니다. 게시 전에 실제 문항으로 바꿉니다.
- HIT마다 항목 수가 다르면 가장 큰 수만큼 탭을 만들고 경고합니다. 짧은 HIT에는 빈 탭이 남습니다.

게시용 데이터는 칸마다 새 컬럼(`slot_data_1`, `slot_item_choice_1` …)을 만들고, binding이 쓰지 않은 원래 컬럼(`qid`, `attention_check` 등)은 그대로 둡니다. 글은 HTML로 해석되지 않게 바꿔 넣습니다.

`reference`와 `attention.expected`가 있으면 `slot_reference`, `slot_attention` 컬럼을 만들고 `Review settings`에 미리 채웁니다. 두 컬럼은 worker에게 보내지 않습니다. 가안을 바꿔 문항 칸이 달라지면 이 둘은 `unused`에 보관했다가, 돌아오면 되살립니다.

[example/6-rough-design/](../example/6-rough-design/)에 합성 데이터와 손으로 쓴 binding이 있으니 그대로 올려 볼 수 있습니다.

### 영상 데이터 쓰기

worker 브라우저가 영상을 받을 수 있어야 하므로, 파일을 콘솔이 서빙하는 폴더에 둡니다.

1. `.mp4` 파일을 `var/video-demo/`에 넣습니다. `var/`는 저장소에 들어가지 않습니다.
2. 이 폴더와 서빙 설정은 frontend 컨테이너를 만들 때 적용되므로 `docker compose up -d --build frontend`를 한 번 실행합니다. 그 뒤로 파일을 추가할 때는 다시 할 필요가 없습니다.
3. HIT 데이터의 값에 `/media/<파일 이름>.mp4`를 씁니다. 다른 서버의 영상 주소를 써도 됩니다.
4. New Project에서 task 종류를 `Video`로 고르고 그 JSON을 올립니다. 영상과 함께 글을 보이려면 그 값에 `"kind": "text"`를 붙입니다.

```json
[{ "video_url": "/media/clip_001.mp4", "question": "Who was working at the trays?" }]
```

- **내려 주는 파일**: `/media/`에서는 `.mp4`만 내려 줍니다. 같은 폴더의 다른 파일(정답이 든 `.json` 등)과 하위 폴더는 404입니다. 정답 파일을 함께 두어도 worker가 받을 수 없지만, `.mp4` 파일 자체는 로그인 없이 주소만 알면 받을 수 있습니다.
- **파일 준비**: 긴 영상은 메타데이터가 파일 앞쪽에 있어야 받으면서 바로 재생하고 옮길 수 있습니다(ffmpeg의 `-movflags +faststart`). 코덱은 브라우저가 재생할 수 있는 H.264를 권합니다.
- **프레임 확인**: 플레이어의 조작은 [요소 설명](annotation-elements.md#ann-video)에 있습니다.
- **`Generate from raw data`**: agent가 만드는 템플릿에도 같은 조작이 있습니다. spec의 필드에 `"style": "video"`를 쓰며, `context` 역할에만 쓸 수 있습니다. 원본 데이터에서 영상을 읽어 HIT를 만드는 일은 아직 없습니다.

### LLM에게 binding 쓰게 하기

`HIT data` 화면의 `What should workers judge?`에 요청 문장을 적고 `Allow API calls`를 체크한 뒤 `Write the binding`을 누릅니다. 유료 호출이므로 서버의 `AGENT_ALLOW_API=1`과 이 체크가 모두 있어야 합니다.

- **보내는 것**: 고른 가안의 칸 목록, task 종류, 요청 문장, 데이터 요약입니다. 요약에는 컬럼마다 값의 모양과 잘린 표본(HIT 두 개)만 들어가며, 파일 전체는 보내지 않습니다.
- **받는 것**: 같은 형식의 binding 하나입니다. 브라우저가 바로 검사하고, 오류가 있으면 오류와 이전 답을 붙여 최대 3번까지 묻습니다. 그래도 오류가 남으면 마지막 답을 편집기에 두고 알립니다.
- **탭마다 다른 값**: 표본은 앞쪽 몇 개뿐이라, 목록의 서로 다른 값 수를 전체 HIT에서 세어 함께 보냅니다. 탭이 있는데 탭마다 값이 다른 목록을 `query[0]`처럼 고정 번호로 읽으면 일부 탭에 틀린 값이 보이므로 오류로 알립니다. 탭마다 자기 값을 보이려면 `[i]`를 씁니다.
- **결과 확인**: 답은 폼과 편집기에 들어가고 미리보기가 바뀝니다. 직접 고칠 수 있습니다. 쓴 모델과 시도 횟수, 비용은 답마다 나옵니다.

LLM은 binding만 쓰고 HTML은 쓰지 않습니다. 화면은 코드가 만들므로 답 형식과 Review 호환은 사람이 쓴 binding과 같습니다. 호출마다 요청과 응답이 `output/bindings/` 아래에 남습니다.

#### 요청으로 고치기

binding을 쓴 뒤에는 같은 칸이 `What should change?`로 바뀌고, 버튼은 `Revise the binding`이 됩니다. 폼이나 편집기로 고쳤거나 `Upload binding`으로 올린 binding도 같습니다. 요청과 답은 패널 위쪽에 대화처럼 쌓입니다.

- **보내는 것**: 처음 쓸 때의 내용에 지금 binding과 앞선 요청(최근 5개)을 더합니다. 가안을 바꿀 때 보관해 둔 값(`unused`)은 보내지 않고, 답에 그대로 다시 붙입니다.
- **받는 것**: 고친 binding 전체와 무엇을 했는지 적은 설명입니다. 처음 쓸 때와 같이 검사하고 오류를 붙여 최대 3번까지 묻습니다.
- **변경 표시**: 답마다 바뀐 항목을 이전 값과 새 값으로 보입니다. 대조 기준, attention, 문항 칸이 사라지면 빨간색으로 표시합니다. 그런 요청을 했는지는 코드가 알 수 없으므로, 막지 않고 알립니다.
- **되돌리기**: 대화의 각 답, 첫 binding, 요청 직전에 사람이 고친 binding으로 `Restore`를 눌러 돌아갑니다. 첫 binding으로 돌아가면 칸이 다시 `Write the binding`이 됩니다. 다른 파일을 올리면 대화를 비웁니다.

LLM이 할 수 없는 요청은 binding을 바꾸지 않고 이유만 답합니다.

| 요청 | 화면 |
| --- | --- |
| 다른 가안이나 task 종류 | 이유와 함께 위쪽의 `Rough design`, `Task type` 버튼으로 안내하고, `Show the buttons`를 누르면 그 자리를 강조합니다 |
| 이미지에 영역 그리기, 같은 종류의 칸 두 개, 탭 밖의 칸, 높이나 색 지정처럼 binding으로 나타낼 수 없는 것 | 이유만 보입니다 |

일부만 할 수 있는 요청은 그 부분만 고치고, 설명에 남은 것을 적습니다.

#### 칸의 배치 바꾸기

"문항을 왼쪽으로", "Chunk를 더 넓게", "아래에 의견 칸을 추가해 줘"처럼 요청하면 LLM이 `layout`을 씁니다. 처음 쓸 때의 요청에 적어도 됩니다.

```json
{ "rows": [{ "columns": "3fr 2fr", "slots": ["data", ["choice", "free-text"]] }] }
```

- **`rows`**: 위에서 아래로 놓는 줄입니다. 최대 6개입니다.
- **`slots`**: 왼쪽에서 오른쪽으로 놓는 열입니다. 한 줄에 최대 3개입니다. 목록으로 쓰면 그 열에 칸을 위아래로 쌓습니다.
- **`columns`**: 열마다 하나씩 적는 폭입니다. `3fr 2fr`처럼 1~99의 숫자에 `fr`을 붙이고, 없으면 같은 폭입니다.

칸은 한 번씩만 놓을 수 있고, 데이터 칸과 문항 칸이 하나씩은 있어야 합니다. `data-a`와 `data-b`는 함께 놓고, `compare`는 이 둘이 있어야 합니다. 어긋나면 오류를 붙여 다시 묻습니다. 안내문, `context`, 탭, `Submit`의 자리는 바꿀 수 없고, 탭이 있으면 모든 줄과 `context`가 탭 안에서 되풀이됩니다. `data`에 쌓인 값 중 하나만 전체 폭으로 올리려면 `context`로 옮깁니다.

LLM이 받는 배치 요소의 설명은 `agent/binding_reference.md`의 `Laying out the page`입니다. 칸 표와 예시가 코드와 어긋나면 frontend 테스트가 실패합니다.

고친 배치는 그 가안에 속합니다. 다른 가안으로 옮겼다가 돌아오면 되살아나고, 위쪽의 `Use the rough design layout`을 누르면 가안의 배치로 돌아갑니다. 이때 가안에 없는 칸의 값은 보관됩니다.

모델 설정은 `deepseek-v4.1-flash`(`environment/models/deepseek-v4.1-flash.yaml`)이고, `environment/.env`의 `AGENT_BINDING_MODEL`로 바꿀 수 있습니다. 형식 설명서는 [agent/binding_reference.md](../agent/binding_reference.md)입니다.

### AI로 초안 만들기 (Draft with AI)

`New Project`의 첫 카드인 `Draft with AI`를 고르고 `Next`를 누르면 `/create/new/describe`로 갑니다. framework의 Pipeline Design 단계와 같이, 데이터와 한 줄 목표를 주면 AI가 먼저 annotation 단위, 보여 줄 값과 문항, 페이지의 모양을 정하고, 사람은 그 초안을 보며 대화 한 곳에서 고쳐 나갑니다. 문항은 개수 제한이 없고 `Pick one`(라디오), `Score`(점수), `Check all that apply`(체크리스트), `One answer per item`(항목마다 라디오), `Written answer`(자유 서술)를 섞어 쓸 수 있습니다.

#### 올릴 수 있는 데이터

어느 정도 정리된 JSON이면 모양에 상관없이 기록(record) 목록을 찾아 읽습니다. 파일은 이 탭에만 있고, LLM에는 구조와 잘린 표본만 갑니다.

- 기록의 목록: `[{...}, {...}]`. 값만 있는 목록(`["text", ...]`)은 기록마다 `value` 하나가 됩니다.
- 기록을 감싼 객체: `{"dataset": "...", "items": [{...}]}`. 깊이 3까지에서 가장 긴 객체 목록을 기록으로 읽고, 목록 옆의 단순 값(`dataset`, `version` 등)은 기록마다 복사합니다.
- id로 묶인 객체: `{"clip-01": {...}, "clip-02": {...}}`. 이름은 `key` 컬럼이 됩니다.
- JSON Lines(`.jsonl`): 줄마다 기록 하나입니다.
- 기록 하나뿐인 객체도 받습니다. 기록 안의 객체와 목록은 그대로 두고 `meta.title`, `chunks[i]` 같은 경로로 읽습니다. 이름에 빈칸이나 점이 있는 키는 `_`로 바꿉니다.

어디서 몇 개를 읽었는지는 업로드 칸 아래에 표시됩니다. 예시 파일은 [example/7-draft-with-ai/](../example/7-draft-with-ai/)에 있습니다.

#### AI가 먼저 정하는 것

목표 칸(`What should workers label?`)에 한 줄을 적고 `Allow API calls`를 체크한 뒤 `Draft the task`를 누릅니다(유료 호출). 목표를 비워 두면 AI가 데이터의 라벨 컬럼 등으로 목표를 짐작하고, 무엇을 가정했는지 알려 줍니다. 정답이 든 컬럼을 함께 적으면 Review가 그 값과 대조합니다.

AI는 먼저 **annotation 단위**를 정합니다. 단위는 답 하나가 무엇에 대한 것인지입니다.

| 데이터 | 단위 |
|---|---|
| 글 | `Document`(글 전체), `Chunk`(문단이나 데이터에 있는 chunk 목록), `Sentence`(문장) |
| 이미지 | `Image` |
| 영상 | `Full video`(클립 전체), `Frame`(한 장면) |

데이터의 라벨이 문장마다 하나면 문장, chunk마다 하나면 chunk를 고르는 식으로 정하고, 그 이유를 `The task`의 단위 상자에 보입니다. AI는 계획만 쓰고, 기록을 HIT로 바꾸는 일은 콘솔의 코드가 합니다.

- **글 나누기**: 데이터에 문서 전체만 있으면 글을 문장이나 문단으로 나눠 새 목록 컬럼(예: `summary_sentences`)을 만듭니다. 원래 글은 그대로 남아 맥락으로 보일 수 있습니다.
- **기록 묶기**: 문장 하나가 기록 하나이고 같은 문서의 기록이 `doc_id` 같은 컬럼을 공유하면, 같은 값의 기록을 HIT 하나로 묶습니다. 모든 묶음에서 값이 같은 컬럼(`doc_title`)은 하나로 남고, 나머지(`sentence`, `label`)는 기록마다 하나씩인 목록이 됩니다.
- **HIT당 단위 수**: 단위가 많으면(대략 10개 넘게) HIT를 여러 개로 자릅니다. 잘린 HIT에는 몇 번째 부분인지(`unit_part`)와 첫 단위의 번호(`unit_start`)가 남고, 단위 목록과 길이가 같은 목록(라벨 등)도 함께 잘립니다. 미리보기의 HIT 목록에 `HIT 2 (part 2)`처럼 표시됩니다.
- **영상 frame**: 데이터에 frame 이미지 목록이나 시각 목록(초 또는 `m:ss`)이 있을 때만 frame 단위를 고릅니다. 시각이면 그 시각에 멈춘 영상을 보이고, 카드에 `This item is the frame at 0:01.50.`과 `Go to the frame` 버튼이 나옵니다. 영상 주소만 있으면 `Full video`로 정하고 이유를 알립니다.

목록 길이가 HIT마다 다르면 짧은 HIT에서 남는 탭(보일 값이 모두 빈 탭)은 숨기고, 그 안의 문항은 필수에서 뺍니다.

AI는 페이지의 모양도 짧은 문장 몇 개(`How the page looks`)로 정합니다. 문장이 있으면 페이지 LLM이 기본 배치를 그대로 다시 쓰고, 판정 LLM이 그린 페이지를 문장마다 대조합니다(아래). 문장이 없으면 기본 배치(값 다음 문항)를 씁니다.

#### 대화 한 곳에서 고치기

초안이 생기면 목표 칸이 `Ask for a change`로 바뀝니다. 과제의 내용, 단위, 페이지의 모양 중 무엇을 바꾸든 이 칸 하나에 적고 `Send`를 누릅니다(유료 호출, Ctrl/Cmd+Enter도 됩니다). AI가 요청이 무엇에 대한 것인지 판단해 그 부분만 바꿉니다.

- 내용: "add a 1 to 5 confidence question", "rename the options to Supported and Not supported"
- 단위: "make it sentence level", "one HIT per document". 단위 상자의 `Ask for another unit` 버튼(`Document`, `Chunk` 등)을 누르면 같은 요청이 대화로 갑니다.
- 페이지: "put the passage on the left and the questions on the right", "make the options green"

과제가 바뀌면 페이지도 자동으로 다시 쓰고 판정합니다. 답 하나에 AI의 설명, 바뀐 점(단위, 값, 문항, 대조 기준, 페이지 문장), 페이지 결과와 판정이 함께 나옵니다. 문항이 없어지거나 대조 기준·attention이 사라지면 빨간색으로 표시하며, `Restore`를 누르면 그때의 과제와 페이지로 함께 돌아갑니다(호출 없음). 처음부터 다시 하려면 `Start over`를 누릅니다.

대화 대신 직접 고칠 수도 있습니다.

- **폼으로 고치기**: `Edit the task`에서 안내문, 항목 반복과 HIT당 단위 수(`Units per HIT`), 페이지 문장(`How the page looks`, 한 줄에 하나), 보여 줄 값, 문항, 대조 기준, attention을 고칩니다. 문항을 지우면 그 문항의 대조 기준과 attention도 함께 지워집니다. 단위는 대화로 바꿉니다.
- **JSON으로 고치기**: `Edit as JSON (advanced)`.

직접 고친 뒤에는 페이지가 바뀐 내용을 아직 따르지 않을 수 있어 `The page`에 안내와 `Arrange the page again` 버튼이 나옵니다. 고친 과제와 맞지 않게 된 페이지는 쓰지 않고 기본 배치로 돌아갑니다.

#### 페이지 판정

다시 쓴 페이지는 화면 밖에서 실제로 그려 칸의 위치, 폭, 탭, 굵기, 글자 크기, 색, 강조 상자를 재고, 판정 LLM이 페이지 문장을 하나씩 `met`(✓), `not met`(✗), `unclear`(?)로 판정합니다(유료 호출). 맞지 않는 것이 있으면 페이지 LLM에게 고쳐 달라고 다시 묻고, 끝까지 남으면 페이지는 쓰되 경고로 보입니다. 과제가 정한 것(정답을 보이지 않는다, 단위마다 다른 값은 단위마다 보인다)과 어긋나는 요구는 판정하지 않고 `unclear`로 둡니다.

Project 이름을 확인하고 `Use this task`를 누르면 Project가 저장되고, 단위대로 만든 HIT와 대조 기준·attention 설정이 Publish Batch로 넘어갑니다.

#### 콘솔의 검사

콘솔은 LLM의 답을 그대로 쓰지 않고 검사합니다. 걸리면 오류를 붙여 최대 3번 다시 묻고, 그래도 남으면 쓰지 않습니다.

- 단위: 단위가 있는지, 나눌 글과 묶을 컬럼이 데이터에 있는지, frame 단위에 영상이나 이미지 값이 있는지, frame 시각을 읽을 수 있는지 봅니다. HIT를 자르는 것은 키에 번호가 든 대조 기준(`map`, `selected`)과 함께 쓸 수 없습니다.
- 과제: 단위대로 만든 HIT에 있는 경로인지, 문항 이름과 선택지가 맞는지, worker에게 보일 글이 영어인지 봅니다. 정답·attention 컬럼이나 정답처럼 보이는 컬럼(`gold`, `labels`, `attention`, `..._check` 등)을 화면 값으로 쓰면 막습니다. 단위마다 다른 목록을 통째로 또는 고정 번호로 읽는 것도 모든 HIT를 세어 막습니다.
- 페이지: 기본 배치의 값과 문항이 모두 같은 이름과 자리로 남아 있는지, 정답 컬럼을 쓰지 않는지, 허용한 요소만 쓰고 스크립트·외부 주소가 없는지 봅니다. 한 단위의 값을 모든 단위의 값처럼 한 번 더 보이거나, 값을 접힌 상자에 숨기는 것도 막습니다.

LLM 없이 과제를 붙여 넣어 시작할 수도 있습니다(`Paste a task contract instead`). 형식 설명서는 [agent/contract_reference.md](../agent/contract_reference.md), [agent/html_reference.md](../agent/html_reference.md), [agent/layout_reference.md](../agent/layout_reference.md)입니다. 같은 흐름을 시나리오로 시험하는 방법은 [scripts/html_experiment/README.md](../scripts/html_experiment/README.md)에 있습니다.

판정은 잰 값만 보므로 그림의 내용이나 글의 뜻은 판단하지 못하고, 판정 자체가 틀릴 수 있습니다. 미리보기도 함께 확인합니다. 글은 문장 부호와 줄바꿈으로 나누므로 약어(`Dr.`)가 많은 글은 문장이 잘못 나뉠 수 있습니다.

### 앞으로 할 일

1. **원본 파일 올리기**: `Draft with AI`는 정리된 JSON을 단위대로 묶고 나누지만, 가안으로 시작하는 흐름은 아직 이미 HIT로 묶인 파일만 받습니다. attention 항목을 만드는 일도 아직 없습니다.

### 다른 방법으로 시작하기

왼쪽에서 시작할 것을 고르면 오른쪽에 설명과 실제 미리보기가 나옵니다. 미리보기는 표본 데이터로 그린 worker 화면 그대로이며, `Submit`을 누르면 제출되었을 답을 보여 줍니다.
`Create Project`를 누르면 그 내용으로 새 Project 편집기가 열립니다.

starter 템플릿은 아홉 가지입니다. 모두 `<ann-*>` 요소로 쓴 수십 줄짜리 HTML입니다.

| 분류 | 이름 | 데이터 컬럼 | 답 |
|---|---|---|---|
| Retrieval & grounding | `Passage relevance` | `query`, `passage` | `relevance`: relevant, partially_relevant, not_relevant |
| | `Statement support (checklist)` | `passage`, `facts`(배열) | 항목마다 `supported_<n>`: supported, not_supported |
| | `Several passages per HIT (tabs)` | `query`, `passage_1`~`passage_3` | 탭마다 `relevance_<n>`: relevant, not_relevant |
| Text | `Text classification` | `text` | `sentiment`: positive, negative, mixed, neutral |
| | `Multi-label tagging` | `text` | 태그마다 `topic_<태그>`: yes, no |
| | `Answer rating (scale)` | `question`, `answer` | `helpfulness`: 1~5, `comment`: 자유 서술(선택) |
| | `Pairwise comparison` | `prompt`, `response_a`, `response_b` | `preference`: a, b, same, `reason`: 자유 서술 |
| | `Free-text writing` | `passage` | `summary`: 자유 서술(30자 이상) |
| Other | `Blank layout` | `text` | `answer`: yes, no |

그 밖의 시작 방법이 두 가지 있습니다.

- **`Upload or paste HTML`**: 빈 layout으로 시작해 Design Layout에서 파일을 올리거나 HTML을 붙여 넣습니다. `${컬럼명}`이나 `window.TASK_DATA`를 쓰는 기존 템플릿, `<crowd-form>`을 쓰는 MTurk 템플릿도 그대로 동작합니다.
- **`Generate from raw data`**: 원본 데이터와 prompt로 agent가 layout과 HIT 데이터를 만듭니다. 아래 [원본 데이터에서 자동으로 만들기](#원본-데이터에서-자동으로-만들기)에 정리되어 있습니다.

## 원본 데이터에서 자동으로 만들기

`New Project` → `Generate from raw data`는 원본 데이터(JSON)와 "무엇을 판정하게 할지" 적은 prompt로 agent job을 돌립니다. `Generate`를 누르면 같은 원본과 prompt로 모델만 바꾼 후보 세 개가 동시에 돌고, 끝나면 비교해서 하나를 고릅니다.
job은 원본의 구조를 분석하고(`profile`), LLM이 작업 명세 `task_spec.json`을 쓰고(`plan`), 코드가 그 명세대로 데이터를 HIT로 자르고(`preprocess`), 템플릿을 그리고(`render`), 결과를 검사합니다(`validate`).
LLM이 쓰는 것은 명세 하나뿐이고, 데이터와 HTML은 코드가 만듭니다. 그래서 같은 명세로 다시 돌리면 결과가 똑같이 나옵니다. 파이프라인과 출력 파일은 [agent/README.md](../agent/README.md)에 있습니다.

### 입력

| 항목 | 설명 |
|---|---|
| `Name` | 후보 세 개가 함께 쓰는 이름입니다. 후보를 고르면 이 이름으로 Project가 저장되고, 같은 이름의 Project가 있으면 덮어씁니다. 시도마다 다른 이름을 씁니다. |
| `Raw data` | 원본 파일입니다. 구조를 미리 알려 줄 필요는 없습니다. |
| `Prompt text` | 무엇을 판정하게 할지 적습니다. 파일에 써 둔 prompt는 본문을 붙여 넣습니다. "chunk 하나를 보여주고 atomic fact 중 그 chunk가 지지하는 걸 전부 고르게 하자. BM25 top-10, HIT 20개" 같은 한 문장도 되고, 절을 나눈 markdown도 됩니다 ([prompt 쓰기](../agent/README.md#prompt-쓰기)). |
| `Models for the candidates` | 후보 A, B, C가 명세를 쓰게 할 모델 설정(`environment/models/`)입니다. 처음에는 서로 다른 세 개(`default`, 그다음 목록 순서)가 골라져 있습니다. 모든 설정이 temperature 0이라 같은 모델을 두 번 고르면 거의 같은 후보가 나오므로, 그렇게 고르면 화면이 알려 줍니다. |
| `Allow API calls (uses credits)` | LLM이 명세를 쓰게 하려면 실행할 때마다 체크합니다. 유료 호출이므로 서버 스위치도 켜져 있어야 하며, 그렇지 않으면 체크할 수 없습니다. 서버 스위치는 `environment/.env`에 `AGENT_ALLOW_API=1`을 적고 `docker compose restart backend`로 켭니다. |
| `Optional task spec · offline replay` | `task_spec.json`을 올리면 LLM 없이 그 명세로 돌립니다(`plan` 단계는 `skipped`). 모델이 쓰이지 않으므로 후보 없이 job 하나만 만들어집니다. `Reuse the saved task spec`은 `Reuse inputs`로 불러온 job의 명세를 그대로 씁니다. |

처음 써 볼 때는 `Tutorial` 탭의 `원본 데이터에서 자동으로 만들기`에서 예시 prompt 네 가지 중 하나를 고릅니다. `Load prompt`는 prompt와 이름만, `Load prompt + example data`는 합성 예시 원본(레코드 6개)까지 채운 채로 Generate from raw data를 엽니다 ([prompt 비교 실험](prompt-experiments.md)). Generate from raw data 화면에는 생성에 필요한 입력만 있습니다.

### Templates 목록

`Generate 3 candidates`를 누르면 아래 `Templates` 목록에 후보 세 개를 묶은 카드가 생깁니다. 후보마다 칸이 하나씩 있고, 단계 다섯 개의 진행 상황, 모델, 걸린 시간이 표시됩니다. 셋이 함께 돌기 때문에 기다리는 시간은 가장 늦은 후보만큼입니다. 모두 끝나면 화면 오른쪽 위에 알림이 뜨고, 후보 칸에 HIT 수, 항목 수, attention 항목 수, LLM 비용이 보입니다. 실패한 후보는 이유가 함께 표시됩니다.

후보 칸의 `Details`를 펼치면 다음이 보입니다.

- `Summary`: 쓴 레코드 수, 항목 수, HIT 수, HIT당 항목 수, attention 항목 수, 정답 라벨의 분포
- `Validation`: 구조 검사 결과 (`OK`면 게시할 수 있는 형태입니다. 문구나 라벨 대응이 원하는 대로인지는 사람이 봐야 합니다)
- `LLM usage`: 호출 수, 토큰, 비용
- `Files`: `task_spec.json`, `template.html`, `hits.json`, `settings.json`, LLM에 보낸 요청과 받은 응답 등. 눌러서 내려받을 수 있습니다.
- `Planner notes`: LLM이 명세를 그렇게 짠 이유

묶음 카드의 버튼은 두 가지입니다.

- `Compare and choose`: 모든 후보가 끝나고 하나 이상 성공하면 누를 수 있습니다. 성공한 후보만 나란히 여는 비교 창에서 결과 요약표와 함께 후보마다 `Requester prompt`, `Task spec`, HIT 한 행을 worker 화면으로 그린 미리보기를 보고, 평가 메모를 남길 수 있습니다. 공통 항목이 있으면 같은 항목을 모든 후보에서 함께 봅니다. 후보는 일부러 모델만 바꾼 것이므로 모델 차이는 경고하지 않고, 샘플링이나 HIT 구성이 다를 때만 알립니다.
- `Reuse inputs`: 묶음의 원본과 prompt를 입력 칸에 다시 채웁니다. 원본은 서버에 남아 있으므로 다시 올리지 않아도 됩니다.

비교 창에서 마음에 드는 후보의 `Choose this template`을 누르면 그 후보를 고른 것으로 기록하고, 그 후보의 결과로 Project를 저장한 뒤 hits.json을 올린 상태로 Publish Batch를 엽니다. 이후는 [Publish Batch](#publish-batch)와 같습니다. settings.json의 attention 규칙과 대조 기준 컬럼은 `Review settings`에 미리 채워집니다. 고른 후보에는 `Chosen`이 표시되며, 다시 비교 창을 열어 다른 후보를 고르면 같은 이름의 Project를 덮어씁니다.

task spec으로 돌린 job은 후보 없이 job 카드 하나로 보이고, 카드에서 `Preview & evaluate`(결과 보기와 평가)와 `Use this result`(Project 저장과 Publish Batch)를 씁니다. 후보 묶음이 생기기 전에 만든 job도 같은 모양입니다.
서로 다른 실행의 결과를 함께 보고 싶으면 후보 칸이나 job 카드의 `Compare`를 2~3개 체크하고 목록 위쪽의 `Compare selected`를 누릅니다.

### 명세를 고쳐 다시 만들기

LLM이 요청과 다르게 명세를 쓰면, 명세를 고쳐 LLM 없이 다시 만듭니다. 비용이 들지 않고 몇 초면 끝납니다.

1. 후보 칸의 `Details` → `Files`에서 `task_spec.json`을 내려받아 고칩니다.
2. 묶음 카드의 `Reuse inputs`를 누르고 `Name`을 새 이름으로 바꿉니다.
3. `Optional task spec · offline replay`의 `Task spec`에 고친 파일을 올리고, `Allow API calls`는 끈 채로 `Generate`를 누릅니다. job 하나가 만들어지고, 그 카드의 `Use this result`로 Project를 만듭니다.

예를 들어 "BM25 top-10, HIT 20개"라고 요청했을 때 LLM이 레코드 20개를 고른 뒤 레코드마다 passage 10개를 5개씩 두 HIT로 나눠(`"items_per_hit": 5`) HIT가 40개가 된 적이 있습니다.
`hit.items_per_hit`만 10으로 고쳐 다시 만들면, 같은 항목 200개와 같은 정답 라벨로 HIT 20개가 됩니다.

### 걸리는 시간과 실패

실제 RAG 평가 원본(레코드 400개, 약 28MB)에 한 문장 prompt와 `default` 모델로 돌렸을 때, 성공한 job은 140초 동안 호출 3번에 $0.0036이 들었습니다. 명세가 검사에 걸리면 오류를 LLM에 돌려주고 다시 묻기 때문에 호출이 여러 번이 됩니다.
후보 세 개는 각자 LLM을 부르므로 비용은 후보 수만큼 들고, 시간은 가장 늦은 후보만큼 걸립니다.
LLM 호출은 실패할 수 있습니다. 같은 입력의 다른 시도는 응답이 공백으로 채워져 출력 상한에 닿아 217초 뒤에 실패했습니다($0.0083). 실패한 후보도 칸에 이유와 비용이 남고, 나머지 후보가 성공했으면 그 후보들로 비교하고 고를 수 있습니다.
모두 실패하면 같은 입력으로 다시 돌리거나 다른 모델을 고릅니다. 발표처럼 결과가 꼭 필요한 자리에서는 미리 만들어 둔 결과를 씁니다.

### Templates 목록 관리

후보 하나하나가 job이며, 입력과 결과 파일은 `output/jobs/<job id>/`(gitignore)에, job의 상태는 DB에 저장됩니다. 묶음은 각 job에 적힌 `group`으로 다시 묶이므로 따로 저장하는 곳이 없습니다. 화면에는 지우는 버튼이 없습니다.
목록에서 빼려면 job 폴더를 `output/jobs/` 밖(예: `output/jobs-archive/`)으로 옮기고 `docker compose restart backend`를 실행합니다. 묶음 전체를 빼려면 그 묶음의 job 폴더 세 개를 함께 옮깁니다. 다시 보이게 하려면 폴더를 되돌리고 같은 명령을 실행합니다.
backend는 job을 기본으로 세 개까지 동시에 돌립니다. 이 수는 `environment/.env`의 `AGENT_JOB_WORKERS`로 바꿀 수 있으며, 3보다 작게 하면 후보가 차례를 기다립니다.

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
- `Variables`: layout이 읽는 `${컬럼}`마다 미리보기에 넣을 표본 값을 적습니다. 표본 값은 Project와 함께 저장되며, 게시할 때는 올린 데이터의 값이 들어갑니다. 비워 둔 변수는 미리보기에 `${컬럼}` 그대로 보입니다.
- `Answer fields`: 미리보기가 보고한 답 칸 목록입니다. 이름과 종류(choice, scale, checkbox, text), 필수 여부가 보입니다.

### 3. `Preview and Finish`

Project의 요약, 표본 값으로 그린 worker 화면 전체, 답 칸 목록이 나옵니다.

- `Download JSON template`: layout이 읽는 컬럼을 키로, 표본 값을 값으로 둔 JSON을 내려받습니다. 이 형식대로 객체를 늘려 Publish Batch에 올립니다.
- `Finish`: 저장하고 Project 목록으로 갑니다.
- `Finish and publish a batch`: 저장하고 바로 그 Project의 Publish Batch를 엽니다.

## Publish Batch

Project의 `Publish Batch`를 누르면 네 단계로 게시합니다. 보상, 인원, 기간, worker 조건은 Project의 속성을 그대로 쓰며, 바꾸려면 위쪽의 `Edit project`로 Project를 고칩니다.
입력은 올린 데이터까지 브라우저에 임시 저장됩니다. 한 번에 하나만 저장되므로, 다른 Project의 Publish Batch를 열면 이전 것은 바뀝니다. `Start over`는 데이터와 검수 설정을 버립니다.

| 단계 | 내용 |
|---|---|
| 1. `Upload JSON` | 객체 하나가 HIT 하나인 JSON 배열을 올리면 layout이 읽는 컬럼이 모두 있는지 검사합니다. 빠진 컬럼이 있으면 다음으로 갈 수 없습니다. 값이 배열이나 객체면 JSON 글로 들어갑니다. `Download JSON template`으로 양식을 받을 수 있고, `Use the sample row`는 Project의 표본 값으로 HIT 1개짜리 데이터를 만듭니다. |
| 2. `Preview tasks` | 데이터의 HIT를 하나씩 골라 worker 화면을 그대로 미리 봅니다. 답 칸 목록은 batch의 `answerSchema`로 저장됩니다. |
| 3. `Review settings` | attention 규칙, 자유 서술 답, Review의 대조 기준을 정합니다. 데이터의 컬럼에 달린 설정이라 batch마다 정하며, 처음 값은 Project에 저장된 값입니다. layout에 자유 서술 문항(`ann-textarea`)이 있으면 그 이름이 자유 서술 답으로 미리 채워집니다. |
| 4. `Confirm and publish` | 비용 견적(보상 + 수수료)과 잔액, 전체 요약을 확인하고 batch 이름을 정해 게시합니다. 요약의 `Workers receive`는 worker의 작업 화면에 보낼 입력 컬럼과 보내지 않는 컬럼(템플릿이 쓰지 않는 컬럼, 정답이 든 컬럼)입니다. 게시가 끝나면 그 batch의 Overview로 가고, worker의 `HITs` 목록에 그 batch가 나타납니다. |

Overview의 `Project` 칸에서 batch를 게시한 Project의 편집기로 갈 수 있습니다.

## 따라 하기: starter로 attention check가 있는 batch 게시하기

1. `New Project`의 `Other ways to start` → `Starter templates`에서 `Passage relevance`를 고르고 `Create Project`를 누릅니다.
2. `Enter Properties`에는 starter의 값이 채워져 있습니다 (`Reward per assignment` $0.05, `Number of assignments per task` 3). 비용 줄에 `$0.18`이 보입니다.
3. `Design Layout`에서 문항을 바꾸거나 `Insert element…`로 `<ann-textarea>`를 `</ann-form>` 앞에 넣어 봅니다. 미리보기와 `Answer fields`가 함께 바뀝니다.
4. `Preview and Finish`에서 `Finish and publish a batch`를 누릅니다.
5. `Upload JSON`에 [example/5-project/passage-relevance.json](../example/5-project/passage-relevance.json)을 올립니다. `2/2 matched`가 표시되고, 쓰이지 않는 컬럼 `gold`, `attention_expected`와 빈 셀이 있는 6행이 경고로 보입니다. 빈 셀은 attention 항목이 아닌 객체에 `attention_expected`가 없는 것이므로 정상입니다.
6. `Preview tasks`에서 행을 넘겨 봅니다. 5행과 8행이 질문과 상관없는 passage를 붙인 attention 행입니다.
7. `Review settings`에서 `Attention check`를 켜고 `Expected answers column`, `attention_expected`를 고릅니다. `Compare answers with`에서는 `Input column: gold`를 고릅니다.
8. `Confirm and publish`에서 비용이 `8 HITs × 3 assignments × $0.05` = $1.20, 수수료 $0.24, 합계 $1.44인 것을 확인하고 게시합니다.

## 서버에 저장되는 모양

서버에는 Project가 템플릿 레코드 하나로 저장됩니다 (`POST /api/templates`). REST 경로는 이전과 같고, 레코드에 선택 필드 두 개가 더해졌습니다.

- `properties`: Enter Properties와 검수 설정의 폼 값입니다. 서버는 객체인지만 확인하며, batch를 게시할 때 `POST /api/batches`가 값을 다시 검사합니다.
- `sampleRow`: Design Layout 미리보기의 표본 값 `{컬럼: 문자열}`입니다.

두 필드 모두 64KB를 넘을 수 없습니다. 기존 템플릿을 고칠 때 필드를 보내지 않으면 저장된 값이 유지되고, `null`을 보내면 지워집니다.
프로토타입의 mock API는 이 두 필드를 저장하지 않습니다.
