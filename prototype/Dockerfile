# syntax=docker/dockerfile:1
#
# MTurk Console (mock). 용도별 target을 한 파일에서 만든다. 보통은 저장소 루트의 docker-compose.yml을 통해 쓴다.
# 빌드 컨텍스트는 저장소 루트다 (data/와 example/을 복사해야 하므로). 이미지 안은 저장소와 같은 배치로 둔다:
# Node 앱은 /app/prototype, 시작 데이터는 /app/data, 예시 파일은 /app/example.
#
#   web   빌드한 정적 파일을 nginx로 서빙하고 /api는 api 서비스로 넘긴다. 리뷰와 시연용 (기본 target)
#   api   mock API 서버 (Node + SQLite). data/ 폴더를 DB에 올리고 REST로 답한다
#   dev   Vite dev 서버. 소스를 bind mount해서 HMR로 개발한다
#   test  Vitest 단위 테스트

ARG NODE_VERSION=24

# ── deps ────────────────────────────────────────────────────────────────────
# 의존성만 설치한다. package.json과 package-lock.json이 바뀔 때만 다시 실행된다.
# root가 아닌 node 사용자로 설치해서, dev와 test가 node_modules/.vite 캐시를 쓸 수 있게 한다.
FROM node:${NODE_VERSION}-slim AS deps
RUN mkdir -p /app/prototype && chown -R node:node /app
WORKDIR /app/prototype
USER node
COPY --chown=node:node prototype/package.json prototype/package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci

# ── source ──────────────────────────────────────────────────────────────────
# 필요한 경로만 복사한다. scripts/의 fixture 변환 스크립트와 salt, 문서는 이미지에 들어가지 않는다.
FROM deps AS source
COPY --chown=node:node prototype/index.html prototype/tsconfig.json prototype/vite.config.ts ./
COPY --chown=node:node prototype/src ./src
COPY --chown=node:node prototype/server ./server
COPY --chown=node:node prototype/scripts ./scripts
# example/의 예시 파일은 Create의 "Load sample" 버튼이 쓰므로 빌드에 필요하다
COPY --chown=node:node example /app/example
COPY --chown=node:node data /app/data

# ── api ─────────────────────────────────────────────────────────────────────
FROM source AS api
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    DB_PATH=/app/var/mturk-console.sqlite
# DB를 담을 volume의 mount 지점. 미리 만들어 두어야 volume이 node 사용자 소유로 초기화된다.
RUN mkdir -p /app/var
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# tsx로 TypeScript를 그대로 실행한다. 핸들러와 계산 로직이 브라우저 mock 모드와 같은 소스(src/)라서 따로 빌드하지 않는다.
CMD ["npx", "tsx", "server/index.ts"]

# ── dev ─────────────────────────────────────────────────────────────────────
FROM source AS dev
EXPOSE 5173
# 컨테이너 밖에서 접속할 수 있게 0.0.0.0에 연다. HMR 웹소켓이 같은 포트를 쓰므로 포트를 고정한다.
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

# ── test ────────────────────────────────────────────────────────────────────
FROM source AS test
CMD ["npm", "test"]

# ── build ───────────────────────────────────────────────────────────────────
FROM source AS build
# Vite는 VITE_* 값을 빌드할 때 코드에 박아 넣는다. 실행할 때 환경변수로 바꿀 수 없으므로 build arg로 받는다.
#   http: /api를 부른다 (api 서비스가 필요)      mock: 브라우저 안에서 전부 동작한다 (서버가 필요 없다)
ARG VITE_API_MODE=http
ENV VITE_API_MODE=${VITE_API_MODE}
# 타입 검사(tsc)를 통과해야 이미지가 만들어진다
RUN npm run build

# ── web ─────────────────────────────────────────────────────────────────────
FROM nginx:stable-alpine AS web
COPY prototype/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/prototype/dist /usr/share/nginx/html
EXPOSE 80
# localhost는 ::1로 풀릴 수 있는데 nginx는 IPv4에만 열려 있다
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
