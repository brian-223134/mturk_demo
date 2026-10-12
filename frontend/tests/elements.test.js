// elements/ann-elements.js 의 core 검사. 요소 자체는 브라우저에서만 돌므로 여기서는 DOM 없이 쓰는 함수만 본다:
// 항목 읽기, 답 이름, TASK_ANSWER_SCHEMA 의 모양, 제출할 답과 막는 문구, 진행률. 이 계약은 agent/render.py 의 템플릿과 같다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { core, version } = require('../src/elements/ann-elements.js');

const choice = { kind: 'choice', name: 'relevance', required: true, values: ['relevant', 'not_relevant'] };
const likert = { kind: 'likert', name: 'helpfulness', required: true, values: ['1', '2', '3', '4', '5'] };
const checklist = { kind: 'checklist', name: 'supported', required: true, keys: ['1', '2', '3'], checkedValue: 'supported', uncheckedValue: 'not_supported' };
const comment = { kind: 'textarea', name: 'comment', required: false, values: [], minLength: 0 };
const reason = { kind: 'textarea', name: 'reason', required: true, values: [], minLength: 20 };

describe('ann-elements core', () => {
  it('Node 에서 불러오면 boot 하지 않고 core 만 준다', () => {
    assert.equal(version, '1');
    assert.equal(typeof core.collect, 'function');
  });

  it('parseItems: JSON 배열의 문자열, 숫자, 객체와 줄 단위 글을 읽는다', () => {
    assert.deepEqual(core.parseItems('["a", 2]'), [{ key: null, text: 'a' }, { key: null, text: '2' }]);
    assert.deepEqual(core.parseItems('[{"text": "x", "key": "f7"}, {"label": "y", "id": 3}]'), [{ key: 'f7', text: 'x' }, { key: '3', text: 'y' }]);
    assert.deepEqual(core.parseItems('  first line\n\n second line \n'), [{ key: null, text: 'first line' }, { key: null, text: 'second line' }]);
    assert.deepEqual(core.parseItems('   '), []);
    assert.deepEqual(core.parseItems('{"not": "a list"}'), [{ key: null, text: '{"not": "a list"}' }]);
  });

  it('itemKeys: 준 key 가 없으면 1부터 센 순번이다', () => {
    assert.deepEqual(core.itemKeys([{ key: null }, { key: 'price' }, { key: '' }]), ['1', 'price', '3']);
    assert.equal(core.itemName('supported', '2'), 'supported_2');
  });

  it('schemaOf: 화면 순서의 답 칸. checklist 는 항목마다, 글은 type text 에 values []', () => {
    assert.deepEqual(core.schemaOf([choice, checklist, likert, comment]), [
      { name: 'relevance', type: 'choice', values: ['relevant', 'not_relevant'], required: true },
      { name: 'supported_1', type: 'multi_select', values: ['supported', 'not_supported'], required: true },
      { name: 'supported_2', type: 'multi_select', values: ['supported', 'not_supported'], required: true },
      { name: 'supported_3', type: 'multi_select', values: ['supported', 'not_supported'], required: true },
      { name: 'helpfulness', type: 'likert', values: ['1', '2', '3', '4', '5'], required: true },
      { name: 'comment', type: 'text', values: [], required: false },
    ]);
  });

  it('collect: 다 답하면 [{name, value}] 문자열 값이고 막는 문구가 없다', () => {
    const result = core.collect([
      { model: choice, value: 'relevant' },
      { model: checklist, value: { checked: ['1', '3'], none: false } },
      { model: likert, value: '4' },
      { model: comment, value: '' },
    ]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.answers, [
      { name: 'relevance', value: 'relevant' },
      { name: 'supported_1', value: 'supported' },
      { name: 'supported_2', value: 'not_supported' },
      { name: 'supported_3', value: 'supported' },
      { name: 'helpfulness', value: '4' },
    ]);
  });

  it('collect: "해당 없음" 만 체크하면 모든 항목이 unchecked-value 다', () => {
    const { answers, problems } = core.collect([{ model: checklist, value: { checked: [], none: true } }]);
    assert.deepEqual(problems, []);
    assert.deepEqual(answers.map((a) => a.value), ['not_supported', 'not_supported', 'not_supported']);
  });

  it('collect: 답하지 않은 필수 문항과 짧은 글은 막고, 그 위치를 알려 준다', () => {
    const { answers, problems } = core.collect([
      { model: choice, value: null },
      { model: checklist, value: { checked: [], none: false } },
      { model: reason, value: 'too short' },
      { model: comment, value: 'fine' },
    ]);
    assert.deepEqual(problems.map((p) => p.index), [0, 1, 2]);
    assert.match(problems[0].message, /Choose an answer/);
    assert.match(problems[1].message, /none apply/);
    assert.match(problems[2].message, /at least 20 characters \(9 so far\)/);
    assert.deepEqual(answers, [{ name: 'reason', value: 'too short' }, { name: 'comment', value: 'fine' }]);
  });

  it('필수가 아닌 글도 minlength 보다 짧으면 막는다. 비어 있으면 통과한다', () => {
    const optional = { ...comment, minLength: 10 };
    assert.match(core.problemOf(optional, 'short'), /at least 10/);
    assert.equal(core.problemOf(optional, ''), null);
  });

  it('항목이 없는 checklist 는 답한 것으로 본다', () => {
    const empty = { ...checklist, keys: [] };
    assert.equal(core.problemOf(empty, { checked: [], none: false }), null);
    assert.deepEqual(core.collect([{ model: empty, value: { checked: [], none: false } }]).answers, []);
  });

  it('progressOf: 필수 문항만 센다', () => {
    assert.deepEqual(core.progressOf([{ model: choice, value: 'relevant' }, { model: likert, value: null }, { model: comment, value: '' }]), { done: 1, total: 2 });
  });

  it('splitList: options="a, b" 를 나눈다', () => {
    assert.deepEqual(core.splitList(' yes, no ,, maybe'), ['yes', 'no', 'maybe']);
  });
});
