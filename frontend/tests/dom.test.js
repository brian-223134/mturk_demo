// dom.js 검사. escapeHtml 과 join 은 순수 함수다. el, append, clear 는 부를 때 document 와 Node 가 필요하므로
// (import 할 때는 필요 없다) 여기서는 아주 작은 가짜 document 를 넣어 속성과 자식을 어떻게 다루는지 본다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { append, clear, el, escapeHtml, join } from '../src/components/dom.js';

describe('escapeHtml', () => {
  it('& < > " \' 를 엔티티로 바꾼다', () => {
    assert.equal(escapeHtml('<a href="x">Tom & Jerry\'s</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    assert.equal(escapeHtml('&&'), '&amp;&amp;');
  });
  it('바꿀 것이 없으면 그대로이고, 문자열이 아닌 값은 String 으로 만든다', () => {
    assert.equal(escapeHtml('plain text 한글'), 'plain text 한글');
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(null), 'null');
  });
});

describe('join', () => {
  it('항목 사이에 구분자를 끼운다', () => {
    assert.deepEqual(join(['a', 'b', 'c']), ['a', ', ', 'b', ', ', 'c']);
    assert.deepEqual(join(['a', 'b'], ' | '), ['a', ' | ', 'b']);
  });
  it('항목이 하나거나 없으면 구분자가 없다', () => {
    assert.deepEqual(join(['a']), ['a']);
    assert.deepEqual(join([]), []);
  });
});

// ── el / append / clear: 가짜 DOM ──────────────────────────────────────────
// el 이 쓰는 것만 흉내 낸다: createElement, createTextNode, className, textContent, dataset, style, setAttribute,
// addEventListener, append, replaceChildren. 실제 DOM 의 동작(렌더링 등)은 브라우저에서 확인한다.

class FakeNode {}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = data;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.childNodes = [];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...nodes) {
    this.childNodes.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.childNodes = nodes;
  }
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (data) => new FakeText(data),
};

describe('el / append / clear (가짜 document)', () => {
  let saved;
  before(() => {
    saved = { document: globalThis.document, Node: globalThis.Node };
    globalThis.document = fakeDocument;
    globalThis.Node = FakeNode;
  });
  after(() => {
    globalThis.document = saved.document;
    globalThis.Node = saved.Node;
  });

  it('태그와 className, text 를 넣는다', () => {
    const node = el('span', { className: 'badge', text: 42 });
    assert.equal(node.tagName, 'SPAN');
    assert.equal(node.className, 'badge');
    assert.equal(node.textContent, '42');
  });

  it('dataset 과 style 은 객체를 합치고, value/checked/selected 는 속성이 아니라 프로퍼티다', () => {
    const node = el('input', { dataset: { id: 'b1' }, style: { width: '3em' }, value: 'x', checked: true });
    assert.deepEqual(node.dataset, { id: 'b1' });
    assert.deepEqual(node.style, { width: '3em' });
    assert.equal(node.value, 'x');
    assert.equal(node.checked, true);
    assert.deepEqual(node.attributes, {});
  });

  it('on* 함수는 소문자 이벤트 이름의 listener 가 된다', () => {
    const fn = () => {};
    const node = el('button', { onClick: fn, onKeyDown: fn });
    assert.deepEqual(node.listeners, { click: [fn], keydown: [fn] });
    assert.deepEqual(node.attributes, {});
  });

  it('true 는 빈 속성, null/undefined/false 는 건너뛰고, 나머지는 문자열 속성이다', () => {
    const node = el('a', { href: '/manage', disabled: true, hidden: false, title: null, role: undefined, tabindex: 0 });
    assert.deepEqual(node.attributes, { href: '/manage', disabled: '', tabindex: '0' });
  });

  it('문자열과 숫자 자식은 텍스트 노드가 되고, 배열은 펴고, null/undefined/false 는 건너뛴다', () => {
    const child = el('b', {}, 'bold');
    const node = el('p', {}, 'a', 1, null, [undefined, ['nested', child]], false);
    assert.deepEqual(
      node.childNodes.map((c) => (c instanceof FakeText ? c.data : c)),
      ['a', '1', 'nested', child],
    );
    assert.equal(node.childNodes[3], child);
  });

  it('attrs 가 null 이어도 된다', () => {
    assert.equal(el('div', null, 'x').childNodes.length, 1);
  });

  it('append 는 노드를 돌려주고 clear 는 자식을 비운다', () => {
    const node = el('ul');
    assert.equal(append(node, ['a', ['b']]), node);
    assert.equal(node.childNodes.length, 2);
    assert.equal(clear(node), node);
    assert.deepEqual(node.childNodes, []);
  });
});
