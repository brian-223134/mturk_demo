"""MTurk Console 의 FastAPI 백엔드.

    main.py          create_app() 팩토리와 uvicorn 이 띄우는 app
    settings.py      환경변수 → Settings (DATA_DIR, DB_PATH, OUTPUT_DIR, MODELS_DIR, ENV_FILE, AGENT_ALLOW_API)
    errors.py        ApiError 와 오류 봉투 {"error": {"code", "message"}}
    db.py            SQLite 문서 저장소. 비어 있으면 data/ 를 올린다
    seed.py          data/ 폴더 읽기 (prototype 의 seedFiles.ts 와 같은 규칙)
    routes.py        REST 경로 표 (prototype/src/api/http/routes.ts 의 API_ROUTES 와 키 하나하나 같다)
    domain/          계산 규칙의 Python 이식 (progress, cost, attention, template)
    routers/         콘솔 REST (/api/…) 와 agent job API (/api/agent/…)
    agent_jobs/      agent 파이프라인을 백그라운드 큐로 돌리는 runner 와 Job 모델
"""

__version__ = "0.1.0"
