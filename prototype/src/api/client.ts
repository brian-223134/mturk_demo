// 설계 명세 6장의 API 인터페이스와 구현체 선택.
// 화면 코드는 이 파일의 `api`만 호출하고, 그 뒤가 mock인지 실제 서버인지 모른다 (설계 원칙 1).

import { createHttpClient } from './http/client';
import { API_ROUTES, MOCK_ROUTES } from './http/routes';
import type { MockTools } from './mock/tools';
import type {
  Account,
  AddAssignmentsMode,
  AddAssignmentsResult,
  AssignmentListItem,
  Assignment,
  Batch,
  BatchDetail,
  BatchResults,
  BatchSummary,
  CreateBatchRequest,
  ExportFile,
  ExportFormat,
  Hit,
  HitListItem,
  ListQuery,
  ListResult,
  SaveTemplateRequest,
  Template,
  Worker,
  WorkerDetail,
  WorkerPool,
} from './types';

export interface Api {
  listTemplates(): Promise<Template[]>;
  getTemplate(id: string): Promise<Template>;
  saveTemplate(req: SaveTemplateRequest): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;

  listBatches(): Promise<BatchSummary[]>;
  getBatch(id: string): Promise<BatchDetail>;
  createBatch(req: CreateBatchRequest): Promise<Batch>;
  expireBatch(id: string): Promise<void>;

  listHits(batchId: string, q: ListQuery): Promise<ListResult<HitListItem>>;
  /** 입력 전체가 든 HIT 1건. 목록은 입력을 잘라서 주므로 미리보기("Open task")에는 이것을 쓴다. */
  getHit(hitId: string): Promise<Hit>;
  listAssignments(batchId: string, q: ListQuery): Promise<ListResult<AssignmentListItem>>;
  /** `override`는 반려 번복이다 (MTurk의 OverrideRejection). */
  approveAssignments(ids: string[], feedback?: string, override?: boolean): Promise<Assignment[]>;
  rejectAssignments(ids: string[], feedback: string): Promise<Assignment[]>;
  addAssignments(hitIds: string[], mode: AddAssignmentsMode): Promise<AddAssignmentsResult>;

  getResults(batchId: string): Promise<BatchResults>;
  exportBatch(batchId: string, format: ExportFormat): Promise<ExportFile>;

  listWorkers(q: ListQuery): Promise<ListResult<Worker>>;
  getWorker(id: string): Promise<WorkerDetail>;
  updateWorkerNote(id: string, note: string): Promise<Worker>;

  listPools(): Promise<WorkerPool[]>;
  createPool(req: { name: string; description: string }): Promise<WorkerPool>;
  addWorkersToPool(poolId: string, workerIds: string[]): Promise<WorkerPool>;
  removeWorkersFromPool(poolId: string, workerIds: string[]): Promise<WorkerPool>;
  blockWorkers(ids: string[], reason: string): Promise<void>;
  unblockWorkers(ids: string[]): Promise<void>;

  getAccount(): Promise<Account>;
}

export type ApiMode = 'mock' | 'http';

/**
 * 구현체 선택. Vite가 빌드할 때 값을 코드에 넣으므로 실행 중에는 바뀌지 않는다.
 *   mock: 브라우저 안에서 전부 동작한다 (data/ 폴더 + IndexedDB). 서버가 필요 없다.
 *   http: REST 서버를 부른다. 지금은 mock API 서버(server/, SQLite), 연동 단계에서는 실제 백엔드.
 */
export const apiMode: ApiMode = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock';

type Client = { api: Api; mockTools: MockTools };

// mock 구현은 data/ 폴더를 번들에 끌고 오므로 http 모드에서는 불러오지 않는다.
const client: Promise<Client> =
  apiMode === 'http'
    ? Promise.resolve(createHttpClient(import.meta.env.VITE_API_BASE_URL ?? '/api'))
    : import('./mock').then((mock) => mock.createMockClient());

function lazy<T extends object>(names: readonly string[], pick: (c: Client) => T): T {
  const entries = names.map((name) => [
    name,
    async (...args: unknown[]) => {
      const target = pick(await client) as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return target[name]!(...args);
    },
  ]);
  return Object.fromEntries(entries) as T;
}

export const api: Api = lazy(Object.keys(API_ROUTES), (c) => c.api);

/**
 * mock 환경에만 있는 도구 (5.1의 Mock tools). API 인터페이스에는 넣지 않는다 (7.3).
 * 화면은 account.env가 'mock'일 때만 보여준다. 실제 백엔드에는 이 경로가 없다.
 */
export const mockTools: MockTools = lazy(Object.keys(MOCK_ROUTES), (c) => c.mockTools);
