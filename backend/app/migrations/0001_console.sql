-- 콘솔의 문서 저장소. 예전 SQLite 스키마(version 1)를 PostgreSQL 로 옮긴 것이다.
-- 레코드 전체는 doc 에 두고, 자주 찾는 값만 컬럼으로 꺼내 색인한다. doc 은 JSONB 가 아니라 JSON 이다:
-- JSONB 는 키 순서를 바꾸는데, API 는 저장한 문서를 그대로 돌려주므로 키 순서가 바뀌면 응답 모양이 달라진다.
-- seq 는 저장 순서다 (목록의 기본 순서). 값을 직접 넣지 않고 identity 가 매긴다.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  seq        BIGINT GENERATED ALWAYS AS IDENTITY,
  name       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc        JSON NOT NULL
);

CREATE TABLE batches (
  id         TEXT PRIMARY KEY,
  seq        BIGINT GENERATED ALWAYS AS IDENTITY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  doc        JSON NOT NULL
);

CREATE TABLE hits (
  id              TEXT PRIMARY KEY,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  batch_id        TEXT NOT NULL REFERENCES batches (id),
  row_index       INTEGER NOT NULL,
  max_assignments INTEGER NOT NULL,
  expiration      TEXT NOT NULL,
  doc             JSON NOT NULL
);
CREATE INDEX hits_batch ON hits (batch_id);

CREATE TABLE assignments (
  id          TEXT PRIMARY KEY,
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  hit_id      TEXT NOT NULL REFERENCES hits (id),
  worker_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  submit_time TEXT NOT NULL,
  doc         JSON NOT NULL
);
CREATE INDEX assignments_hit    ON assignments (hit_id);
CREATE INDEX assignments_worker ON assignments (worker_id);
CREATE INDEX assignments_status ON assignments (status);

CREATE TABLE pools (
  id   TEXT PRIMARY KEY,
  seq  BIGINT GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  doc  JSON NOT NULL
);

-- 콘솔이 worker 에 붙인 정보 (blocked, note, blockReason). id 는 WorkerId
CREATE TABLE workers (
  id  TEXT PRIMARY KEY,
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  doc JSON NOT NULL
);

-- 행 하나 (id = 'account')
CREATE TABLE account (
  id  TEXT PRIMARY KEY,
  doc JSON NOT NULL
);
