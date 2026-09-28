# Prompt 반복 실험

2026-09-28 기준입니다. Raw와 requester prompt에서 정제 데이터·annotation HTML을 만드는 파이프라인에 입력 재사용, 직접 미리보기, 후보 비교와 평가 기록을 추가했습니다. Worker 응답 수집과 MTurk 연동은 이번 범위에 포함하지 않습니다.

## UI에서 실행하기

3000 포트의 **Create → Template → Generate from raw data**를 엽니다.

1. `Example prompt candidates`에서 후보를 고르고 `Load prompt + example data`를 누릅니다. 본문은 편집할 수 있습니다.
2. 모델과 후보 이름을 정하고 API 호출을 허용한 뒤 Generate를 누릅니다. 서버도 `AGENT_ALLOW_API=1`로 실행되어 있어야 합니다. 유료 호출이므로 실행할 때만 허용합니다.
3. 다음 후보는 `Load prompt`로 바꾸거나 이전 job의 `Reuse inputs`로 복원합니다. 제출한 raw는 재사용할 수 있습니다. API 허용 상태와 이전 spec 재사용은 복원할 때 자동으로 켜지지 않습니다.
4. 성공한 job의 `Preview & evaluate`에서 CSV를 주입한 HTML과 prompt/spec을 확인하고 데이터·안내문·attention 평가와 메모를 저장합니다.
5. 성공한 job 2~3개를 선택하여 `Compare selected`를 누릅니다. 공통 record/item 그룹이 있으면 같은 일반 항목을 나란히 보여 줍니다. Raw hash·모델·처리 조건이 다르거나 공통 항목이 없으면 안내합니다.
6. 평가 저장 후 `Export comparison JSON`으로 prompt·spec·요약·비용·평가를 함께 보관합니다. 선택한 결과는 `Use this result`로 마법사에 적용합니다.

Prompt·후보 이름·모델·이전 raw 참조는 localStorage에 보존합니다. 아직 제출하지 않은 로컬 파일은 새로고침 뒤 다시 선택해야 합니다. `Clear inputs`로 초안을 비웁니다. API 호출 허용은 저장하지 않습니다.

**Task spec을 함께 올리거나 재사용하면 planner를 건너뜁니다.** Prompt 변경 효과를 비교할 때는 spec을 해제합니다. 화면에도 이 상태를 표시합니다. 미리보기의 Submit은 답변을 표시하며 worker 응답을 저장하지 않습니다.

## 후보와 공통 조건

후보는 [agent/prompt_variants/groundedness](../agent/prompt_variants/groundedness/)에 있습니다. 기존 [예시 prompt](../agent/examples/groundedness/prompt.md)와 planner 시스템 지시는 수정하지 않습니다.

| ID | 변경 사항 |
|---|---|
| `baseline` | 기존 영어 markdown 9개 절에 공통 비교 조건을 추가합니다. |
| `data-explicit` | 같은 record/passage/statement의 경로·라벨 대응과 데이터 보존을 더 명확히 합니다. |
| `instructions` | paraphrase·부분 지지·모순·정보 부재의 예시를 worker에게 보이는 안내문에 넣도록 지시합니다. 주제가 다르다는 이유만으로 답하는 지름길을 금지합니다. |
| `combined` | 데이터 대응과 안내문 강화를 결합합니다. |

모든 후보의 공통 조건은 다음과 같습니다.

- [합성 raw](../agent/examples/groundedness/raw.json)의 6레코드를 모두 사용합니다. `filter`, `sample`, `limit`는 null이며 레코드 ID는 `$.id`입니다.
- 각 레코드의 `passages.retriever_a` 첫 4개와 `facts.model_a`의 모든 statement를 유지합니다. 일반 항목은 24개, 일반 답변은 48개입니다.
- Record별 일반 항목 4개를 묶어 6 HIT를 만듭니다.
- Attention은 HIT당 1개, random 위치, seed 42, mismatch 거리 3입니다. Question과 passage를 함께 바꾸고 source statement는 유지합니다. `max_targets=2`, expected value는 `not_grounded`입니다. Attention 답변 10개를 더해 총 58개입니다.
- 기존 Yes/No를 `grounded`/`not_grounded`로 매핑하며 이유를 보존합니다. `llm_label`, `llm_reason`을 출력하되 worker에게 참조 정답을 보여 주지 않습니다.

이 조건은 모델이 지켜야 할 **요구사항**입니다. Prompt에 적었다는 사실만으로 준수가 보장되지는 않으므로 실제 출력에서 별도로 확인합니다.

## 평가와 비용 기록

| 구분 | 확인 사항 |
|---|---|
| 구조 | Plan → preprocess → render → validate의 성공, 출력 파일 완성, 오류·경고를 확인합니다. |
| 데이터 | 6레코드·24일반 항목·6 HIT·48일반 답변·10attention 답변, 누락/skip 0을 확인합니다. |
| 내용 | 원본 passage/statement/참조 라벨/이유와 대조합니다. 필드 이름 차이와 실제 내용 오류를 구분합니다. |
| 정책 | 무단 표본·필터, passage 제한, 그룹 구성, attention seed·거리·상한을 확인합니다. |
| 안내문 | Passage만 근거로 판단하는지, paraphrase/부분 지지/모순/정보 부재가 일관되는지, 내부 경로나 정답이 노출되지 않는지 확인합니다. |
| Attention | 실제로 바뀐 문맥이 statement를 지지하지 않는지 읽어 봅니다. Mismatch 생성 코드가 의미적 정답성을 보증하지 않습니다. |
| 비용 | 각 호출의 입력·출력·전체 토큰, `usage.cost`의 USD 청구액, 수정 호출 수, 실행 시간을 보관합니다. 비용이 응답에 없으면 미확인으로 기록합니다. |

`validation.ok`는 구조 검증입니다. 품질 평가는 `review`에 별도로 저장하며 job 성공 상태를 바꾸지 않습니다. UI 비교는 record/item ID를 맞추므로 내용 검토를 대체하지 않습니다.

실험 기록에는 후보 ID/원문, raw·prompt hash, 모델 설정과 실제 provider, job ID, 요청/응답, 산출물, 평가와 비용을 연결합니다. 모델별로 prompt 효과를 먼저 비교하고 모델 간 차이는 별도로 해석합니다. Temperature 0과 고정 attention seed만으로 LLM 응답의 재현성이 보장되지는 않습니다.

실제 입력·출력은 gitignore된 `output/`, `var/`에 둡니다. API 키와 실제 연구 데이터는 커밋하지 않습니다. UI job은 `output/jobs/<job-id>/`에 남으며 직접 실행한 `output/<이름>/`을 자동으로 UI에 가져오지는 않습니다.

## Planner와 평가 범위의 한계

[build_messages](../agent/planner/prompts.py)는 아래 순서로 메시지를 구성합니다.

```text
system: ROLE + spec_reference.md + OUTPUT_RULES
user: 고정 groundedness 예시 profile + 예시 prompt.md
assistant: 고정 예시 task_spec.json
user: 이번 raw의 profile + requester prompt
```

예시 데이터는 이미 few-shot에 포함되어 있습니다. 이번 비교는 mock 동작과 안내문 개선을 확인하는 개발 실험이며 독립 데이터에 대한 일반화 평가가 아닙니다. 각 조합을 한 번 실행한 결과만으로 반복 안정성이나 최적 모델을 확정하지 않습니다.

LLM은 task spec을 생성합니다. 전처리와 HTML 배치·상호작용은 [preprocess.py](../agent/preprocess.py), [render.py](../agent/render.py)가 수행합니다. Prompt가 바꾸는 것은 주로 필드 구성·질문·선택지·안내문이며 임의 HTML 레이아웃 생성은 아닙니다. Worker 예시는 기존 instructions의 문자열에 들어갑니다.

고정 예시 대화는 프로세스 단위로 캐시됩니다. 향후 고정 예시를 바꾸는 실험은 requester 후보와 구분하고 프로세스를 재시작합니다. 자동 수정은 파싱된 spec의 검증 오류를 대상으로 하며 API 장애·JSON 파싱 오류·후속 전처리 실패를 모두 재시도하는 것은 아닙니다.

## 조사에서 확인한 기존 기록과 후속 개선

기존 `output/example-*`, `output/real-*`의 6건은 데이터군별 동일 prompt를 모델 3종에 전달한 과거 기록입니다. 새 4종 후보 실험과 구분합니다. 저장된 과거 비용 합계는 약 $0.0192입니다.

기존 실제 데이터 실험은 400레코드 중 160개를 뽑았지만 seed가 7과 42로 갈려 공통 레코드가 68개뿐이었습니다. 그 범위의 일반 항목 680개는 필드 이름 차이를 제외하면 본문·target·라벨이 같았습니다. Mismatch 거리와 안내문은 달랐고 profile에는 경로 42개 생략 기록이 있었습니다. 이 때문에 새 비교에서는 입력·정책을 고정하고 의미상 같은 항목을 대조합니다.

후속 개선은 실제 실패를 보고 정합니다. 고정 예시에 없는 입력, profile 축약에 따른 정보 누락, 선택된 전체 데이터의 라벨 대응, attention 의미 검토, 별도 worker 예시 UI가 후보입니다. Worker 계정·제출 저장, MTurk API, 폴더 구조 재편은 이번 mock의 선행 조건으로 두지 않습니다.
