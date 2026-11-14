-- 유료 LLM 호출(OpenRouter)의 사용 기록. 콘솔이 직접 부르는 호출(binding, 자유 계약, 페이지, 배치 판정)이 끝날 때마다 한 줄을 남긴다.
-- Generate from raw data 의 agent job 은 이미 job 문서(agent_jobs.doc.usage)에 사용량이 있으므로 여기에 다시 적지 않는다.
-- admin 의 API usage 화면(/api/admin/usage)이 이 표와 job 문서를 함께 읽는다. 비용은 OpenRouter 가 응답에 준 실제 청구액(USD)이다.

CREATE TABLE api_usage (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,   -- 호출한 계정
  kind              TEXT NOT NULL,                                   -- binding | contract | page | layout-check
  model             TEXT,                                            -- OpenRouter 의 모델 id
  provider          TEXT,                                            -- 실제로 답한 업체 (응답의 provider)
  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost              DOUBLE PRECISION                                 -- 응답에 청구액이 없으면 NULL
);
CREATE INDEX api_usage_at ON api_usage (at);
