// 브라우저 mock 모드의 조립: data/ 폴더(번들) + IndexedDB 스냅샷. 서버가 없어도 동작한다.

import type { Api } from '../client';
import { createMockApi } from './handlers';
import { createIdbSnapshot } from './idbSnapshot';
import { loadSeedFilesFromBundle } from './seedFromBundle';
import { assembleState } from './seedFiles';
import { MockStore, type StoreState } from './store';
import { createMockTools, type MockTools } from './tools';

const SNAPSHOT_KEY = 'mturk-console:mock-store';

export function createMockClient(): { api: Api; mockTools: MockTools } {
  const store = new MockStore({
    snapshot: createIdbSnapshot<StoreState>(SNAPSHOT_KEY),
    loadSeed: async () => assembleState(await loadSeedFilesFromBundle()),
  });
  return { api: createMockApi(store), mockTools: createMockTools(store) };
}
