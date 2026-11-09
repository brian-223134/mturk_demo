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
