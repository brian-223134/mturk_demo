-- 계정과 로그인. Requester 와 Worker 가 같은 표에 있고, 계정 하나에 역할(role)은 하나다.
-- 첫 admin 은 화면이 아니라 명령으로 만든다 (python -m app.users create-admin). Requester 는 초대 코드로만 가입한다.
-- 시각은 문서 테이블과 달리 TIMESTAMPTZ 다 (API 로 내보낼 때 ISO 문자열로 바꾼다).

CREATE TABLE users (
  id                TEXT PRIMARY KEY,                    -- 'u-' + 12 hex. 내부용, Requester 화면에는 보이지 않는다
  email             TEXT NOT NULL UNIQUE CHECK (email = lower(email)),   -- 로그인 ID. 소문자로 저장한다
  password_hash     TEXT NOT NULL,                       -- 'pbkdf2_sha256$<반복 횟수>$<salt>$<hash>'
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('admin', 'requester', 'worker')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  email_verified_at TIMESTAMPTZ,                         -- 메일 발송 수단이 생기면 쓴다
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ
);

-- worker 계정의 공개 ID. Requester 화면과 assignment, pool 에는 이 값만 보인다 (MTurk 의 WorkerId 처럼)
CREATE TABLE worker_profiles (
  user_id   TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL UNIQUE,                        -- 'W' + 12 hex. 계정 없는 seed worker 의 ID 와 겹치지 않게 만든다
  doc       JSON NOT NULL DEFAULT '{}'                   -- 선택 정보. 나중에 자격 조건 판정에 쓴다
);

-- 로그인 세션. 쿠키에는 토큰 원문, 여기에는 SHA-256 해시만 둔다
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),       -- 유휴 만료 계산용
  expires_at   TIMESTAMPTZ NOT NULL,                     -- 절대 만료
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

-- 가입 초대 코드. 코드 원문은 만들 때 한 번만 보여 주고 해시만 둔다
CREATE TABLE invitations (
  id         TEXT PRIMARY KEY,                           -- 'inv-' + 12 hex
  code_hash  TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL CHECK (role IN ('requester', 'worker')),
  email      TEXT CHECK (email = lower(email)),           -- 적으면 그 주소로만 가입할 수 있다
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,   -- 명령줄로 만든 코드는 NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);

-- Requester 가 worker 에 붙인 정보 (blocked, blockReason, note). 차단은 Requester 별이다:
-- A 가 차단한 worker 는 A 가 만든 batch 만 받을 수 없다. 예전 workers 테이블(주인 없는 정보)은 첫 admin 이 가져간다.
CREATE TABLE requester_workers (
  requester_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  worker_id    TEXT NOT NULL,                            -- 계정 없는 seed worker 도 있어서 외래 키를 걸지 않는다
  blocked      BOOLEAN NOT NULL DEFAULT false,           -- doc.blocked 와 같은 값 (조회용)
  doc          JSON NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, worker_id)
);
CREATE INDEX requester_workers_blocked ON requester_workers (worker_id) WHERE blocked;

-- 만든 사람. seed 와 계정이 생기기 전의 데이터는 NULL 이고, 첫 admin 을 만들 때 그 admin 의 것이 된다
ALTER TABLE templates  ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE batches    ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE pools      ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE agent_jobs ADD COLUMN owner_id TEXT REFERENCES users (id) ON DELETE SET NULL;
