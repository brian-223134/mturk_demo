// lib/html-harness.js: Agent 가 쓴 템플릿 HTML 의 검사. example/6-rough-design 의 binding 으로 만든 정답지를 계약으로 두고,
// 정답지는 통과하고, 정답 누출·빠진 값·바꾼 문항·스크립트·외부 주소는 막히며, 재요청 루프가 오류를 붙여 다시 묻는지 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { dataReader } from '../src/lib/design-binding.js';
import { checkAgentHtml, compareRendered, contractFor, pageRequest, placeholderRoles, requestHtml } from '../src/lib/html-harness.js';
import { parseJsonData } from '../src/lib/json-data.js';

const example = (name) => readFileSync(new URL(`../../example/6-rough-design/${name}`, import.meta.url), 'utf8');
const binding = JSON.parse(example('chunk-fact.binding.json'));
const contract = contractFor(binding, dataReader(parseJsonData(example('chunk-fact-hits.json'), 'chunk-fact-hits.json')));
const errorsOf = (html) => checkAgentHtml(html, contract).errors;

describe('contractFor', () => {
  it('정답지가 쓰는 컬럼과 쓰지 않는 컬럼, 정답 컬럼, 문항을 나눈다', () => {
    assert.equal(contract.tabs, 11);
    assert.ok(contract.shown.includes('slot_data_f2_11'));
    assert.deepEqual(contract.answerColumns.sort(), ['attention_check', 'chunk_fact_relevance_check', 'slot_attention', 'slot_reference']);
    assert.ok(contract.hidden.includes('qid'));
    assert.equal(contract.roles.slot_data_f1_1, 'text');
    assert.equal(contract.roles.slot_item_choice_1, 'json');
    assert.equal(contract.questions.length, 11);
  });

  it('검사를 통과하지 못하는 binding 은 계약을 만들지 않는다', () => {
    assert.throws(() => contractFor({ ...binding, slots: { ...binding.slots, data: { from: 'nope[i]' } } }, dataReader(parseJsonData(example('chunk-fact-hits.json'), 'x.json'))), /does not pass/);
  });
});

describe('checkAgentHtml', () => {
  it('정답지와, 배치·글·스타일만 바꾼 페이지는 통과한다', () => {
    assert.deepEqual(errorsOf(contract.html), []);
    const restyled = contract.html
      .replace('<ann-form>', '<style>.note { color: #333; }</style>\n<ann-form>')
      .replaceAll('<ann-columns columns="3fr 2fr">', '<div class="note"><p>Read carefully.</p></div><ann-columns columns="1fr">');
    assert.deepEqual(errorsOf(restyled), []);
  });

  it('정답이나 attention 컬럼을 쓰면 누출로 막는다', () => {
    const leaked = contract.html.replace('<ann-form>', '<ann-form><p>${slot_reference} ${chunk_fact_relevance_check}</p>');
    const errors = errorsOf(leaked);
    assert.ok(errors.some((e) => e.includes('"slot_reference"') && e.includes('answers')));
    assert.ok(errors.some((e) => e.includes('"chunk_fact_relevance_check"')));
  });

  it('값을 빼거나, 주석에만 두거나, 다른 자리로 옮기면 막는다', () => {
    assert.ok(errorsOf(contract.html.replace('${slot_data_f2_7}', '')).some((e) => e.includes('"slot_data_f2_7" is missing')));
    assert.ok(errorsOf(contract.html.replace('${slot_data_f2_7}', '<!-- ${slot_data_f2_7} -->')).some((e) => e.includes('missing')));
    assert.ok(errorsOf(contract.html.replace('>${slot_data_f2_7}<', ' title="${slot_data_f2_7}"><')).some((e) => e.includes('as visible text')));
  });

  it('한 항목의 값을 맨 위에 한 번 더 쓰거나, 값을 접힌 상자에 넣으면 막는다', () => {
    // 실제 Agent 가 "모든 Chunk 에 같다"는 요청을 따라 1번 Query 를 맨 위에 두고 탭의 Query 를 접어 숨겼던 경우
    const repeated = contract.html.replace('<ann-tabs>', '<ann-text label="Query (same for every chunk)">${slot_data_f1_1}</ann-text>\n  <ann-tabs>');
    assert.ok(errorsOf(repeated).some((e) => e.includes('"slot_data_f1_1" belongs to one item but appears more than once')));
    const folded = contract.html.replace('<ann-text label="Query">${slot_data_f1_2}</ann-text>', '<details><summary>Query for this chunk</summary><ann-text label="Query">${slot_data_f1_2}</ann-text></details>');
    assert.ok(errorsOf(folded).some((e) => e.includes('"slot_data_f1_2" is inside a collapsed <details>')));
    assert.deepEqual(errorsOf(contract.html.replace('<ann-form>', '<ann-form><details><summary>Tips</summary><p>Read carefully.</p></details>')), []);
  });

  it('없는 컬럼, 페이지에 없던 컬럼을 쓰면 막는다', () => {
    const errors = errorsOf(contract.html.replace('<ann-form>', '<ann-form><p>${qid} ${made_up}</p>'));
    assert.ok(errors.some((e) => e.includes('"qid"') && e.includes('not part of this page')));
    assert.ok(errors.some((e) => e.includes('no column "made_up"')));
  });

  it('문항을 빼거나 더하거나 요소를 바꾸면 막는다', () => {
    assert.ok(errorsOf(contract.html.replace('name="supported_3"', 'name="support_3"')).some((e) => e.includes('"supported_3"') && e.includes('missing')));
    const added = contract.html.replace('</ann-form>', '<ann-likert name="confidence" header="How sure are you?"></ann-likert></ann-form>');
    assert.ok(errorsOf(added).some((e) => e.includes('"confidence"') && e.includes('not in the current template')));
  });

  it('스크립트, 이벤트 속성, 외부 주소, 허용하지 않은 요소를 막는다', () => {
    const html = contract.html
      .replace('<ann-form>', '<ann-form><script>fetch("/x")</script><div onclick="x()">hi</div><a href="https://example.com">link</a>')
      .replace('</ann-form>', '<style>@import url("https://example.com/a.css");</style></ann-form>');
    const errors = errorsOf(html);
    assert.ok(errors.some((e) => e.includes('Only <script')));
    assert.ok(errors.some((e) => e.includes('"onclick"')));
    assert.ok(errors.some((e) => e.includes('https://example.com')));
    assert.ok(errors.some((e) => e.includes('<a>')));
    assert.ok(errors.some((e) => e.includes('@import')));
  });

  it('숨겨지는 <ann-option>, <ann-item> 을 겨냥한 스타일은 효과가 없다고 알리고, 선택지 안의 클래스는 허용한다', () => {
    const dead = contract.html.replace('<ann-form>', '<style>ann-option[value="grounded"] { color: green; }</style><ann-form>');
    assert.ok(errorsOf(dead).some((e) => e.includes('have no effect')));
    const alive = contract.html
      .replace('<ann-form>', '<style>.ann-option-label .good { color: green; }</style><ann-form>')
      .replaceAll('<ann-option value="grounded">Grounded</ann-option>', '<ann-option value="grounded"><span class="good">Grounded</span></ann-option>');
    assert.deepEqual(errorsOf(alive), []);
  });

  it('빈 답은 빈 페이지로 알린다', () => {
    assert.deepEqual(errorsOf(''), ['The HTML is empty.']);
  });
});

describe('pageRequest', () => {
  it('HTML Agent 에게는 정답지와 보여 줄 컬럼만 보내고, 정답 컬럼은 이름도 보내지 않는다', () => {
    const request = pageRequest(contract, 'Stack it.', 'text');
    assert.equal(request.template, contract.html);
    assert.equal(request.columns.length, contract.shown.length);
    assert.equal(request.columns[0].role, 'text');
    const sent = JSON.stringify(request);
    for (const column of contract.answerColumns) assert.ok(!sent.includes(column), column);
    assert.ok(request.columns.every((c) => c.sample.length <= 240));
  });
});

describe('placeholderRoles', () => {
  it('글, 주소, 항목 목록, 그 밖의 속성을 구분한다', () => {
    const roles = placeholderRoles('<ann-image src="${a}"></ann-image><ann-text>${b}</ann-text><script type="application/json">${c}</script><div title="${d}"></div><!-- ${e} -->');
    assert.deepEqual(Object.fromEntries([...roles].map(([k, v]) => [k, [...v]])), { c: ['json'], a: ['src'], d: ['attribute'], b: ['text'] });
  });
});

describe('compareRendered', () => {
  const rows = contract.data.rows;
  const page = (row) => ({ schema: [{ name: 'supported_1', type: 'choice', values: ['grounded', 'not_grounded'], required: true }], text: contract.shown.filter((n) => contract.roles[n] === 'text').map((n) => rows[row][n]).join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), srcs: [] });
  const reference = rows.map((_, row) => page(row));

  it('같은 답 칸과 값이 모두 보이면 오류가 없다', () => {
    assert.deepEqual(compareRendered(contract, reference, reference).errors, []);
  });

  it('답 칸이 다르거나 값이 화면에 없거나 그리지 못하면 행 번호와 함께 알린다', () => {
    const rendered = reference.map((p, row) => (row === 0 ? { ...p, schema: [] } : row === 1 ? { ...p, text: '' } : { error: 'boom' }));
    const errors = compareRendered(contract, reference, rendered).errors;
    assert.ok(errors.some((e) => e.row === 0 && e.message.includes('answer fields differ')));
    assert.ok(errors.some((e) => e.row === 1 && e.message.includes('not shown as text')));
    assert.ok(errors.some((e) => e.row === 2 && e.message.includes('boom')));
  });
});

describe('requestHtml', () => {
  it('누출된 첫 답의 오류를 붙여 다시 묻고, 고친 답에서 멈춘다 (흐름)', async () => {
    const leaky = contract.html.replace('<ann-form>', '<ann-form><p>${slot_reference}</p>');
    const replies = [{ html: leaky, message: 'first', usage: { cost: 0.01 } }, { html: contract.html, message: 'fixed', usage: { cost: 0.02 } }];
    const sent = [];
    const result = await requestHtml({ send: async (body) => (sent.push(body), replies.shift()), check: (html) => checkAgentHtml(html, contract), request: { request: 'x' } });
    assert.equal(result.attempts, 2);
    assert.equal(result.html, contract.html);
    assert.equal(result.message, 'fixed');
    assert.deepEqual(result.errors, []);
    assert.equal(sent[1].previous, leaky);
    assert.ok(sent[1].errors.some((e) => e.includes('slot_reference')));
    assert.ok(Math.abs(result.usage.cost - 0.03) < 1e-9);
    assert.equal(result.history.length, 2);
  });

  it('검사를 통과한 페이지를 판정하고, 요청과 다른 점이 있으면 그것을 붙여 다시 묻는다', async () => {
    const replies = [{ html: contract.html, message: 'first' }, { html: contract.html.replace('<ann-form>', '<ann-form><p>Read carefully.</p>'), message: 'second' }];
    const reviews = [{ notes: ['Not as requested: facts on the right'], checks: [{ wish: 'facts on the right', result: 'not_met' }], usage: { cost: 0.001 } }, { notes: [], checks: [{ wish: 'facts on the right', result: 'met' }], usage: { cost: 0.001 } }];
    const sent = [];
    const result = await requestHtml({ send: async (body) => (sent.push(body), replies.shift()), check: (html) => checkAgentHtml(html, contract), review: async () => reviews.shift(), request: {} });
    assert.equal(result.attempts, 2);
    assert.equal(result.message, 'second');
    assert.deepEqual(result.notes, []);
    assert.equal(result.checks[0].result, 'met');
    assert.deepEqual(sent[1].errors, ['Not as requested: facts on the right']);
    assert.ok(Math.abs(result.usage.cost - 0.002) < 1e-9);
  });

  it('판정이 끝까지 맞지 않거나 나중 답이 검사에 걸려도, 검사를 통과한 마지막 페이지를 남은 점과 함께 돌려준다', async () => {
    const replies = [{ html: contract.html, message: 'ok page' }, { html: '', message: 'broken' }];
    const result = await requestHtml({ send: async () => replies.shift(), check: (html) => checkAgentHtml(html, contract), review: async () => ({ notes: ['Not as requested: X'], checks: [{ wish: 'X', result: 'not_met' }] }), request: {}, maxAttempts: 2 });
    assert.equal(result.html, contract.html);
    assert.equal(result.message, 'ok page');
    assert.deepEqual(result.notes, ['Not as requested: X']);
    assert.deepEqual(result.errors, []);
  });

  it('할 수 없다는 답은 다시 묻지 않는다', async () => {
    const result = await requestHtml({ send: async () => ({ cannot: 'format', message: 'no' }), check: () => assert.fail('no check'), request: {} });
    assert.equal(result.cannot, 'format');
    assert.equal(result.html, null);
    assert.equal(result.attempts, 1);
  });

  it('끝까지 통과하지 못하면 마지막 답과 오류를 돌려준다', async () => {
    const result = await requestHtml({ send: async () => ({ html: '' }), check: (html) => checkAgentHtml(html, contract), request: {}, maxAttempts: 2 });
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.errors, ['The HTML is empty.']);
  });
});
