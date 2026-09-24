// 5.1의 Mock tools. mock 환경에만 있는 기능이라 Api 인터페이스와 따로 둔다 (7.3).
// 브라우저 mock 모드는 이 구현을 직접 쓰고, 서버 모드는 같은 구현을 /mock/* 경로로 부른다 (src/api/http).

import { ApiError, type ExportFile } from '../types';
import { generateFakeSubmissions, type FakeSubmissionRequest, type FakeSubmissionResult } from './simulate';
import { MockStore, SNAPSHOT_VERSION, type MockStoreInfo, type StoreState } from './store';

export interface MockTools {
  getInfo(): Promise<MockStoreInfo>;
  /** "fixture로 초기화": 저장된 상태를 지우고 data/ 폴더의 내용으로 돌린다. */
  reset(): Promise<void>;
  /** "가짜 제출 N건 생성" (7.3) */
  generateFakeSubmissions(request: FakeSubmissionRequest): Promise<FakeSubmissionResult>;
  /** 현재 상태 전체를 JSON 파일 하나로 내보낸다. `npm run data:unpack`으로 data/ 구조로 풀 수 있다. */
  exportState(): Promise<ExportFile>;
  importState(json: string): Promise<MockStoreInfo>;
}

export const STATE_FILE_FORMAT = 'mturk-console-state';

export interface StateFile {
  format: typeof STATE_FILE_FORMAT;
  version: number;
  exportedAt: string;
  state: StoreState;
}

const COLLECTIONS = ['templates', 'batches', 'hits', 'assignments', 'pools'] as const;

export function parseStateFile(json: string): StoreState {
  let file: Partial<StateFile>;
  try {
    file = JSON.parse(json) as Partial<StateFile>;
  } catch (error) {
    throw new ApiError('INVALID_REQUEST', `Not a valid JSON file: ${(error as Error).message}`);
  }
  if (file?.format !== STATE_FILE_FORMAT || !file.state) {
    throw new ApiError('INVALID_REQUEST', `This is not a console data file ("format" must be "${STATE_FILE_FORMAT}").`);
  }
  if (file.version !== SNAPSHOT_VERSION) {
    throw new ApiError('INVALID_REQUEST', `Data file version ${String(file.version)} is not supported (expected ${SNAPSHOT_VERSION}).`);
  }
  for (const key of COLLECTIONS) {
    if (!Array.isArray(file.state[key])) {
      throw new ApiError('INVALID_REQUEST', `Data file is incomplete: "state.${key}" must be an array.`);
    }
  }
  if (!file.state.account?.AvailableBalance) {
    throw new ApiError('INVALID_REQUEST', 'Data file is incomplete: "state.account" is missing.');
  }
  return { ...file.state, workerMeta: file.state.workerMeta ?? {} };
}

export function createMockTools(
  store: MockStore,
  options: { now?: () => Date; random?: () => number } = {},
): MockTools {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  return {
    getInfo: () => store.getInfo(),
    reset: () => store.reset(),

    async generateFakeSubmissions(request) {
      if (!Number.isInteger(request.count) || request.count < 1 || request.count > 5000) {
        throw new ApiError('INVALID_REQUEST', 'count must be an integer between 1 and 5000.');
      }
      let result!: FakeSubmissionResult;
      await store.update((state) => {
        result = generateFakeSubmissions(state, request, { now: now(), random });
      });
      return result;
    },

    async exportState() {
      const at = now();
      const file: StateFile = {
        format: STATE_FILE_FORMAT,
        version: SNAPSHOT_VERSION,
        exportedAt: at.toISOString(),
        state: await store.getState(),
      };
      return {
        filename: `mturk-console-data-${at.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`,
        mimeType: 'application/json',
        content: JSON.stringify(file),
      };
    },

    async importState(json) {
      await store.replaceState(parseStateFile(json));
      return store.getInfo();
    },
  };
}
