-- agent job (Generate from raw data). 입력과 결과 파일은 OUTPUT_DIR/jobs/<id>/ 에 있고, 여기에는 상태(job.json 과 같은 모양)만 둔다.
-- seed 데이터가 아니므로 reseed 해도 지우지 않는다.
CREATE TABLE agent_jobs (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL,
  group_id   TEXT,
  doc        JSON NOT NULL
);
CREATE INDEX agent_jobs_group ON agent_jobs (group_id);
