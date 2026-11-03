// lib/binding-form.js: 폼의 드롭다운 목록과 binding 고치기. 폼으로 고친 binding 이 검사를 통과하고 원본을 바꾸지 않는지 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { addField, fieldsIn, labelFromPath, pathChoices, referenceForm, removeField, setReferenceForm, updateAnswer, updateAttention, updateField, updateInstructions, updateReference, updateRepeat } from '../src/lib/binding-form.js';
import { checkBinding, dataReader, draftBinding, filledSlots, judgedOptions } from '../src/lib/design-binding.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { roughDesignById, taskTypeById } from '../src/lib/rough-designs.js';

const example = (name) => readFileSync(new URL(`../../example/6-rough-design/${name}`, import.meta.url), 'utf8');
const reader = dataReader(parseJsonData(example('chunk-fact-hits.json'), 'chunk-fact-hits.json'));
const binding = JSON.parse(example('chunk-fact.binding.json'));
const readerOf = (rows) => dataReader(parseJsonData(JSON.stringify(rows), 't.json'));
const errorsOf = (b, r = reader) => checkBinding(b, r).errors;

describe('pathChoices', () => {
  it('목록 컬럼은 탭이 있으면 [i] 로, 없으면 컬럼 그대로 보인다', () => {
    const repeating = pathChoices(reader, true);
    assert.ok(repeating.values.includes('retrieved_chunk[i]'));
    assert.ok(repeating.lists.includes('atomic_facts[i]'));
    assert.ok(repeating.repeats.includes('retrieved_chunk'));
    const flat = pathChoices(reader, false);
    assert.ok(flat.values.includes('retrieved_chunk'));
    assert.equal(flat.values.includes('retrieved_chunk[i]'), false);
  });

  it('고를 수 있는 경로는 모두 검사를 통과한다', () => {
    const { values } = pathChoices(reader, true);
    for (const from of values) assert.deepEqual(errorsOf({ ...binding, slots: { ...binding.slots, data: { from } } }), [], from);
  });

  it('worker 에게 보이지 않을 법한 값은 목록 뒤에 둔다', () => {
    const { values } = pathChoices(reader, true);
    assert.ok(values.indexOf('retrieved_chunk[i]') < values.indexOf('attention_check[i]'));
    assert.ok(values.indexOf('retrieved_chunk[i]') < values.indexOf(values.find((path) => path.startsWith('qid'))));
  });

  it('객체 목록은 키까지, 객체는 키와 그 안의 목록까지 내려간다', () => {
    const r = readerOf([{ passages: JSON.stringify([{ text: 't', tags: ['a'] }]), meta: JSON.stringify({ title: 'x', items: ['a', 'b'], 'bad key': 1 }), plain: 'p' }]);
    const repeating = pathChoices(r, true);
    assert.deepEqual(repeating.values.filter((path) => path.startsWith('passages')), ['passages[i].text', 'passages[i].tags']);
    assert.ok(repeating.lists.includes('passages[i].tags'));
    assert.ok(repeating.lists.includes('meta.items'));
    assert.ok(repeating.repeats.includes('meta.items'));
    assert.ok(repeating.values.includes('meta.title'));
    assert.equal(repeating.values.some((path) => path.includes('bad')), false, '경로로 쓸 수 없는 키는 뺀다');
    assert.ok(repeating.values.includes('plain'));
  });

  it('경로로 쓸 수 없는 컬럼 이름은 뺀다', () => {
    const r = readerOf([{ 'has space': 'a', ok: 'b' }]);
    assert.deepEqual(pathChoices(r, false).values, ['ok']);
  });
});

describe('폼으로 binding 고치기', () => {
  it('값 하나를 고치면 원본은 그대로이고 새 binding 은 검사를 통과한다', () => {
    const before = structuredClone(binding);
    const next = updateField(binding, 'data', 0, 'from', 'retrieved_chunk[i]');
    assert.deepEqual(binding, before);
    assert.equal(fieldsIn(next, 'data')[0].from, 'retrieved_chunk[i]');
    assert.deepEqual(errorsOf(next), []);
  });

  it('값을 더하고 빼면 하나일 때 객체, 여럿일 때 배열로 쓴다', () => {
    const added = addField(binding, 'data', ['query[i]', 'retrieved_chunk[i]', 'atomic_facts[i]']);
    assert.equal(added.slots.data.length, 3);
    assert.deepEqual(added.slots.data[2], { label: 'Atomic facts', from: 'atomic_facts[i]' });
    const one = removeField(binding, 'data', 0);
    assert.deepEqual(one.slots.data, { label: 'Chunk', from: 'retrieved_chunk[i]' });
  });

  it('kind 를 Default 로 돌리면 키가 사라진다', () => {
    const image = updateField(binding, 'data', 0, 'kind', 'image');
    assert.equal(fieldsIn(image, 'data')[0].kind, 'image');
    assert.equal('kind' in fieldsIn(updateField(image, 'data', 0, 'kind', ''), 'data')[0], false);
  });

  it('context 는 배열로 쓰고 다 빼면 키가 사라진다', () => {
    const added = addField(binding, 'context', ['qid']);
    assert.ok(Array.isArray(added.context));
    assert.equal('context' in removeField(added, 'context', 0), false);
  });

  it('문항을 비우면 예시 문항으로 돌아가고 경고한다', () => {
    const cleared = ['header', 'items', 'name', 'options'].reduce((b, key) => updateAnswer(b, 'item-choice', key, ''), binding);
    assert.equal('item-choice' in cleared.slots, false);
    const design = roughDesignById('item-list');
    const type = taskTypeById('text');
    assert.ok(filledSlots(cleared, design, type)['item-choice'].header.length > 0);
    const { reference, attention, ...plain } = cleared;
    assert.ok(checkBinding(plain, reader).warnings.some((warning) => /example question/.test(warning)));
  });

  it('탭을 끄면 repeat 가 사라지고 [i] 경로는 이유를 알린다', () => {
    const next = updateRepeat(binding, '', undefined);
    assert.equal('repeat' in next, false);
    assert.ok(errorsOf(next).some((error) => /\[i\] needs "repeat"/.test(error)));
    assert.deepEqual(updateRepeat(binding, 'query', 'Item').repeat, { over: 'query', label: 'Item' });
  });

  it('안내문을 비우면 키가 사라진다', () => {
    assert.equal('instructions' in updateInstructions(binding, ''), false);
  });

  it('대조 기준의 형식을 바꾸면 경로를 잇고 없는 키를 지우며, None 이면 사라진다', () => {
    assert.equal(referenceForm(binding), 'selected');
    const asMap = setReferenceForm(binding, 'map', 'x');
    assert.deepEqual(asMap.reference, { map: 'chunk_fact_relevance_check', key: 'Chunk {i}' });
    assert.deepEqual(setReferenceForm(binding, 'value', 'x').reference, { value: 'chunk_fact_relevance_check' });
    assert.equal('reference' in setReferenceForm(binding, '', 'x'), false);
    const { reference, ...plain } = binding;
    assert.deepEqual(setReferenceForm(plain, 'value', 'first').reference, { value: 'first' });
    assert.equal(referenceForm(plain), '');
    assert.equal(updateReference(binding, 'yes', 'not_grounded').reference.yes, 'not_grounded');
  });

  it('attention: 기대 답만 비우면 표시가 남고, 표시를 비우면 전체가 사라진다', () => {
    const noExpected = updateAttention(binding, 'expected', '');
    assert.deepEqual(noExpected.attention, { flag: 'attention_check[i]' });
    assert.equal('attention' in updateAttention(binding, 'flag', ''), false);
    assert.deepEqual(updateAttention({ design: 'item-list' }, 'flag', 'x').attention, { flag: 'x' });
  });

  it('문항의 선택지 값을 바꾸면 대조 기준과의 불일치를 검사가 알린다', () => {
    const next = updateAnswer(binding, 'item-choice', 'options', [['a', 'A'], ['b', 'B']]);
    assert.ok(errorsOf(next).length > 0);
  });

  it('첫 binding 에서 시작해 폼으로 모든 칸을 채우면 예시 경고가 사라진다', () => {
    let next = draftBinding('item-list', 'text', reader);
    next = updateAnswer(next, 'item-choice', 'header', 'Is it supported?');
    next = updateAnswer(next, 'item-choice', 'items', 'atomic_facts[i]');
    const check = checkBinding(next, reader);
    assert.deepEqual(check.errors, []);
    assert.equal(check.warnings.some((warning) => /example question/.test(warning)), false);
  });

  it('문항이 없는 가안은 대조할 문항이 없다', () => {
    const noQuestion = { rows: [{ slots: ['data', 'free-text'] }] };
    assert.equal(judgedOptions({ design: 'x', slots: {} }, noQuestion, taskTypeById('text')), null);
  });
});

describe('labelFromPath', () => {
  it('컬럼 이름으로 칸 제목을 만든다', () => {
    assert.equal(labelFromPath('retrieved_chunk[i]'), 'Retrieved chunk');
    assert.equal(labelFromPath('passages[i].text'), 'Passages');
  });
});
