import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../types';
import { fileURLToPath } from 'node:url';
import { createMockApi } from './handlers';
import { assembleState } from './seedFiles';
import { readSeedFiles } from './seedFromDisk';
import { createMemorySnapshot, type SnapshotBackend } from './snapshot';
import { MockStore, SNAPSHOT_VERSION, type StoreState } from './store';

const fixtures = readSeedFiles(fileURLToPath(new URL('../../../../data', import.meta.url)));
// 세 batch의 게시 기간이 모두 지난 시점
const NOW = new Date('2026-09-19T00:00:00Z');

function createStore(snapshot: SnapshotBackend<StoreState>) {
  let seedCount = 0;
  const store = new MockStore({
    snapshot,
    loadSeed: async () => {
      seedCount += 1;
      return assembleState(structuredClone(fixtures), NOW);
    },
  });
  return { store, seedCount: () => seedCount };
}

describe('MockStore', () => {
  let snapshot: SnapshotBackend<StoreState>;

  beforeEach(() => {
    snapshot = createMemorySnapshot<StoreState>();
  });

  it('스냅샷이 없으면 fixture에서 시작하고, 변경이 없으면 스냅샷을 만들지 않는다', async () => {
    const { store, seedCount } = createStore(snapshot);
    const info = await store.getInfo();
    expect(info).toMatchObject({ source: 'fixtures', savedAt: null });
    expect(seedCount()).toBe(1);
    expect(await snapshot.load()).toBeUndefined();
  });

  it('동시에 여러 번 불러도 fixture는 한 번만 올린다', async () => {
    const { store, seedCount } = createStore(snapshot);
    await Promise.all([store.getState(), store.getState(), store.getState()]);
    expect(seedCount()).toBe(1);
  });

  it('변경은 스냅샷에 저장되고, 새로고침(새 store)하면 스냅샷에서 복원된다', async () => {
    const first = createStore(snapshot);
    await first.store.update((state) => {
      state.pools.push({ id: 'pool-test', name: 'Test', description: '', workerIds: ['W000000000001'] });
    });

    const second = createStore(snapshot);
    const state = await second.store.getState();
    expect(state.pools.map((p) => p.id)).toContain('pool-test');
    expect(second.seedCount()).toBe(0);
    expect(await second.store.getInfo()).toMatchObject({ source: 'snapshot' });
    expect((await second.store.getInfo()).savedAt).not.toBeNull();
  });

  it('"fixture로 초기화"는 스냅샷을 지우고 처음 상태로 돌린다', async () => {
    const { store } = createStore(snapshot);
    await store.update((state) => {
      state.pools = [];
      state.assignments = [];
    });
    expect((await store.getState()).assignments).toHaveLength(0);

    await store.reset();

    const state = await store.getState();
    expect(state.assignments).toHaveLength(231);
    expect(state.pools.map((p) => p.name)).toEqual(['Trusted', 'Excluded']);
    expect(await store.getInfo()).toMatchObject({ source: 'fixtures', savedAt: null });
    expect(await snapshot.load()).toBeUndefined();

    // 초기화 뒤에 새로고침해도 fixture에서 시작한다
    const reloaded = createStore(snapshot);
    expect(await reloaded.store.getInfo()).toMatchObject({ source: 'fixtures' });
  });

  it('버전이 다른 스냅샷은 버리고 fixture에서 시작한다', async () => {
    const stale = assembleState(structuredClone(fixtures), NOW);
    await snapshot.save({ ...stale, version: SNAPSHOT_VERSION - 1, batches: [] });

    const { store } = createStore(snapshot);
    expect((await store.getState()).batches).toHaveLength(3);
    expect(await store.getInfo()).toMatchObject({ source: 'fixtures' });
  });

  it('스냅샷을 읽거나 쓸 수 없어도 메모리만으로 동작한다', async () => {
    const broken: SnapshotBackend<StoreState> = {
      name: 'memory',
      load: async () => {
        throw new Error('IndexedDB unavailable');
      },
      save: async () => {
        throw new Error('IndexedDB unavailable');
      },
      clear: async () => {
        throw new Error('IndexedDB unavailable');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { store } = createStore(broken);
      await store.update((state) => {
        state.account.AvailableBalance = '1.00';
      });
      expect((await store.getState()).account.AvailableBalance).toBe('1.00');
      await store.reset();
      expect((await store.getState()).account.AvailableBalance).toBe('500.00');
      // 읽기, 저장, 지우기 실패를 각각 한 번씩 알린다
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('상태가 바뀌면 revision이 늘어난다', async () => {
    const { store } = createStore(snapshot);
    await store.getState();
    const before = store.revision;
    await store.update(() => {});
    expect(store.revision).toBe(before + 1);
    await store.reset();
    expect(store.revision).toBe(before + 2);
  });
});

describe('mock Api (조회)', () => {
  function createApi() {
    const { store } = createStore(createMemorySnapshot<StoreState>());
    return { store, api: createMockApi(store, { delayMs: [0, 0], now: () => NOW }) };
  }

  it('listBatches: 최근 batch부터, 진행률과 비용을 계산해서 준다', async () => {
    const { api } = createApi();
    const batches = await api.listBatches();
    expect(batches.map((b) => b.batch.id)).toEqual(['batch-1000003', 'batch-1000002', 'batch-1000001']);
    for (const b of batches) expect(b.batch).not.toHaveProperty('templateHtml');

    const f1 = batches.find((b) => b.batch.id === 'batch-1000001')!;
    expect(f1.progress).toMatchObject({ hitsTotal: 40, submitted: 6, approved: 108, rejected: 18 });
    expect(f1.progress.rejectRate).toBeCloseTo(18 / 126);
    expect(f1.needsReview).toBe(true);
    // 게시 기간이 지났는데 승인 3건이 안 찬 HIT가 있다
    expect(f1.progress.hitsCompleted).toBeLessThan(40);
    expect(f1.status).toBe('expired');
    // $0.05 + 수수료 $0.01(최소 수수료) = assignment당 6센트
    expect(f1.cost.spentCents).toBe(108 * 6);

    const f2 = batches.find((b) => b.batch.id === 'batch-1000003')!;
    expect(f2).toMatchObject({ status: 'completed', needsReview: false });
    expect(f2.progress).toMatchObject({ hitsTotal: 16, hitsCompleted: 16, approved: 48, open: 0 });
    expect(f2.cost).toEqual({ spentCents: 48 * 12, estimatedCents: 48 * 12 });

    const f3 = batches.find((b) => b.batch.id === 'batch-1000002')!;
    expect(f3.status).toBe('completed'); // 3건 반려 후 재모집으로 채웠다
    expect(f3.progress).toMatchObject({ hitsCompleted: 16, approved: 48, rejected: 3 });
  });

  it('getBatch: 템플릿 사본을 포함한 상세. 없는 id는 NOT_FOUND', async () => {
    const { api } = createApi();
    const detail = await api.getBatch('batch-1000001');
    expect(detail.batch.templateHtml).toContain('<crowd-form>');
    expect(detail.progress.hitsTotal).toBe(40);
    await expect(api.getBatch('nope')).rejects.toMatchObject({ name: 'ApiError', code: 'NOT_FOUND' });
  });

  it('listWorkers: 60명, 서버식 페이지네이션과 정렬', async () => {
    const { api } = createApi();
    const page1 = await api.listWorkers({
      page: 1,
      pageSize: 25,
      sort: { field: 'stats.rejectRate', order: 'desc' },
    });
    expect(page1.total).toBe(60);
    expect(page1.items).toHaveLength(25);
    const rates = page1.items.map((w) => w.stats.rejectRate);
    expect(rates[0]).toBeGreaterThan(0);
    const present = rates.filter((r): r is number => r !== null);
    expect(present).toEqual([...present].sort((a, b) => b - a));

    const page3 = await api.listWorkers({ page: 3, pageSize: 25 });
    expect(page3.items).toHaveLength(10);

    const total = (await api.listWorkers({ page: 1, pageSize: 100 })).items.reduce(
      (sum, w) => sum + w.stats.total,
      0,
    );
    expect(total).toBe(231);
  });

  it('listWorkers: 정렬에서 null은 방향과 무관하게 맨 뒤', async () => {
    const { api, store } = createApi();
    await store.update((state) => {
      state.pools[0]!.workerIds.push('Wnoanswers000'); // 응답이 없는 worker
    });
    for (const order of ['asc', 'desc'] as const) {
      const { items } = await api.listWorkers({
        page: 1,
        pageSize: 100,
        sort: { field: 'stats.medianWorkTimeInSeconds', order },
      });
      expect(items).toHaveLength(61);
      expect(items.at(-1)?.WorkerId).toBe('Wnoanswers000');
    }
  });

  it('listWorkers: search와 poolId 필터', async () => {
    const { api, store } = createApi();
    const all = await api.listWorkers({ page: 1, pageSize: 100 });
    const target = all.items[0]!.WorkerId;

    const found = await api.listWorkers({
      page: 1,
      pageSize: 10,
      filters: { search: target.slice(0, 8).toUpperCase() },
    });
    expect(found.items.map((w) => w.WorkerId)).toContain(target);

    await store.update((state) => {
      state.pools.find((p) => p.id === 'pool-excluded')!.workerIds.push(target);
    });
    const excluded = await api.listWorkers({ page: 1, pageSize: 10, filters: { poolId: 'pool-excluded' } });
    expect(excluded.items.map((w) => w.WorkerId)).toEqual([target]);
    expect(excluded.items[0]!.poolIds).toEqual(['pool-excluded']);
  });

  it('listAssignments / listHits: batch 단위 조회와 상태 필터', async () => {
    const { api } = createApi();
    const submitted = await api.listAssignments('batch-1000001', {
      page: 1,
      pageSize: 50,
      filters: { AssignmentStatus: 'Submitted' },
    });
    expect(submitted.total).toBe(6);

    const reviewed = await api.listAssignments('batch-1000001', {
      page: 1,
      pageSize: 5,
      filters: { AssignmentStatus: ['Approved', 'Rejected'] },
    });
    expect(reviewed.total).toBe(126);
    expect(reviewed.items).toHaveLength(5);

    const hits = await api.listHits('batch-1000001', {
      page: 1,
      pageSize: 100,
      sort: { field: 'rowIndex', order: 'asc' },
    });
    expect(hits.total).toBe(40);
    expect(hits.items.map((h) => h.rowIndex)).toEqual([...Array(40).keys()]);
  });

  it('잘못된 페이지 요청은 INVALID_REQUEST', async () => {
    const { api } = createApi();
    await expect(api.listWorkers({ page: 0, pageSize: 25 })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(api.listWorkers({ page: 1, pageSize: 5000 })).rejects.toBeInstanceOf(ApiError);
  });

  it('돌려준 객체를 바꿔도 저장소는 바뀌지 않는다', async () => {
    const { api } = createApi();
    const pools = await api.listPools();
    pools[0]!.name = 'mutated';
    expect((await api.listPools())[0]!.name).toBe('Trusted');
  });

  it('getAccount / listTemplates / listPools', async () => {
    const { api } = createApi();
    expect(await api.getAccount()).toEqual({ env: 'mock', AvailableBalance: '500.00' });
    expect((await api.listTemplates()).map((t) => t.id).sort()).toEqual([
      'tpl-chunk-fact-relevance',
      'tpl-query-fact-coverage',
    ]);
    expect((await api.listPools()).map((p) => p.id)).toEqual(['pool-trusted', 'pool-excluded']);
  });
});
