// API 클라이언트의 mock 테스트. globalThis.fetch 를 가짜로 바꿔 call() 과 api.<route>() 가 보내는 메서드, URL, 헤더, body 를 확인하고,
// 응답(200 JSON, 204, 오류 봉투, JSON 이 아닌 502, fetch 자체의 실패)이 각각 어떤 값 또는 ApiError 가 되는지 본다.

import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import { AUTH_REQUIRED_EVENT, ApiError, BASE_URL, admin, agent, api, auth, call, createJob, createJobGroup, fileUrl, isApiError } from '../src/api-client/client.js';
import { API_ROUTES } from '../src/api-client/routes.js';

let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** fetch 를 가짜로 바꾼다. 호출 기록을 돌려주고, respond 가 만든 Response(또는 throw)를 돌려준다. */
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return calls;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
}

describe('요청 만들기', () => {
  it('GET 은 /api + 경로로, 헤더와 body 없이 보낸다', async () => {
    const calls = stubFetch(() => json(200, { id: 'b1' }));
    await api.getBatch('b1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/batches/b1');
    assert.equal(calls[0].init.method, 'GET');
    assert.deepEqual(calls[0].init.headers, {});
    assert.equal(calls[0].init.body, undefined);
  });

  it('call(routeName, args) 는 api.<route>(…args) 와 같은 요청을 만든다', async () => {
    const calls = stubFetch(() => json(200, { items: [], total: 0 }));
    await call('listHits', ['b1', { page: 1, pageSize: 25 }]);
    await api.listHits('b1', { page: 1, pageSize: 25 });
    assert.equal(calls[0].url, '/api/batches/b1/hits?page=1&pageSize=25');
    assert.deepEqual(calls[1], calls[0]);
  });

  it('POST 는 JSON body 와 Content-Type: application/json 을 보낸다', async () => {
    const calls = stubFetch(() => json(200, { ok: true }));
    await api.approveAssignments(['a1'], 'ok', false);
    assert.equal(calls[0].url, '/api/assignments/approve');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
    assert.equal(calls[0].init.body, JSON.stringify({ ids: ['a1'], feedback: 'ok', override: false }));
  });

  it('DELETE 는 경로 인자만 쓴다', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const result = await api.deleteTemplate('t1');
    assert.equal(result, undefined);
    assert.equal(calls[0].url, '/api/templates/t1');
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.body, undefined);
  });

  it('모르는 경로 이름은 바로 throw 한다 (fetch 를 부르지 않는다)', () => {
    const calls = stubFetch(() => json(200, {}));
    assert.throws(() => call('nope'), /Unknown API route: nope/);
    assert.equal(calls.length, 0);
  });

  it('api 객체의 키는 API_ROUTES 와 같고 agent 경로는 없다', () => {
    assert.deepEqual(Object.keys(api), Object.keys(API_ROUTES));
    assert.equal('getJob' in api, false);
  });
});

describe('응답 처리', () => {
  it('200 JSON 은 파싱한 body 로 resolve 된다', async () => {
    stubFetch(() => json(200, { items: [{ id: 'b1' }], total: 1 }));
    assert.deepEqual(await api.listBatches(), { items: [{ id: 'b1' }], total: 1 });
  });

  it('204 와 빈 body 는 undefined 다', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    assert.equal(await api.expireBatch('b1'), undefined);
    stubFetch(() => new Response('', { status: 200 }));
    assert.equal(await api.expireBatch('b1'), undefined);
  });

  it('501 NOT_IMPLEMENTED 봉투는 같은 code, status, message 의 ApiError 가 된다', async () => {
    stubFetch(() => json(501, { error: { code: 'NOT_IMPLEMENTED', message: 'listHits is not implemented yet.' } }));
    const error = await rejection(api.listHits('b1', { page: 1, pageSize: 25 }));
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.code, 'NOT_IMPLEMENTED');
    assert.equal(error.status, 501);
    assert.equal(error.message, 'listHits is not implemented yet.');
  });

  it('404 NOT_FOUND 도 마찬가지다', async () => {
    stubFetch(() => json(404, { error: { code: 'NOT_FOUND', message: 'No such batch: b9' } }));
    const error = await rejection(api.getBatch('b9'));
    assert.ok(isApiError(error, 'NOT_FOUND'));
    assert.equal(error.status, 404);
    assert.equal(error.message, 'No such batch: b9');
  });

  it('모르는 code 나 봉투가 아닌 오류 응답은 UNKNOWN 이고 message 는 HTTP 상태다', async () => {
    stubFetch(() => json(400, { error: { code: 'WEIRD' } }));
    let error = await rejection(api.getAccount());
    assert.equal(error.code, 'UNKNOWN');
    assert.equal(error.status, 400);
    assert.equal(error.message, 'HTTP 400');

    stubFetch(() => json(500, 'oops'));
    error = await rejection(api.getAccount());
    assert.equal(error.code, 'UNKNOWN');
    assert.equal(error.message, 'HTTP 500');
  });

  it('JSON 이 아닌 502 응답(nginx 의 HTML)은 NETWORK 다', async () => {
    stubFetch(() => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const error = await rejection(api.getAccount());
    assert.ok(isApiError(error, 'NETWORK'));
    assert.equal(error.status, 502);
    assert.match(error.message, /non-JSON response \(HTTP 502\)/);
  });

  it('fetch 가 throw 하면(서버에 닿지 못함) NETWORK 이고 status 는 0 이다', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await rejection(api.getAccount());
    assert.ok(isApiError(error, 'NETWORK'));
    assert.equal(error.status, 0);
    assert.match(error.message, /Cannot reach the API server \(\/api\): Failed to fetch/);
  });
});

describe('isApiError', () => {
  it('code 를 주면 그 중 하나인지, 안 주면 ApiError 인지만 본다', () => {
    const error = new ApiError('NOT_IMPLEMENTED', 'later', 501);
    assert.equal(isApiError(error, 'NOT_IMPLEMENTED'), true);
    assert.equal(isApiError(error, 'NOT_FOUND'), false);
    assert.equal(isApiError(error, 'NOT_FOUND', 'NOT_IMPLEMENTED'), true);
    assert.equal(isApiError(error), true);
    assert.equal(isApiError(new Error('plain')), false);
    assert.equal(isApiError(undefined, 'NETWORK'), false);
  });
});

describe('agent job API', () => {
  it('이전 입력을 읽고 평가만 별도로 저장한다', async () => {
    const calls = stubFetch(() => json(200, {}));
    await agent.getJobInputs('job 1');
    await agent.reviewJob('job 1', { decision: 'shortlisted', notes: 'Clear criteria.' });
    assert.equal(calls[0].url, '/api/agent/jobs/job%201/inputs');
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal(calls[1].url, '/api/agent/jobs/job%201/review');
    assert.deepEqual(JSON.parse(calls[1].init.body), { decision: 'shortlisted', notes: 'Clear criteria.' });
  });
  it('createJob(formData) 는 multipart 로 보내고 Content-Type 을 직접 넣지 않는다', async () => {
    const form = new FormData();
    form.append('name', 'job 1');
    form.append('raw', new Blob(['[]'], { type: 'application/json' }), 'raw.json');
    const job = { id: 'j1', status: 'queued' };
    const calls = stubFetch(() => json(202, { job }));

    assert.deepEqual(await createJob(form), { job });
    assert.equal(calls[0].url, '/api/agent/jobs');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, form);
    assert.deepEqual(calls[0].init.headers, {});
    assert.equal(agent.createJob, createJob);
  });

  it('createJobGroup(formData) 은 /api/agent/job-groups 로 multipart 를 보내고, chooseCandidate 는 job_id 를 JSON 으로 PUT 한다', async () => {
    const form = new FormData();
    form.append('model_configs', 'default');
    form.append('model_configs', 'qwen3-235b');
    const result = { group: { id: 'grp-1', size: 2 }, jobs: [{ id: 'j1' }, { id: 'j2' }] };
    const calls = stubFetch((url) => (url.endsWith('/choice') ? json(200, { jobs: result.jobs }) : json(202, result)));

    assert.deepEqual(await createJobGroup(form), result);
    assert.deepEqual(await agent.chooseCandidate('grp 1', 'j2'), { jobs: result.jobs });
    assert.equal(calls[0].url, '/api/agent/job-groups');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, form);
    assert.deepEqual(calls[0].init.headers, {});
    assert.equal(calls[1].url, '/api/agent/job-groups/grp%201/choice');
    assert.equal(calls[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].init.body), { job_id: 'j2' });
    assert.equal(agent.createJobGroup, createJobGroup);
  });

  it('agent.listModels, listJobs, getJob 은 /api/agent/… 를 GET 한다', async () => {
    const calls = stubFetch(() => json(200, {}));
    await agent.listModels();
    await agent.listJobs();
    await agent.getJob('j 1');
    assert.deepEqual(
      calls.map((c) => [c.init.method, c.url]),
      [
        ['GET', '/api/agent/models'],
        ['GET', '/api/agent/jobs'],
        ['GET', '/api/agent/jobs/j%201'],
      ],
    );
  });

  it('fileUrl(jobId, name) 은 /api/agent/jobs/:id/files/:name 이고 이름을 인코딩한다', () => {
    assert.equal(BASE_URL, '/api');
    assert.equal(fileUrl('j1', 'hits.csv'), '/api/agent/jobs/j1/files/hits.csv');
    assert.equal(fileUrl('j 1', 'a b/c.csv'), '/api/agent/jobs/j%201/files/a%20b%2Fc.csv');
    assert.equal(agent.fileUrl, fileUrl);
  });
});

describe('계정 API 와 세션이 끝났을 때', () => {
  /** globalThis.dispatchEvent 를 가짜로 바꿔 보낸 이벤트 이름을 모은다. */
  function stubEvents() {
    const original = globalThis.dispatchEvent;
    const events = [];
    globalThis.dispatchEvent = (event) => events.push(event.type);
    return { events, restore: () => (globalThis.dispatchEvent = original) };
  }
  const unauthorized = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });

  it('콘솔 REST 가 401 이면 UNAUTHORIZED ApiError 를 던지고 auth:required 이벤트를 보낸다', async () => {
    const { events, restore } = stubEvents();
    try {
      stubFetch(unauthorized);
      const error = await rejection(api.listBatches());
      assert.ok(isApiError(error, 'UNAUTHORIZED'));
      assert.equal(error.status, 401);
      await rejection(agent.listJobs());
      assert.deepEqual(events, [AUTH_REQUIRED_EVENT, AUTH_REQUIRED_EVENT]);
    } finally {
      restore();
    }
  });

  it('계정 API 의 401(틀린 비밀번호, 로그인 안 함)은 이벤트를 보내지 않는다. 403 은 FORBIDDEN 이다', async () => {
    const { events, restore } = stubEvents();
    try {
      stubFetch(unauthorized);
      assert.ok(isApiError(await rejection(auth.login('a@b.c', 'x')), 'UNAUTHORIZED'));
      assert.ok(isApiError(await rejection(auth.me()), 'UNAUTHORIZED'));
      stubFetch(() => json(403, { error: { code: 'FORBIDDEN', message: 'no' } }));
      assert.ok(isApiError(await rejection(api.listBatches()), 'FORBIDDEN'));
      assert.deepEqual(events, []);
    } finally {
      restore();
    }
  });

  it('auth 와 admin 은 /api/auth/… 와 /api/admin/… 로 보낸다', async () => {
    const calls = stubFetch(() => json(200, {}));
    await auth.login('kim@example.com', 'secret');
    await auth.signup({ role: 'worker', email: 'kim@example.com' });
    await auth.logout();
    await admin.suspendUser('u-1');
    await admin.createInvitation({ role: 'requester' });
    await admin.deleteInvitation('inv-1');
    assert.deepEqual(
      calls.map((c) => [c.init.method, c.url, c.init.body && JSON.parse(c.init.body)]),
      [
        ['POST', '/api/auth/login', { email: 'kim@example.com', password: 'secret' }],
        ['POST', '/api/auth/signup', { role: 'worker', email: 'kim@example.com' }],
        ['POST', '/api/auth/logout', {}],
        ['POST', '/api/admin/users/u-1/suspend', {}],
        ['POST', '/api/admin/invitations', { role: 'requester' }],
        ['DELETE', '/api/admin/invitations/inv-1', undefined],
      ],
    );
  });
});
