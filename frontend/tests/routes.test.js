// 경로 표 검사. src/api-client/routes.js 의 API_ROUTES 가 prototype/src/api/http/routes.ts 의 표와 키 순서, 메서드, 경로, 인자 순서까지
// 같은지 확인하고, encodeRequest 가 표의 규칙대로 URL, 메서드, body 를 만드는지 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_ROUTES, API_ROUTES, encodeRequest, pathParamNames } from '../src/api-client/routes.js';
import { readTsRoutes } from './helpers/routes-ts.js';

const ts = readTsRoutes();

describe('API_ROUTES 는 routes.ts 의 표와 같다', () => {
  it('routes.ts 를 제대로 읽었다 (표가 비어 있으면 아래 비교가 의미가 없다)', () => {
    assert.ok(Object.keys(ts.API_ROUTES).length >= 20, `API_ROUTES parsed: ${Object.keys(ts.API_ROUTES).length}`);
    assert.ok(Object.keys(ts.MOCK_ROUTES).length >= 1, 'MOCK_ROUTES parsed');
    assert.deepEqual(ts.API_ROUTES.listHits, { method: 'GET', path: '/batches/:batchId/hits', args: ['batchId', 'q'] });
  });

  it('키 이름과 순서가 같다', () => {
    assert.deepEqual(Object.keys(API_ROUTES), Object.keys(ts.API_ROUTES));
  });

  it('키마다 메서드, 경로, 인자 순서가 같다', () => {
    for (const [name, def] of Object.entries(ts.API_ROUTES)) {
      assert.deepEqual(API_ROUTES[name], def, name);
    }
  });

  it('mock 전용 경로(MOCK_ROUTES)는 없다', () => {
    for (const name of Object.keys(ts.MOCK_ROUTES)) {
      assert.equal(name in API_ROUTES, false, name);
    }
    for (const [name, def] of Object.entries(API_ROUTES)) {
      assert.ok(!def.path.startsWith('/mock'), `${name}: ${def.path}`);
    }
  });
});

describe('AGENT_ROUTES', () => {
  it('agent job API 다섯 경로가 있다', () => {
    assert.deepEqual(AGENT_ROUTES, {
      listModels: { method: 'GET', path: '/agent/models', args: [] },
      createJob: { method: 'POST', path: '/agent/jobs', args: ['form'], encoding: 'multipart' },
      listJobs: { method: 'GET', path: '/agent/jobs', args: [] },
      getJob: { method: 'GET', path: '/agent/jobs/:id', args: ['id'] },
      getJobFile: { method: 'GET', path: '/agent/jobs/:id/files/:name', args: ['id', 'name'] },
    });
  });

  it('콘솔 REST 의 이름과 겹치지 않는다', () => {
    for (const name of Object.keys(AGENT_ROUTES)) assert.equal(name in API_ROUTES, false, name);
  });
});

describe('pathParamNames', () => {
  it('경로의 :이름 을 순서대로 뽑는다', () => {
    assert.deepEqual(pathParamNames('/batches/:batchId/hits'), ['batchId']);
    assert.deepEqual(pathParamNames('/agent/jobs/:id/files/:name'), ['id', 'name']);
    assert.deepEqual(pathParamNames('/account'), []);
  });
});

describe('encodeRequest', () => {
  it('경로 인자는 경로에 넣고 encodeURIComponent 를 거친다', () => {
    const r = encodeRequest(API_ROUTES.getBatch, ['b 1/x']);
    assert.deepEqual(r, { method: 'GET', url: '/batches/b%201%2Fx' });
    assert.equal('body' in r, false);
  });

  it('GET 의 q(ListQuery) 는 page, pageSize, sort=필드:방향, filters=JSON 으로 편다', () => {
    const q = { page: 2, pageSize: 25, sort: { field: 'createdAt', order: 'desc' }, filters: { status: ['Submitted'] } };
    const r = encodeRequest(API_ROUTES.listHits, ['b1', q]);
    assert.equal(r.method, 'GET');
    const url = new URL(r.url, 'http://example.test');
    assert.equal(url.pathname, '/batches/b1/hits');
    assert.deepEqual([...url.searchParams.keys()], ['page', 'pageSize', 'sort', 'filters']);
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('pageSize'), '25');
    assert.equal(url.searchParams.get('sort'), 'createdAt:desc');
    assert.deepEqual(JSON.parse(url.searchParams.get('filters')), { status: ['Submitted'] });
  });

  it('sort 가 없고 filters 가 비어 있으면 page, pageSize 만 넣는다', () => {
    const r = encodeRequest(API_ROUTES.listHits, ['b1', { page: 1, pageSize: 25, filters: {} }]);
    assert.equal(r.url, '/batches/b1/hits?page=1&pageSize=25');
  });

  it('q 를 안 주면 query string 이 없다', () => {
    assert.equal(encodeRequest(API_ROUTES.listHits, ['b1']).url, '/batches/b1/hits');
    assert.equal(encodeRequest(API_ROUTES.listWorkers, [null]).url, '/workers');
  });

  it('GET 의 다른 인자는 이름 그대로 query string 에 넣는다', () => {
    assert.deepEqual(encodeRequest(API_ROUTES.exportBatch, ['b1', 'csv']), { method: 'GET', url: '/batches/b1/export?format=csv' });
  });

  it('POST 의 이름 있는 인자는 이름을 키로 한 JSON body 가 된다', () => {
    const r = encodeRequest(API_ROUTES.approveAssignments, [['a1', 'a2'], 'Thanks', true]);
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/assignments/approve');
    assert.equal(r.body, JSON.stringify({ ids: ['a1', 'a2'], feedback: 'Thanks', override: true }));
  });

  it('PUT 도 같은 규칙이다 (경로 인자는 경로로, 나머지는 body 로)', () => {
    const r = encodeRequest(API_ROUTES.updateWorkerNote, ['w1', 'careful']);
    assert.deepEqual(r, { method: 'PUT', url: '/workers/w1/note', body: JSON.stringify({ note: 'careful' }) });
  });

  it('인자 이름이 body 면 그 값 자체가 body 다', () => {
    const draft = { name: 'Batch A', settings: { reward: '0.10' } };
    const r = encodeRequest(API_ROUTES.createBatch, [draft]);
    assert.deepEqual(r, { method: 'POST', url: '/batches', body: JSON.stringify(draft) });
  });

  it('경로 인자만 있는 POST 는 빈 JSON 객체를 보낸다', () => {
    assert.deepEqual(encodeRequest(API_ROUTES.expireBatch, ['b1']), { method: 'POST', url: '/batches/b1/expire', body: '{}' });
  });

  it('DELETE 는 경로 인자만 넣고 body 가 없다', () => {
    const r = encodeRequest(API_ROUTES.deleteTemplate, ['t1']);
    assert.deepEqual(r, { method: 'DELETE', url: '/templates/t1' });
  });

  it('multipart 경로(createJob)는 FormData 를 그대로 body 로 넘긴다', () => {
    const form = new FormData();
    form.append('name', 'job 1');
    const r = encodeRequest(AGENT_ROUTES.createJob, [form]);
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/agent/jobs');
    assert.equal(r.body, form);
  });

  it('getJobFile 은 파일 이름도 경로 인자로 넣는다', () => {
    assert.equal(encodeRequest(AGENT_ROUTES.getJobFile, ['j1', 'hits.csv']).url, '/agent/jobs/j1/files/hits.csv');
    assert.equal(encodeRequest(AGENT_ROUTES.getJobFile, ['j1', 'a b/c.csv']).url, '/agent/jobs/j1/files/a%20b%2Fc.csv');
  });
});
