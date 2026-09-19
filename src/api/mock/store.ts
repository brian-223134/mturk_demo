// 7.2 Mock 저장소. 상태는 메모리에 두고, 변경이 있을 때마다 스냅샷으로 저장한다.

import type { Account, Assignment, Batch, Hit, Template, WorkerPool } from '../types';
import type { SnapshotBackend } from './snapshot';

/** StoreState의 모양이 바뀌면 올린다. 버전이 다른 스냅샷은 버리고 fixture에서 다시 시작한다. */
export const SNAPSHOT_VERSION = 1;

export interface StoreState {
  version: number;
  seededAt: string; // fixture를 올린 시각
  savedAt: string | null; // 마지막으로 스냅샷을 저장한 시각. 변경이 없었으면 null
  templates: Template[];
  batches: Batch[];
  hits: Hit[];
  assignments: Assignment[];
  pools: WorkerPool[];
  workerMeta: Record<string, { blocked: boolean; note: string; blockReason?: string }>; // 콘솔이 worker에 붙인 정보
  account: Account;
}

export interface MockStoreInfo {
  source: 'fixtures' | 'snapshot'; // 이번 세션의 상태가 어디서 왔는지 (fixtures = data/ 폴더)
  backend: SnapshotBackend<StoreState>['name']; // 변경이 저장되는 곳
  seededAt: string;
  savedAt: string | null;
  counts: { templates: number; batches: number; hits: number; assignments: number; pools: number };
}

export interface MockStoreOptions {
  snapshot: SnapshotBackend<StoreState>;
  loadSeed: () => Promise<StoreState>;
  /**
   * data/에서 시작한 직후에도 스냅샷을 저장한다. 서버(SQLite)는 DB를 바로 들여다볼 수 있게 켜고,
   * 브라우저는 변경이 있을 때만 저장한다 (7.2).
   */
  persistSeed?: boolean;
}

export class MockStore {
  private state: StoreState | null = null;
  private source: MockStoreInfo['source'] = 'fixtures';
  private ready: Promise<void> | null = null;
  private currentRevision = 0;

  constructor(private readonly options: MockStoreOptions) {}

  /** 상태가 바뀔 때마다 늘어난다. 파생 값을 캐시할 때 쓴다. */
  get revision(): number {
    return this.currentRevision;
  }

  async getState(): Promise<StoreState> {
    this.ready ??= this.init();
    await this.ready;
    return this.state!;
  }

  async getInfo(): Promise<MockStoreInfo> {
    const state = await this.getState();
    return {
      source: this.source,
      backend: this.options.snapshot.name,
      seededAt: state.seededAt,
      savedAt: state.savedAt,
      counts: {
        templates: state.templates.length,
        batches: state.batches.length,
        hits: state.hits.length,
        assignments: state.assignments.length,
        pools: state.pools.length,
      },
    };
  }

  /** 상태 전체를 바꾼다 ("Import data"). */
  async replaceState(next: StoreState): Promise<void> {
    await this.getState();
    this.state = { ...next, version: SNAPSHOT_VERSION, savedAt: new Date().toISOString() };
    this.source = 'snapshot';
    this.currentRevision += 1;
    await this.persist(this.state);
  }

  /** 상태를 바꾸고 스냅샷을 저장한다. 모든 변경은 이 메서드를 거친다. */
  async update(mutate: (state: StoreState) => void): Promise<void> {
    const state = await this.getState();
    mutate(state);
    state.savedAt = new Date().toISOString();
    this.currentRevision += 1;
    await this.persist(state);
  }

  /** "fixture로 초기화". 스냅샷을 지우고 처음 상태로 돌린다. */
  async reset(): Promise<void> {
    this.ready = (async () => {
      try {
        await this.options.snapshot.clear();
      } catch (error) {
        console.warn('[mock] 스냅샷을 지우지 못했습니다.', error);
      }
      await this.seed();
    })();
    await this.ready;
  }

  private async init(): Promise<void> {
    let saved: StoreState | undefined;
    try {
      saved = await this.options.snapshot.load();
    } catch (error) {
      // 사생활 보호 모드 등 저장소를 쓸 수 없는 환경. 메모리만으로 계속 동작한다.
      console.warn('[mock] 스냅샷을 읽지 못해 data/에서 시작합니다.', error);
    }
    if (saved && saved.version === SNAPSHOT_VERSION) {
      this.state = saved;
      this.source = 'snapshot';
      this.currentRevision += 1;
      return;
    }
    await this.seed();
  }

  private async seed(): Promise<void> {
    this.state = await this.options.loadSeed();
    this.source = 'fixtures';
    this.currentRevision += 1;
    if (this.options.persistSeed) await this.persist(this.state);
  }

  private async persist(state: StoreState): Promise<void> {
    try {
      await this.options.snapshot.save(state);
    } catch (error) {
      console.warn('[mock] 스냅샷을 저장하지 못했습니다. 새로고침하면 변경이 사라집니다.', error);
    }
  }
}
