"""spec → MTurk crowd-form 템플릿(template.html).

    render_template(spec)     HTML 문자열
    run_render(spec, out_dir) template.html 저장, 경로 반환

데이터 주입은 `${컬럼}` 치환만 쓴다 (MTurk Requester 웹사이트와 콘솔이 같은 방식으로 치환한다). HTML 안의
`${identifier}`는 정확히 hit_id, attention, spec의 필드 이름들뿐이다. 그래서 JS 템플릿 리터럴은 쓰지 않고,
spec의 어떤 문자열에도 `${`가 들어 있으면 ValueError를 낸다.

화면 구성과 CSS는 연구실의 이전 템플릿을 따른다: Instructions 패널 → 진행률 바 → 탭(항목마다 하나) → Submit.
탭 안의 모든 데이터는 JS의 esc()로 escape해서 넣는다. spec에서 오는 문구(instructions)는 여기서 escape하고
**굵게**만 <strong>으로 바꾼다.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from agent.spec import TaskSpec, spec_to_dict

TEMPLATE_FILE = "template.html"
SIZE_TARGET = 40 * 1024
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def rich(text: str) -> str:
    """escape한 뒤 **굵게**만 <strong>으로 바꾼다."""
    return BOLD_RE.sub(r"<strong>\1</strong>", html.escape(text, quote=True))


def layout_json(spec: TaskSpec) -> str:
    """LAYOUT 상수: 필드 순서·label·role·style, 질문, 옵션, 답 접미어, 제목. `<`는 \\u003c로 escape한다."""
    target = spec.target_field
    layout = {
        "title": spec.task.title,
        "fields": [{"name": f.name, "label": f.label, "role": f.role, "style": f.style} for f in spec.item.fields.values()],
        "target": target.name,
        "target_label": target.label,
        "question": spec.item.question.text,
        "options": [{"value": o.value, "label": o.label} for o in spec.item.question.options],
        "answer_suffix": spec.item.question.answer_suffix,
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
        "var ATTENTION = ${attention};\n",
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
var ATT = asList(ATTENTION);
var DATA = {};
for (var fi = 0; fi < LAYOUT.fields.length; fi++) { var fname = LAYOUT.fields[fi].name; DATA[fname] = asList(FIELDS[fname]); }
var TOTAL = DATA[LAYOUT.target].length;
var TARGETS = [];
for (var ti = 0; ti < TOTAL; ti++) TARGETS.push(asList(DATA[LAYOUT.target][ti]));
var SUFFIX = LAYOUT.answer_suffix || '';
function nameOf(i, j) { return (Number(ATT[i]) === 1 ? 'attention_' : 'general_') + i + '_' + (j + 1) + SUFFIX; }
function isAnswered(name) { return !!document.querySelector('input[type="radio"][name="' + name + '"]:checked'); }

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
function optionRow(name) {
  var h = '<div class="opt-row">';
  for (var o = 0; o < LAYOUT.options.length; o++) {
    var opt = LAYOUT.options[o];
    h += '<label class="opt"><input type="radio" name="' + esc(name) + '" value="' + esc(opt.value) + '"><span class="opt-btn">' + esc(opt.label) + '</span></label>';
  }
  return h + '</div>';
}
function itemHtml(i) {
  var h = '<div class="tab-inner"><h3 class="tab-title">Item ' + (i + 1) + ' / ' + TOTAL + '</h3>';
  for (var fi = 0; fi < LAYOUT.fields.length; fi++) {
    var f = LAYOUT.fields[fi];
    if (f.role !== 'context') continue;
    h += contextCard(f, DATA[f.name][i]);
  }
  var targets = TARGETS[i];
  h += '<div class="target-section"><div class="target-hdr">' + esc(LAYOUT.target_label) + ' (' + targets.length + ')</div>';
  for (var j = 0; j < targets.length; j++) {
    h += '<div class="target-card"><div class="target-num">' + esc(LAYOUT.target_label) + ' ' + (j + 1) + '</div>' +
      '<div class="target-text">' + esc(targets[j]) + '</div>' +
      '<div class="question">' + esc(LAYOUT.question) + '</div>' + optionRow(nameOf(i, j)) + '</div>';
  }
  return h + '</div></div>';
}

var tabsEl = document.getElementById('summary-tabs');
var TABS = [];
for (var i = 0; i < TOTAL; i++) {
  var tab = document.createElement('crowd-tab');
  tab.setAttribute('header', 'Item ' + (i + 1));
  tab.innerHTML = itemHtml(i);
  tabsEl.appendChild(tab);
  TABS.push(tab);
}

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
  var state = count > 0 && answered === count ? 'completed' : (answered > 0 ? 'partial' : 'pending');
  var text = state === 'completed' ? '&#10003;' : (state === 'partial' ? answered + '/' + count : '&bull;');
  var wanted = 'Item ' + (i + 1) + ' <span class="tab-status" style="' + IND_BASE + IND_STATE[state] + '">' + text + '</span>';
  if (el.getAttribute('data-status') !== state) { el.innerHTML = wanted; el.setAttribute('data-status', state); }
}

function updateProgress() {
  var total = 0, done = 0, incomplete = [];
  for (var i = 0; i < TOTAL; i++) {
    var count = TARGETS[i].length, answered = 0;
    for (var j = 0; j < count; j++) if (isAnswered(nameOf(i, j))) answered++;
    total += count; done += answered;
    if (answered < count) incomplete.push(i + 1);
    updateTabStatus(i, answered, count);
  }
  var pct = total === 0 ? 0 : Math.round(done / total * 100);
  var bar = document.getElementById('progressBar'); if (bar) bar.style.width = pct + '%';
  var pctEl = document.getElementById('progressPercentage'); if (pctEl) pctEl.innerText = pct + '%';
  var allDone = total > 0 && done === total;
  var btn = document.getElementById('submitButton');
  if (btn) { btn.disabled = !allDone; btn.className = allDone ? 'btn-enabled' : ''; }
  var msg = document.getElementById('incompleteContent');
  if (msg) {
    if (allDone) msg.innerHTML = '<strong class="msg-done">All items complete! You can now submit.</strong>';
    else if (total > 0) msg.innerHTML = '<strong class="msg-left">' + (total - done) + ' answer(s) remaining &ndash; incomplete items: ' + incomplete.join(', ') + '</strong>';
  }
  return allDone;
}

function handleFormSubmit() {
  var result = [];
  var missing = 0;
  for (var i = 0; i < TOTAL; i++) {
    for (var j = 0; j < TARGETS[i].length; j++) {
      var name = nameOf(i, j);
      var checked = document.querySelector('input[type="radio"][name="' + name + '"]:checked');
      if (!checked) { missing++; continue; }
      result.push({ name: name, value: checked.value });
    }
  }
  if (missing > 0 || result.length === 0) { updateProgress(); alert('Please answer every item before submitting.'); return; }
  var crowdForm = document.querySelector('crowd-form');
  if (!crowdForm) { alert('The form could not be found.'); return; }
  var hidden = crowdForm.querySelector('input[name="input_answers"]');
  if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'input_answers'; crowdForm.appendChild(hidden); }
  hidden.value = JSON.stringify(result);
  var radios = document.querySelectorAll('input[type="radio"]');
  for (var r = 0; r < radios.length; r++) { radios[r].setAttribute('data-bak', radios[r].getAttribute('name') || ''); radios[r].removeAttribute('name'); }
  crowdForm.submit();
  setTimeout(function () {
    for (var r = 0; r < radios.length; r++) { var bak = radios[r].getAttribute('data-bak'); if (bak) radios[r].setAttribute('name', bak); radios[r].removeAttribute('data-bak'); }
  }, 0);
}

document.addEventListener('change', function (e) { if (e.target && e.target.type === 'radio') setTimeout(updateProgress, 10); });
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
@media(max-width:768px) { .entire-UI { margin:10px; padding:14px; } .opt-row { gap:10px; } .opt-btn { padding:8px 22px; font-size:14px; } .target-card { margin:12px 10px; } }
"""
