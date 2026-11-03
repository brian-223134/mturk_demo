// lib/design-binding.js: 이미 HIT 로 묶인 데이터를 rough design 의 칸에 넣는 binding. 값 읽기, 검사, 조립, 가안 바꾸기를
// example/6-rough-design 의 합성 데이터와 손으로 쓴 binding 으로 따라간다. 게시 전의 Upload JSON 검사까지 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { checkData } from '../src/lib/data-check.js';
import { adaptBinding, attentionItems, boundData, boundRow, buildBoundTemplate, checkBinding, dataReader, draftBinding, parseCell, parsePath } from '../src/lib/design-binding.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';
import { ROUGH_DESIGNS, TASK_TYPES, roughDesignById, taskTypeById } from '../src/lib/rough-designs.js';
import { extractPlaceholders, renderTemplate } from '../src/lib/template.js';

const example = (name) => readFileSync(new URL(`../../example/6-rough-design/${name}`, import.meta.url), 'utf8');
const data = parseJsonData(example('chunk-fact-hits.json'), 'chunk-fact-hits.json');
const binding = JSON.parse(example('chunk-fact.binding.json'));
const reader = dataReader(data);
const readerOf = (rows) => dataReader(parseJsonData(JSON.stringify(rows), 't.json'));
const build = (b, r) => {
  const check = checkBinding(b, r);
  assert.deepEqual(check.errors, []);
  return { check, html: buildBoundTemplate(b, check.design, check.taskType, check.tabs) };
};

describe('parseCell', () => {
  it('목록과 객체로 보이는 글만 풀고 나머지는 그대로 둔다', () => {
    assert.equal(parseCell('plain text, with comma'), 'plain text, with comma');
    assert.equal(parseCell('007'), '007');
    assert.equal(parseCell(''), '');
    assert.equal(parseCell(undefined), '');
    assert.deepEqual(parseCell('["a", 1]'), ['a', 1]);
    assert.deepEqual(parseCell('{"a": [1]}'), { a: [1] });
  });

  it('Python 리터럴을 읽는다', () => {
    assert.deepEqual(parseCell("['a', \"it's\", 'don\\'t', 'line\\nbreak']"), ['a', "it's", "don't", 'line\nbreak']);
    assert.deepEqual(parseCell("{'k': [1, 2.5, True, False, None], 'nested': {'x': ('t', 'u')}}"), { k: [1, 2.5, true, false, null], nested: { x: ['t', 'u'] } });
    assert.deepEqual(parseCell("[['a'], [], {}, 'b',]"), [['a'], [], {}, 'b']);
    assert.equal(parseCell('[not a literal'), '[not a literal');
    assert.equal(parseCell("['open"), "['open");
    assert.equal(parseCell("['a'] trailing"), "['a'] trailing");
  });
});

describe('parsePath', () => {
  it('컬럼 뒤에 [i], [숫자], .키 를 붙인다', () => {
    assert.deepEqual(parsePath('facts'), { column: 'facts', steps: [] });
    assert.deepEqual(parsePath('facts[i][0].text'), { column: 'facts', steps: [{ index: 'i' }, { index: 0 }, { key: 'text' }] });
    for (const bad of ['', 'a b', 'a[j]', 'a[', null]) assert.equal(parsePath(bad), null, String(bad));
  });
});

describe('손으로 쓴 Chunk-Fact binding', () => {
  const { check, html } = build(binding, reader);
  const row = boundRow(binding, check.design, check.taskType, check.tabs, reader, 0);

  it('HIT 당 항목 11개가 탭 11개가 되고 layout 검사에 문제가 없다', () => {
    assert.equal(check.tabs, 11);
    assert.deepEqual(check.warnings, []);
    assert.equal(html.match(/<ann-tab /g).length, 11);
    assert.ok(html.includes('header="Chunk 11"'));
    const lint = lintLayout(html);
    assert.equal(hasLayoutErrors(lint), false, JSON.stringify(lint.problems));
    assert.deepEqual(lint.problems.filter((p) => p.level === 'warning'), []);
    assert.equal(lint.questions.length, 11);
    assert.equal(lint.questions[10].name, 'supported_11');
  });

  it('칸의 값은 원본 목록의 같은 번호 값이다', () => {
    const chunks = reader.cell(0, 'retrieved_chunk');
    const facts = reader.cell(0, 'atomic_facts');
    assert.equal(chunks.length, 11);
    assert.equal(row.slot_data_f2_3, chunks[2]);
    assert.deepEqual(JSON.parse(row.slot_checklist_3), facts[2]);
    assert.equal(row.slot_data_f1_1, reader.cell(0, 'query')[0]);
  });

  it('미리보기: 치환되지 않은 칸이 없고 안내문은 binding 의 글이다', () => {
    const page = renderTemplate(html, row, { preview: true });
    assert.deepEqual(extractPlaceholders(page.slice(page.indexOf('<ann-form>'))), []);
    assert.ok(html.includes('For each chunk, read the query'));
  });

  it('게시용 데이터: 쓰지 않은 컬럼은 그대로 남고 쓴 컬럼은 칸으로 바뀌어 Upload JSON 검사를 통과한다', () => {
    const bound = boundData(binding, check.design, check.taskType, check.tabs, reader, 'x.json');
    assert.equal(bound.rows.length, data.rows.length);
    for (const kept of ['idx', 'qid', 'key_counts', 'attention_check']) assert.equal(bound.rows[1][kept], data.rows[1][kept]);
    for (const moved of ['query', 'retrieved_chunk', 'atomic_facts']) assert.equal(moved in bound.rows[0], false);
    const result = checkData(extractPlaceholders(html), bound.columns, bound.rows);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.unusedColumns, ['idx', 'qid', 'key_counts', 'attention_check']);
  });

  it('attention 항목 번호를 알린다', () => {
    const flags = reader.cell(0, 'attention_check');
    const expected = flags.flatMap((flag, index) => (flag === '1' ? [index + 1] : []));
    assert.ok(expected.length >= 1);
    assert.deepEqual(attentionItems(binding, check.tabs, reader, 0), expected);
    assert.deepEqual(attentionItems({ ...binding, attention: undefined }, check.tabs, reader, 0), []);
  });
});

describe('값 넣기의 안전', () => {
  const unsafe = readerOf([{ list: ['<b>x</b> ${y} & "q"', 'b'], items: [['</script><i>', 'ok']] }]);
  const b = { design: 'item-list', task_type: 'text', repeat: { over: 'list' }, slots: { data: { from: 'list[i]' }, checklist: { header: 'H "1" ${z}', items: 'items[0]' } } };
  const { check, html } = build(b, unsafe);

  it('글은 HTML 로 해석되지 않고 항목은 script 를 닫지 못한다', () => {
    const row = boundRow(b, check.design, check.taskType, check.tabs, unsafe, 0);
    assert.equal(row.slot_data_1, '&lt;b&gt;x&lt;/b&gt; ${y} &amp; "q"');
    assert.equal(row.slot_checklist_1.includes('</script>'), false);
    assert.deepEqual(JSON.parse(row.slot_checklist_1), ['</script><i>', 'ok']);
  });

  it('머리글의 따옴표와 ${ 는 템플릿을 깨지 않는다', () => {
    assert.ok(html.includes('header="H &quot;1&quot; &#36;{z}"'));
    assert.deepEqual(extractPlaceholders(html).filter((name) => !name.startsWith('slot_')), []);
  });
});

describe('checkBinding 의 오류', () => {
  const flat = readerOf([{ text: 'a', list: ['x'] }, { text: 'b', list: 'not a list' }]);
  const cases = [
    ['객체가 아님', [], /must be a JSON object/],
    ['없는 가안', { design: 'nope', task_type: 'text' }, /"design" must be/],
    ['없는 종류', { design: 'stacked', task_type: 'audio' }, /"task_type" must be/],
    ['가안에 없는 칸', { design: 'stacked', task_type: 'text', slots: { data: { from: 'text' }, 'data-a': { from: 'text' } } }, /has no slot "data-a"/],
    ['데이터 칸이 빔', { design: 'stacked', task_type: 'text', slots: {} }, /Slot "data" has no data/],
    ['Tabs 인데 repeat 없음', { design: 'tabs', task_type: 'text', slots: { data: { from: 'text' } } }, /needs "repeat"/],
    ['없는 컬럼', { design: 'stacked', task_type: 'text', slots: { data: { from: 'nope' } } }, /no column "nope"/],
    ['잘못된 경로', { design: 'stacked', task_type: 'text', slots: { data: { from: 'a b' } } }, /is not a path/],
    ['repeat 없이 [i]', { design: 'stacked', task_type: 'text', slots: { data: { from: 'list[i]' } } }, /\[i\] needs "repeat"/],
    ['목록이 아닌 repeat', { design: 'stacked', task_type: 'text', repeat: { over: 'text' }, slots: { data: { from: 'text' } } }, /is not a list in 2 HIT/],
    ['행 일부만 목록', { design: 'stacked', task_type: 'text', repeat: { over: 'list' }, slots: { data: { from: 'list[i]' } } }, /is not a list in 1 HIT\(s\), starting with HIT 2/],
    ['선택지 하나', { design: 'stacked', task_type: 'text', slots: { data: { from: 'text' }, choice: { header: 'H', options: ['one'] } } }, /at least two options/],
    ['잘못된 답 이름', { design: 'stacked', task_type: 'text', slots: { data: { from: 'text' }, choice: { name: 'a b', header: 'H' } } }, /"name" must use/],
  ];
  for (const [name, b, message] of cases) {
    it(name, () => assert.match(checkBinding(b, flat).errors.join('\n'), message));
  }

  it('문항 칸이 비면 예시 문항을 쓰고 경고한다', () => {
    const check = checkBinding({ design: 'stacked', task_type: 'text', slots: { data: { from: 'text' } } }, flat);
    assert.deepEqual(check.errors, []);
    assert.equal(check.warnings.length, 2);
    assert.match(check.warnings[0], /Slot "choice" has no binding/);
  });

  it('HIT 마다 항목 수가 다르면 가장 큰 수로 만들고 경고한다', () => {
    const uneven = readerOf([{ list: ['a', 'b', 'c'] }, { list: ['a'] }]);
    const b = { design: 'stacked', task_type: 'text', repeat: { over: 'list' }, slots: { data: { from: 'list[i]' } } };
    const check = checkBinding(b, uneven);
    assert.equal(check.tabs, 3);
    assert.match(check.warnings[0], /different numbers of items \(1 to 3\)/);
    assert.equal(boundRow(b, check.design, check.taskType, check.tabs, uneven, 1).slot_data_3, '');
  });
});

describe('가안 바꾸기', () => {
  it('Chunk-Fact 데이터를 LLM 없이 모든 가안으로 옮긴다', () => {
    for (const design of ROUGH_DESIGNS) {
      const moved = adaptBinding(binding, design.id);
      const check = checkBinding(moved, reader);
      assert.deepEqual(check.errors, [], design.id);
      const html = buildBoundTemplate(moved, check.design, check.taskType, check.tabs);
      const lint = lintLayout(html);
      assert.equal(hasLayoutErrors(lint), false, `${design.id}: ${JSON.stringify(lint.problems)}`);
      const row = boundRow(moved, check.design, check.taskType, check.tabs, reader, 0);
      assert.deepEqual(checkData(extractPlaceholders(html), Object.keys(row), [row]).missingColumns, [], design.id);
    }
  });

  it('돌아오면 처음 값이 되살아난다', () => {
    const away = adaptBinding(binding, 'compare');
    assert.equal(away.slots['data-a'].from, 'query[i]');
    assert.equal(away.slots['data-b'].from, 'retrieved_chunk[i]');
    assert.ok(away.unused.checklist);
    const back = adaptBinding(away, 'item-list');
    assert.deepEqual(back.slots, binding.slots);
    assert.equal('unused' in back, false);
  });

  it('데이터가 하나뿐이면 비교 가안은 이유를 알린다', () => {
    const flat = readerOf([{ text: 'a' }]);
    const one = { design: 'stacked', task_type: 'text', slots: { data: { from: 'text' } } };
    assert.match(checkBinding(adaptBinding(one, 'compare'), flat).errors.join(), /Slot "data-b" has no data/);
  });
});

describe('첫 binding', () => {
  it('task 종류의 컬럼이 있으면 그 컬럼을 쓰고, 모든 가안과 종류의 템플릿이 만들어진다', () => {
    const flat = readerOf([{ id: '1', text: 'first passage', image_url: '/a.png', video_url: '/a.mp4' }]);
    for (const design of ROUGH_DESIGNS.filter((d) => !d.tabs)) {
      for (const type of TASK_TYPES) {
        const b = draftBinding(design.id, type.id, flat);
        const check = checkBinding(b, flat);
        assert.deepEqual(check.errors, [], `${design.id} ${type.id}`);
        const lint = lintLayout(buildBoundTemplate(b, check.design, check.taskType, check.tabs));
        assert.equal(hasLayoutErrors(lint), false);
      }
    }
    assert.equal(draftBinding('stacked', 'text', flat).slots.data.from, 'text');
    assert.equal(draftBinding('stacked', 'vision', flat).slots.data.from, 'image_url');
  });

  it('목록 컬럼이면 repeat 로 시작하고, id 같은 컬럼은 고르지 않는다', () => {
    const b = draftBinding('item-list', 'text', reader);
    assert.equal(b.repeat.over, 'retrieved_chunk');
    assert.equal(b.slots.data.from, 'retrieved_chunk[i]');
    assert.deepEqual(checkBinding(b, reader).errors, []);
    const named = draftBinding('stacked', 'text', readerOf([{ qid: 'a very long identifier that should be skipped', passage: 'short' }]));
    assert.equal(named.slots.data.from, 'passage');
  });
});

describe('영상과 이미지 칸', () => {
  it('주소는 src 를 깨지 않는다', () => {
    const urls = readerOf([{ clip: '/m/a"b.mp4' }]);
    const b = { design: 'stacked', task_type: 'video', slots: { data: { from: 'clip' } } };
    const check = checkBinding(b, urls);
    assert.ok(buildBoundTemplate(b, roughDesignById('stacked'), taskTypeById('video'), 0).includes('<ann-video label="Video" src="${slot_data}">'));
    assert.equal(boundRow(b, check.design, check.taskType, 0, urls, 0).slot_data, '/m/a%22b.mp4');
  });
});
