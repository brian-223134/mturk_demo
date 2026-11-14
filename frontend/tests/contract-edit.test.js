// 자유 계약을 고치는 두 길: 요청 문장으로 고치는 대화의 기록(lib/contract-revision.js)과 폼의 계산(lib/contract-form.js).
// 손으로 쓴 계약(scripts/html_experiment/fixtures)을 고친 결과가 계약 검사를 계속 통과하는지도 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { addOption, addQuestion, addValue, answerValues, pathChoices, referenceOf, removeOption, removeQuestion, removeValue, setItems, setQuestionType, setReferenceValue, updateAttention, updateLayout, updateOption, updatePerHit, updateQuestion, updateRepeat, updateValue } from '../src/lib/contract-form.js';
import { addContractAnswer, describeContractChanges, earlierRequests, isCurrentContract, sameContract, setVersionPage, versionPage } from '../src/lib/contract-revision.js';
import { dataReader } from '../src/lib/design-binding.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { checkContract } from '../src/lib/task-contract.js';

const file = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const passage = JSON.parse(file('scripts/html_experiment/fixtures/free-passage-problems.contract.json'));
const chunk = JSON.parse(file('scripts/html_experiment/fixtures/free-chunk-confidence.contract.json'));
const passageReader = dataReader(parseJsonData(file('scripts/html_experiment/data/passage-answer.json'), 'x.json'));
const chunkReader = dataReader(parseJsonData(file('example/6-rough-design/chunk-fact-hits.json'), 'x.json'));
const errorsOf = (contract, reader = passageReader) => checkContract(contract, reader).errors;

describe('describeContractChanges', () => {
  it('고친 값, 더한 문항, 바꾼 선택지를 보이고, 경고는 없다', () => {
    const after = { ...passage, instructions: 'New text.', questions: [{ ...passage.questions[0], options: [['yes', 'Yes'], ['no', 'No']] }, ...passage.questions.slice(1), { name: 'confidence', type: 'likert', header: 'How sure?' }] };
    const changes = describeContractChanges(passage, after);
    assert.ok(changes.some((c) => c.what === 'Instructions' && c.after === 'New text.'));
    assert.ok(changes.some((c) => c.what === 'Question answers: options' && c.before === 'Yes, Partly, No' && c.after === 'Yes, No'));
    assert.ok(changes.some((c) => c.what === 'Question confidence' && c.before === '' && c.after === 'How sure? (likert)'));
    assert.ok(changes.every((c) => !c.alert));
  });

  it('문항이 없어지거나 대조 기준·attention 이 사라지면 경고한다', () => {
    const after = { ...passage, questions: passage.questions.slice(0, 2), reference: undefined, attention: undefined };
    const alerts = describeContractChanges(passage, after).filter((c) => c.alert).map((c) => c.what);
    assert.deepEqual(alerts.sort(), ['Answer key for answers', 'Attention checks', 'Question comment'].sort());
  });

  it('같은 계약이면 바뀐 것이 없고, 키 순서는 상관없다', () => {
    const reordered = Object.fromEntries(Object.entries(passage).reverse());
    assert.deepEqual(describeContractChanges(passage, reordered), []);
    assert.ok(sameContract(passage, reordered));
  });
});

describe('addContractAnswer', () => {
  it('고친 계약은 바뀐 점과 함께 쌓이고, 사람이 고친 직전 계약도 남긴다', () => {
    const edited = { ...passage, instructions: 'Edited by hand.' };
    const revised = { ...edited, questions: passage.questions.slice(0, 1) };
    const first = addContractAnswer([], { before: null, result: { contract: passage, message: 'Wrote it.' }, request: 'Write it', meta: 'm' });
    assert.deepEqual(first.map((v) => v.kind), ['model']);
    const second = addContractAnswer(first, { before: edited, result: { contract: revised, message: 'Removed two.' }, request: 'Keep only the first question', meta: 'm' });
    assert.deepEqual(second.map((v) => v.kind), ['model', 'edit', 'model']);
    assert.ok(second[2].changes.some((c) => c.alert));
    assert.ok(isCurrentContract(second[2], revised));
    assert.ok(!isCurrentContract(second[0], revised));
    assert.deepEqual(earlierRequests(second), ['Write it', 'Keep only the first question']);
  });

  it('할 수 없거나 바뀐 것이 없는 답은 계약 없이 쌓인다', () => {
    const versions = addContractAnswer([], { before: passage, result: { contract: null, cannot: 'format', message: 'No.' }, request: 'Draw boxes', meta: 'm' });
    assert.deepEqual(versions, [{ kind: 'reply', request: 'Draw boxes', message: 'No.', cannot: 'format', meta: 'm' }]);
  });
});

describe('contract-form', () => {
  it('값을 더하고 고치고 지워도 계약 검사를 통과한다', () => {
    const choices = pathChoices(passageReader, false);
    let next = addValue(passage, choices.values);
    assert.equal(next.fields.length, 4);
    assert.match(next.fields[3].id, /^[a-z_][a-z0-9_]*$/);
    next = updateValue(next, 3, 'from', 'title');
    next = updateValue(next, 3, 'label', 'Title again');
    assert.deepEqual(errorsOf(next), []);
    assert.deepEqual(removeValue(next, 3).fields, passage.fields);
  });

  it('문항을 더하고 종류를 바꾸면 그 종류의 기본값이 채워지고, 다른 종류의 키는 지운다', () => {
    let next = addQuestion(passage, 'likert');
    const added = next.questions.at(-1);
    assert.equal(added.type, 'likert');
    assert.equal(added.min, 1);
    assert.deepEqual(errorsOf(next), []);
    next = setQuestionType(next, next.questions.length - 1, 'choice');
    assert.deepEqual(next.questions.at(-1).options, [['yes', 'Yes'], ['no', 'No']]);
    assert.equal(next.questions.at(-1).min, undefined);
    assert.equal(next.questions.at(-1).name, added.name);
    assert.deepEqual(errorsOf(next), []);
  });

  it('선택지와 항목을 고친다', () => {
    let next = addOption(passage, 0);
    assert.equal(next.questions[0].options.length, 4);
    next = updateOption(next, 0, 3, 1, 'Unsure');
    assert.deepEqual(next.questions[0].options[3], ['option_4', 'Unsure']);
    next = removeOption(next, 0, 3);
    assert.equal(next.questions[0].options.length, 3);
    next = setItems(next, 1, 'Off topic, Wrong date', false);
    assert.deepEqual(next.questions[1].items, ['Off topic', 'Wrong date']);
    assert.deepEqual(errorsOf(next), []);
  });

  it('문항을 지우면 그 문항의 대조 기준과 attention 도 지운다', () => {
    const next = removeQuestion(passage, 0);
    assert.equal(next.reference, undefined);
    assert.equal(next.attention, undefined);
    assert.equal(next.questions.length, 2);
  });

  it('대조 기준(value 형식)과 attention 을 고친다', () => {
    let next = setReferenceValue(passage, 'answers', '');
    assert.equal(next.reference, undefined);
    next = setReferenceValue(next, 'answers', 'gold');
    assert.deepEqual(referenceOf(next, 'answers'), { ref: { question: 'answers', value: 'gold' }, form: 'value' });
    next = updateAttention(next, 'expected', 'partly');
    assert.equal(next.attention.expected, 'partly');
    assert.equal(updateAttention(next, 'flag', '').attention, undefined);
    assert.ok(errorsOf(next)[0].includes('disagrees with the answer key'), '정답은 attention 항목에 "no" 를 준다');
    assert.deepEqual(errorsOf(updateAttention(next, 'expected', 'no')), []);
    assert.deepEqual(referenceOf(chunk, 'supported').form, 'selected');
    assert.deepEqual(answerValues(chunk.questions[1]), ['1', '2', '3', '4', '5']);
  });

  it('항목 목록을 바꾸고 지운다', () => {
    const next = updateRepeat(chunk, 'retrieved_chunk', 'Passage');
    assert.deepEqual(next.repeat, { over: 'retrieved_chunk', label: 'Passage' });
    assert.deepEqual(checkContract(next, chunkReader).errors, []);
    const flat = updateRepeat(chunk, '', '');
    assert.equal(flat.repeat, undefined);
    assert.ok(checkContract(flat, chunkReader).errors.some((e) => e.includes('[i] needs "repeat"')));
    assert.equal(updateQuestion(chunk, 1, 'per_item', false).questions[1].per_item, false);
  });
});

describe('Draft with AI: 단위와 페이지를 한 대화에서', () => {
  const unit = { level: 'chunk', why: 'One label per chunk.' };
  const before = { ...chunk, unit, layout: ['Show the query at the top.'] };

  it('단위와 페이지 바람의 변화도 바뀐 점에 나온다', () => {
    const after = { ...before, unit: { level: 'sentence', split: { from: 'retrieved_chunk', by: 'sentence' } }, layout: ['Show the query at the top.', 'Make the options green and red.'] };
    const changes = describeContractChanges(before, after);
    assert.ok(changes.some((c) => c.what === 'Unit' && c.before === 'chunk' && c.after === 'sentence (retrieved_chunk split into sentences)'));
    assert.ok(changes.some((c) => c.what === 'Page' && c.before === '' && c.after === 'Make the options green and red.'));
    assert.ok(!changes.some((c) => c.what === 'Page' && c.before === 'Show the query at the top.'), '그대로인 바람은 나오지 않는다');
    const removed = describeContractChanges(before, { ...before, layout: [] });
    assert.deepEqual(removed.map((c) => [c.what, c.before, c.after]), [['Page', 'Show the query at the top.', '']]);
  });

  it('답 뒤에 그 계약으로 다시 쓴 페이지를 붙이고, Restore 는 그 페이지로 돌아간다', () => {
    const page = { html: '<ann-form></ann-form>', message: 'Moved.', checks: [{ wish: 'x', result: 'met' }], remaining: false };
    let versions = addContractAnswer([], { before: null, result: { contract: before, errors: [] }, request: 'goal', meta: 'm' });
    versions = setVersionPage(versions, page);
    assert.equal(versionPage(versions[0]), page);
    // 사람이 고친 계약(그때의 페이지와 함께) → 다음 답
    const edited = { ...before, instructions: 'Edited.' };
    const after = { ...edited, layout: [] };
    versions = addContractAnswer(versions, { before: edited, beforePage: page, result: { contract: after, errors: [] }, request: 'plain page', meta: 'm' });
    assert.equal(versions[1].kind, 'edit');
    assert.equal(versionPage(versions[1]), page);
    versions = setVersionPage(versions, null);
    assert.equal(versionPage(versions[2]), null, '바람이 없으면 기본 페이지');
    assert.equal(versionPage({ kind: 'model', text: '{}' }), null, '페이지 기록이 없는 예전 줄은 기본 페이지');
    assert.deepEqual(setVersionPage([], page), []);
  });

  it('폼: 페이지 바람은 한 줄에 하나, 단위 수는 1 이상의 정수만', () => {
    assert.deepEqual(updateLayout(before, 'Query at the top.\n\n  Chunk on the left.  \n').layout, ['Query at the top.', 'Chunk on the left.']);
    assert.deepEqual(updateLayout(before, '').layout, []);
    assert.equal(updatePerHit(before, '4').repeat.per_hit, 4);
    assert.equal('per_hit' in updatePerHit({ ...before, repeat: { ...before.repeat, per_hit: 4 } }, '').repeat, false);
    assert.equal('per_hit' in updatePerHit(before, '0').repeat, false);
    assert.equal(updatePerHit(passage, '3'), passage, 'repeat 이 없으면 그대로');
    assert.deepEqual(errorsOf(updateLayout(before, 'A\nB'), chunkReader), []);
  });
});
