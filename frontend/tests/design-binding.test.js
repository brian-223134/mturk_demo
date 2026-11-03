// lib/design-binding.js: 이미 HIT 로 묶인 데이터를 rough design 의 칸에 넣는 binding. 값 읽기, 검사, 조립, 가안 바꾸기를
// example/6-rough-design 의 합성 데이터와 손으로 쓴 binding 으로 따라간다. 게시 전의 Upload JSON 검사까지 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { checkData } from '../src/lib/data-check.js';
import { adaptBinding, attentionItems, boundData, boundRow, bindingSettings, buildBoundTemplate, checkBinding, dataReader, designForRequest, draftBinding, dropLayout, layoutErrors, parseCell, parsePath, requestBinding, summarizeData } from '../src/lib/design-binding.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';
import { ROUGH_DESIGNS, SLOT_LABELS, TASK_TYPES, roughDesignById, taskTypeById } from '../src/lib/rough-designs.js';
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
    assert.equal(lint.questions[0].tag, 'ann-item-choice');
  });

  it('칸의 값은 원본 목록의 같은 번호 값이다', () => {
    const chunks = reader.cell(0, 'retrieved_chunk');
    const facts = reader.cell(0, 'atomic_facts');
    assert.equal(chunks.length, 11);
    assert.equal(row.slot_data_f2_3, chunks[2]);
    assert.deepEqual(JSON.parse(row.slot_item_choice_3), facts[2]);
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
    for (const kept of ['idx', 'qid', 'key_counts', 'chunk_fact_relevance_check', 'attention_check']) assert.equal(bound.rows[1][kept], data.rows[1][kept]);
    for (const moved of ['query', 'retrieved_chunk', 'atomic_facts']) assert.equal(moved in bound.rows[0], false);
    const result = checkData(extractPlaceholders(html), bound.columns, bound.rows);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.unusedColumns, ['idx', 'qid', 'key_counts', 'chunk_fact_relevance_check', 'attention_check', 'slot_reference', 'slot_attention']);
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
  const b = { design: 'item-list', task_type: 'text', repeat: { over: 'list' }, slots: { data: { from: 'list[i]' }, 'item-choice': { header: 'H "1" ${z}', items: 'items[0]' } } };
  const { check, html } = build(b, unsafe);

  it('글은 HTML 로 해석되지 않고 항목은 script 를 닫지 못한다', () => {
    const row = boundRow(b, check.design, check.taskType, check.tabs, unsafe, 0);
    assert.equal(row.slot_data_1, '&lt;b&gt;x&lt;/b&gt; ${y} &amp; "q"');
    assert.equal(row.slot_item_choice_1.includes('</script>'), false);
    assert.deepEqual(JSON.parse(row.slot_item_choice_1), ['</script><i>', 'ok']);
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
    assert.ok(away.unused['item-choice']);
    assert.equal('reference' in away, false, '문항 칸이 달라지면 대조 기준을 보관한다');
    assert.equal(away.unused.judged.expected, 'not_grounded');
    const back = adaptBinding(away, 'item-list');
    assert.deepEqual(back.slots, binding.slots);
    assert.deepEqual(back.reference, binding.reference);
    assert.deepEqual(back.attention, binding.attention);
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

describe('LLM 에 보내는 요약', () => {
  const summary = summarizeData(reader);
  const byName = Object.fromEntries(summary.columns.map((c) => [c.name, c]));

  it('구조와 잘린 표본만 담고 파일 전체보다 훨씬 작다', () => {
    assert.equal(summary.hit_count, 3);
    assert.deepEqual(summary.columns.map((c) => c.name), data.columns);
    assert.equal(byName.retrieved_chunk.shape, 'list[11] of str');
    assert.match(byName.atomic_facts.shape, /^list\[11\] of list\[str\]/);
    assert.equal(byName.retrieved_chunk.samples.length, 2);
    assert.equal(byName.retrieved_chunk.samples[0].length, 4, '목록은 앞의 3개와 남은 수');
    assert.ok(JSON.stringify(summary).length < JSON.stringify(data.rows).length / 3);
  });

  it('긴 글은 자르고 원래 길이를 알린다', () => {
    const long = 'x'.repeat(1000);
    const [column] = summarizeData(readerOf([{ text: long }])).columns;
    assert.equal(column.shape, 'str');
    assert.ok(column.samples[0].endsWith('… (1000 characters)'));
    assert.ok(column.samples[0].length < 320);
  });

  it('가안 정의에서 칸 목록만 보낸다', () => {
    const tabs = designForRequest(roughDesignById('tabs'));
    assert.deepEqual(tabs.rows, [{ slots: ['data'] }, { slots: ['choice'] }]);
    assert.equal(tabs.one_tab_per_item, true);
    assert.equal('tabs' in tabs, false, '가안의 예시 탭 수는 보내지 않는다');
    assert.equal('one_tab_per_item' in designForRequest(roughDesignById('stacked')), false);
  });
});

describe('requestBinding', () => {
  const check = (b) => checkBinding(b, reader);
  const good = binding;
  const bad = { ...binding, slots: { ...binding.slots, data: { from: 'no_such_column' } } };
  const fake = (replies) => {
    const seen = [];
    return { seen, send: async (body) => { seen.push(body); return { binding: replies[seen.length - 1], usage: { prompt_tokens: 10, cost: 0.001, note: 'x' }, model: { model: 'm', provider_tag: 'p/fp8' } }; } };
  };

  it('첫 답이 맞으면 한 번만 묻는다', async () => {
    const { send, seen } = fake([good]);
    const result = await requestBinding({ send, check, request: { prompt: 'p' } });
    assert.equal(seen.length, 1);
    assert.equal('errors' in seen[0], false);
    assert.deepEqual(result.errors, []);
    assert.equal(result.attempts, 1);
    assert.equal(result.model.provider_tag, 'p/fp8');
  });

  it('검사에 걸리면 오류와 이전 답을 보내 다시 묻고 사용량을 더한다', async () => {
    const { send, seen } = fake([bad, good]);
    const result = await requestBinding({ send, check, request: { prompt: 'p' } });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1].previous, bad);
    assert.match(seen[1].errors[0], /no column "no_such_column"/);
    assert.equal(seen[1].prompt, 'p');
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(result.usage.prompt_tokens, 20);
    assert.equal(result.usage.note, undefined);
  });

  it('끝까지 틀리면 마지막 답과 오류를 돌려주고 횟수를 넘지 않는다', async () => {
    const { send, seen } = fake([bad, bad, bad, good]);
    const result = await requestBinding({ send, check, request: {} });
    assert.equal(seen.length, 3);
    assert.deepEqual(result.binding, bad);
    assert.equal(result.errors.length, 1);
    assert.equal(result.attempts, 3);
  });

  it('호출 실패는 그대로 던진다', async () => {
    await assert.rejects(requestBinding({ send: async () => { throw new Error('boom'); }, check, request: {} }), /boom/);
  });
});

describe('LLM 설명서 (agent/binding_reference.md)', () => {
  const reference = readFileSync(new URL('../../agent/binding_reference.md', import.meta.url), 'utf8');

  it('예시 binding 은 검사를 통과하는 example/6-rough-design 의 binding 과 같다', () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(reference)[1];
    assert.deepEqual(JSON.parse(block), binding);
  });

  it('검사가 아는 칸을 모두 설명한다', () => {
    for (const slot of ['data', 'data-a', 'data-b', 'choice', 'compare', 'item-choice', 'free-text', 'context', 'reference', 'kind']) assert.ok(reference.includes(`\`${slot}\``), slot);
  });
});

describe('binding 의 layout', () => {
  const layout = (...rows) => ({ rows });
  const at = (html, text) => {
    const index = html.indexOf(text);
    assert.ok(index >= 0, text);
    return index;
  };

  it('문항을 왼쪽으로: 값과 대조 기준은 그대로이고 배치와 폭만 바뀐다', () => {
    const moved = { ...binding, layout: layout({ columns: '2fr 3fr', slots: ['item-choice', 'data'] }) };
    const { check, html } = build(moved, reader);
    assert.equal(check.design.id, 'item-list');
    assert.equal(check.design.customLayout, true);
    assert.ok(at(html, '<ann-columns columns="2fr 3fr">') < at(html, '<ann-item-choice'));
    assert.ok(at(html, '<ann-item-choice') < at(html, '<ann-text'));
    assert.equal(hasLayoutErrors(lintLayout(html)), false);
    const before = boundRow(binding, checkBinding(binding, reader).design, check.taskType, check.tabs, reader, 1);
    assert.deepEqual(boundRow(moved, check.design, check.taskType, check.tabs, reader, 1), before);
  });

  it('한 열에 칸을 쌓고, 탭마다 배치를 되풀이한다', () => {
    const stacked = { ...binding, layout: layout({ columns: '3fr 2fr', slots: ['data', ['item-choice', 'free-text']] }), slots: { ...binding.slots, 'free-text': { name: 'comment', header: 'Any comment?' } } };
    const { check, html } = build(stacked, reader);
    const firstTab = html.slice(0, html.indexOf('</ann-tab>'));
    assert.ok(firstTab.indexOf('<ann-item-choice') < firstTab.indexOf('<ann-textarea'));
    assert.equal(firstTab.match(/<ann-column>/g).length, 2);
    assert.equal(html.match(/<ann-textarea name="comment_/g).length, check.tabs);
    assert.equal(hasLayoutErrors(lintLayout(html)), false);
  });

  it('위아래로 놓으면 열 없이 줄만 생긴다', () => {
    const { html } = build({ ...binding, layout: layout({ slots: ['data'] }, { slots: ['item-choice'] }) }, reader);
    assert.equal(html.includes('<ann-columns'), false);
    assert.ok(at(html, '<ann-text') < at(html, '<ann-item-choice'));
  });

  it('폭을 안 적으면 같은 폭이고 속성을 쓰지 않는다', () => {
    const { html } = build({ ...binding, layout: layout({ slots: ['data', 'item-choice'] }) }, reader);
    assert.ok(html.includes('<ann-columns>'));
    assert.equal(html.includes('undefined'), false);
  });

  it('틀린 배치를 고칠 수 있는 말로 알린다', () => {
    const cases = [
      ['x', /"layout" must be an object/],
      [{ rows: [] }, /"layout" must be an object/],
      [layout(...Array.from({ length: 7 }, () => ({ slots: ['data'] }))), /at most 6 rows/],
      [layout({ slots: 'data' }), /must have a list of "slots"/],
      [layout({ slots: ['data', 'item-choice', 'free-text', 'choice'] }), /at most 3/],
      [layout({ slots: ['data', []] }), /empty column/],
      [layout({ slots: ['data', 'chart'] }), /"chart" is not a slot/],
      [layout({ slots: ['data', 'data', 'item-choice'] }), /placed twice/],
      [layout({ slots: ['data', 'item-choice'], columns: '1fr' }), /one width per column/],
      [layout({ slots: ['data', 'data-a', 'item-choice'] }), /must be placed together/],
      [layout({ slots: ['data', 'compare'] }), /place them too/],
      [layout({ slots: ['item-choice'] }), /at least one data slot/],
      [layout({ slots: ['data'] }), /at least one answer slot/],
    ];
    for (const [value, message] of cases) assert.match(checkBinding({ ...binding, layout: value }, reader).errors.join(' '), message, JSON.stringify(value));
  });

  it('폭은 템플릿의 속성으로 들어가므로 fr 숫자 말고는 받지 않는다', () => {
    for (const columns of ['1fr" onload="alert(1)', '1fr 1fr;color:red', '100px 1fr', '0fr 1fr', '1fr  1fr', 3]) {
      assert.match(checkBinding({ ...binding, layout: layout({ slots: ['data', 'item-choice'], columns }) }, reader).errors.join(' '), /one width per column/, String(columns));
    }
  });

  it('배치에 없는 칸의 값이 남으면 오류이고, 새 문항 칸은 비면 예시를 쓰며 경고한다', () => {
    const removed = checkBinding({ ...binding, layout: layout({ slots: ['data'] }, { slots: ['free-text'] }) }, reader);
    assert.match(removed.errors.join(' '), /no slot "item-choice"/);
    const added = checkBinding({ ...binding, layout: layout({ slots: ['data', 'item-choice'] }, { slots: ['free-text'] }) }, reader);
    assert.deepEqual(added.errors, []);
    assert.match(added.warnings.join(' '), /Slot "free-text" has no binding/);
  });

  it('고른 문항 칸이 사라지면 대조 기준이 가리킬 곳이 없어 오류로 알린다', () => {
    const { reference, attention, ...rest } = binding;
    const slots = { data: binding.slots.data, 'free-text': { name: 'comment', header: 'Why?' } };
    const check = checkBinding({ ...rest, reference, slots, layout: layout({ slots: ['data', 'free-text'] }) }, reader);
    assert.match(check.errors.join(' '), /"reference" needs a question/);
  });

  it('task 종류를 바꿔도, 같은 가안으로 다시 들어와도 배치는 유지된다', () => {
    const moved = { ...binding, layout: layout({ slots: ['item-choice', 'data'] }) };
    assert.deepEqual(adaptBinding(moved, 'item-list').layout, moved.layout);
    assert.deepEqual(adaptBinding(moved, 'item-list').slots, moved.slots);
  });

  it('다른 가안으로 가면 배치를 보관했다가 돌아오면 되살린다', () => {
    const moved = { ...binding, layout: layout({ slots: ['item-choice', 'data'] }), slots: { ...binding.slots } };
    const away = adaptBinding(moved, 'stacked');
    assert.equal(away.layout, undefined);
    assert.deepEqual(checkBinding(away, reader).errors, []);
    assert.deepEqual(away.unused.layout, { design: 'item-list', layout: moved.layout });
    const further = adaptBinding(away, 'side-by-side');
    assert.deepEqual(further.unused.layout, away.unused.layout);
    const back = adaptBinding(further, 'item-list');
    assert.deepEqual(back.layout, moved.layout);
    assert.deepEqual(back.reference, binding.reference);
    assert.equal(back.unused, undefined);
    assert.deepEqual(checkBinding(back, reader).errors, []);
  });

  it('가안의 배치로 돌아가면 가안에 없는 칸의 값은 보관한다', () => {
    const custom = { ...binding, layout: layout({ slots: ['data', 'item-choice'] }, { slots: ['free-text'] }), slots: { ...binding.slots, 'free-text': { name: 'comment', header: 'Why?' } } };
    const dropped = dropLayout(custom);
    assert.equal('layout' in dropped, false);
    assert.equal(dropped.slots['free-text'], undefined);
    assert.equal(dropped.unused['free-text'].name, 'comment');
    assert.deepEqual(checkBinding(dropped, reader).errors, []);
    assert.deepEqual(dropped.slots['item-choice'], binding.slots['item-choice']);
  });

  it('틀린 배치가 들어 있어도 가안 바꾸기는 예외를 내지 않는다', () => {
    const broken = { ...binding, layout: { rows: 'nope' } };
    assert.equal(adaptBinding(broken, 'stacked').layout, undefined);
    assert.ok(adaptBinding(broken, 'item-list').slots);
  });

  it('LLM 에 가안의 폭도 함께 보낸다', () => {
    assert.deepEqual(designForRequest(roughDesignById('item-list')).rows, [{ columns: '3fr 2fr', slots: ['data', 'item-choice'] }]);
  });
});

describe('LLM 설명서의 배치 요소', () => {
  const reference = readFileSync(new URL('../../agent/binding_reference.md', import.meta.url), 'utf8');
  const section = reference.slice(reference.indexOf('## Laying out the page'), reference.indexOf('## Revising a binding'));

  it('코드가 아는 칸을 표에 모두 적고, 없는 칸은 적지 않는다', () => {
    const boxes = section.slice(section.indexOf('| box |'), section.indexOf('### The `layout` key'));
    const listed = boxes.split('\n').filter((line) => line.startsWith('| `')).flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z-]+)`/g)].map((match) => match[1]));
    assert.deepEqual(listed.sort(), Object.keys(SLOT_LABELS).sort());
  });

  it('예시 배치는 모두 검사를 통과한다', () => {
    const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
    assert.equal(blocks.length, 3);
    for (const layout of blocks) assert.deepEqual(layoutErrors(layout), []);
  });

  it('검사의 한도를 그대로 적는다', () => {
    assert.match(section, /at most 6/);
    assert.match(section, /at most 3 columns/);
    assert.deepEqual(layoutErrors({ rows: ['data', 'data-a', 'data-b', 'choice', 'compare', 'free-text'].map((slot) => ({ slots: [slot] })) }), []);
    assert.deepEqual(layoutErrors({ rows: [{ columns: '1fr 99fr 2fr', slots: ['data', 'choice', 'free-text'] }] }), []);
  });

  it('배치 요청은 할 수 없는 요청이 아니다', () => {
    const cannot = reference.slice(reference.indexOf('## What you cannot do'));
    assert.match(cannot, /Moving, resizing, adding and removing boxes is yours/);
    assert.doesNotMatch(cannot.slice(cannot.indexOf('{"cannot": "layout"')).split('\n')[0], /moves|resizes|adds/);
  });
});

describe('대조 기준과 attention', () => {
  const rowsOf = (b, r = reader) => {
    const check = checkBinding(b, r);
    assert.deepEqual(check.errors, []);
    return { check, data: boundData(b, check.design, check.taskType, check.tabs, r, 'x.json') };
  };

  it('selected: 고른 항목은 yes, 없는 항목은 no 이고 attention 항목은 뺀다', () => {
    const { data: bound } = rowsOf(binding);
    const labels = reader.cell(1, 'chunk_fact_relevance_check');
    const facts = reader.cell(1, 'atomic_facts');
    const flags = reader.cell(1, 'attention_check');
    const reference = JSON.parse(bound.rows[1].slot_reference);
    const attention = JSON.parse(bound.rows[1].slot_attention);
    const expected = {};
    const expectedAttention = {};
    facts.forEach((list, tab) => list.forEach((_, item) => {
      const name = `supported_${tab + 1}_${item + 1}`;
      if (flags[tab] === '1') expectedAttention[name] = 'not_grounded';
      else expected[name] = (labels[`Chunk ${tab}`] ?? []).includes(`Atomic fact${item + 1}`) ? 'grounded' : 'not_grounded';
    }));
    assert.deepEqual(reference, expected);
    assert.deepEqual(attention, expectedAttention);
    assert.ok(Object.values(reference).includes('grounded'));
  });

  it('map: 키의 {i}, {n} 을 채워 라벨을 읽는다', () => {
    const r = readerOf([{ q: ['a', 'b'], facts: [['x', 'y'], ['z']], coverage: { general_0_1: 'Covered', general_0_2: 'Not covered', general_1_1: 'Covered' } }]);
    const b = { design: 'item-list', task_type: 'text', repeat: { over: 'q' }, slots: { data: { from: 'q[i]' }, 'item-choice': { name: 'general', header: 'H', items: 'facts[i]', options: ['Covered', 'Not covered'] } }, reference: { map: 'coverage', key: 'general_{i}_{n}' } };
    assert.deepEqual(JSON.parse(rowsOf(b, r).data.rows[0].slot_reference), { general_1_1: 'Covered', general_1_2: 'Not covered', general_2_1: 'Covered' });
  });

  it('value: 칸마다 라벨이 있는 경우와 항목 목록인 경우', () => {
    const r = readerOf([{ text: ['a', 'b'], gold: ['yes', 'no'] }]);
    const b = { design: 'tabs', task_type: 'text', repeat: { over: 'text' }, slots: { data: { from: 'text[i]' }, choice: { name: 'answer', header: 'H', options: ['yes', 'no'] } }, reference: { value: 'gold[i]' } };
    assert.deepEqual(JSON.parse(rowsOf(b, r).data.rows[0].slot_reference), { answer_1: 'yes', answer_2: 'no' });
    const items = readerOf([{ passage: 'p', facts: ['x', 'y'], gold: ['yes', 'no'] }]);
    const flat = { design: 'item-list', task_type: 'text', slots: { data: { from: 'passage' }, 'item-choice': { name: 's', header: 'H', items: 'facts', options: ['yes', 'no'] } }, reference: { value: 'gold' } };
    assert.deepEqual(JSON.parse(rowsOf(flat, items).data.rows[0].slot_reference), { s_1: 'yes', s_2: 'no' });
  });

  it('없는 라벨 값과 선택지 밖의 값은 오류, 일부만 있으면 경고다', () => {
    const r = readerOf([{ text: ['a', 'b'], gold: ['yes', 'maybe'] }]);
    const b = { design: 'tabs', task_type: 'text', repeat: { over: 'text' }, slots: { data: { from: 'text[i]' }, choice: { header: 'H', options: ['yes', 'no'] } }, reference: { value: 'gold[i]' } };
    assert.match(checkBinding(b, r).errors.join(), /label\(s\) "maybe" are not options/);
    assert.match(checkBinding({ ...b, reference: { value: 'text[9]' } }, r).errors.join(), /no labels were found/);
    assert.match(checkBinding({ ...b, reference: { value: 'nope' } }, r).errors.join(), /is not a path to a column/);
    assert.match(checkBinding({ ...b, reference: { value: 'gold[i]', map: 'gold' } }, r).errors.join(), /exactly one/);
    const some = readerOf([{ text: ['a', 'b'], gold: ['yes'] }]);
    assert.match(checkBinding(b, some).warnings.join(), /cover 1 of 2 answers/);
  });

  it('attention.expected 는 선택지 안에 있어야 한다', () => {
    assert.match(checkBinding({ ...binding, attention: { flag: 'attention_check[i]', expected: 'nope' } }, reader).errors.join(), /is not one of the options/);
    assert.match(checkBinding({ ...binding, attention: { expected: 'grounded' } }, reader).errors.join(), /needs attention.flag/);
  });

  it('게시 설정으로 잇는다', () => {
    assert.deepEqual(bindingSettings(binding), { referenceColumn: 'slot_reference', attentionEnabled: true, attentionMode: 'column', attentionColumn: 'slot_attention', attentionMinRatio: 1 });
    assert.deepEqual(bindingSettings({ attention: { flag: 'x' } }), {});
  });
});

describe('데이터 칸의 종류와 context', () => {
  const images = readerOf([{ photo: 'https://x.test/a.jpg', caption: 'A dog on a beach', question: 'Q <1>' }]);

  it('이미지 칸에 글이 들어가면 고치라고 알리고, kind 가 text 면 글로 보인다', () => {
    const wrong = { design: 'stacked', task_type: 'vision', slots: { data: [{ from: 'photo' }, { from: 'caption' }] } };
    assert.match(checkBinding(wrong, images).errors.join(), /"caption" does not look like a URL/);
    const right = { design: 'stacked', task_type: 'vision', slots: { data: [{ from: 'photo' }, { label: 'Caption', from: 'caption', kind: 'text' }] } };
    const { check, html } = build(right, images);
    assert.ok(html.includes('<ann-image label="Image" src="${slot_data_f1}">'));
    assert.ok(html.includes('<ann-text label="Caption">${slot_data_f2}</ann-text>'));
    assert.equal(boundRow(right, check.design, check.taskType, 0, images, 0).slot_data_f2, 'A dog on a beach');
    assert.match(checkBinding({ ...right, slots: { data: { from: 'photo', kind: 'audio' } } }, images).errors.join(), /"kind" must be/);
  });

  it('context 는 칸들 위에 글로 보이고 컬럼이 따로 생긴다', () => {
    const pair = readerOf([{ question: 'Q <1>', a: 'first', b: 'second' }]);
    const b = { design: 'compare', task_type: 'text', context: { label: 'Question', from: 'question' }, slots: { 'data-a': { from: 'a' }, 'data-b': { from: 'b' }, compare: { header: 'H' } } };
    const { check, html } = build(b, pair);
    assert.ok(html.indexOf('slot_context') < html.indexOf('slot_data_a'));
    const row = boundRow(b, check.design, check.taskType, 0, pair, 0);
    assert.equal(row.slot_context, 'Q &lt;1&gt;');
    assert.equal('question' in row, false);
    assert.match(checkBinding({ ...b, context: { from: 'nope' } }, pair).errors.join(), /context\[0\]\.from: the data has no column/);
  });
});

describe('worker 에게 보일 글은 영어', () => {
  const flat = readerOf([{ text: '한글 데이터' }]);
  const base = { design: 'stacked', task_type: 'text', slots: { data: { label: 'Text', from: 'text' } } };

  it('직접 쓴 글의 한글, 한자, 가나는 오류이고 어디인지 알린다', () => {
    const cases = [
      [{ ...base, instructions: '읽으세요' }, /^instructions:/],
      [{ ...base, slots: { data: { label: '리뷰', from: 'text' } } }, /^slots\.data\[0\]\.label:/],
      [{ ...base, slots: { ...base.slots, choice: { header: '감정은?', options: ['a', 'b'] } } }, /^slots\.choice\.header:/],
      [{ ...base, slots: { ...base.slots, choice: { header: 'H', options: [['a', '예'], ['b', 'No']] } } }, /^slots\.choice\.options\[0\]:/],
      [{ ...base, slots: { ...base.slots, 'free-text': { header: 'H', placeholder: '理由' } } }, /^slots\.free-text\.placeholder:/],
      [{ ...base, repeat: { over: 'text', label: 'テスト' } }, /repeat\.label:|repeat\.over/],
      [{ ...base, context: { label: '질문', from: 'text' } }, /^context\[0\]\.label:/],
    ];
    for (const [binding_, pattern] of cases) assert.ok(checkBinding(binding_, flat).errors.some((e) => pattern.test(e)), String(pattern));
  });

  it('데이터의 값은 보지 않는다', () => {
    assert.deepEqual(checkBinding({ ...base, instructions: 'Read the text.' }, flat).errors, []);
  });
});

describe('requestBinding 의 수정 요청', () => {
  const check = (b) => checkBinding(b, reader);
  const reply = (body) => ({ usage: { cost: 0.001 }, model: { model: 'm' }, ...body });

  it('할 수 없다는 답은 다시 묻지 않고 binding 없이 돌려준다', async () => {
    const seen = [];
    const result = await requestBinding({ send: async (body) => { seen.push(body); return reply({ binding: null, cannot: 'layout', message: 'Use the buttons.' }); }, check, request: { prompt: 'Move it', current: binding } });
    assert.equal(seen.length, 1);
    assert.equal(result.binding, null);
    assert.equal(result.cannot, 'layout');
    assert.equal(result.message, 'Use the buttons.');
    assert.deepEqual(result.errors, []);
  });

  it('재요청에도 고칠 binding 과 요청이 함께 가고 마지막 설명을 돌려준다', async () => {
    const bad = { ...binding, slots: { ...binding.slots, data: { from: 'no_such_column' } } };
    const replies = [reply({ binding: bad, message: 'first' }), reply({ binding, message: 'second' })];
    const seen = [];
    const result = await requestBinding({ send: async (body) => { seen.push(body); return replies[seen.length - 1]; }, check, request: { prompt: 'p', current: binding } });
    assert.deepEqual(seen[1].current, binding);
    assert.deepEqual(seen[1].previous, bad);
    assert.equal(result.message, 'second');
    assert.equal(result.cannot, null);
  });

  it('선택지가 목록이 아닌 답도 예외 없이 오류로 알린다', () => {
    const odd = { ...binding, slots: { ...binding.slots, 'item-choice': { ...binding.slots['item-choice'], options: 'yes or no' } } };
    assert.ok(check(odd).errors.some((error) => /at least two options/.test(error)));
  });
});
