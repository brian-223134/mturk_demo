// lib/template.js: placeholder 추출과 렌더. 기대값은 prototype/src/domain/template.test.ts 와 template.ts 의 규약에서 왔다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PREVIEW_MESSAGE_SOURCE, extractPlaceholders, jsonForScript, renderTemplate } from '../src/lib/template.js';

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
