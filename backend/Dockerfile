# backend 실행 이미지. 빌드 컨텍스트는 저장소 루트다 (agent/ 와 backend/app 을 함께 복사하려고).
# 컨테이너 안의 배치는 /app/agent, /app/backend/app 이고, docker-compose.yml 이 같은 경로에 bind mount 를 걸어
# 코드를 고쳐도 다시 빌드할 필요가 없게 한다 (uvicorn --reload). 의존성은 backend/requirements.txt 로만 설치한다.
FROM python:3.14-slim

# /app 에서 agent 를, /app/backend 에서 app 을 import 한다. .pyc 는 만들지 않고(bind mount 가 읽기 전용), 출력은 바로 보이게 한다.
ENV PYTHONPATH=/app:/app/backend \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# 이미지만으로도 돌게 코드를 복사한다 (개발 중에는 compose 의 bind mount 가 이 위를 덮는다).
COPY agent /app/agent
COPY backend/app /app/backend/app

# SQLite(volume backend-db)와 agent job 결과(./output) 가 붙는 자리
RUN mkdir -p /app/var /app/output

EXPOSE 8000

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=6 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--reload-dir", "/app/backend/app", "--reload-dir", "/app/agent"]
