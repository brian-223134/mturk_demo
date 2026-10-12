// Project 편집기 (2) Design Layout. 왼쪽은 템플릿 HTML 편집기(요소 넣기, 파일 올리기, 검사 결과, 변수의 표본 값), 오른쪽은
// 표본 행으로 그린 worker 화면(입력을 멈추면 다시 그린다)과 미리보기가 보고한 답 칸 목록이다.
// 편집은 change({ html }) / change({ sampleRow }) 로 편집기 상태에 바로 쓰고(이 탭을 다시 그리지 않는다), 검사와 미리보기만 고친다.

import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { ELEMENT_REFERENCE } from '../../lib/element-reference.js';
import { ELEMENTS_SCRIPT, lintLayout } from '../../lib/layout-lint.js';
import { failureNotice } from './common.js';

const PREVIEW_DELAY_MS = 700;
const LINT_DELAY_MS = 250;
const PREVIEW_HEIGHT = 760;
const TEMPLATE_FILE_TYPES = '.html,.htm,.txt,.py'; // 케이스 스터디의 템플릿 파일은 확장자만 .py 이고 내용은 HTML 이다
const LEVEL_TAGS = { error: ['red', 'ERROR'], warning: ['gold', 'WARN'], info: ['blue', 'INFO'] };
const TYPE_LABELS = { choice: 'choice', likert: 'scale', multi_select: 'checkbox', text: 'text' };

/** 미리보기에 넣을 행: 값이 있는 변수만. 비어 있는 변수는 `${이름}` 그대로 보여 빠진 표본을 알린다 (MTurk 의 미리보기와 같다). */
export function previewRow(sampleRow) {
  return Object.fromEntries(Object.entries(sampleRow ?? {}).filter(([, value]) => typeof value === 'string' && value !== ''));
}

/** 답 칸 목록 (미리보기가 보고한 것). */
export function answerFieldList(fields) {
  if (fields.length === 0) return muted('No answer fields yet. Questions appear here once the preview has drawn them.');
  return el(
    'div',
    { className: 'answer-field-list' },
    fields.map((f) =>
      el(
        'span',
        { className: 'answer-field-chip', dataset: { field: f.name }, title: (f.values ?? []).length > 0 ? `Values: ${f.values.join(', ')}` : 'Free text' },
        el('code', {}, f.name),
        el('span', { className: 'muted small' }, ` ${TYPE_LABELS[f.type] ?? 'field'}${f.required === false ? ', optional' : ''}`),
      ),
    ),
  );
}

/** layout 검사 결과 목록. */
export function lintList(result) {
  if (result.problems.length === 0) {
    return el('div', { className: 'check-line check-ok' }, tag('OK', 'green', { className: 'check-tag' }), el('div', { className: 'check-body' }, `No problems found. ${result.questions.length} question element(s).`));
  }
  return result.problems.map((problem) => {
    const [color, label] = LEVEL_TAGS[problem.level];
    return el('div', { className: `check-line check-${problem.level === 'warning' ? 'warn' : problem.level}`, dataset: { level: problem.level } }, tag(label, color, { className: 'check-tag' }), el('div', { className: 'check-body' }, problem.message));
  });
}

function referencePanel() {
  return el(
    'details',
    { className: 'element-reference', id: 'element-reference' },
    el('summary', {}, 'Element reference'),
    el('p', { className: 'muted small' }, 'Load the elements once at the top of the layout: ', el('code', {}, `<script src="${ELEMENTS_SCRIPT}"></script>`), '. Put every question inside ', el('code', {}, '<ann-form>'), '.'),
    ELEMENT_REFERENCE.map((item) =>
      el(
        'div',
        { className: 'element-ref-item' },
        el('div', {}, el('code', { className: 'element-ref-tag' }, `<${item.tag}>`), ' ', el('span', {}, item.summary)),
        el('dl', { className: 'element-ref-attrs' }, item.attributes.flatMap(([name, text]) => [el('dt', {}, el('code', {}, name)), el('dd', {}, text)])),
      ),
    ),
  );
}

/**
 * renderLayoutTab({ draft, change, signal, footer }) → { node, cleanup }
 *  - draft(): 지금의 편집 값 { html, sampleRow, … }, change(patch): 편집 값을 바꾼다 (탭을 다시 그리지 않는다)
 *  - footer: 탭 아래의 이동 버튼 줄 (편집기가 만든다)
 */
export function renderLayoutTab({ draft, change, signal, footer }) {
  const errorSlot = el('div', { id: 'layout-error' });
  const htmlInput = el('textarea', { id: 'layout-html', className: 'code-editor', spellcheck: 'false', autocomplete: 'off', wrap: 'off', rows: 30, 'aria-label': 'Layout HTML', placeholder: `<script src="${ELEMENTS_SCRIPT}"></script>\n<ann-form>\n  …\n</ann-form>` });
  htmlInput.value = draft().html;
  const sizeText = el('span', { className: 'muted small', id: 'layout-size' });
  const lintBody = el('div', { className: 'check-list', id: 'layout-checks' });
  const variablesBody = el('div', { id: 'layout-variables' });
  const previewHolder = el('div', { id: 'layout-preview' });
  const fieldsBody = el('div', { id: 'layout-fields' });
  let frame = null;
  let shownPlaceholders = null;
  let lintTimer = null;
  let previewTimer = null;

  function refreshLint() {
    const result = lintLayout(draft().html);
    lintBody.replaceChildren(...[lintList(result)].flat());
    const lines = draft().html.split('\n').length;
    sizeText.textContent = `${lines.toLocaleString('en-US')} lines, ${draft().html.length.toLocaleString('en-US')} characters`;
    // 변수 목록은 이름이 바뀔 때만 다시 그린다 (표본 값을 치는 중에 칸이 다시 만들어지지 않게)
    const key = result.placeholders.join('\n');
    if (key !== shownPlaceholders) {
      shownPlaceholders = key;
      renderVariables(result.placeholders);
    }
  }

  function renderVariables(names) {
    if (names.length === 0) {
      variablesBody.replaceChildren(muted('The layout reads no ${column} variables. Values from the CSV can also be read from window.TASK_DATA.'));
      return;
    }
    variablesBody.replaceChildren(
      muted('Sample values for the preview only. When you publish a batch, each CSV row fills these variables.'),
      ...names.map((name) => {
        const input = el('textarea', { className: 'variable-value', id: `var-${name}`, rows: 2, spellcheck: 'false', 'aria-label': `Sample value of ${name}`, dataset: { variable: name } });
        input.value = draft().sampleRow[name] ?? '';
        input.addEventListener('input', () => {
          change({ sampleRow: { ...draft().sampleRow, [name]: input.value } });
          schedulePreview();
        });
        return el('div', { className: 'variable-row' }, el('label', { for: `var-${name}` }, el('code', { className: 'placeholder' }, `\${${name}}`)), input);
      }),
    );
  }

  function refreshPreview() {
    if (frame) frame.destroy();
    const { html, sampleRow } = draft();
    if (html.trim() === '') {
      frame = null;
      previewHolder.replaceChildren(muted('The preview appears here when the layout has some HTML.'));
      fieldsBody.replaceChildren(answerFieldList([]));
      return;
    }
    fieldsBody.replaceChildren(answerFieldList([]));
    frame = previewFrame({
      html,
      row: previewRow(sampleRow),
      height: PREVIEW_HEIGHT,
      onSchema: (fields) => fieldsBody.replaceChildren(answerFieldList(fields)),
    });
    previewHolder.replaceChildren(frame.node);
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY_MS);
  }
  function scheduleLint() {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(refreshLint, LINT_DELAY_MS);
  }

  function setHtml(html) {
    change({ html });
    scheduleLint();
    schedulePreview();
  }

  htmlInput.addEventListener('input', () => setHtml(htmlInput.value));
  // Tab 은 칸을 벗어나지 않고 공백 두 칸을 넣는다 (Shift+Tab 과 Esc 다음 Tab 은 그대로 둔다)
  let escaped = false;
  htmlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      escaped = true;
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !escaped) {
      event.preventDefault();
      htmlInput.setRangeText('  ', htmlInput.selectionStart, htmlInput.selectionEnd, 'end');
      setHtml(htmlInput.value);
    }
    escaped = false;
  });

  // ── 도구 줄 ──
  const insert = el('select', { id: 'insert-element', 'aria-label': 'Insert an element' }, el('option', { value: '' }, 'Insert element…'), ELEMENT_REFERENCE.map((item, index) => el('option', { value: String(index) }, `<${item.tag}>`)));
  insert.addEventListener('change', () => {
    const item = ELEMENT_REFERENCE[Number(insert.value)];
    insert.value = '';
    if (!item) return;
    htmlInput.focus();
    htmlInput.setRangeText(item.snippet, htmlInput.selectionStart, htmlInput.selectionEnd, 'end');
    setHtml(htmlInput.value);
  });
  const addScript = el('button', { type: 'button', className: 'btn btn-small', id: 'insert-script', title: 'Insert the script tag that loads the <ann-*> elements' }, 'Insert script tag');
  addScript.addEventListener('click', () => {
    htmlInput.value = `<script src="${ELEMENTS_SCRIPT}"></script>\n${htmlInput.value}`;
    setHtml(htmlInput.value);
  });
  const fileInput = el('input', { type: 'file', id: 'layout-file', accept: TEMPLATE_FILE_TYPES, className: 'visually-hidden' });
  const fileButton = el('label', { className: 'btn btn-small', for: 'layout-file' }, 'Upload .html');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const html = await file.text();
      if (signal.aborted) return;
      if (draft().html.trim() !== '' && !window.confirm(`Replace the current layout with ${file.name}?`)) return;
      htmlInput.value = html;
      setHtml(html);
      errorSlot.replaceChildren(notice('success', `Loaded ${file.name}.`));
    } catch (error) {
      errorSlot.replaceChildren(failureNotice(`Could not read ${file.name}`, error));
    }
  });

  const node = el(
    'div',
    { className: 'layout-tab', id: 'tab-layout' },
    errorSlot,
    el(
      'div',
      { className: 'layout-split' },
      el(
        'section',
        { className: 'panel layout-editor-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Layout HTML'), sizeText),
        el('div', { className: 'layout-toolbar' }, insert, addScript, fileButton, fileInput),
        htmlInput,
        referencePanel(),
        el('h4', { className: 'section-title' }, 'Checks'),
        lintBody,
        el('h4', { className: 'section-title' }, 'Variables'),
        variablesBody,
      ),
      el(
        'section',
        { className: 'panel layout-preview-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Preview'), el('button', { type: 'button', className: 'btn btn-small', id: 'refresh-preview', onClick: refreshPreview }, 'Refresh')),
        muted('What a worker sees, filled with the sample values. Submit is intercepted and nothing is sent.'),
        previewHolder,
        el('h4', { className: 'section-title' }, 'Answer fields'),
        fieldsBody,
      ),
    ),
    footer,
  );

  refreshLint();
  refreshPreview();
  return {
    node,
    cleanup: () => {
      clearTimeout(lintTimer);
      clearTimeout(previewTimer);
      if (frame) frame.destroy();
    },
  };
}
