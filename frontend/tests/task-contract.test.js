// lib/task-contract.js: 가안 없이 prompt 로 정하는 자유 계약. 검사, 기본 템플릿, 게시용 행, harness 용 계약, 재요청 루프를
// example/6-rough-design 의 합성 데이터와 손으로 쓴 계약(scripts/html_experiment/fixtures)으로 따라간다.
// 같은 과제를 binding 으로 만든 것과 대조 기준·attention 값이 HIT 마다 같은지도 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { boundData, checkBinding, dataReader } from '../src/lib/design-binding.js';
import { checkAgentHtml } from '../src/lib/html-harness.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { buildContractTemplate, checkContract, contractOutline, contractRow, contractSettings, contractTaskType, harnessContract, requestContract } from '../src/lib/task-contract.js';

const file = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const readerOf = (path) => dataReader(parseJsonData(file(path), 'x.json'));
const chunkReader = readerOf('example/6-rough-design/chunk-fact-hits.json');
const passageReader = readerOf('scripts/html_experiment/data/passage-answer.json');
const chunk = JSON.parse(file('scripts/html_experiment/fixtures/free-chunk-confidence.contract.json'));
const passage = JSON.parse(file('scripts/html_experiment/fixtures/free-passage-problems.contract.json'));
const errorsOf = (contract, reader = passageReader) => checkContract(contract, reader).errors;

describe('checkContract', () => {
  it('손으로 쓴 계약은 통과하고 탭 수를 센다', () => {
    assert.deepEqual(checkContract(chunk, chunkReader), { errors: [], warnings: [], tabs: 11 });
    assert.deepEqual(checkContract(passage, passageReader), { errors: [], warnings: [], tabs: 0 });
  });

  it('대조 기준·attention 컬럼이나 정답처럼 보이는 컬럼을 화면 값으로 쓰면 막는다', () => {
    const declared = { ...passage, fields: [...passage.fields, { id: 'g', label: 'Gold', from: 'gold' }] };
    assert.ok(errorsOf(declared).some((e) => e.includes('"gold" holds the answers')));
    const undeclared = { ...passage, reference: undefined, attention: undefined, fields: [...passage.fields, { id: 'g', label: 'Gold', from: 'gold' }, { id: 'a', label: 'A', from: 'attention' }] };
    const errors = errorsOf(undeclared);
    assert.ok(errors.some((e) => e.includes('"gold" looks like it holds answers')));
    assert.ok(errors.some((e) => e.includes('"attention" looks like it holds answers')));
  });

  it('경로, 이름, 선택지, 점수 범위, 영어가 아닌 글을 검사한다', () => {
    const broken = {
      ...passage,
      instructions: '질문을 읽으세요',
      fields: [{ id: 'q', from: 'nope' }, { id: 'q', from: 'question[i]' }],
      questions: [
        { name: 'a', type: 'choice', header: 'H', options: [['yes', 'Yes']] },
        { name: 'a', type: 'likert', header: 'H', min: 3, max: 3 },
        { name: 'b', type: 'checklist', header: 'H' },
        { name: 'c', type: 'slider', header: 'H' },
      ],
      reference: undefined,
      attention: undefined,
    };
    const errors = errorsOf(broken);
    for (const part of ['no column "nope"', 'id "q" is used twice', '[i] needs "repeat"', 'at least two options', 'name "a" is used twice', '"max" must be', 'needs "items"', '"type" must be one of', 'in English']) {
      assert.ok(errors.some((e) => e.includes(part)), part);
    }
  });

  it('항목마다 하나씩인 목록을 통째로 보이거나, 항목마다 다른 목록을 고정 번호로 읽으면 막는다', () => {
    // 합성 데이터의 query 는 HIT 마다 11개 중 마지막(attention 항목)만 다르다. "모든 항목에 같다"고 믿고 쓴 계약을 막아야 한다
    const whole = { ...chunk, fields: [{ ...chunk.fields[0], from: 'query' }, chunk.fields[1]] };
    assert.ok(checkContract(whole, chunkReader).errors.some((e) => e.includes('holds one value per item') && e.includes('query[i]')));
    const fixed = { ...chunk, fields: [{ ...chunk.fields[0], from: 'query[0]' }, chunk.fields[1]] };
    assert.ok(checkContract(fixed, chunkReader).errors.some((e) => e.includes('differ between items in 3 of 3 HIT(s)')));
    const rows = JSON.parse(file('example/6-rough-design/chunk-fact-hits.json')).map((row) => ({ ...row, query: JSON.stringify(Array(11).fill('Same question?')) }));
    assert.deepEqual(checkContract(fixed, dataReader(parseJsonData(JSON.stringify(rows), 'x.json'))).errors, []);
  });

  it('대조 기준 라벨이 문항의 값이 아니거나 attention 기대 답이 값이 아니면 막는다', () => {
    const wrong = { ...passage, questions: [{ ...passage.questions[0], options: [['y', 'Yes'], ['n', 'No']] }], attention: { flag: 'attention', question: 'answers', expected: 'maybe' } };
    const errors = errorsOf(wrong);
    assert.ok(errors.some((e) => e.includes('attention.expected: "maybe"')));
    const labels = { ...passage, questions: [{ ...passage.questions[0], options: [['y', 'Yes'], ['n', 'No']] }], attention: undefined };
    assert.ok(errorsOf(labels).some((e) => e.includes('are not values of the question')));
  });
});

describe('기본 템플릿과 게시용 행', () => {
  it('한 번만 보일 값은 탭 위에, 항목마다의 값과 문항은 탭 안에 둔다', () => {
    const once = { ...chunk, fields: [{ ...chunk.fields[0], from: 'query[0]' }, chunk.fields[1]] };
    const html = buildContractTemplate(once, 11);
    assert.ok(html.indexOf('${f_query}') < html.indexOf('<ann-tabs>'));
    assert.ok(buildContractTemplate(chunk, 11).includes('${f_query_11}'));
    assert.ok(html.includes('name="confidence_11"'));
    assert.ok(html.includes('${q_supported_items_3}'));
  });

  it('per_item: false 문항은 탭 밖에서 한 번만 묻는다', () => {
    const once = { ...chunk, questions: [...chunk.questions, { name: 'overall', type: 'text', header: 'Anything else?', per_item: false }] };
    const html = buildContractTemplate(once, 11);
    assert.ok(html.indexOf('name="overall"') > html.indexOf('</ann-tabs>'));
    assert.ok(!html.includes('name="overall_1"'));
  });

  it('같은 과제를 binding 으로 만든 것과 대조 기준·attention 값이 HIT 마다 같다', () => {
    const binding = JSON.parse(file('example/6-rough-design/chunk-fact.binding.json'));
    const check = checkBinding(binding, chunkReader);
    const bound = boundData(binding, check.design, check.taskType, check.tabs, chunkReader, 'x.json').rows;
    for (let row = 0; row < chunkReader.rowCount; row += 1) {
      const free = contractRow(chunk, 11, chunkReader, row);
      assert.deepEqual(JSON.parse(free.slot_reference), JSON.parse(bound[row].slot_reference));
      assert.deepEqual(JSON.parse(free.slot_attention), JSON.parse(bound[row].slot_attention));
    }
  });

  it('attention 행은 대조 기준에서 빠지고 기대 답만 남는다', () => {
    const rows = Array.from({ length: passageReader.rowCount }, (_, row) => contractRow(passage, 0, passageReader, row));
    assert.deepEqual(rows.map((r) => JSON.parse(r.slot_attention)), [{}, {}, {}, {}, { answers: 'no' }, {}]);
    assert.deepEqual(JSON.parse(rows[4].slot_reference), {});
    assert.deepEqual(JSON.parse(rows[0].slot_reference), { answers: 'yes' });
    assert.equal(rows[0].gold, 'yes');
    assert.equal(rows[0].f_question, 'When does the city library open on Sundays?');
  });

  it('harness 용 계약: 기본 템플릿은 스스로 통과하고, 정답 컬럼을 알고 있다', () => {
    const contract = harnessContract(passage, passageReader);
    assert.deepEqual(checkAgentHtml(contract.html, contract).errors, []);
    assert.deepEqual(contract.answerColumns.sort(), ['attention', 'gold', 'slot_attention', 'slot_reference']);
    assert.deepEqual(contract.questions.map((q) => q.tag), ['ann-choice', 'ann-checklist', 'ann-textarea']);
    assert.ok(checkAgentHtml(contract.html.replace('</ann-form>', '<p>${gold}</p></ann-form>'), contract).errors.some((e) => e.includes('"gold"')));
    assert.deepEqual(contractSettings(passage), { referenceColumn: 'slot_reference', attentionEnabled: true, attentionMode: 'column', attentionColumn: 'slot_attention', attentionMinRatio: 1 });
  });
});

describe('화면에 보일 요약', () => {
  it('값과 문항, 항목마다인지, 대조 기준과 attention 이 붙었는지 보인다', () => {
    const outline = contractOutline(chunk);
    assert.equal(outline.itemLabel, 'Chunk (one per element of retrieved_chunk)');
    assert.deepEqual(outline.values.map((v) => [v.label, v.from, v.perItem]), [['Query', 'query[i]', true], ['Chunk', 'retrieved_chunk[i]', true]]);
    assert.deepEqual(outline.questions.map((q) => [q.name, q.type, q.compared, q.attention]), [['supported', 'item-choice', true, true], ['confidence', 'likert', false, false]]);
    assert.equal(outline.questions[1].answers, '1 to 5 (Guessing … Certain)');
    const passageOutline = contractOutline(passage);
    assert.equal(passageOutline.itemLabel, null);
    assert.equal(passageOutline.questions[0].answers, 'Yes / Partly / No');
    assert.equal(passageOutline.questions[1].answers, 'yes / no for each item; items: Off topic, Outdated, Too vague');
    assert.equal(passageOutline.questions[2].answers, 'written answer');
  });

  it('값의 종류로 task 종류를 정한다', () => {
    assert.equal(contractTaskType(passage), 'text');
    assert.equal(contractTaskType({ fields: [{ from: 'a', kind: 'image' }] }), 'vision');
    assert.equal(contractTaskType({ fields: [{ from: 'a', kind: 'image' }, { from: 'b', kind: 'video' }] }), 'video');
  });
});

describe('requestContract', () => {
  it('검사에 걸린 계약의 오류를 붙여 다시 묻고, 고친 계약에서 멈춘다 (흐름)', async () => {
    const leaky = { ...passage, fields: [...passage.fields, { id: 'g', label: 'Gold', from: 'gold' }] };
    const replies = [{ contract: leaky, message: 'first', usage: { cost: 0.001 } }, { contract: passage, message: 'fixed', usage: { cost: 0.002 } }];
    const sent = [];
    const result = await requestContract({ send: async (body) => (sent.push(body), replies.shift()), check: (c) => checkContract(c, passageReader), request: { request: 'x' } });
    assert.equal(result.attempts, 2);
    assert.equal(result.contract, passage);
    assert.deepEqual(sent[1].previous, leaky);
    assert.ok(sent[1].errors.some((e) => e.includes('"gold"')));
    assert.ok(Math.abs(result.usage.cost - 0.003) < 1e-9);
  });

  it('할 수 없다는 답은 다시 묻지 않는다', async () => {
    const result = await requestContract({ send: async () => ({ cannot: 'format', message: 'no' }), check: () => assert.fail('no check'), request: {} });
    assert.equal(result.cannot, 'format');
    assert.equal(result.contract, null);
  });
});
