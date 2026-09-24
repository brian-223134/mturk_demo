// 라우터의 순수한 부분(src/router-match.js) 검사. main.js 가 등록하는 패턴으로 경로가 어느 route 에 맞고 params 가 무엇인지 본다.
// router.js 자체는 이동할 때 window, history, document 를 쓰므로 여기서 다루지 않는다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compilePattern, matchRoute } from '../src/router-match.js';

// main.js 와 같은 순서
const handlers = { create: () => 'create', manage: () => 'manage', batch: () => 'batch', workers: () => 'workers' };
const routes = [
  ['/', null, { redirect: '/create' }],
  ['/index.html', null, { redirect: '/create' }],
  ['/create', handlers.create, { tab: 'create' }],
  ['/manage', handlers.manage, { tab: 'manage' }],
  ['/manage/:batchId', handlers.batch, { tab: 'manage' }],
  ['/manage/:batchId/:tab', handlers.batch, { tab: 'manage' }],
  ['/workers', handlers.workers, { tab: 'workers' }],
].map(([pattern, handler, meta]) => ({ ...compilePattern(pattern), handler, meta }));

describe('compilePattern', () => {
  it(':이름 조각을 키로 뽑고 한 조각짜리 그룹으로 만든다', () => {
    const { regex, keys } = compilePattern('/manage/:batchId/:tab');
    assert.deepEqual(keys, ['batchId', 'tab']);
    assert.ok(regex.test('/manage/b1/review'));
    assert.ok(regex.test('/manage/b1/review/'), '끝의 / 하나는 허용');
    assert.equal(regex.test('/manage/b1'), false);
    assert.equal(regex.test('/manage/b1/review/extra'), false);
    assert.equal(regex.test('/manage//review'), false);
  });

  it('고정 조각은 앞뒤가 정확히 맞아야 하고 정규식 특수 문자는 글자로 본다', () => {
    const fixed = compilePattern('/index.html');
    assert.deepEqual(fixed.keys, []);
    assert.ok(fixed.regex.test('/index.html'));
    assert.equal(fixed.regex.test('/indexXhtml'), false);
    assert.equal(fixed.regex.test('/manage/index.html'), false);
    assert.equal(compilePattern('/workers').regex.test('/workers/w1'), false);
  });
});

describe('matchRoute (main.js 의 패턴)', () => {
  it('/manage/:batchId/:tab', () => {
    const found = matchRoute(routes, '/manage/b1/review');
    assert.equal(found.handler, handlers.batch);
    assert.deepEqual(found.params, { batchId: 'b1', tab: 'review' });
    assert.deepEqual(found.meta, { tab: 'manage' });
  });

  it('/manage/:batchId (탭 없음)', () => {
    const found = matchRoute(routes, '/manage/b1');
    assert.equal(found.handler, handlers.batch);
    assert.deepEqual(found.params, { batchId: 'b1' });
    assert.deepEqual(matchRoute(routes, '/manage/b1/').params, { batchId: 'b1' });
  });

  it('고정 경로는 params 가 비어 있다', () => {
    assert.equal(matchRoute(routes, '/workers').handler, handlers.workers);
    assert.deepEqual(matchRoute(routes, '/workers').params, {});
    assert.equal(matchRoute(routes, '/manage').handler, handlers.manage);
    assert.equal(matchRoute(routes, '/create').meta.tab, 'create');
  });

  it('/ 와 /index.html 은 redirect 메타를 가진 route 에 맞는다', () => {
    assert.equal(matchRoute(routes, '/').meta.redirect, '/create');
    assert.equal(matchRoute(routes, '/index.html').meta.redirect, '/create');
  });

  it('params 는 decodeURIComponent 를 거친다', () => {
    assert.deepEqual(matchRoute(routes, '/manage/b%201/hits').params, { batchId: 'b 1', tab: 'hits' });
  });

  it('맞는 route 가 없으면 null 이다', () => {
    for (const pathname of ['/nope', '/manage/b1/review/extra', '/workers/w1', '/create/x', '/api/batches', '']) {
      assert.equal(matchRoute(routes, pathname), null, pathname);
    }
  });

  it('등록 순서대로 처음 맞는 route 를 고른다', () => {
    const ordered = [
      { ...compilePattern('/:anything'), handler: 'first', meta: {} },
      { ...compilePattern('/create'), handler: 'second', meta: {} },
    ];
    assert.equal(matchRoute(ordered, '/create').handler, 'first');
    assert.equal(matchRoute(ordered.reverse(), '/create').handler, 'second');
  });
});
