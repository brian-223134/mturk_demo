// prototype/src/api/http/routes.ts 의 경로 표(API_ROUTES, MOCK_ROUTES)를 정규식으로 읽는 도우미. 테스트 파일이 아니다.
// TypeScript 를 컴파일하지 않고 표의 각 줄(`이름: { method: '…', path: '…', args: […] },`)만 뽑아 { 이름: { method, path, args } } 로 만든다.
// 경로는 import.meta.url 기준 상대 경로라 컨테이너(/app/frontend/tests/helpers → /app/prototype/…)와 호스트에서 모두 같은 파일을 가리킨다.

import { readFileSync } from 'node:fs';

export const ROUTES_TS_URL = new URL('../../../prototype/src/api/http/routes.ts', import.meta.url);

const ENTRY = /^\s*(\w+):\s*\{\s*method:\s*'(GET|POST|PUT|DELETE)',\s*path:\s*'([^']+)',\s*args:\s*\[([^\]]*)\]\s*\},?\s*$/gm;

/** 소스에서 `export const <name> = {` … `}` 블록을 찾아 표로 만든다. 블록이 없으면 throw. */
export function parseRouteTable(source, name) {
  const start = source.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`${name} not found in routes.ts`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`${name} block is not closed`);
  const block = source.slice(start, end);

  const table = {};
  for (const [, key, method, path, argsText] of block.matchAll(ENTRY)) {
    const args = argsText
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter((s) => s !== '');
    table[key] = { method, path, args };
  }
  return table;
}

/** routes.ts 를 읽어 { API_ROUTES, MOCK_ROUTES } 를 돌려준다. */
export function readTsRoutes() {
  const source = readFileSync(ROUTES_TS_URL, 'utf-8');
  return { API_ROUTES: parseRouteTable(source, 'API_ROUTES'), MOCK_ROUTES: parseRouteTable(source, 'MOCK_ROUTES') };
}
