# vanilla JS 콘솔을 nginx 로 서빙하는 이미지. 빌드 단계가 없어 frontend/src 를 그대로 복사한다.
# 빌드 컨텍스트는 저장소 루트다 (docker-compose.yml 의 frontend 서비스: context ".", dockerfile frontend/Dockerfile).
# 개발 중에는 compose 가 ./frontend/src 를 같은 경로에 bind mount 하므로 파일을 고치면 새로고침만으로 반영된다.
FROM nginx:stable-alpine

# 공식 이미지는 시작할 때 /etc/nginx/templates/*.template 에 envsubst 를 돌려 /etc/nginx/conf.d/ 에 쓴다.
# API_UPSTREAM 환경 변수로 /api 를 넘길 곳을 정한다 (compose 기본값 http://backend:8000).
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/src /usr/share/nginx/html
# Create 의 `Load sample template` / `Load sample CSV` 가 /example/… 로 읽는 예시 파일. nginx.conf.template 의 alias 가 이 폴더를 /example/ 로 잇는다
# (html 폴더 안이 아닌 이유: compose 가 frontend/src 를 읽기 전용으로 mount 하면 그 안에 mount point 를 만들 수 없다).
COPY example /usr/share/nginx/example

EXPOSE 80
# localhost 는 ::1 로 풀릴 수 있는데 nginx 는 IPv4 에만 열려 있다
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
