"""spec → MTurk crowd-form 템플릿(template.html).

    render_template(spec)     HTML 문자열
    run_render(spec, out_dir) template.html 저장, 경로 반환

데이터 주입은 `${컬럼}` 치환만 쓴다 (MTurk Requester 웹사이트와 콘솔이 같은 방식으로 치환한다). HTML 안의
`${identifier}`는 정확히 hit_id와 spec의 필드 이름들뿐이다 (attention 표시는 CSV에만 있고 템플릿에는 없다). 그래서
JS 템플릿 리터럴은 쓰지 않고, spec의 어떤 문자열에도 `${`가 들어 있으면 ValueError를 낸다.

화면 구성과 CSS는 연구실의 이전 템플릿을 따른다: Instructions 패널 → 진행률 바 → 탭(항목마다 하나) → Submit.
탭 안에는 context 카드들 다음에 문항들이 spec 순서대로 나온다 (spec.question_blocks): 연속한 target 문항(choice,
likert, text)은 target마다 카드 하나에 차례로, multi_select는 문항 글 아래 target마다 체크박스와 "해당 없음" 칸,
item 문항은 문항마다 카드 하나. 답 이름은 모두 "general_"로 시작해 attention 탭을 가려낼 수 없다.

탭을 다 그린 뒤 window.TASK_ANSWER_SCHEMA에 답 칸들을 화면 순서대로 [{name, type, values, required}]로 둔다
(required_when이 있는 문항은 required false). Submit은 필수 칸이 다 채워져야 켜지고, 누르면 hidden input_answers에
[{name, value}] JSON 배열을 넣어 crowd-form을 제출한다. multi_select는 칸이 하나라도 체크되면 target마다
options[0](체크) 또는 options[1](체크 안 함) 값을 내고, text는 앞뒤 공백을 지운 글을 내며 비어 있으면 뺀다.

탭 안의 모든 데이터는 JS의 esc()로 escape해서 넣는다. spec에서 오는 문구(instructions, 문항 글)는 여기서 rich()로
escape하고 **굵게**만 <strong>으로 바꾼다. 필드·선택지 라벨은 JS의 esc()를 거친다.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from agent.spec import TaskSpec, question_blocks, spec_to_dict

TEMPLATE_FILE = "template.html"
SIZE_TARGET = 40 * 1024
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def rich(text: str) -> str:
    """escape한 뒤 **굵게**만 <strong>으로 바꾼다."""
    return BOLD_RE.sub(r"<strong>\1</strong>", html.escape(text, quote=True))


def layout_json(spec: TaskSpec) -> str:
    """LAYOUT 상수: 필드 순서·label·role·style, target 필드, 문항들, 화면 묶음, 제목. `<`는 \\u003c로 escape한다.

    문항 글(text)은 rich()를 거친 HTML이다. suffix는 답 이름 접미어(v2는 "_" + id, v1은 옛 answer_suffix)다."""
    target = spec.target_field
    questions = []
    for q in spec.item.questions:
        questions.append({
            "id": q.id,
            "type": q.type,
            "scope": q.scope,
            "text": rich(q.text),
            "options": [{"value": o.value, "label": o.label} for o in q.options],
            "values": q.values,
            "none_label": q.none_text if q.type == "multi_select" else None,
            "scale": ({"min": q.scale.min, "max": q.scale.max, "min_label": q.scale.min_label, "max_label": q.scale.max_label}
                      if q.scale is not None else None),
            "min_chars": q.min_chars,
            "required": q.required,
            "required_when": {"question": q.required_when.question, "value": q.required_when.value} if q.required_when else None,
            "suffix": q.suffix,
        })
    layout = {
        "title": spec.task.title,
        "fields": [{"name": f.name, "label": f.label, "role": f.role, "style": f.style} for f in spec.item.fields.values()],
        "target": target.name if target is not None else None,
        "target_label": target.label if target is not None else "",
        "questions": questions,
        "blocks": [{"kind": kind, "questions": indexes} for kind, indexes in question_blocks(spec.item.questions)],
    }
    return json.dumps(layout, ensure_ascii=False).replace("<", "\\u003c")


def instructions_html(spec: TaskSpec) -> str:
    ins = spec.instructions
    parts = ['<div class="panel panel-primary"><div class="panel-heading"><strong>Instructions</strong></div><div class="panel-body">']
    if ins.summary.strip():
        parts.append(f'<p><span class="highlight-yellow"><strong>{rich(ins.summary)}</strong></span></p>')
    if ins.background:
        parts.append(f"<h3>Background</h3><p>{rich(ins.background)}</p>")
    if ins.criteria:
        parts.append("<h3>What each option means</h3><div class=\"crit-box\">")
        for criterion in ins.criteria:
            parts.append(f'<div class="crit-row"><span class="crit-label">{rich(criterion.label)}</span> '
                         f'<span class="crit-text">{rich(criterion.text)}</span></div>')
        parts.append("</div>")
    if ins.steps:
        parts.append("<h3>How to evaluate</h3><ol>")
        parts.extend(f"<li>{rich(step)}</li>" for step in ins.steps)
        parts.append("</ol>")
    if ins.notes:
        parts.append("<h3>Notes</h3><ul>")
        parts.extend(f"<li>{rich(note)}</li>" for note in ins.notes)
        parts.append("</ul>")
    if ins.tip:
        parts.append(f'<div class="notice-box notice-tip">&#9733; <strong>Tip:</strong> {rich(ins.tip)}</div>')
    if ins.notices.attention:
        parts.append('<div class="notice-box notice-attention">&#9888; <strong>Attention Check Notice:</strong> '
                     "Some items check whether you are reading carefully. Submissions that fail these checks may be "
                     "<strong>rejected</strong>.</div>")
    if ins.notices.research:
        parts.append('<div class="notice-box notice-research">&#9888; <strong>Research Use Notice:</strong> '
                     "Your responses will be used only for academic research purposes.</div>")
    parts.append("</div></div>")
    return "".join(parts)


def render_template(spec: TaskSpec) -> str:
    """spec으로 crowd-form 템플릿을 만든다. spec의 문자열에 `${`가 있으면 ValueError."""
    if "${" in json.dumps(spec_to_dict(spec), ensure_ascii=False):
        raise ValueError("spec text must not contain \"${\" (it would be read as a template placeholder)")
    field_lines = "".join(f'FIELDS["{name}"] = ${{{name}}};\n' for name in spec.item.fields)
    parts = [
        '<script src="https://assets.crowd.aws/crowd-html-elements.js"></script>\n',
        "<crowd-form>\n",
        '<section class="entire-UI">\n',
        instructions_html(spec), "\n",
        PROGRESS_HTML,
        "<script>\n",
        "var HIT_ID = ${hit_id};\n",
        "var FIELDS = {};\n",
        field_lines,
        "var LAYOUT = ", layout_json(spec), ";\n",
        SCRIPT,
        "</script>\n",
        "</section>\n",
        "</crowd-form>\n",
        "<style>\n", STYLE, "</style>\n",
    ]
    return "".join(parts)


def run_render(spec: TaskSpec, out_dir: Path) -> Path:
    """template.html을 out_dir에 저장한다."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / TEMPLATE_FILE
    path.write_text(render_template(spec), encoding="utf-8")
    return path


PROGRESS_HTML = """<div class="panel-body"><strong><span class="progress-label">Your current progress</span></strong>
<div id="progressBarContainer"><div id="progressBar"><span id="progressPercentage">0%</span></div></div>
</div>
<div class="panel-body highlight-remaining"><div id="incompleteContent"><strong>&nbsp;</strong></div></div>
<p class="nav-hint">Click the tab numbers below to navigate between items. Answer every item, then press Submit.</p>
<div id="summary-container">
<crowd-tabs id="summary-tabs"></crowd-tabs>
<div class="submit-row"><button type="button" disabled="disabled" id="submitButton" onclick="handleFormSubmit()">Submit</button></div>
</div>
"""

# 탭 안의 모든 데이터는 esc()를 거친다. 템플릿 리터럴(`${`)은 쓰지 않는다 (콘솔이 placeholder로 센다).
SCRIPT = r"""
function asList(v) {
  if (typeof v === 'string') { try { var p = JSON.parse(v); if (Array.isArray(p)) return p; } catch (e) {} return [v]; }
  return Array.isArray(v) ? v : [v];
}
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
var DATA = {};
for (var fi = 0; fi < LAYOUT.fields.length; fi++) { var fname = LAYOUT.fields[fi].name; DATA[fname] = asList(FIELDS[fname]); }
var TOTAL = DATA[LAYOUT.fields[0].name].length;
var TARGETS = [];
for (var ti = 0; ti < TOTAL; ti++) TARGETS.push(LAYOUT.target ? asList(DATA[LAYOUT.target][ti]) : []);
var QS = LAYOUT.questions;
var QBYID = {};
for (var qi = 0; qi < QS.length; qi++) QBYID[QS[qi].id] = QS[qi];

// 답 이름: target 문항은 general_{i}_{j}{suffix}, item 문항은 general_{i}{suffix}. j는 0부터 받아 1부터 쓴다
function nameOf(i, j, q) { return 'general_' + i + (j === null ? '' : '_' + (j + 1)) + q.suffix; }
function groupOf(i, q) { return i + ':' + q.id; }
// 탭 하나의 답 칸들 (화면 순서). 전처리의 answer_slots와 같은 규칙이다
function slotsOf(i) {
  var out = [], n = TARGETS[i].length;
  for (var b = 0; b < LAYOUT.blocks.length; b++) {
    var block = LAYOUT.blocks[b], j, k;
    if (block.kind === 'targets') { for (j = 0; j < n; j++) for (k = 0; k < block.questions.length; k++) out.push({ q: QS[block.questions[k]], j: j }); }
    else if (block.kind === 'multi') { for (j = 0; j < n; j++) out.push({ q: QS[block.questions[0]], j: j }); }
    else out.push({ q: QS[block.questions[0]], j: null });
  }
  for (var s = 0; s < out.length; s++) out[s].name = nameOf(i, out[s].j, out[s].q);
  return out;
}
// 진행률 단위: multi_select는 탭마다 문항 하나가 한 단위, 나머지는 답 칸 하나가 한 단위
function unitsOf(i) {
  var out = [], multi = {};
  for (var s = 0; s < SLOTS[i].length; s++) {
    var slot = SLOTS[i][s];
    if (slot.q.type === 'multi_select') {
      if (multi[slot.q.id]) { multi[slot.q.id].slots.push(slot); continue; }
      multi[slot.q.id] = { q: slot.q, key: groupOf(i, slot.q), slots: [slot] };
      out.push(multi[slot.q.id]);
    } else out.push({ q: slot.q, key: slot.name, slots: [slot] });
  }
  return out;
}

function radioValue(name) { var r = document.querySelector('input[type="radio"][name="' + name + '"]:checked'); return r ? r.value : null; }
function textValue(name) { var t = document.querySelector('textarea[name="' + name + '"]'); return t ? t.value.replace(/^\s+|\s+$/g, '') : ''; }
function groupAnswered(i, q) { return !!document.querySelector('input[type="checkbox"][data-group="' + groupOf(i, q) + '"]:checked'); }
function boxChecked(name) { var b = document.querySelector('input[type="checkbox"][name="' + name + '"]'); return !!(b && b.checked); }
function valueOf(i, j, q) {
  var name = nameOf(i, j, q);
  if (q.type === 'multi_select') return groupAnswered(i, q) ? (boxChecked(name) ? q.options[0].value : q.options[1].value) : null;
  if (q.type === 'text') return textValue(name) || null;
  return radioValue(name);
}
// required_when: 같은 target(둘 다 target 문항일 때) 또는 탭의 답(item 문항)이 value일 때만 필수
function isRequired(i, slot) {
  var cond = slot.q.required_when;
  if (!cond) return !!slot.q.required;
  var ref = QBYID[cond.question];
  return valueOf(i, ref.scope === 'item' ? null : slot.j, ref) === cond.value;
}
function isAnswered(i, slot) {
  var q = slot.q;
  if (q.type === 'multi_select') return groupAnswered(i, q);
  if (q.type === 'text') return textValue(slot.name).length >= Math.max(1, q.min_chars || 0);
  return radioValue(slot.name) !== null;
}
function unitRequired(i, unit) { for (var s = 0; s < unit.slots.length; s++) if (isRequired(i, unit.slots[s])) return true; return false; }

function contextCard(f, value) {
  var body;
  if (Array.isArray(value)) {
    body = '<ol class="ctx-list">';
    for (var k = 0; k < value.length; k++) body += '<li>' + esc(value[k]) + '</li>';
    body += '</ol>';
  } else {
    body = '<div class="ctx-text' + (f.style === 'passage' ? ' ctx-passage' : '') + '">' + esc(value) + '</div>';
  }
  return '<div class="ctx-card"><div class="ctx-label">' + esc(f.label) + '</div>' + body + '</div>';
}
function questionLabel(q, key) {
  var note = '';
  if (q.required_when) note = ' <span class="req-note" data-req="' + esc(key) + '"></span>';
  else if (!q.required) note = ' <span class="req-note">(optional)</span>';
  return '<div class="question">' + q.text + note + '</div>';
}
function optionRow(name, q) {
  var h = '<div class="opt-row">';
  for (var o = 0; o < q.options.length; o++) {
    var opt = q.options[o];
    h += '<label class="opt"><input type="radio" name="' + esc(name) + '" value="' + esc(opt.value) + '"><span class="opt-btn">' + esc(opt.label) + '</span></label>';
  }
  return h + '</div>';
}
function likertRow(name, q) {
  var s = q.scale, h = '<div class="opt-row likert-row">';
  if (s.min_label) h += '<span class="likert-end">' + esc(s.min_label) + '</span>';
  for (var v = s.min; v <= s.max; v++) h += '<label class="opt"><input type="radio" name="' + esc(name) + '" value="' + v + '"><span class="opt-btn lk-btn">' + v + '</span></label>';
  if (s.max_label) h += '<span class="likert-end">' + esc(s.max_label) + '</span>';
  return h + '</div>';
}
function textBox(name, q) {
  var h = '<textarea class="ft" name="' + esc(name) + '" rows="3" placeholder="Type your answer here"></textarea>';
  if (q.min_chars > 0) h += '<div class="ft-count" data-for="' + esc(name) + '" data-min="' + q.min_chars + '">0 / ' + q.min_chars + ' characters minimum</div>';
  return h;
}
function widget(name, q) {
  if (q.type === 'likert') return likertRow(name, q);
  if (q.type === 'text') return textBox(name, q);
  return optionRow(name, q);
}
function targetBlock(i, block) {
  var targets = TARGETS[i];
  var h = '<div class="target-section"><div class="target-hdr">' + esc(LAYOUT.target_label) + ' (' + targets.length + ')</div>';
  for (var j = 0; j < targets.length; j++) {
    h += '<div class="target-card"><div class="target-num">' + esc(LAYOUT.target_label) + ' ' + (j + 1) + '</div>' +
      '<div class="target-text">' + esc(targets[j]) + '</div>';
    for (var k = 0; k < block.questions.length; k++) {
      var q = QS[block.questions[k]], name = nameOf(i, j, q);
      h += questionLabel(q, name) + widget(name, q);
    }
    h += '</div>';
  }
  return h + '</div>';
}
function multiBlock(i, q) {
  var targets = TARGETS[i], group = esc(groupOf(i, q));
  var h = '<div class="target-section"><div class="target-hdr">' + esc(LAYOUT.target_label) + ' (' + targets.length + ')</div>' +
    '<div class="multi-body">' + questionLabel(q, groupOf(i, q)) + '<div class="chk-list">';
  for (var j = 0; j < targets.length; j++) {
    h += '<label class="chk-opt"><input type="checkbox" name="' + esc(nameOf(i, j, q)) + '" value="' + esc(q.options[0].value) + '" data-group="' + group + '">' +
      '<span class="chk-num">' + (j + 1) + '</span><span class="chk-text">' + esc(targets[j]) + '</span></label>';
  }
  h += '<label class="chk-opt chk-none"><input type="checkbox" data-group="' + group + '" data-none="1"><span class="chk-text">' + esc(q.none_label) + '</span></label>';
  return h + '</div></div></div>';
}
function itemBlock(i, q) {
  var name = nameOf(i, null, q);
  return '<div class="q-card">' + questionLabel(q, name) + widget(name, q) + '</div>';
}
function itemHtml(i) {
  var h = '<div class="tab-inner"><h3 class="tab-title">Item ' + (i + 1) + ' / ' + TOTAL + '</h3>';
  for (var fi = 0; fi < LAYOUT.fields.length; fi++) {
    var f = LAYOUT.fields[fi];
    if (f.role !== 'context') continue;
    h += contextCard(f, DATA[f.name][i]);
  }
  for (var b = 0; b < LAYOUT.blocks.length; b++) {
    var block = LAYOUT.blocks[b];
    if (block.kind === 'targets') h += targetBlock(i, block);
    else if (block.kind === 'multi') h += multiBlock(i, QS[block.questions[0]]);
    else h += itemBlock(i, QS[block.questions[0]]);
  }
  return h + '</div>';
}

var SLOTS = [];
var UNITS = [];
for (var si = 0; si < TOTAL; si++) SLOTS.push(slotsOf(si));
for (var ui = 0; ui < TOTAL; ui++) UNITS.push(unitsOf(ui));

var tabsEl = document.getElementById('summary-tabs');
var TABS = [];
for (var i = 0; i < TOTAL; i++) {
  var tab = document.createElement('crowd-tab');
  tab.setAttribute('header', 'Item ' + (i + 1));
  tab.innerHTML = itemHtml(i);
  tabsEl.appendChild(tab);
  TABS.push(tab);
}

// 콘솔 미리보기가 읽는 답 칸 목록 (화면 순서). required_when이 있으면 required는 false다
window.TASK_ANSWER_SCHEMA = (function () {
  var out = [];
  for (var i = 0; i < TOTAL; i++) {
    for (var s = 0; s < SLOTS[i].length; s++) {
      var q = SLOTS[i][s].q;
      out.push({ name: SLOTS[i][s].name, type: q.type, values: q.values.slice(), required: !!q.required && !q.required_when });
    }
  }
  return out;
})();

var IND_BASE = 'display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border-radius:9px;margin-left:6px;color:#fff;font-size:11px;font-weight:700;';
var IND_STATE = { pending: 'background:#fbbf24;', partial: 'background:#f59e0b;', completed: 'background:#10b981;' };
function headerOf(i) {
  var tab = TABS[i];
  var el = tab.shadowRoot ? tab.shadowRoot.querySelector('[slot="header"]') : null;
  if (!el) el = tab.querySelector('[slot="header"]');
  if (!el && tabsEl && tabsEl.shadowRoot) {
    var items = tabsEl.shadowRoot.querySelectorAll('.menu a.item');
    if (items.length === TOTAL) el = items[i];
  }
  return el;
}
function updateTabStatus(i, answered, count) {
  var el = headerOf(i);
  if (!el) return;
  var state = answered === count ? 'completed' : (answered > 0 ? 'partial' : 'pending');
  var text = state === 'completed' ? '&#10003;' : (state === 'partial' ? answered + '/' + count : '&bull;');
  var wanted = 'Item ' + (i + 1) + ' <span class="tab-status" style="' + IND_BASE + IND_STATE[state] + '">' + text + '</span>';
  if (el.getAttribute('data-status') !== state) { el.innerHTML = wanted; el.setAttribute('data-status', state); }
}

function updateProgress() {
  var total = 0, done = 0, incomplete = [];
  for (var i = 0; i < TOTAL; i++) {
    var count = 0, answered = 0, units = UNITS[i];
    for (var u = 0; u < units.length; u++) {
      var required = unitRequired(i, units[u]);
      if (units[u].q.required_when) {
        var note = document.querySelector('.req-note[data-req="' + units[u].key + '"]');
        if (note) note.textContent = required ? '(required)' : '(optional)';
      }
      if (!required) continue;
      count++;
      if (isAnswered(i, units[u].slots[0])) answered++;
    }
    total += count; done += answered;
    if (answered < count) incomplete.push(i + 1);
    updateTabStatus(i, answered, count);
  }
  var pct = total === 0 ? 100 : Math.round(done / total * 100);
  var bar = document.getElementById('progressBar'); if (bar) bar.style.width = pct + '%';
  var pctEl = document.getElementById('progressPercentage'); if (pctEl) pctEl.innerText = pct + '%';
  var allDone = done === total;
  var btn = document.getElementById('submitButton');
  if (btn) { btn.disabled = !allDone; btn.className = allDone ? 'btn-enabled' : ''; }
  var msg = document.getElementById('incompleteContent');
  if (msg) {
    if (allDone) msg.innerHTML = '<strong class="msg-done">All items complete! You can now submit.</strong>';
    else msg.innerHTML = '<strong class="msg-left">' + (total - done) + ' answer(s) remaining &ndash; incomplete items: ' + incomplete.join(', ') + '</strong>';
  }
  return allDone;
}

function handleFormSubmit() {
  var result = [];
  var missing = 0;
  for (var i = 0; i < TOTAL; i++) {
    for (var s = 0; s < SLOTS[i].length; s++) {
      var slot = SLOTS[i][s], q = slot.q, required = isRequired(i, slot);
      if (q.type === 'multi_select') {
        if (groupAnswered(i, q)) result.push({ name: slot.name, value: boxChecked(slot.name) ? q.options[0].value : q.options[1].value });
        else if (required) missing++;
        continue;
      }
      if (q.type === 'text') {
        if (required && !isAnswered(i, slot)) { missing++; continue; }
        var text = textValue(slot.name);
        if (text) result.push({ name: slot.name, value: text });
        continue;
      }
      var value = radioValue(slot.name);
      if (value === null) { if (required) missing++; continue; }
      result.push({ name: slot.name, value: value });
    }
  }
  if (missing > 0 || result.length === 0) { updateProgress(); alert('Please answer every item before submitting.'); return; }
  var crowdForm = document.querySelector('crowd-form');
  if (!crowdForm) { alert('The form could not be found.'); return; }
  var hidden = crowdForm.querySelector('input[name="input_answers"]');
  if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'input_answers'; crowdForm.appendChild(hidden); }
  hidden.value = JSON.stringify(result);
  // 문항 입력의 name을 잠시 떼어 crowd-form이 input_answers만 보내게 한다
  var named = document.querySelectorAll('input[name^="general_"], textarea[name^="general_"]');
  for (var r = 0; r < named.length; r++) { named[r].setAttribute('data-bak', named[r].getAttribute('name') || ''); named[r].removeAttribute('name'); }
  crowdForm.submit();
  setTimeout(function () {
    for (var r = 0; r < named.length; r++) { var bak = named[r].getAttribute('data-bak'); if (bak) named[r].setAttribute('name', bak); named[r].removeAttribute('data-bak'); }
  }, 0);
}

// capture 단계에서 듣는다: crowd-html-elements가 입력의 change를 문서까지 올려 보내지 않고 자기 이벤트로 바꿔 낸다
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t) return;
  // multi_select: "해당 없음"을 체크하면 다른 칸을, 다른 칸을 체크하면 "해당 없음"을 지운다
  if (t.type === 'checkbox' && t.checked && t.getAttribute('data-group')) {
    var none = t.getAttribute('data-none') === '1';
    var boxes = document.querySelectorAll('input[type="checkbox"][data-group="' + t.getAttribute('data-group') + '"]');
    for (var b = 0; b < boxes.length; b++) if (boxes[b] !== t && (none || boxes[b].getAttribute('data-none') === '1')) boxes[b].checked = false;
  }
  if (t.type === 'radio' || t.type === 'checkbox') setTimeout(updateProgress, 10);
}, true);
document.addEventListener('input', function (e) {
  var t = e.target;
  if (!t || t.tagName !== 'TEXTAREA') return;
  var counter = document.querySelector('.ft-count[data-for="' + t.getAttribute('name') + '"]');
  if (counter) counter.textContent = textValue(t.getAttribute('name')).length + ' / ' + counter.getAttribute('data-min') + ' characters minimum';
  setTimeout(updateProgress, 10);
}, true);
if (tabsEl) tabsEl.addEventListener('click', function () { setTimeout(updateProgress, 50); });
document.addEventListener('DOMContentLoaded', function () { setTimeout(updateProgress, 50); setTimeout(updateProgress, 500); });
window.addEventListener('load', function () { setTimeout(updateProgress, 100); setTimeout(updateProgress, 1000); });
"""

STYLE = """body { margin:0; padding:0; font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif; line-height:1.7; color:#333; background:#f5f7fa; }
.entire-UI { max-width:1200px; margin:20px auto; padding:20px; background:#fff; box-shadow:0 0 20px rgba(0,0,0,.1); border-radius:12px; }
.panel-primary { border:1px solid #3b82f6; border-radius:8px; margin-bottom:20px; background:#fff; }
.panel-heading { background:linear-gradient(135deg,#3b82f6,#1d4ed8); color:#fff; padding:18px; font-size:22px; text-align:center; border-radius:8px 8px 0 0; }
.panel-body { padding:18px; }
.panel-body h3 { font-size:17px; color:#1e3a8a; margin:18px 0 6px; }
.panel-body p, .panel-body li { font-size:14.5px; }
.panel-body ol, .panel-body ul { margin:6px 0; padding-left:24px; }
.highlight-yellow { background:#fef3c7; padding:8px 12px; border-radius:6px; border-left:4px solid #f59e0b; display:inline-block; }
.highlight-remaining { background:#fff; }
.progress-label { font-size:12px; }
.crit-box { background:#f8fafc; border:2px solid #c7d2fe; border-radius:10px; padding:14px 18px; margin:8px 0 12px; }
.crit-row { margin-bottom:8px; font-size:14px; line-height:1.7; color:#374151; }
.crit-row:last-child { margin-bottom:0; }
.crit-label { display:inline-block; font-weight:700; padding:2px 10px; border-radius:12px; font-size:13px; background:#eef2ff; color:#4338ca; border:1px solid #c7d2fe; margin-right:6px; }
.notice-box { padding:12px 16px; border-radius:8px; margin-top:14px; font-size:13.5px; line-height:1.6; }
.notice-tip { background:#eff6ff; border:1px solid #93c5fd; color:#1e40af; }
.notice-attention { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; }
.notice-research { background:#f0fdf4; border:1px solid #86efac; color:#166534; }
#progressBarContainer { width:100%; background:#e5e7eb; margin:10px 0; border-radius:12px; overflow:hidden; }
#progressBar { width:0%; height:22px; background:linear-gradient(90deg,#10b981,#059669); position:relative; transition:width .4s; border-radius:12px; }
#progressPercentage { position:absolute; right:10px; top:50%; transform:translateY(-50%); color:#fff; font-size:12px; font-weight:700; }
#incompleteContent { font-size:15px; }
.msg-left { color:#dc2626; }
.msg-done { color:#10b981; }
.nav-hint { text-align:center; color:#64748b; font-size:14px; margin:16px 0; }
crowd-tabs#summary-tabs { border:none; border-radius:12px; box-shadow:0 4px 6px rgba(0,0,0,.07); }
.submit-row { text-align:center; margin-top:30px; }
#submitButton { background:#d1d5db; color:#6b7280; padding:14px 44px; border:none; border-radius:10px; font-size:17px; font-weight:700; cursor:not-allowed; transition:all .3s; }
.btn-enabled { background:linear-gradient(135deg,#3b82f6,#1d4ed8) !important; color:#fff !important; cursor:pointer !important; box-shadow:0 4px 10px rgba(59,130,246,.3); }
.btn-enabled:hover { background:linear-gradient(135deg,#2563eb,#1e40af) !important; transform:translateY(-1px); }
.tab-inner { padding:4px 0; display:flex; flex-direction:column; gap:18px; }
.tab-title { color:#1e40af; font-size:19px; font-weight:700; margin:0; padding-bottom:8px; border-bottom:2px solid #3b82f6; }
.ctx-card { border:2px solid #e5e7eb; border-radius:14px; overflow:hidden; }
.ctx-label { background:linear-gradient(135deg,#6366f1,#4f46e5); color:#fff; padding:10px 18px; font-weight:600; font-size:15px; }
.ctx-text { padding:14px 18px; font-size:14.5px; line-height:1.75; color:#1f2937; white-space:pre-wrap; word-wrap:break-word; background:#fafbfc; }
.ctx-passage { max-height:420px; overflow-y:auto; }
.ctx-list { margin:0; padding:14px 18px 14px 40px; font-size:14.5px; line-height:1.7; color:#1f2937; background:#fafbfc; }
.ctx-list li { margin-bottom:6px; }
.target-section { border:2px solid #8b5cf6; border-radius:14px; overflow:hidden; }
.target-hdr { background:linear-gradient(135deg,#8b5cf6,#7c3aed); color:#fff; padding:12px 20px; font-weight:700; font-size:16px; text-align:center; }
.target-card { background:#faf5ff; border-left:4px solid #8b5cf6; border-radius:0 12px 12px 0; padding:16px 20px; margin:16px 20px; }
.target-num { font-size:.82rem; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:#6d28d9; margin-bottom:6px; }
.target-text { font-size:15px; color:#1f2937; line-height:1.6; padding:10px 14px; background:#fff; border-radius:8px; border-left:4px solid #c4b5fd; margin-bottom:12px; white-space:pre-wrap; word-wrap:break-word; }
.question { font-size:14.5px; font-weight:600; color:#374151; margin-bottom:12px; }
.opt-row { display:flex; justify-content:center; gap:14px; flex-wrap:wrap; }
.opt { cursor:pointer; position:relative; }
.opt input[type="radio"] { position:absolute; opacity:0; width:0; height:0; }
.opt-btn { display:inline-block; padding:10px 32px; border-radius:10px; font-weight:700; font-size:15px; border:2px solid #93c5fd; color:#1d4ed8; background:#eff6ff; transition:all .2s; }
.opt:hover .opt-btn { transform:translateY(-2px); box-shadow:0 2px 8px rgba(0,0,0,.1); }
.opt input:checked + .opt-btn { background:#2563eb; color:#fff; border-color:#2563eb; box-shadow:0 4px 12px rgba(37,99,235,.3); }
.opt input:focus-visible + .opt-btn { outline:3px solid #fbbf24; }
.opt-row + .question, .ft + .question, .ft-count + .question { margin-top:18px; }
.req-note { font-weight:400; font-size:13px; color:#6b7280; }
.likert-row { align-items:center; }
.likert-end { font-size:13px; color:#6b7280; }
.lk-btn { padding:8px 16px; min-width:20px; text-align:center; }
.ft { display:block; width:100%; box-sizing:border-box; min-height:72px; padding:10px 12px; border:2px solid #c7d2fe; border-radius:10px; font:inherit; font-size:14.5px; resize:vertical; }
.ft:focus { outline:none; border-color:#6366f1; }
.ft-count { font-size:12px; color:#6b7280; text-align:right; margin-top:4px; }
.multi-body { padding:16px 20px; }
.chk-list { display:flex; flex-direction:column; gap:10px; }
.chk-opt { display:flex; align-items:flex-start; gap:12px; padding:12px 16px; background:#faf5ff; border:2px solid #ddd6fe; border-radius:10px; cursor:pointer; }
.chk-opt:has(input:checked) { background:#ede9fe; border-color:#7c3aed; }
.chk-opt input { flex:none; width:18px; height:18px; margin:3px 0 0; accent-color:#7c3aed; }
.chk-num { flex:none; min-width:18px; font-weight:700; color:#6d28d9; }
.chk-text { font-size:15px; color:#1f2937; line-height:1.6; white-space:pre-wrap; word-wrap:break-word; }
.chk-none { background:#fff; border-style:dashed; }
.q-card { border:2px solid #c7d2fe; border-radius:14px; padding:16px 20px; background:#f8fafc; }
@media(max-width:768px) { .entire-UI { margin:10px; padding:14px; } .opt-row { gap:10px; } .opt-btn { padding:8px 22px; font-size:14px; } .target-card { margin:12px 10px; } }
"""
