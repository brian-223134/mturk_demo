// mock API 서버를 실제로 띄워 http 클라이언트(src/api/http)와 왕복시킨다. 화면이 쓰는 것과 같은 경로다.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/api/http/client';
import { API_ROUTES } from '../src/api/http/routes';
import { createMockApi } from '../src/api/mock/handlers';
import { assembleState } from '../src/api/mock/seedFiles';
import { readSeedFiles } from '../src/api/mock/seedFromDisk';
import { MockStore } from '../src/api/mock/store';
import { createMockTools } from '../src/api/mock/tools';
import { createRequestHandler } from './app';
import { createSqliteSnapshot } from './sqliteSnapshot';

const files = readSeedFiles(resolve(process.cwd(), 'data'));
const F1 = 'batch-1000001';
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mturk-console-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'test.sqlite');
}

async function start(dbPath: string) {
  const snapshot = createSqliteSnapshot(dbPath);
  let seeds = 0;
  const store = new MockStore({
    snapshot,
    persistSeed: true,
    loadSeed: async () => {
      seeds += 1;
      return assembleState(structuredClone(files));
    },
  });
  const handler = createRequestHandler(createMockApi(store, { delayMs: [0, 0] }), createMockTools(store), () => {});
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  let stopped = false;
  const stop = async () => {
    if (stopped) return; // 테스트가 직접 멈춘 뒤 afterEach가 한 번 더 부른다
    stopped = true;
    await new Promise((done) => server.close(done));
    snapshot.close();
  };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { ...createHttpClient(base), base, stop, seedCount: () => seeds };
}

describe('REST 왕복 (src/api/http ↔ server)', () => {
  it('조회: 목록, 정렬과 필터가 든 query string, 경로 인자', async () => {
    const { api } = await start(tempDb());
    expect((await api.listBatches()).map((b) => b.batch.id)).toEqual(['batch-1000003', 'batch-1000002', F1]);
    expect((await api.getAccount()).AvailableBalance).toBe('500.00');

    const workers = await api.listWorkers({
      page: 2,
      pageSize: 10,
      sort: { field: 'stats.rejectRate', order: 'desc' },
      filters: { minApproved: 1 },
    });
    expect(workers.items).toHaveLength(10);
    expect(workers.total).toBeLessThan(60);

    const submitted = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: ['Submitted'] } });
    expect(submitted.total).toBe(6);
    expect((await api.getHit(submitted.items[0]!.HITId)).HITId).toBe(submitted.items[0]!.HITId);
    expect((await api.exportBatch(F1, 'labels-json')).filename).toBe('pilot-close-ended-chunk-fact-labels.json');
  });

  it('변경: JSON body, 결과가 없는 응답(204), 큰 body', async () => {
    const { api } = await start(tempDb());
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    const [rejected] = await api.rejectAssignments([items[0]!.AssignmentId], 'Poor Quality.');
    expect(rejected).toMatchObject({ AssignmentStatus: 'Rejected', RequesterFeedback: 'Poor Quality.' });
    expect(await api.blockWorkers([items[0]!.WorkerId], 'test')).toBeUndefined();

    const template = await api.saveTemplate({ name: 'Big', html: '<html><head></head><body>x</body></html>' });
    const batch = await api.createBatch({
      name: 'big rows',
      templateId: template.id,
      inputColumns: ['text'],
      rows: Array.from({ length: 20 }, () => ({ text: 'x'.repeat(100_000) })), // 셀 하나가 100KB (명세 9장)
      settings: {
        Title: 't', Description: 'd', Keywords: 'k', Reward: '0.05', MaxAssignments: 3,
        AssignmentDurationInSeconds: 1800, LifetimeInSeconds: 86400, AutoApprovalDelayInSeconds: 86400, QualificationRequirements: [],
      },
      attentionRule: null,
      requiredPoolIds: [],
      excludedPoolIds: [],
    });
    const hits = await api.listHits(batch.id, { page: 1, pageSize: 5 });
    expect(hits.total).toBe(20);
    expect((await api.getHit(hits.items[0]!.HITId)).input.text).toHaveLength(100_000);
  });

  it('오류는 ApiError의 code와 메시지로 되살아난다', async () => {
    const { api, base } = await start(tempDb());
    await expect(api.getBatch('nope')).rejects.toMatchObject({ name: 'ApiError', code: 'NOT_FOUND', message: 'Batch not found: nope' });
    await expect(api.rejectAssignments(['x'], '')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(api.listWorkers({ page: 0, pageSize: 10 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect((await fetch(`${base}/no-such-route`)).status).toBe(404);
    expect((await fetch(`${base}/assignments/approve`, { method: 'POST', body: '{broken' })).status).toBe(400);
    expect((await fetch(`${base}/workers?filters=%7Bbroken`)).status).toBe(400);
  });

  it('서버가 내려가 있으면 NETWORK 오류로 알린다', async () => {
    const { api, stop } = await start(tempDb());
    await stop();
    await expect(api.listBatches()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('경로 표의 모든 메서드가 서버에 연결되어 있다', async () => {
    const { api } = await start(tempDb());
    for (const name of Object.keys(API_ROUTES)) expect(typeof (api as unknown as Record<string, unknown>)[name]).toBe('function');
    // 인자 없이 불러도 "경로 없음"이 아니라 핸들러의 검증 오류나 정상 응답이 와야 한다
    for (const name of Object.keys(API_ROUTES) as (keyof typeof API_ROUTES)[]) {
      const outcome = await (api[name] as (...a: unknown[]) => Promise<unknown>)('x', { page: 1, pageSize: 1 }).then(
        () => 'ok',
        (e: { code: string; message: string }) => `${e.code}: ${e.message}`,
      );
      expect(outcome).not.toMatch(/No such route|NETWORK|UNKNOWN/);
    }
  });
});

describe('SQLite 저장', () => {
  it('DB가 비어 있으면 data/를 올리고, 변경은 서버를 다시 띄워도 남는다', async () => {
    const dbPath = tempDb();
    const first = await start(dbPath);
    expect(await first.mockTools.getInfo()).toMatchObject({ source: 'fixtures', backend: 'sqlite', counts: { batches: 3, hits: 72, assignments: 231 } });
    const { items } = await first.api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    await first.api.rejectAssignments(items.map((a) => a.AssignmentId), 'Poor Quality.');
    await first.api.createPool({ name: 'Persisted pool', description: '' });
    await first.stop();

    const second = await start(dbPath);
    expect(second.seedCount()).toBe(0);
    expect(await second.mockTools.getInfo()).toMatchObject({ source: 'snapshot', backend: 'sqlite' });
    expect((await second.api.getBatch(F1)).progress).toMatchObject({ submitted: 0, rejected: 24 });
    expect((await second.api.listPools()).map((p) => p.name)).toEqual(['Trusted', 'Excluded', 'Persisted pool']);
    expect((await second.api.getAccount()).AvailableBalance).toBe('500.36'); // 6건 환불
    // 순서도 그대로다 (data/에서 올린 직후와 같은 목록 순서)
    expect((await second.api.listBatches()).map((b) => b.batch.id)).toEqual(['batch-1000003', 'batch-1000002', F1]);
  });

  it('DB를 SQL로 직접 들여다볼 수 있다', async () => {
    const dbPath = tempDb();
    const { api, stop } = await start(dbPath);
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 1, filters: { AssignmentStatus: 'Submitted' } });
    await api.rejectAssignments([items[0]!.AssignmentId], 'Poor Quality.');
    await stop();

    const db = new DatabaseSync(dbPath);
    try {
      const counts = db.prepare('SELECT status, COUNT(*) AS n FROM assignments GROUP BY status ORDER BY status').all();
      expect(counts.map((r) => [r.status, r.n])).toEqual([['Approved', 204], ['Rejected', 22], ['Submitted', 5]]);
      const feedback = db.prepare("SELECT json_extract(doc, '$.RequesterFeedback') AS f FROM assignments WHERE id = ?").get(items[0]!.AssignmentId);
      expect(feedback?.f).toBe('Poor Quality.');
      expect(db.prepare('SELECT COUNT(*) AS n FROM hits WHERE batch_id = ?').get(F1)?.n).toBe(40);
    } finally {
      db.close();
    }
  });

  it('Reset은 DB를 비우고 data/를 다시 올린다. Import한 상태도 DB에 저장된다', async () => {
    const dbPath = tempDb();
    const first = await start(dbPath);
    await first.api.createPool({ name: 'Temporary', description: '' });
    const exported = await first.mockTools.exportState();
    await first.mockTools.reset();
    expect((await first.api.listPools()).map((p) => p.name)).toEqual(['Trusted', 'Excluded']);

    await first.mockTools.importState(exported.content);
    await first.stop();
    const second = await start(dbPath);
    expect((await second.api.listPools()).map((p) => p.name)).toContain('Temporary');
  });
});
