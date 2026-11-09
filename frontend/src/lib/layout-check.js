// 요청한 배치대로 되었는지의 자동 확인. 페이지를 실제로 그린 뒤 칸의 위치·폭·탭·굵기·색을 재고(measureLayout),
// 그 값과 Requester 의 요청을 판정 Agent(POST /api/agent/layout-checks)에게 보내 바람마다 met / not_met / unclear 를 받는다.
// HTML 이나 페이지를 쓴 Agent 의 설명이 아니라 그려진 결과로 판정하려는 것이다. 판정도 틀릴 수 있으므로 페이지를 버리지 않고,
// 맞지 않은 바람은 페이지 Agent 에게 고쳐 달라고 다시 보내거나(layoutNotes) Requester 에게 경고로 보인다.

/**
 * 그려진 페이지의 측정값 { width, tabs, blocks }. 미리보기 iframe 안(lib/template.js 의 PREVIEW_BRIDGE)과 실험의 headless Chrome
 * (scripts/html_experiment/render.mjs)에서 이 함수의 소스를 그대로 실행하므로 모듈의 다른 것을 쓰지 않고 ES5 로 쓴다.
 * blocks: 보이는 칸을 위에서 아래로. { kind: instructions|value|question|text, label, text, x, w (페이지 폭의 %), y, h (px), tab?, bold?, size?, color?, background?,
 *          frame? (칸을 감싼 상자의 배경·왼쪽 띠), options?, scale? }
 */
export function measureLayout(doc, win) {
  var root = doc.documentElement;
  var width = Math.max(1, root.clientWidth || 1);
  var body = doc.body;
  var base = win.getComputedStyle(body);
  var blocks = [];
  var CONTAINERS = { 'ANN-FORM': 1, 'ANN-TABS': 1, 'ANN-TAB': 1, 'ANN-COLUMNS': 1, 'ANN-COLUMN': 1, FORM: 1, BODY: 1 };
  function clip(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    return text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }
  function look(el) {
    var s = win.getComputedStyle(el);
    var out = {};
    if (parseInt(s.fontWeight, 10) >= 600) out.bold = true;
    var size = parseFloat(s.fontSize);
    if (Math.abs(size - parseFloat(base.fontSize)) >= 1) out.size = Math.round(size);
    if (s.color !== base.color) out.color = s.color;
    var parent = el.parentElement ? win.getComputedStyle(el.parentElement).backgroundColor : '';
    if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== parent) out.background = s.backgroundColor;
    return out;
  }
  var STOP = { 'ANN-TAB': 1, 'ANN-TABS': 1, 'ANN-FORM': 1, FORM: 1, BODY: 1, HTML: 1 };
  /** 칸을 감싼 상자(Agent 가 만든 강조 상자 등): 칸 위로 네 단계까지 배경이나 굵은 왼쪽 띠가 있는 요소. */
  function frameOf(el) {
    var node = el.parentElement;
    for (var depth = 0; node && depth < 4 && !STOP[node.tagName]; depth += 1, node = node.parentElement) {
      if (node.tagName.indexOf('ANN-') === 0 && !CONTAINERS[node.tagName]) continue;
      var s = win.getComputedStyle(node);
      var frame = {};
      if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== base.backgroundColor) frame.background = s.backgroundColor;
      if (parseFloat(s.borderLeftWidth) >= 3 && s.borderLeftStyle !== 'none') frame.border = s.borderLeftColor;
      if (frame.background || frame.border) return frame;
    }
    return null;
  }
  function add(kind, el, label, text, extra) {
    var r = rectOf(el);
    if (!r) return;
    var block = { kind: kind, label: clip(label), text: clip(text), x: Math.round((r.left / width) * 100), w: Math.round((r.width / width) * 100), y: Math.round(r.top + (win.scrollY || 0)), h: Math.round(r.height) };
    if (el.closest && el.closest('ann-tab')) block.tab = 1;
    for (var key in extra || {}) block[key] = extra[key];
    if (kind === 'value' || kind === 'question') {
      var frame = frameOf(el.closest ? el.closest('ann-text, ann-image, ann-video, ann-choice, ann-likert, ann-checklist, ann-item-choice, ann-textarea') || el : el);
      if (frame) block.frame = frame;
    }
    blocks.push(block);
  }
  function textOf(el) {
    return el ? el.textContent : '';
  }
  doc.querySelectorAll('.ann-instructions').forEach(function (el) {
    add('instructions', el, textOf(el.querySelector('summary')), textOf(el.querySelector('.ann-instructions-body')));
  });
  doc.querySelectorAll('.ann-card').forEach(function (el) {
    var label = el.querySelector('.ann-label');
    var bodyText = el.querySelector('.ann-text-body');
    add('value', el, textOf(label), textOf(bodyText || el), label ? look(label) : {});
  });
  doc.querySelectorAll('.ann-question').forEach(function (el) {
    var seen = {};
    var options = [];
    el.querySelectorAll('.ann-option-text').forEach(function (option) {
      var text = clip(option.textContent);
      if (!text || seen[text]) return;
      seen[text] = true;
      var styled = look(option.firstElementChild || option);
      var entry = { text: text };
      if (styled.color) entry.color = styled.color;
      if (styled.bold) entry.bold = true;
      options.push(entry);
    });
    var extra = options.length ? { options: options } : {};
    var points = el.querySelectorAll('.ann-likert-point');
    if (points.length) {
      var ends = el.querySelectorAll('.ann-likert-end');
      extra.scale = clip(points[0].textContent) + ' to ' + clip(points[points.length - 1].textContent) + (ends.length === 2 ? ' (' + clip(ends[0].textContent) + ' … ' + clip(ends[1].textContent) + ')' : '');
    }
    add('question', el, textOf(el.querySelector('.ann-header')), '', extra);
    el.querySelectorAll('.ann-description').forEach(function (description) {
      if (clip(description.textContent)) add('text', description, 'inside: ' + clip(textOf(el.querySelector('.ann-header'))), description.textContent, look(description.firstElementChild || description));
    });
  });
  // Agent 가 직접 쓴 글(안내 상자, 제목 등). ann 요소 안의 글은 위에서 다뤘다
  doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, aside').forEach(function (el) {
    for (var node = el.parentElement; node; node = node.parentElement) {
      if (node.tagName.indexOf('ANN-') === 0 && !CONTAINERS[node.tagName]) return;
      if (node.classList && (node.classList.contains('ann-question') || node.classList.contains('ann-card') || node.classList.contains('ann-instructions') || node.classList.contains('ann-submit-row') || node.classList.contains('ann-tab-bar') || node.classList.contains('ann-tab-nav'))) return;
    }
    if (el.className && String(el.className).indexOf('ann-') === 0) return;
    var own = '';
    el.childNodes.forEach(function (child) {
      if (child.nodeType === 3) own += child.textContent;
      else if (child.nodeType === 1 && /^(STRONG|EM|B|I|U|SMALL|SPAN|MARK|CODE|SUB|SUP|BR)$/.test(child.tagName)) own += child.textContent;
    });
    if (clip(own)) add('text', el, '', own, look(el));
  });
  blocks.sort(function (a, b) {
    return a.y - b.y || a.x - b.x;
  });
  return { width: width, tabs: doc.querySelectorAll('ann-tab').length, blocks: blocks.slice(0, 80) };
}

/** 판정 Agent 에게 보낼 요청. fixed 는 계약이 정해서 페이지가 바꿀 수 없는 것들이다 (그런 바람은 판정하지 않는다). */
export function layoutRequest(requestText, page, fixed = []) {
  return { request: requestText, page, fixed: [...ALWAYS_FIXED, ...fixed] };
}

const ALWAYS_FIXED = ['Answer keys and attention checks are never shown to workers.', 'Values and questions are decided by the task, not by the page: adding, removing or rewording them is not a layout wish.'];

/** 계약 요약(contractOutline)에서 페이지가 바꿀 수 없는 것: 항목마다 다른 값은 한 번만 보일 수 없다. */
export function fixedFromOutline(outline) {
  return (outline?.values ?? []).filter((value) => value.perItem).map((value) => `"${value.label}" differs between items, so it is shown once for each item, never once for the whole page.`);
}

/** 맞지 않은 바람을 페이지 Agent 에게 다시 보낼 글로. unclear 는 보내지 않는다. */
export function layoutNotes(checks) {
  return (checks ?? []).filter((check) => check.result === 'not_met').map((check) => `Not as requested: ${check.wish}${check.evidence ? ` (${check.evidence})` : ''}`);
}

/** 판정 요약: met / not_met / unclear 의 수. */
export function layoutSummary(checks) {
  const counts = { met: 0, not_met: 0, unclear: 0 };
  for (const check of checks ?? []) counts[check.result] = (counts[check.result] ?? 0) + 1;
  return counts;
}
