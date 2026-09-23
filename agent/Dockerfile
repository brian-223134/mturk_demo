# agent 실행 이미지. 코드는 복사하지 않고 docker-compose.yml에서 ./agent를 /work/agent로 bind mount 한다.
# 그래서 코드를 고쳐도 이미지를 다시 빌드할 필요가 없다. requirements.txt에는 모델 설정 yaml을 읽는 PyYAML만 있다
# (environment/models/*.yaml). 파이프라인 자체는 표준 라이브러리만 쓴다.
FROM python:3.14-slim

WORKDIR /work

# .pyc를 만들지 않는다 (bind mount가 읽기 전용이다). 출력은 버퍼 없이 바로 보이게 한다.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 외부 패키지가 생기면 requirements.txt에만 적는다. 그러면 컨테이너 안에만 설치된다.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

ENTRYPOINT ["python", "-m", "agent"]
CMD ["--help"]
