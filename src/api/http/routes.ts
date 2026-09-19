// REST 경로 표 (설계 명세 6장의 "연동 시 REST" 열). 브라우저의 http 구현(client.ts)과 mock API 서버(server/)가
// 이 표 하나를 함께 쓰므로 양쪽이 어긋날 수 없다. 실제 백엔드를 만들 때는 이 표가 계약서다.
//
// 인자를 요청에 싣는 규칙
//   - 경로의 `:이름`과 같은 이름의 인자는 경로에 넣는다.
//   - GET, DELETE의 나머지 인자는 query string에 넣는다. `q`(ListQuery)는 page, pageSize, sort=필드:방향, filters=JSON으로 편다.
//   - POST, PUT의 나머지 인자는 JSON body에 이름으로 넣는다. 인자 이름이 `body`면 그 값 자체가 body다.

import type { Api } from '../client';
import type { MockTools } from '../mock/tools';
import type { ListQuery } from '../types';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  args: readonly string[]; // 메서드의 인자 이름 (순서대로)
}

export const API_ROUTES = {
  listTemplates: { method: 'GET', path: '/templates', args: [] },
  getTemplate: { method: 'GET', path: '/templates/:id', args: ['id'] },
  saveTemplate: { method: 'POST', path: '/templates', args: ['body'] },
  deleteTemplate: { method: 'DELETE', path: '/templates/:id', args: ['id'] },

  listBatches: { method: 'GET', path: '/batches', args: [] },
  getBatch: { method: 'GET', path: '/batches/:id', args: ['id'] },
  createBatch: { method: 'POST', path: '/batches', args: ['body'] },
  expireBatch: { method: 'POST', path: '/batches/:id/expire', args: ['id'] },

  listHits: { method: 'GET', path: '/batches/:batchId/hits', args: ['batchId', 'q'] },
  getHit: { method: 'GET', path: '/hits/:hitId', args: ['hitId'] },
  listAssignments: { method: 'GET', path: '/batches/:batchId/assignments', args: ['batchId', 'q'] },
  approveAssignments: { method: 'POST', path: '/assignments/approve', args: ['ids', 'feedback', 'override'] },
  rejectAssignments: { method: 'POST', path: '/assignments/reject', args: ['ids', 'feedback'] },
  addAssignments: { method: 'POST', path: '/hits/add-assignments', args: ['hitIds', 'mode'] },

  getResults: { method: 'GET', path: '/batches/:batchId/results', args: ['batchId'] },
  exportBatch: { method: 'GET', path: '/batches/:batchId/export', args: ['batchId', 'format'] },

  listWorkers: { method: 'GET', path: '/workers', args: ['q'] },
  getWorker: { method: 'GET', path: '/workers/:id', args: ['id'] },
  updateWorkerNote: { method: 'PUT', path: '/workers/:id/note', args: ['id', 'note'] },

  listPools: { method: 'GET', path: '/pools', args: [] },
  createPool: { method: 'POST', path: '/pools', args: ['body'] },
  addWorkersToPool: { method: 'POST', path: '/pools/:poolId/workers', args: ['poolId', 'workerIds'] },
  removeWorkersFromPool: { method: 'POST', path: '/pools/:poolId/workers/remove', args: ['poolId', 'workerIds'] },
  blockWorkers: { method: 'POST', path: '/workers/block', args: ['ids', 'reason'] },
  unblockWorkers: { method: 'POST', path: '/workers/unblock', args: ['ids'] },

  getAccount: { method: 'GET', path: '/account', args: [] },
} as const satisfies Record<keyof Api, RouteDef>;

/** mock 환경에만 있는 경로. 실제 백엔드에는 만들지 않는다. */
export const MOCK_ROUTES = {
  getInfo: { method: 'GET', path: '/mock/info', args: [] },
  reset: { method: 'POST', path: '/mock/reset', args: [] },
  generateFakeSubmissions: { method: 'POST', path: '/mock/fake-submissions', args: ['body'] },
  exportState: { method: 'GET', path: '/mock/export', args: [] },
  importState: { method: 'POST', path: '/mock/import', args: ['json'] },
} as const satisfies Record<keyof MockTools, RouteDef>;

const PARAM = /:([A-Za-z]+)/g;

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(PARAM)].map((m) => m[1]!);
}

export interface EncodedRequest {
  method: RouteDef['method'];
  url: string; // 경로 + query string (base URL 제외)
  body?: string;
}

function isListQuery(name: string, value: unknown): value is ListQuery {
  return name === 'q' && typeof value === 'object' && value !== null;
}

export function encodeRequest(def: RouteDef, args: readonly unknown[]): EncodedRequest {
  const values = new Map(def.args.map((name, i) => [name, args[i]]));
  const inPath = new Set(pathParamNames(def.path));
  const path = def.path.replace(PARAM, (_, name: string) => encodeURIComponent(String(values.get(name))));
  const rest = def.args.filter((name) => !inPath.has(name));

  if (def.method === 'GET' || def.method === 'DELETE') {
    const query = new URLSearchParams();
    for (const name of rest) {
      const value = values.get(name);
      if (value === undefined || value === null) continue;
      if (isListQuery(name, value)) {
        query.set('page', String(value.page));
        query.set('pageSize', String(value.pageSize));
        if (value.sort) query.set('sort', `${value.sort.field}:${value.sort.order}`);
        if (value.filters && Object.keys(value.filters).length > 0) query.set('filters', JSON.stringify(value.filters));
      } else {
        query.set(name, String(value));
      }
    }
    const text = query.toString();
    return { method: def.method, url: text ? `${path}?${text}` : path };
  }

  const body =
    rest.length === 1 && rest[0] === 'body'
      ? values.get('body')
      : Object.fromEntries(rest.map((name) => [name, values.get(name)]));
  return { method: def.method, url: path, body: JSON.stringify(body ?? {}) };
}

/** encodeRequest의 역변환. 서버가 요청에서 메서드의 인자를 순서대로 되살린다. */
export function decodeArgs(
  def: RouteDef,
  request: { params: Record<string, string>; query: URLSearchParams; body: unknown },
): unknown[] {
  const inPath = new Set(pathParamNames(def.path));
  const rest = def.args.filter((name) => !inPath.has(name));
  const bodyIsArg = rest.length === 1 && rest[0] === 'body';

  return def.args.map((name) => {
    if (inPath.has(name)) return request.params[name];
    if (def.method === 'GET' || def.method === 'DELETE') {
      if (name === 'q') {
        const sort = request.query.get('sort');
        const separator = sort?.lastIndexOf(':') ?? -1;
        const filters = request.query.get('filters');
        return {
          page: Number(request.query.get('page') ?? 1),
          pageSize: Number(request.query.get('pageSize') ?? 25),
          sort:
            sort && separator > 0
              ? { field: sort.slice(0, separator), order: sort.slice(separator + 1) === 'desc' ? 'desc' : 'asc' }
              : undefined,
          filters: filters ? (JSON.parse(filters) as Record<string, unknown>) : undefined,
        } satisfies ListQuery;
      }
      return request.query.get(name) ?? undefined;
    }
    if (bodyIsArg) return request.body;
    return (request.body as Record<string, unknown> | null)?.[name];
  });
}
