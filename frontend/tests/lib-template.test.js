// lib/template.js: placeholder 추출과 렌더. 기대값은 prototype/src/domain/template.test.ts 와 template.ts 의 규약에서 왔다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PREVIEW_MESSAGE_SOURCE, declaredAnswerSchema, extractPlaceholders, jsonForScript, renderTemplate } from '../src/lib/template.js';

describe('extractPlaceholders', () => {
  it('처음 나온 순서대로, 중복 없이 뽑는다', () => {
    const html = `
      <script>
        var idx = \${idx};
        var query = \${query};
        var again = \${idx};
      </script>`;
    assert.deepEqual(extractPlaceholders(html), ['idx', 'query']);
  });

  it('식별자 형태가 아닌 ${...} 는 placeholder 가 아니다 (JS 템플릿 리터럴의 표현식)', () => {
    const html = 'const s = `Tab ${i + 1} of ${tabs.length}`; var q = ${query}; ${my-column} ${column name} ${1st}';
    assert.deepEqual(extractPlaceholders(html), ['query']);
  });

  it('placeholder 가 없으면 빈 배열', () => {
    assert.deepEqual(extractPlaceholders('<p>window.TASK_DATA 를 쓰는 템플릿</p>'), []);
  });
});

describe('jsonForScript', () => {
  it('</script> 와 <!-- 가 데이터에 있어도 문서를 깨지 않는다', () => {
    const text = jsonForScript({ a: '</script><!--' });
    assert.ok(!text.includes('<'));
    assert.deepEqual(JSON.parse(text), { a: '</script><!--' });
  });

  it('U+2028, U+2029 는 \\u 로 쓴다', () => {
    const text = jsonForScript(String.fromCharCode(0x2028) + String.fromCharCode(0x2029));
    assert.equal(text, '"\\u2028\\u2029"');
  });
});

describe('renderTemplate', () => {
  const row = { passage: 'A <b>bold</b> passage', idx: '7' };

  it('${컬럼명} 을 셀 문자열로 escape 없이 바꾸고, 행에 없는 이름은 그대로 둔다', () => {
    const out = renderTemplate('<html><head></head><body>${passage} ${idx} ${missing}</body></html>', row);
    assert.ok(out.includes('<body>A <b>bold</b> passage 7 ${missing}</body>'));
  });

  it('window.TASK_DATA 를 <head> 맨 앞의 script 로 주입한다', () => {
    const out = renderTemplate('<html><head><title>t</title></head><body></body></html>', row);
    assert.ok(out.startsWith('<html><head><script>window.TASK_DATA = {"passage":"A \\u003cb>bold\\u003c/b> passage","idx":"7"};</script><title>t</title>'));
  });

  it('<head> 가 없는 조각이면 문서 맨 앞에 둔다', () => {
    const out = renderTemplate('<p>${idx}</p>', row);
    assert.ok(out.startsWith('<script>window.TASK_DATA = '));
    assert.ok(out.endsWith('<p>7</p>'));
  });

  it('셀의 "$&" 나 "$1" 은 치환 패턴으로 해석되지 않는다', () => {
    const out = renderTemplate('<p>${passage}</p>', { passage: 'cost $& and $1' });
    assert.ok(out.endsWith('<p>cost $& and $1</p>'));
  });

  it('preview 옵션이 있으면 제출 가로채기 스크립트를 함께 넣고, 없으면 넣지 않는다', () => {
    const plain = renderTemplate('<html><head></head></html>', row);
    const preview = renderTemplate('<html><head></head></html>', row, { preview: true });
    assert.ok(!plain.includes(PREVIEW_MESSAGE_SOURCE));
    assert.ok(preview.includes(PREVIEW_MESSAGE_SOURCE));
    assert.ok(preview.includes("window.addEventListener('submit'"));
    assert.ok(preview.includes('MutationObserver'));
    assert.equal(PREVIEW_MESSAGE_SOURCE, 'mturk-console-preview');
  });
});

describe('declaredAnswerSchema (window.TASK_ANSWER_SCHEMA)', () => {
  it('배열이 아니면 null 이라 미리보기는 화면의 라디오, 체크박스, select 를 훑는다', () => {
    for (const value of [undefined, null, {}, 'x', { length: 1 }]) assert.equal(declaredAnswerSchema(value), null);
    assert.deepEqual(declaredAnswerSchema([]), []);
  });

  it('agent 템플릿의 목록을 name, values, type, required 로 옮긴다 (DOM 순서 그대로)', () => {
    const declared = [
      { name: 'general_0_1_support', type: 'multi_select', values: ['supported', 'not_supported'], required: true },
      { name: 'general_0_covered', type: 'choice', values: ['Yes', 'No'], required: true },
      { name: 'general_0_missing_info', type: 'text', values: [], required: false },
      { name: 'general_0_quality', type: 'likert', values: [1, 2, 3, 4, 5], required: true },
    ];
    assert.deepEqual(declaredAnswerSchema(declared), [
      { name: 'general_0_1_support', values: ['supported', 'not_supported'], type: 'multi_select', required: true },
      { name: 'general_0_covered', values: ['Yes', 'No'], type: 'choice', required: true },
      { name: 'general_0_missing_info', values: [], type: 'text', required: false },
      { name: 'general_0_quality', values: ['1', '2', '3', '4', '5'], type: 'likert', required: true },
    ]);
  });

  it('이름이 없거나 겹치는 항목은 빼고, 모르는 값과 키는 버린다', () => {
    const declared = [null, { values: ['a'] }, { name: '' }, { name: 'q', values: ['a', 'a', null, { x: 1 }], type: 3, required: 'yes', extra: 1 }, { name: 'q', values: ['b'] }];
    assert.deepEqual(declaredAnswerSchema(declared), [{ name: 'q', values: ['a'] }]);
  });

  it('미리보기 스크립트가 같은 함수를 넣어 TASK_ANSWER_SCHEMA 를 먼저 본다', () => {
    const preview = renderTemplate('<html><head></head></html>', {}, { preview: true });
    assert.ok(preview.includes(declaredAnswerSchema.toString()));
    assert.ok(preview.includes('declaredAnswerSchema(window.TASK_ANSWER_SCHEMA)'));
    const script = preview.slice(preview.indexOf('(function () {'), preview.lastIndexOf('})();') + 5);
    assert.doesNotThrow(() => new Function(script.replace('(function () {', '(function () { return;'))); // 문법이 깨지지 않았다
  });
});
