// pages/manage/reviewDecisions.js: Review 의 검수 결정(응답 단위, HIT 단위)과 HIT 묶기.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDecisions, decisionSummary, groupDecision, groupMembers, hitGroups } from '../src/pages/manage/reviewDecisions.js';

const a = (id, hit, status = 'Submitted', row = Number(hit.slice(1))) => ({ AssignmentId: id, HITId: hit, AssignmentStatus: status, rowIndex: row });

describe('createDecisions', () => {
  it('Submitted 응답에만 결정을 넣고, 같은 값을 다시 고르면(toggle) 지운다', () => {
    const d = createDecisions();
    const open = a('a1', 'h1');
    const done = a('a2', 'h1', 'Approved');
    d.set(open, 'approve');
    d.set(done, 'reject');
    assert.equal(d.get(open), 'approve');
    assert.equal(d.get(done), null);
    assert.equal(d.size, 1);
    d.toggle(open, 'approve');
    assert.equal(d.get(open), null);
    d.toggle(open, 'reject');
    assert.equal(d.get(open), 'reject');
  });

  it('setMany 는 바뀐 수를 돌려주고 한 번만 알린다. lists 는 결정별 응답이다', () => {
    const d = createDecisions();
    let calls = 0;
    d.subscribe(() => { calls += 1; });
    const rows = [a('a1', 'h1'), a('a2', 'h1'), a('a3', 'h1', 'Rejected')];
    assert.equal(d.setMany(rows, 'approve'), 2);
    assert.equal(calls, 1);
    assert.equal(d.setMany(rows, 'approve'), 0);
    assert.equal(calls, 1);
    d.set(rows[1], 'reject');
    assert.deepEqual(Object.fromEntries(Object.entries(d.lists()).map(([k, v]) => [k, v.map((x) => x.AssignmentId)])), { approve: ['a1'], reject: ['a2'] });
    assert.equal(decisionSummary(d.lists()), '1 to approve · 1 to reject');
    d.removeIds(['a1']);
    assert.equal(d.size, 1);
    d.clear();
    assert.equal(d.size, 0);
    assert.equal(decisionSummary(d.lists()), '');
  });
});

describe('groupDecision', () => {
  it('HIT 의 Submitted 응답 결정이 모두 같으면 그 값, 섞이면 mixed, 없으면 none, 검수할 것이 없으면 done', () => {
    const d = createDecisions();
    const rows = [a('a1', 'h1'), a('a2', 'h1'), a('a3', 'h1', 'Approved')];
    assert.equal(groupDecision(rows, d), 'none');
    d.set(rows[0], 'approve');
    assert.equal(groupDecision(rows, d), 'mixed');
    d.set(rows[1], 'approve');
    assert.equal(groupDecision(rows, d), 'approve');
    d.set(rows[1], 'reject');
    assert.equal(groupDecision(rows, d), 'mixed');
    assert.equal(groupDecision([rows[2]], d), 'done');
  });
});

describe('hitGroups', () => {
  it('이어진 같은 HIT 를 묶고, 페이지 경계의 HIT 에는 앞뒤 페이지의 같은 HIT 응답을 붙인다', () => {
    const page = [a('a3', 'h1'), a('a4', 'h2'), a('a5', 'h2'), a('a6', 'h3')];
    const before = [a('a0', 'h0'), a('a1', 'h1'), a('a2', 'h1')];
    const after = [a('a7', 'h3'), a('a8', 'h4'), a('a9', 'h3')];
    const groups = hitGroups(page, { before, after });
    assert.deepEqual(groups.map((g) => [g.hitId, g.items.length, g.before.length, g.after.length]), [['h1', 1, 2, 0], ['h2', 2, 0, 0], ['h3', 1, 0, 1]]);
    assert.deepEqual(groupMembers(groups[0]).map((x) => x.AssignmentId), ['a1', 'a2', 'a3']);
    assert.deepEqual(hitGroups([]), []);
  });
});
