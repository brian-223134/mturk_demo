// mock API 서버의 SQLite를 읽기 전용으로 조회한다. 시연이나 디버깅 때 DB에 무엇이 들어 있는지 볼 때 쓴다.
//
//   npm run sql -- "SELECT status, COUNT(*) AS n FROM assignments GROUP BY status"
//   docker compose exec api npm run sql -- "SELECT id, name FROM batches"
//   npm run sql                          (인자가 없으면 테이블별 행 수)

import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = resolve(process.env.DB_PATH ?? 'var/mturk-console.sqlite');
const query =
  process.argv.slice(2).join(' ').trim() ||
  ['templates', 'batches', 'hits', 'assignments', 'pools', 'worker_meta']
    .map((t) => `SELECT '${t}' AS "table", COUNT(*) AS rows FROM ${t}`)
    .join(' UNION ALL ');

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare(query).all();
  console.log(`${dbPath}\n> ${query}`);
  console.table(rows);
} finally {
  db.close();
}
