// 브라우저 전용 mock 모드에서 data/ 폴더를 읽는다. Vite가 파일을 별도 chunk로 묶어 두고, 앱이 처음 뜰 때 받아 온다.
// 서버 모드(VITE_API_MODE=http)에서는 이 모듈이 실행되지 않으므로 data/가 브라우저로 내려가지 않는다.

import type { SeedFiles } from './seedFiles';

// Vite의 root는 prototype/이고 data/는 저장소 루트에 있으므로, 이 파일 기준의 상대 경로로 가리킨다.
const jsonFiles = import.meta.glob<unknown>('../../../../data/**/*.json', { import: 'default' });
const htmlFiles = import.meta.glob<string>('../../../../data/**/*.html', { query: '?raw', import: 'default' });

export async function loadSeedFilesFromBundle(): Promise<SeedFiles> {
  const loaders = { ...jsonFiles, ...htmlFiles };
  const entries = await Promise.all(
    Object.entries(loaders).map(async ([path, load]) => [path.replace(/^(\.\.\/)+data\//, ''), await load()] as const),
  );
  return Object.fromEntries(entries);
}
