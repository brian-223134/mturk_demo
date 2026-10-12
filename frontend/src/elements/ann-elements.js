/*
 * Annotation elements: 템플릿을 짧은 HTML 로 쓰게 하는 자체 요소 모음. MTurk 의 crowd-html-elements(<crowd-form>,
 * <crowd-classifier> …) 자리를 맡는다. 템플릿은 맨 위에 이 파일 하나를 불러오고 <ann-*> 요소만 쓴다.
 *
 *   <script src="/elements/ann-elements.js"></script>
 *   <ann-form>
 *     <ann-instructions>…</ann-instructions>
 *     <ann-text label="Passage">${passage}</ann-text>
 *     <ann-choice name="relevance" header="Is the passage relevant?" required>
 *       <ann-option value="relevant">Relevant</ann-option>
 *       <ann-option value="not_relevant">Not relevant</ann-option>
 *     </ann-choice>
 *   </ann-form>
 *
 * 요소 (속성과 예시는 docs/annotation-elements.md)
 *   ann-form          제출 폼. 맨 아래에 진행 상황과 Submit 을 붙이고, 필수 문항을 검사한 뒤 답을 모아 제출한다
 *   ann-instructions  접을 수 있는 안내 패널
 *   ann-text          라벨이 붙은 본문 카드 (CSV 값을 보여 준다)
 *   ann-choice        하나 고르기 (라디오). 선택지는 <ann-option> 또는 options="a, b"
 *   ann-likert        min~max 점수 하나 고르기
 *   ann-checklist     항목마다 해당 여부 체크 (+ "해당 없음"). 항목은 <ann-item> 또는 JSON 배열 <script type="application/json">
 *   ann-textarea      자유 서술
 *   ann-tabs/ann-tab  한 HIT 에 항목이 여러 개일 때 탭으로 나눈다. 탭 제목에 남은 필수 문항 수가 보인다
 *
 * 콘솔과의 계약 (agent/render.py 의 템플릿과 같다)
 *   - 제출: 숨은 input_answers 에 [{name, value}] JSON 배열을 넣고 form.submit() 을 부른다. 값은 모두 문자열이다.
 *     ann-choice, ann-likert 는 고른 값, ann-textarea 는 앞뒤 공백을 뺀 글(비어 있으면 뺀다),
 *     ann-checklist 는 칸이 하나라도 체크되면 항목마다 `<name>_<key>` 이름으로 checked-value 또는 unchecked-value 를 낸다.
 *   - window.TASK_ANSWER_SCHEMA: 답 칸 목록 [{name, type, values, required}] (화면 순서). type 은 choice | likert |
 *     multi_select | text. 콘솔 미리보기가 이것으로 문항을 알고, 게시할 때 batch 의 answerSchema 로 저장된다.
 *   - 제출 전에는 ann-form 에 취소할 수 있는 `ann-submit` 이벤트(detail.answers)를 낸다.
 *
 * 문서가 다 읽힌 뒤(DOMContentLoaded) 요소를 정의한다. 정의할 때 자식이 이미 있어야 그릴 수 있기 때문이다.
 * shadow DOM 을 쓰지 않으므로 템플릿의 <style> 로 모양을 바꿀 수 있다 (클래스 이름은 ann- 로 시작한다).
 * Node 에서는 DOM 없이 core 함수만 테스트한다 (frontend/tests/elements.test.js).
 */
(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') api.boot(window, document);
})(function () {
  'use strict';

  var VERSION = '1';
  var TYPES = { choice: 'choice', likert: 'likert', checklist: 'multi_select', textarea: 'text' };

  // ── core: DOM 없이 쓰는 함수 ────────────────────────────────────────────────

  /** "a, b ,c" → ['a', 'b', 'c']. 빈 값은 뺀다. */
  function splitList(text) {
    return String(text == null ? '' : text)
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
  }

  /**
   * ann-checklist 의 항목 글을 읽는다. JSON 배열이면 원소마다 항목 하나 (문자열, 숫자, 또는 {text|label, key|id} 객체),
   * JSON 이 아니면 비어 있지 않은 줄마다 항목 하나. → [{ key, text }] (key 는 없으면 null).
   */
  function parseItems(text) {
    var source = String(text == null ? '' : text).trim();
    if (source === '') return [];
    var parsed;
    try {
      parsed = JSON.parse(source);
    } catch (e) {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      return parsed.map(function (item) {
        if (item !== null && typeof item === 'object') {
          var label = item.text != null ? item.text : item.label;
          var key = item.key != null ? item.key : item.id;
          return { key: key == null ? null : String(key), text: label == null ? JSON.stringify(item) : String(label) };
        }
        return { key: null, text: item == null ? '' : String(item) };
      });
    }
    return source
      .split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line !== ''; })
      .map(function (line) { return { key: null, text: line }; });
  }

  /** 항목의 key 를 정한다. 따로 준 key 가 없으면 1부터 센 순번이다. */
  function itemKeys(items) {
    return items.map(function (item, index) { return item.key != null && item.key !== '' ? String(item.key) : String(index + 1); });
  }

  function itemName(name, key) {
    return name + '_' + key;
  }

  /** 문항 하나의 답 칸들 (TASK_ANSWER_SCHEMA 의 항목). model 은 요소의 annModel() 이다. */
  function fieldsOf(model) {
    if (model.kind === 'checklist') {
      return model.keys.map(function (key) {
        return { name: itemName(model.name, key), type: TYPES.checklist, values: [model.checkedValue, model.uncheckedValue], required: model.required };
      });
    }
    return [{ name: model.name, type: TYPES[model.kind], values: model.kind === 'textarea' ? [] : model.values.slice(), required: model.required }];
  }

  function schemaOf(models) {
    var out = [];
    models.forEach(function (model) { out = out.concat(fieldsOf(model)); });
    return out;
  }

  function isAnswered(model, value) {
    if (model.kind === 'checklist') return model.keys.length === 0 || Boolean(value && (value.none || value.checked.length > 0));
    if (model.kind === 'textarea') return typeof value === 'string' && value.length >= Math.max(1, model.minLength || 0);
    return value !== null && value !== undefined && value !== '';
  }

  /** 제출을 막는 문제 문구. 없으면 null. 필수가 아니어도 minlength 보다 짧게 쓴 글은 막는다. */
  function problemOf(model, value) {
    if (model.kind === 'textarea' && model.minLength > 0 && typeof value === 'string' && value.length > 0 && value.length < model.minLength) {
      return 'Write at least ' + model.minLength + ' characters (' + value.length + ' so far).';
    }
    if (!model.required || isAnswered(model, value)) return null;
    if (model.kind === 'checklist') return 'Check every item that applies, or the last box if none apply.';
    if (model.kind === 'textarea') return model.minLength > 0 ? 'Write at least ' + model.minLength + ' characters.' : 'Write an answer.';
    return 'Choose an answer.';
  }

  /**
   * entries: [{ model, value }] (화면 순서). → { answers: [{name, value}], problems: [{ index, message }] }.
   * value 는 choice/likert 면 고른 값(없으면 null), textarea 면 앞뒤 공백을 뺀 글, checklist 면 { checked: [key], none }.
   */
  function collect(entries) {
    var answers = [];
    var problems = [];
    entries.forEach(function (entry, index) {
      var model = entry.model;
      var value = entry.value;
      var message = problemOf(model, value);
      if (message) problems.push({ index: index, message: message });
      if (model.kind === 'checklist') {
        if (!value || !(value.none || value.checked.length > 0)) return;
        model.keys.forEach(function (key) {
          answers.push({ name: itemName(model.name, key), value: value.checked.indexOf(key) >= 0 ? model.checkedValue : model.uncheckedValue });
        });
        return;
      }
      if (value !== null && value !== undefined && value !== '') answers.push({ name: model.name, value: String(value) });
    });
    return { answers: answers, problems: problems };
  }

  /** 필수 문항 중 답한 수. → { done, total } */
  function progressOf(entries) {
    var done = 0;
    var total = 0;
    entries.forEach(function (entry) {
      if (!entry.model.required) return;
      total += 1;
      if (problemOf(entry.model, entry.value) === null) done += 1;
    });
    return { done: done, total: total };
  }

  var core = {
    splitList: splitList,
    parseItems: parseItems,
    itemKeys: itemKeys,
    itemName: itemName,
    fieldsOf: fieldsOf,
    schemaOf: schemaOf,
    isAnswered: isAnswered,
    problemOf: problemOf,
    collect: collect,
    progressOf: progressOf,
  };

  // ── DOM ───────────────────────────────────────────────────────────────────

  var STYLE = [
    ':root{--ann-accent:#1d5fc4;--ann-accent-soft:#e8f0fc;--ann-text:#1f1f1f;--ann-muted:#646464;--ann-border:#dcdcd8;--ann-bg:#f4f4f2;--ann-card:#fff;--ann-error:#c62f2f;--ann-done:#13893a}',
    'ann-form{display:block;max-width:1000px;margin:0 auto;padding:16px;color:var(--ann-text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
    'body:has(> ann-form),body:has(> form > ann-form){background:var(--ann-bg);margin:0}',
    'ann-instructions,ann-text,ann-choice,ann-likert,ann-checklist,ann-textarea,ann-tabs,ann-tab{display:block}',
    'ann-option,ann-item{display:none}',
    // 위의 display 규칙이 hidden 속성을 덮지 않게 한다 (탭 전환, 탭 상태, 오류 문구가 hidden 으로 숨는다)
    'ann-tab[hidden],.ann-tab-status[hidden],.ann-error[hidden]{display:none}',
    '.ann-instructions{background:var(--ann-card);border:1px solid var(--ann-border);border-left:4px solid var(--ann-accent);border-radius:6px;margin:0 0 14px}',
    '.ann-instructions>summary{cursor:pointer;padding:10px 14px;font-weight:600;list-style-position:inside}',
    '.ann-instructions-body{padding:0 16px 12px}',
    '.ann-instructions-body>:first-child{margin-top:0}',
    '.ann-card{background:var(--ann-card);border:1px solid var(--ann-border);border-radius:6px;padding:12px 16px;margin:0 0 12px}',
    '.ann-label{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ann-muted);margin:0 0 4px}',
    '.ann-text-body{white-space:pre-line;overflow-wrap:anywhere}',
    '.ann-question{border:1px solid var(--ann-border);border-radius:6px;background:var(--ann-card);padding:12px 16px;margin:0 0 12px;min-width:0}',
    '.ann-question.ann-missing{border-color:var(--ann-error);box-shadow:0 0 0 1px var(--ann-error)}',
    '.ann-header{font-weight:600;padding:0;margin:0 0 8px;float:left;width:100%}',
    '.ann-header+*{clear:both}',
    '.ann-required{color:var(--ann-error)}',
    '.ann-description{color:var(--ann-muted);margin:0 0 8px;clear:both}',
    '.ann-options{display:flex;flex-direction:column;gap:4px;clear:both}',
    '.ann-options.ann-horizontal{flex-direction:row;flex-wrap:wrap;gap:6px 18px}',
    '.ann-option-label{display:flex;align-items:flex-start;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer}',
    '.ann-option-label:hover{background:var(--ann-accent-soft)}',
    '.ann-option-label input{margin:4px 0 0;flex:none}',
    '.ann-likert-scale{display:flex;align-items:center;gap:10px;flex-wrap:wrap;clear:both}',
    '.ann-likert-points{display:flex;gap:6px}',
    '.ann-likert-point{display:flex;flex-direction:column;align-items:center;min-width:38px;padding:4px;border:1px solid var(--ann-border);border-radius:4px;cursor:pointer}',
    '.ann-likert-point:hover{background:var(--ann-accent-soft)}',
    '.ann-likert-point input{margin:0 0 2px}',
    '.ann-likert-end{color:var(--ann-muted);font-size:13px}',
    '.ann-checklist-item{border-bottom:1px solid #eeeeea}',
    '.ann-checklist-item:last-child{border-bottom:0}',
    '.ann-checklist-key{color:var(--ann-muted);font-variant-numeric:tabular-nums;min-width:1.6em}',
    '.ann-checklist-none{margin-top:4px;font-style:italic}',
    '.ann-textarea textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid var(--ann-border);border-radius:4px;resize:vertical;clear:both;display:block}',
    '.ann-counter{color:var(--ann-muted);font-size:12px;margin-top:2px}',
    '.ann-error{color:var(--ann-error);font-size:13px;margin-top:6px}',
    '.ann-tab-bar{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--ann-border);margin:0 0 12px}',
    '.ann-tab-button{font:inherit;font-size:14px;padding:6px 12px;border:1px solid transparent;border-bottom:0;border-radius:6px 6px 0 0;background:none;cursor:pointer;color:var(--ann-muted);margin-bottom:-1px}',
    '.ann-tab-button[aria-selected="true"]{background:var(--ann-card);border-color:var(--ann-border);color:var(--ann-text);font-weight:600}',
    '.ann-tab-status{display:inline-block;margin-left:6px;padding:0 6px;border-radius:9px;font-size:11px;font-weight:700;color:#fff;background:#d9a21b}',
    '.ann-tab-status.ann-done{background:var(--ann-done)}',
    '.ann-tab-nav{display:flex;justify-content:space-between;margin:4px 0 12px}',
    '.ann-submit-row{display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-top:16px;padding-top:12px;border-top:1px solid var(--ann-border)}',
    '.ann-progress{color:var(--ann-muted);font-size:14px}',
    '.ann-progress.ann-done{color:var(--ann-done)}',
    '.ann-progress.ann-blocked{color:var(--ann-error)}',
    '.ann-button{font:inherit;padding:7px 18px;border-radius:4px;border:1px solid var(--ann-border);background:var(--ann-card);cursor:pointer}',
    '.ann-submit{background:var(--ann-accent);border-color:var(--ann-accent);color:#fff;font-weight:600}',
    '.ann-button:disabled{opacity:.5;cursor:default}',
  ].join('\n');

  function injectStyle(doc) {
    if (doc.querySelector('style[data-ann-elements]')) return;
    var style = doc.createElement('style');
    style.setAttribute('data-ann-elements', VERSION);
    style.textContent = STYLE;
    var head = doc.head || doc.documentElement;
    // 템플릿의 <style> 보다 앞에 두어 템플릿이 덮어쓸 수 있게 한다
    head.insertBefore(style, head.firstChild);
  }

  function make(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 앞뒤의 공백뿐인 글 노드를 지운다 (`<ann-text>\n  ${passage}\n</ann-text>` 의 줄바꿈이 pre-line 으로 보이지 않게). */
  function trimEdges(node) {
    while (node.firstChild && node.firstChild.nodeType === 3 && node.firstChild.nodeValue.trim() === '') node.removeChild(node.firstChild);
    while (node.lastChild && node.lastChild.nodeType === 3 && node.lastChild.nodeValue.trim() === '') node.removeChild(node.lastChild);
    if (node.firstChild && node.firstChild.nodeType === 3) node.firstChild.nodeValue = node.firstChild.nodeValue.replace(/^\s+/, '');
    if (node.lastChild && node.lastChild.nodeType === 3) node.lastChild.nodeValue = node.lastChild.nodeValue.replace(/\s+$/, '');
  }

  function moveChildren(from, to) {
    while (from.firstChild) to.appendChild(from.firstChild);
  }

  function isTag(node, tag) {
    return node.nodeType === 1 && node.tagName.toLowerCase() === tag;
  }

  function flag(element, name) {
    return element.hasAttribute(name) && element.getAttribute(name) !== 'false';
  }

  var uid = 0;
  function nextId(prefix) {
    uid += 1;
    return prefix + '-' + uid;
  }

  /** 모든 문항 요소의 공통: 문항 제목(fieldset legend), 설명, 오류 자리. */
  function questionShell(element, kind) {
    var doc = element.ownerDocument;
    var shell = make(doc, 'fieldset', 'ann-question ann-' + kind);
    shell.setAttribute('data-name', element.getAttribute('name') || '');
    var legend = make(doc, 'legend', 'ann-header');
    legend.textContent = element.getAttribute('header') || '';
    if (flag(element, 'required')) {
      var star = make(doc, 'span', 'ann-required', ' *');
      star.setAttribute('aria-hidden', 'true');
      legend.appendChild(star);
    }
    if (legend.textContent.trim() !== '') shell.appendChild(legend);
    var error = make(doc, 'div', 'ann-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    return { shell: shell, error: error };
  }

  function setMissing(element, message) {
    var shell = element.querySelector('.ann-question');
    var error = element.querySelector('.ann-error');
    if (!shell || !error) return;
    shell.classList.toggle('ann-missing', Boolean(message));
    error.hidden = !message;
    error.textContent = message || '';
  }

  function checkedValue(element, name) {
    var inputs = element.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < inputs.length; i++) if (inputs[i].name === name && inputs[i].checked) return inputs[i].value;
    return null;
  }

  /** 선택지: <ann-option value> 자식 또는 options="a, b". → [{ value, label(노드 또는 글) }] */
  function readOptions(element) {
    var options = [];
    var extra = [];
    Array.prototype.slice.call(element.childNodes).forEach(function (child) {
      if (isTag(child, 'ann-option')) {
        var value = child.getAttribute('value');
        var label = child.innerHTML.trim();
        if (value === null || value === '') value = child.textContent.trim();
        options.push({ value: value, labelHtml: label === '' ? null : label });
      } else {
        extra.push(child);
      }
    });
    if (options.length === 0) {
      options = splitList(element.getAttribute('options')).map(function (value) { return { value: value, labelHtml: null }; });
    }
    return { options: options, extra: extra };
  }

  function appendDescription(shell, nodes) {
    var meaningful = nodes.filter(function (node) { return !(node.nodeType === 3 && node.nodeValue.trim() === ''); });
    if (meaningful.length === 0) return;
    var description = make(shell.ownerDocument, 'div', 'ann-description');
    meaningful.forEach(function (node) { description.appendChild(node); });
    trimEdges(description);
    shell.appendChild(description);
  }

  function optionLabel(doc, type, name, value, labelHtml) {
    var label = make(doc, 'label', 'ann-option-label');
    var input = doc.createElement('input');
    input.type = type;
    input.name = name;
    input.value = value;
    var text = make(doc, 'span', 'ann-option-text');
    if (labelHtml === null) text.textContent = value;
    else text.innerHTML = labelHtml;
    label.appendChild(input);
    label.appendChild(text);
    return label;
  }

  // 요소 클래스는 정의할 때 만든다 (Node 에는 HTMLElement 가 없다)
  function defineElements(win) {
    var registry = win.customElements;
    if (!registry) return;

    function define(tag, render, methods) {
      if (registry.get(tag)) return;
      var Element = class extends win.HTMLElement {
        connectedCallback() {
          // 다른 요소 안으로 옮겨질 때도 불린다. 한 번만 그린다
          if (this.__annRendered) return;
          this.__annRendered = true;
          if (render) render(this);
        }
      };
      Object.keys(methods || {}).forEach(function (key) { Element.prototype[key] = methods[key]; });
      registry.define(tag, Element);
    }

    define('ann-option', null);
    define('ann-item', null);

    define('ann-instructions', function (element) {
      var doc = element.ownerDocument;
      var details = make(doc, 'details', 'ann-instructions');
      if (!flag(element, 'collapsed')) details.open = true;
      details.appendChild(make(doc, 'summary', null, element.getAttribute('header') || 'Instructions'));
      var body = make(doc, 'div', 'ann-instructions-body');
      moveChildren(element, body);
      details.appendChild(body);
      element.appendChild(details);
    });

    define('ann-text', function (element) {
      var doc = element.ownerDocument;
      var card = make(doc, 'div', 'ann-card ann-text-card');
      var label = element.getAttribute('label');
      if (label) card.appendChild(make(doc, 'div', 'ann-label', label));
      var body = make(doc, 'div', 'ann-text-body');
      moveChildren(element, body);
      trimEdges(body);
      card.appendChild(body);
      element.appendChild(card);
    });

    define(
      'ann-choice',
      function (element) {
        var doc = element.ownerDocument;
        var parts = questionShell(element, 'choice');
        var read = readOptions(element);
        element.__annValues = read.options.map(function (o) { return o.value; });
        appendDescription(parts.shell, read.extra);
        var list = make(doc, 'div', 'ann-options' + (element.getAttribute('layout') === 'horizontal' ? ' ann-horizontal' : ''));
        var name = element.getAttribute('name') || '';
        read.options.forEach(function (o) { list.appendChild(optionLabel(doc, 'radio', name, o.value, o.labelHtml)); });
        parts.shell.appendChild(list);
        parts.shell.appendChild(parts.error);
        element.replaceChildren(parts.shell);
      },
      {
        annModel: function () {
          return { kind: 'choice', name: this.getAttribute('name') || '', required: flag(this, 'required'), values: (this.__annValues || []).slice() };
        },
        annValue: function () {
          return checkedValue(this, this.getAttribute('name') || '');
        },
      },
    );

    define(
      'ann-likert',
      function (element) {
        var doc = element.ownerDocument;
        var parts = questionShell(element, 'likert');
        var min = parseInt(element.getAttribute('min') || '1', 10);
        var max = parseInt(element.getAttribute('max') || '5', 10);
        if (!(max >= min)) max = min;
        var values = [];
        for (var n = min; n <= max; n++) values.push(String(n));
        element.__annValues = values;
        appendDescription(parts.shell, Array.prototype.slice.call(element.childNodes));
        var scale = make(doc, 'div', 'ann-likert-scale');
        if (element.getAttribute('min-label')) scale.appendChild(make(doc, 'span', 'ann-likert-end', element.getAttribute('min-label')));
        var points = make(doc, 'div', 'ann-likert-points');
        var name = element.getAttribute('name') || '';
        values.forEach(function (value) {
          var label = make(doc, 'label', 'ann-likert-point');
          var input = doc.createElement('input');
          input.type = 'radio';
          input.name = name;
          input.value = value;
          label.appendChild(input);
          label.appendChild(make(doc, 'span', null, value));
          points.appendChild(label);
        });
        scale.appendChild(points);
        if (element.getAttribute('max-label')) scale.appendChild(make(doc, 'span', 'ann-likert-end', element.getAttribute('max-label')));
        parts.shell.appendChild(scale);
        parts.shell.appendChild(parts.error);
        element.replaceChildren(parts.shell);
      },
      {
        annModel: function () {
          return { kind: 'likert', name: this.getAttribute('name') || '', required: flag(this, 'required'), values: (this.__annValues || []).slice() };
        },
        annValue: function () {
          return checkedValue(this, this.getAttribute('name') || '');
        },
      },
    );

    define(
      'ann-checklist',
      function (element) {
        var doc = element.ownerDocument;
        var parts = questionShell(element, 'checklist');
        var items = [];
        var extra = [];
        var jsonText = null;
        Array.prototype.slice.call(element.childNodes).forEach(function (child) {
          if (isTag(child, 'ann-item')) items.push({ key: child.getAttribute('key'), html: child.innerHTML.trim() });
          else if (isTag(child, 'script') && /json/i.test(child.getAttribute('type') || '')) jsonText = child.textContent;
          else extra.push(child);
        });
        if (items.length === 0) {
          // JSON 스크립트가 없으면 남은 글 전체를 항목 목록으로 읽는다 (`<ann-checklist>${facts}</ann-checklist>`)
          var source = jsonText;
          if (source === null) {
            source = extra.map(function (node) { return node.textContent; }).join('');
            extra = [];
          }
          items = parseItems(source).map(function (item) { return { key: item.key, text: item.text }; });
        }
        var keys = itemKeys(items);
        element.__annKeys = keys;
        appendDescription(parts.shell, extra);
        var name = element.getAttribute('name') || '';
        var group = nextId('ann-group');
        var list = make(doc, 'div', 'ann-options');
        items.forEach(function (item, index) {
          var label = make(doc, 'label', 'ann-option-label ann-checklist-item');
          var input = doc.createElement('input');
          input.type = 'checkbox';
          input.name = itemName(name, keys[index]);
          input.value = keys[index];
          input.setAttribute('data-ann-group', group);
          label.appendChild(input);
          if (flag(element, 'numbered')) label.appendChild(make(doc, 'span', 'ann-checklist-key', keys[index] + '.'));
          var text = make(doc, 'span', 'ann-option-text');
          if (item.html !== undefined) text.innerHTML = item.html;
          else text.textContent = item.text;
          label.appendChild(text);
          list.appendChild(label);
        });
        if (items.length > 0 && !flag(element, 'no-none')) {
          var none = make(doc, 'label', 'ann-option-label ann-checklist-none');
          var noneInput = doc.createElement('input');
          noneInput.type = 'checkbox';
          noneInput.setAttribute('data-ann-group', group);
          noneInput.setAttribute('data-ann-none', '1');
          none.appendChild(noneInput);
          none.appendChild(make(doc, 'span', 'ann-option-text', element.getAttribute('none-label') || 'None of the above'));
          list.appendChild(none);
        }
        if (items.length === 0) list.appendChild(make(doc, 'span', 'ann-description', 'No items.'));
        // "해당 없음" 과 다른 칸은 함께 체크할 수 없다
        list.addEventListener('change', function (event) {
          var target = event.target;
          if (!target || target.type !== 'checkbox' || !target.checked) return;
          var isNone = target.getAttribute('data-ann-none') === '1';
          var boxes = list.querySelectorAll('input[type="checkbox"]');
          for (var i = 0; i < boxes.length; i++) {
            if (boxes[i] !== target && (isNone || boxes[i].getAttribute('data-ann-none') === '1')) boxes[i].checked = false;
          }
        });
        parts.shell.appendChild(list);
        parts.shell.appendChild(parts.error);
        element.replaceChildren(parts.shell);
      },
      {
        annModel: function () {
          return {
            kind: 'checklist',
            name: this.getAttribute('name') || '',
            required: flag(this, 'required'),
            keys: (this.__annKeys || []).slice(),
            checkedValue: this.getAttribute('checked-value') || 'yes',
            uncheckedValue: this.getAttribute('unchecked-value') || 'no',
          };
        },
        annValue: function () {
          var checked = [];
          var none = false;
          var boxes = this.querySelectorAll('input[type="checkbox"]');
          for (var i = 0; i < boxes.length; i++) {
            if (!boxes[i].checked) continue;
            if (boxes[i].getAttribute('data-ann-none') === '1') none = true;
            else checked.push(boxes[i].value);
          }
          return { checked: checked, none: none };
        },
      },
    );

    define(
      'ann-textarea',
      function (element) {
        var doc = element.ownerDocument;
        var parts = questionShell(element, 'textarea');
        appendDescription(parts.shell, Array.prototype.slice.call(element.childNodes));
        var textarea = doc.createElement('textarea');
        textarea.name = element.getAttribute('name') || '';
        textarea.rows = parseInt(element.getAttribute('rows') || '3', 10) || 3;
        if (element.getAttribute('placeholder')) textarea.placeholder = element.getAttribute('placeholder');
        parts.shell.appendChild(textarea);
        var min = parseInt(element.getAttribute('minlength') || '0', 10) || 0;
        if (min > 0) {
          var counter = make(doc, 'div', 'ann-counter', '0 / ' + min + ' characters minimum');
          textarea.addEventListener('input', function () {
            counter.textContent = textarea.value.trim().length + ' / ' + min + ' characters minimum';
          });
          parts.shell.appendChild(counter);
        }
        parts.shell.appendChild(parts.error);
        element.replaceChildren(parts.shell);
      },
      {
        annModel: function () {
          return { kind: 'textarea', name: this.getAttribute('name') || '', required: flag(this, 'required'), values: [], minLength: parseInt(this.getAttribute('minlength') || '0', 10) || 0 };
        },
        annValue: function () {
          var textarea = this.querySelector('textarea');
          return textarea ? textarea.value.trim() : '';
        },
      },
    );

    define('ann-tab', null);

    define(
      'ann-tabs',
      function (element) {
        var doc = element.ownerDocument;
        var tabs = Array.prototype.slice.call(element.children).filter(function (child) { return isTag(child, 'ann-tab'); });
        var bar = make(doc, 'div', 'ann-tab-bar');
        bar.setAttribute('role', 'tablist');
        var nav = make(doc, 'div', 'ann-tab-nav');
        var prev = make(doc, 'button', 'ann-button', '‹ Previous');
        var next = make(doc, 'button', 'ann-button', 'Next ›');
        prev.type = 'button';
        next.type = 'button';
        nav.appendChild(prev);
        nav.appendChild(next);
        element.__annTabs = tabs;
        element.__annButtons = tabs.map(function (tab, index) {
          var button = make(doc, 'button', 'ann-tab-button');
          button.type = 'button';
          button.setAttribute('role', 'tab');
          button.appendChild(make(doc, 'span', 'ann-tab-title', tab.getAttribute('header') || 'Item ' + (index + 1)));
          button.appendChild(make(doc, 'span', 'ann-tab-status'));
          button.addEventListener('click', function () { element.annSelect(index); });
          bar.appendChild(button);
          tab.setAttribute('role', 'tabpanel');
          return button;
        });
        prev.addEventListener('click', function () { element.annSelect(element.__annIndex - 1); });
        next.addEventListener('click', function () { element.annSelect(element.__annIndex + 1); });
        element.__annNav = { prev: prev, next: next };
        element.insertBefore(bar, element.firstChild);
        if (tabs.length > 1) element.appendChild(nav);
        element.annSelect(0);
      },
      {
        annSelect: function (index) {
          var tabs = this.__annTabs || [];
          if (tabs.length === 0) return;
          var at = Math.min(Math.max(0, index), tabs.length - 1);
          this.__annIndex = at;
          tabs.forEach(function (tab, i) { tab.hidden = i !== at; });
          (this.__annButtons || []).forEach(function (button, i) { button.setAttribute('aria-selected', i === at ? 'true' : 'false'); });
          if (this.__annNav) {
            this.__annNav.prev.disabled = at === 0;
            this.__annNav.next.disabled = at === tabs.length - 1;
          }
        },
        /** 탭마다 남은 필수 문항 수를 제목 옆에 보인다. missing 은 탭 → 남은 수를 돌려주는 함수다. */
        annShowStatus: function (missing) {
          var tabs = this.__annTabs || [];
          (this.__annButtons || []).forEach(function (button, i) {
            var status = button.querySelector('.ann-tab-status');
            var left = missing(tabs[i]);
            if (left === null) {
              status.hidden = true;
              return;
            }
            status.hidden = false;
            status.textContent = left === 0 ? '✓' : String(left);
            status.title = left === 0 ? 'Complete' : left + ' required answer(s) left';
            status.classList.toggle('ann-done', left === 0);
          });
        },
      },
    );

    define('ann-form', function (element) {
      var doc = element.ownerDocument;
      var form = make(doc, 'form', 'ann-form-body');
      form.method = element.getAttribute('method') || 'post';
      if (element.getAttribute('action')) form.action = element.getAttribute('action');
      form.noValidate = true;
      moveChildren(element, form);
      var hidden = doc.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'input_answers';
      form.appendChild(hidden);
      var row = make(doc, 'div', 'ann-submit-row');
      var progress = make(doc, 'span', 'ann-progress');
      progress.setAttribute('aria-live', 'polite');
      var submit = make(doc, 'button', 'ann-button ann-submit', element.getAttribute('submit-label') || 'Submit');
      submit.type = 'button';
      row.appendChild(progress);
      row.appendChild(submit);
      form.appendChild(row);
      element.appendChild(form);

      var attempted = false;

      function questions() {
        return Array.prototype.slice.call(form.querySelectorAll('ann-choice, ann-likert, ann-checklist, ann-textarea')).filter(function (q) {
          return typeof q.annModel === 'function';
        });
      }
      function entriesOf(list) {
        return list.map(function (q) { return { model: q.annModel(), value: q.annValue() }; });
      }

      var lastSchema = '';
      function publishSchema(entries) {
        // 페이지의 모든 ann-form 을 합친다 (보통 하나다)
        var all = [];
        Array.prototype.forEach.call(doc.querySelectorAll('ann-form'), function (f) {
          if (typeof f.annEntries === 'function') all = all.concat(f.annEntries());
        });
        if (all.length === 0) all = entries;
        var schema = schemaOf(all.map(function (e) { return e.model; }));
        var text = JSON.stringify(schema);
        if (text === lastSchema) return;
        lastSchema = text;
        win.TASK_ANSWER_SCHEMA = schema;
      }

      function refresh() {
        var list = questions();
        var entries = entriesOf(list);
        var p = progressOf(entries);
        var result = collect(entries);
        if (attempted) {
          var byIndex = {};
          result.problems.forEach(function (problem) { byIndex[problem.index] = problem.message; });
          list.forEach(function (q, i) { setMissing(q, byIndex[i] || null); });
        }
        Array.prototype.forEach.call(form.querySelectorAll('ann-tabs'), function (tabs) {
          if (typeof tabs.annShowStatus !== 'function') return;
          tabs.annShowStatus(function (tab) {
            var inTab = list.filter(function (q) { return tab.contains(q) && q.annModel().required; });
            if (inTab.length === 0) return null;
            return inTab.filter(function (q) { return problemOf(q.annModel(), q.annValue()) !== null; }).length;
          });
        });
        progress.classList.remove('ann-blocked');
        progress.classList.toggle('ann-done', result.problems.length === 0);
        if (p.total === 0) progress.textContent = '';
        else progress.textContent = p.done === p.total ? 'All ' + p.total + ' required answers done.' : p.done + ' of ' + p.total + ' required answers done.';
        publishSchema(entries);
        return { list: list, result: result };
      }

      element.annEntries = function () {
        return entriesOf(questions());
      };

      function reveal(question) {
        // 숨은 탭 안이면 그 탭을 연다
        var node = question;
        while (node && node !== element) {
          if (isTag(node, 'ann-tab') && node.parentNode && typeof node.parentNode.annSelect === 'function') {
            node.parentNode.annSelect(node.parentNode.__annTabs.indexOf(node));
          }
          node = node.parentNode;
        }
        if (typeof question.scrollIntoView === 'function') question.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }

      function trySubmit() {
        attempted = true;
        var state = refresh();
        if (state.result.problems.length > 0) {
          var count = state.result.problems.length;
          progress.classList.remove('ann-done');
          progress.classList.add('ann-blocked');
          progress.textContent = count + ' question(s) still need an answer. They are highlighted.';
          reveal(state.list[state.result.problems[0].index]);
          return;
        }
        var answers = state.result.answers;
        var event;
        try {
          event = new win.CustomEvent('ann-submit', { detail: { answers: answers }, cancelable: true, bubbles: true });
        } catch (e) {
          event = null;
        }
        if (event && !element.dispatchEvent(event)) return;
        hidden.value = JSON.stringify(answers);
        form.submit();
      }

      submit.addEventListener('click', trySubmit);
      // 글 입력칸에서 Enter 를 눌러도 같은 검사를 거친다
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        trySubmit();
      });
      var pending = false;
      function schedule() {
        if (pending) return;
        pending = true;
        setTimeout(function () {
          pending = false;
          refresh();
        }, 0);
      }
      form.addEventListener('change', schedule);
      form.addEventListener('input', schedule);
      refresh();
    });
  }

  function boot(w, doc) {
    if (w.__annElements) return;
    w.__annElements = VERSION;
    injectStyle(doc);
    var start = function () { defineElements(w); };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return { version: VERSION, core: core, boot: boot };
});
