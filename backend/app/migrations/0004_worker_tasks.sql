-- worker 가 HIT 를 받아 푸는 경로 (routers/worker.py).
-- assignment 는 worker 가 HIT 를 받은 순간 Accepted 로 생기고, 제출하면 Submitted 가 된다. 아직 제출 시각이 없으므로 submit_time 은 비어도 된다.
-- Returned(worker 가 반납)와 Abandoned(제한 시간이 지남)는 자리를 다시 연다. Requester 화면(검수, 결과, worker 지표)에는
-- Submitted, Approved, Rejected 만 보인다.
-- 같은 worker 는 HIT 하나에 assignment 하나다. 반납하거나 시간이 지난 HIT 를 다시 받으면 그 행을 다시 쓴다.

ALTER TABLE assignments ALTER COLUMN submit_time DROP NOT NULL;
ALTER TABLE assignments ADD COLUMN deadline TIMESTAMPTZ;      -- 받은 시각 + AssignmentDurationInSeconds
ALTER TABLE assignments ADD CONSTRAINT assignments_status_check
  CHECK (status IN ('Accepted', 'Submitted', 'Approved', 'Rejected', 'Returned', 'Abandoned'));
CREATE UNIQUE INDEX assignments_hit_worker ON assignments (hit_id, worker_id);
CREATE INDEX assignments_active ON assignments (deadline) WHERE status = 'Accepted';
