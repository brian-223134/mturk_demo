// REST 경로 표. prototype/src/api/http/routes.ts 의 API_ROUTES 를 그대로 옮긴 것이다 (키, 메서드, 경로, 인자 순서가 같다).
// backend(FastAPI)가 같은 표를 구현하므로 이 파일이 frontend 쪽 계약이다. MOCK_ROUTES 는 실제 backend 에 없어 옮기지 않는다.
//
// 인자를 요청에 싣는 규칙 (routes.ts 와 같다)
//   - 경로의 `:이름`과 같은 이름의 인자는 경로에 넣는다.
//   - GET, DELETE 의 나머지 인자는 query string 에 넣는다. `q`(ListQuery)는 page, pageSize, sort=필드:방향, filters=JSON 으로 편다.
//   - POST, PUT 의 나머지 인자는 JSON body 에 이름으로 넣는다. 인자 이름이 `body`면 그 값 자체가 body 다.
//   - encoding 이 'multipart' 인 경로는 인자 하나(FormData)를 그대로 body 로 보낸다 (agent job 생성).

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
};

/** agent 파이프라인의 job API. backend 에만 있고 prototype 의 mock API 에는 없다. */
export const AGENT_ROUTES = {
  listModels: { method: 'GET', path: '/agent/models', args: [] },
  createJob: { method: 'POST', path: '/agent/jobs', args: ['form'], encoding: 'multipart' },
  listJobs: { method: 'GET', path: '/agent/jobs', args: [] },
  getJob: { method: 'GET', path: '/agent/jobs/:id', args: ['id'] },
  getJobFile: { method: 'GET', path: '/agent/jobs/:id/files/:name', args: ['id', 'name'] },
};

const PARAM = /:([A-Za-z]+)/g;

export function pathParamNames(path) {
  return [...path.matchAll(PARAM)].map((m) => m[1]);
}

function isListQuery(name, value) {
  return name === 'q' && typeof value === 'object' && value !== null;
}

/** 메서드의 인자 목록을 { method, url, body } 로 바꾼다. url 은 base URL(/api)을 뺀 경로 + query string 이다. */
export function encodeRequest(def, args) {
  const values = new Map(def.args.map((name, i) => [name, args[i]]));
  const inPath = new Set(pathParamNames(def.path));
  const path = def.path.replace(PARAM, (_, name) => encodeURIComponent(String(values.get(name))));
  const rest = def.args.filter((name) => !inPath.has(name));

  if (def.encoding === 'multipart') {
    return { method: def.method, url: path, body: values.get(rest[0]) };
  }

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
