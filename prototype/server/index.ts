// mock API 서버. 실제 MTurk에는 연결하지 않는다.
//
//   data/ 폴더 (JSON + HTML) ──처음 한 번──▶ SQLite ◀──▶ 메모리 상태 ◀── REST (/api/...) ◀── 브라우저
//
//   npm run server                      http://localhost:8787/api/health
//   PORT, DATA_DIR, DB_PATH, MOCK_DELAY_MS("최소-최대") 환경변수로 바꿀 수 있다.
//
// DB가 비어 있으면 data/ 폴더를 올린다. 이후의 변경은 DB에 남고, "Reset to fixtures"를 누르면 다시 data/로 돌아간다.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockApi } from '../src/api/mock/handlers';
import { assembleState } from '../src/api/mock/seedFiles';
import { readSeedFiles } from '../src/api/mock/seedFromDisk';
import { MockStore } from '../src/api/mock/store';
import { createMockTools } from '../src/api/mock/tools';
import { createRequestHandler } from './app';
import { createSqliteSnapshot } from './sqliteSnapshot';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
// data/와 var/는 저장소 루트(prototype/의 상위)에 있다. 호스트의 prototype/에서 실행하든 컨테이너의 /app/prototype에서
// 실행하든 같은 곳을 보도록, 현재 폴더가 아니라 이 파일의 위치에서 계산한다.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR ?? resolve(REPO_ROOT, 'data'));
const DB_PATH = resolve(process.env.DB_PATH ?? resolve(REPO_ROOT, 'var/mturk-console.sqlite'));
// 요청이 너무 빨리 끝나면 로딩 상태를 볼 수 없다 (7.2). 네트워크가 있으므로 브라우저 mock(200~500ms)보다 짧게 둔다.
const [minDelay = 100, maxDelay = 300] = (process.env.MOCK_DELAY_MS ?? '100-300').split('-').map(Number);

const snapshot = createSqliteSnapshot(DB_PATH);
const store = new MockStore({
  snapshot,
  loadSeed: async () => assembleState(readSeedFiles(DATA_DIR)),
  persistSeed: true,
});
const handler = createRequestHandler(
  createMockApi(store, { delayMs: [minDelay, maxDelay] }),
  createMockTools(store),
);

const info = await store.getInfo(); // 시작할 때 data/나 DB에 문제가 있으면 여기서 바로 드러난다
const server = createServer((req, res) => void handler(req, res));
server.listen(PORT, HOST, () => {
  console.log(`mock API server  http://${HOST}:${PORT}/api`);
  console.log(`  data   ${DATA_DIR}`);
  console.log(`  db     ${DB_PATH}  (${info.source === 'snapshot' ? 'restored' : 'seeded from data/'})`);
  console.log(`  state  ${Object.entries(info.counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      snapshot.close();
      process.exit(0);
    });
  });
}
