// mock 저장소의 상태를 SQLite에 저장한다 (Node 내장 node:sqlite. 네이티브 모듈을 설치하지 않아도 된다).
//
// 문서 저장형 테이블이다: 레코드 전체는 doc(JSON) 컬럼에 두고, 자주 찾는 값만 컬럼으로 꺼내 색인한다.
// 덕분에 데이터 모델(src/api/types.ts)이 바뀌어도 스키마를 고칠 일이 적고, DB를 직접 들여다볼 수도 있다:
//
//   sqlite3 var/mturk-console.sqlite "SELECT status, COUNT(*) FROM assignments GROUP BY status"
//   sqlite3 var/mturk-console.sqlite "SELECT json_extract(doc,'$.RequesterFeedback') FROM assignments WHERE status='Rejected' LIMIT 3"
//
// 저장소(MockStore)는 상태 전체를 메모리에 들고 있고, 바뀔 때마다 save()를 부른다. save()는 직전에 쓴 내용과
// 비교해 달라진 행만 다시 쓴다. 실제 백엔드의 관계형 설계는 연동 단계에서 따로 정한다.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SnapshotBackend } from '../src/api/mock/snapshot';
import type { StoreState } from '../src/api/mock/store';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS templates   (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS batches     (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS hits        (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, batch_id TEXT NOT NULL, row_index INTEGER NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hit_id TEXT NOT NULL, worker_id TEXT NOT NULL, status TEXT NOT NULL, submit_time TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pools       (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS worker_meta (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS hits_batch         ON hits (batch_id);
  CREATE INDEX IF NOT EXISTS assignments_hit    ON assignments (hit_id);
  CREATE INDEX IF NOT EXISTS assignments_worker ON assignments (worker_id);
  CREATE INDEX IF NOT EXISTS assignments_status ON assignments (status);
`;

type SqlValue = string | number;

interface TableSpec<T> {
  table: string;
  columns: string[]; // id, seq, doc 외의 컬럼
  rows: (state: StoreState) => T[];
  id: (row: T) => string;
  values: (row: T) => SqlValue[]; // columns와 같은 순서
}

function spec<T>(s: TableSpec<T>): TableSpec<unknown> {
  return s as TableSpec<unknown>;
}

const TABLES: TableSpec<unknown>[] = [
  spec({ table: 'templates', columns: ['name', 'updated_at'], rows: (s) => s.templates, id: (t) => t.id, values: (t) => [t.name, t.updatedAt] }),
  spec({ table: 'batches', columns: ['name', 'created_at'], rows: (s) => s.batches, id: (b) => b.id, values: (b) => [b.name, b.createdAt] }),
  spec({ table: 'hits', columns: ['batch_id', 'row_index'], rows: (s) => s.hits, id: (h) => h.HITId, values: (h) => [h.batchId, h.rowIndex] }),
  spec({
    table: 'assignments',
    columns: ['hit_id', 'worker_id', 'status', 'submit_time'],
    rows: (s) => s.assignments,
    id: (a) => a.AssignmentId,
    values: (a) => [a.HITId, a.WorkerId, a.AssignmentStatus, a.SubmitTime],
  }),
  spec({ table: 'pools', columns: ['name'], rows: (s) => s.pools, id: (p) => p.id, values: (p) => [p.name] }),
  spec({
    table: 'worker_meta',
    columns: [],
    rows: (s) => Object.entries(s.workerMeta).map(([WorkerId, meta]) => ({ WorkerId, ...meta })),
    id: (w) => w.WorkerId,
    values: () => [],
  }),
];

export function createSqliteSnapshot(dbPath: string): SnapshotBackend<StoreState> & { close(): void } {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  // 테이블별로 "id → 직전에 쓴 내용". 달라진 행만 다시 쓰기 위한 것이다.
  const written = new Map<string, Map<string, string>>(TABLES.map((t) => [t.table, new Map()]));

  function transaction(work: () => void): void {
    db.exec('BEGIN');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const readMeta = (key: string) => (getMeta.get(key) as { value: string } | undefined)?.value;

  return {
    name: 'sqlite',

    async load() {
      const version = readMeta('version');
      if (version === undefined) return undefined;

      const docs = (table: string) =>
        (db.prepare(`SELECT id, seq, doc FROM ${table} ORDER BY seq`).all() as { id: string; seq: number; doc: string }[]).map(
          (row) => {
            written.get(table)!.set(row.id, `${row.seq}|${row.doc}`);
            return JSON.parse(row.doc) as unknown;
          },
        );
      const workerMeta: StoreState['workerMeta'] = {};
      for (const { WorkerId, ...meta } of docs('worker_meta') as ({ WorkerId: string } & StoreState['workerMeta'][string])[]) {
        workerMeta[WorkerId] = meta;
      }
      return {
        version: Number(version),
        seededAt: readMeta('seededAt') ?? new Date().toISOString(),
        savedAt: readMeta('savedAt') || null,
        templates: docs('templates'),
        batches: docs('batches'),
        hits: docs('hits'),
        assignments: docs('assignments'),
        pools: docs('pools'),
        workerMeta,
        account: JSON.parse(readMeta('account') ?? 'null'),
      } as StoreState;
    },

    async save(state) {
      transaction(() => {
        for (const t of TABLES) {
          const cache = written.get(t.table)!;
          const columns = ['id', 'seq', ...t.columns, 'doc'];
          const upsert = db.prepare(
            `INSERT INTO ${t.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
              `ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`,
          );
          const remove = db.prepare(`DELETE FROM ${t.table} WHERE id = ?`);

          const seen = new Set<string>();
          t.rows(state).forEach((row, seq) => {
            const id = t.id(row);
            const doc = JSON.stringify(row);
            const signature = `${seq}|${doc}`;
            seen.add(id);
            if (cache.get(id) === signature) return;
            upsert.run(id, seq, ...t.values(row), doc);
            cache.set(id, signature);
          });
          for (const id of [...cache.keys()]) {
            if (seen.has(id)) continue;
            remove.run(id);
            cache.delete(id);
          }
        }
        setMeta.run('version', String(state.version));
        setMeta.run('seededAt', state.seededAt);
        setMeta.run('savedAt', state.savedAt ?? '');
        setMeta.run('account', JSON.stringify(state.account));
      });
    },

    async clear() {
      transaction(() => {
        for (const t of TABLES) db.exec(`DELETE FROM ${t.table}`);
        db.exec('DELETE FROM meta');
      });
      for (const cache of written.values()) cache.clear();
    },

    close: () => db.close(),
  };
}
