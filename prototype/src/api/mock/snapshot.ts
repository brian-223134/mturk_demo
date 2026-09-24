// 7.2 스냅샷 저장의 경계. 저장소는 이 인터페이스만 알고, 실제 저장 위치는 구현체가 정한다:
//   브라우저 mock 모드 → IndexedDB (idbSnapshot.ts),  mock API 서버 → SQLite (server/sqliteSnapshot.ts)

export interface SnapshotBackend<T> {
  readonly name: 'indexeddb' | 'sqlite' | 'memory';
  load(): Promise<T | undefined>;
  save(state: T): Promise<void>;
  clear(): Promise<void>;
}

/** 테스트용. 실제 DB처럼 저장할 때와 읽을 때 복제해서, 메모리 상태와 스냅샷이 객체를 공유하지 않게 한다. */
export function createMemorySnapshot<T>(): SnapshotBackend<T> {
  let saved: T | undefined;
  return {
    name: 'memory',
    load: async () => (saved === undefined ? undefined : structuredClone(saved)),
    save: async (state) => {
      saved = structuredClone(state);
    },
    clear: async () => {
      saved = undefined;
    },
  };
}
