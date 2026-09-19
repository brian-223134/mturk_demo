// 브라우저 mock 모드의 스냅샷. localStorage는 약 5MB 제한이라 HIT 입력 데이터를 담을 수 없어 IndexedDB를 쓴다.

import { del, get, set } from 'idb-keyval';
import type { SnapshotBackend } from './snapshot';

const LOAD_TIMEOUT_MS = 3000;

export function createIdbSnapshot<T>(key: string): SnapshotBackend<T> {
  return {
    name: 'indexeddb',
    // 일부 환경(사생활 보호 모드, 내장 브라우저)에서는 IndexedDB 요청이 오류도 없이 끝나지 않는다.
    // 그러면 앱 전체가 로딩에서 멈추므로, 시간 안에 답이 없으면 오류로 처리해 저장소가 data/에서 시작하게 한다.
    load: () =>
      Promise.race([
        get<T>(key),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`IndexedDB did not respond within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS),
        ),
      ]),
    save: (state) => set(key, state),
    clear: () => del(key),
  };
}
