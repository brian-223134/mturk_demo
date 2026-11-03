// lib/binding-revision.js: 요청으로 binding 을 고치는 대화의 기록과 변경 목록.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { addAnswer, describeChanges, earlierRequests, isCurrentVersion, sameBinding, withoutUnused } from '../src/lib/binding-revision.js';

const binding = JSON.parse(readFileSync(new URL('../../example/6-rough-design/chunk-fact.binding.json', import.meta.url), 'utf8'));
const change = (mutate) => {
  const next = structuredClone(binding);
  mutate(next);
  return next;
};
const whatChanged = (next) => describeChanges(binding, next).map((item) => item.what);

describe('describeChanges', () => {
  it('바뀐 것만 사람이 읽을 이름으로 알린다', () => {
    const next = change((b) => {
      b.instructions = 'Read and judge.';
      b.slots['item-choice'].header = 'Is each fact supported?';
      b.slots['item-choice'].options = [['grounded', 'Yes'], ['not_grounded', 'No']];
    });
    const changes = describeChanges(binding, next);
    assert.deepEqual(changes.map((item) => item.what), ['Instructions', 'HIT: judge each item: question', 'HIT: judge each item: options']);
    assert.equal(changes[2].before, 'Grounded, Not grounded');
    assert.equal(changes[2].after, 'Yes, No');
    assert.equal(changes.some((item) => item.alert), false);
  });

  it('키 순서만 다르면 변경이 아니다', () => {
    const { design, ...rest } = binding;
    assert.deepEqual(describeChanges(binding, { ...rest, design }), []);
    assert.equal(sameBinding(binding, { ...rest, design }), true);
  });

  it('데이터 칸은 라벨과 경로로 알린다', () => {
    const changes = describeChanges(binding, change((b) => { b.slots.data = { label: 'Chunk', from: 'retrieved_chunk[i]' }; }));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, 'Query (query[i]), Chunk (retrieved_chunk[i])');
    assert.equal(changes[0].after, 'Chunk (retrieved_chunk[i])');
  });

  it('대조 기준, attention, 문항 칸이 사라지면 표시한다', () => {
    for (const [mutate, what] of [
      [(b) => delete b.reference, 'Reference labels'],
      [(b) => delete b.attention, 'Attention items'],
      [(b) => delete b.attention.expected, 'Attention answer'],
      [(b) => delete b.slots['item-choice'], 'HIT: judge each item'],
    ]) {
      const found = describeChanges(binding, change(mutate)).find((item) => item.what === what);
      assert.ok(found, what);
      assert.equal(found.alert, true, what);
      assert.equal(found.after, '', what);
    }
  });

  it('새로 생긴 대조 기준은 표시하지 않는다', () => {
    const { reference, ...rest } = binding;
    const found = describeChanges(rest, binding).find((item) => item.what === 'Reference labels');
    assert.equal(found.before, '');
    assert.equal(found.alert, false);
  });

  it('unused 는 변경이 아니고 LLM 에 보내지 않는다', () => {
    const stored = { ...binding, unused: { choice: { header: 'kept' } } };
    assert.equal(sameBinding(binding, stored), true);
    assert.equal('unused' in withoutUnused(stored), false);
    assert.deepEqual(whatChanged(stored), []);
  });
});

describe('배치의 변경 표시', () => {
  const layout = { rows: [{ columns: '2fr 3fr', slots: ['item-choice', ['data', 'free-text']] }, { slots: ['choice'] }] };

  it('고친 배치를 칸 이름과 폭으로 보이고, 빨갛게 표시하지 않는다', () => {
    const found = describeChanges(binding, change((b) => { b.layout = layout; })).find((item) => item.what === 'Layout');
    assert.deepEqual(found, { what: 'Layout', before: '', after: 'HIT: judge each item | Data + Short answer (2fr 3fr) / HIT: multiple choice', alert: false });
  });

  it('가안의 배치로 돌아가도 알린다', () => {
    const found = describeChanges(change((b) => { b.layout = layout; }), binding).find((item) => item.what === 'Layout');
    assert.equal(found.after, '');
    assert.equal(found.alert, false);
  });

  it('배치가 같으면 줄이 없고, 틀린 배치에도 예외를 내지 않는다', () => {
    assert.deepEqual(whatChanged(binding), []);
    assert.equal(describeChanges(binding, change((b) => { b.layout = { rows: 'nope' }; })).some((item) => item.what === 'Layout'), false);
    assert.ok(describeChanges(binding, change((b) => { b.layout = { rows: [null, { slots: 'x' }] }; })));
  });
});

describe('대화 기록', () => {
  const draft = { design: 'item-list', task_type: 'text', slots: {} };
  const first = addAnswer([], { before: draft, authored: false, result: { binding, message: 'Written.', errors: [] }, request: 'Check the facts', meta: 'm' });

  it('첫 답은 코드가 만든 첫 binding 과 함께 남아 돌아갈 수 있다', () => {
    assert.deepEqual(first.map((version) => version.kind), ['draft', 'model']);
    assert.deepEqual(JSON.parse(first[0].text), draft);
    assert.deepEqual(JSON.parse(first[1].text), binding);
    assert.equal(first[1].message, 'Written.');
    assert.equal(isCurrentVersion(first[1], binding), true);
    assert.equal(isCurrentVersion(first[0], binding), false);
  });

  it('사람이 고친 뒤 물으면 고친 binding 도 남기고, 변경 목록은 그것과 비교한다', () => {
    const edited = change((b) => { b.instructions = 'Edited by hand.'; });
    const revised = change((b) => { b.instructions = 'Written again.'; });
    const versions = addAnswer(first, { before: edited, authored: true, result: { binding: revised, errors: [] }, request: 'Shorter', meta: 'm' });
    assert.deepEqual(versions.map((version) => version.kind), ['draft', 'model', 'edit', 'model']);
    assert.deepEqual(JSON.parse(versions[2].text), edited);
    assert.equal(versions[3].changes[0].before, 'Edited by hand.');
    assert.equal(first.length, 2, '원래 목록을 바꾸지 않는다');
  });

  it('이전 버전으로 돌아가 물으면 같은 버전을 또 남기지 않는다', () => {
    const revised = change((b) => { b.instructions = 'Again.'; });
    const versions = addAnswer(first, { before: draft, authored: false, result: { binding: revised, errors: [] }, request: 'x', meta: 'm' });
    assert.deepEqual(versions.map((version) => version.kind), ['draft', 'model', 'model']);
  });

  it('할 수 없다는 답과 아무것도 안 바꾼 답은 돌아갈 binding 이 없는 줄이다', () => {
    const cannot = addAnswer(first, { before: binding, authored: true, result: { binding: null, cannot: 'layout', message: 'No.' }, request: 'Move it', meta: 'm' });
    assert.equal(cannot.at(-1).kind, 'reply');
    assert.equal(cannot.at(-1).cannot, 'layout');
    assert.equal(cannot.at(-1).text, undefined);
    assert.equal(isCurrentVersion(cannot.at(-1), binding), false);
    const same = addAnswer(first, { before: binding, authored: true, result: { binding: structuredClone(binding), errors: [] }, request: 'Keep it', meta: 'm' });
    assert.equal(same.at(-1).kind, 'reply');
    assert.equal(same.at(-1).cannot, null);
  });

  it('고치지 못한 오류가 있으면 답에 남긴다', () => {
    const versions = addAnswer([], { before: binding, authored: true, result: { binding: change((b) => { b.instructions = 'x'; }), errors: ['bad'] }, request: 'r', meta: 'm' });
    assert.deepEqual(versions.at(-1).problems, ['bad']);
  });

  it('앞선 요청은 최근 다섯 개를 오래된 순서로 보낸다', () => {
    const versions = [{ kind: 'draft', text: '{}' }, ...['a', 'b', 'c', 'd', 'e', 'f'].map((request) => ({ kind: 'reply', request }))];
    assert.deepEqual(earlierRequests(versions), ['b', 'c', 'd', 'e', 'f']);
  });
});

describe('LLM 설명서의 수정 규칙', () => {
  const reference = readFileSync(new URL('../../agent/binding_reference.md', import.meta.url), 'utf8');

  it('수정 요청과 할 수 없는 요청의 답 형식을 설명한다', () => {
    for (const text of ['`current`', '`earlier_requests`', '`message`', '{"cannot": "layout"', '{"cannot": "format"']) assert.ok(reference.includes(text), text);
  });
});
