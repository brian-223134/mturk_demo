// Publish Batch (2) Preview tasks: CSV 의 행을 하나씩 골라 Project 의 layout 으로 그린 worker 화면 그대로 보여 준다
// (components/preview-frame.js, MTurk 의 "Preview" 와 같다). 미리보기가 보고한 답 칸 목록은 batch 의 answerSchema 로 저장된다.
// 비용 견적은 (4) Confirm and publish 에 있다 (publish-step.js).

import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { checkAnswerFields } from '../../lib/answer-fields.js';
import { stepFooter } from './common.js';

const VISIBLE_FIELDS = 10;
const FRAME_HEIGHT = 640;

/** row 는 미리보기 중인 CSV 행이다. column 방식 attention 은 행마다 기대 답이 다르므로 그 행의 셀로 검사한다. */
function answerFieldsBody(ctx, row) {
  const { answerSchema, settings } = ctx.draft;
  if (answerSchema.length === 0) {
    return muted('None yet. Fields come from window.TASK_ANSWER_SCHEMA when the layout declares it (layouts built with <ann-*> elements always do), otherwise from the radio buttons, checkboxes and selects in the preview below. A layout that draws a question only after a click reports it once you open that question. This list is optional.');
  }
  const { attention, freeText, warnings } = checkAnswerFields(answerSchema, settings, row);
  const choices = [...new Set(answerSchema.flatMap((f) => f.values))];
  const counts = [
    settings.attentionEnabled ? `${attention.size} of them attention checks${settings.attentionMode === 'column' ? ' in this row' : ''}` : null,
    freeText.size > 0 ? `${freeText.size} free text` : null,
  ].filter(Boolean);
  const color = (name) => (attention.has(name) ? 'gold' : freeText.has(name) ? 'blue' : 'default');
  return [
    el('p', {}, `${answerSchema.length} field(s)${counts.length > 0 ? `, ${counts.join(', ')}` : ''}. Saved with the batch as its answer schema; the console uses it only to show and check the fields here.`),
    el(
      'div',
      { className: 'answer-field-list' },
      answerSchema.slice(0, VISIBLE_FIELDS).map((f) => tag(f.name, color(f.name), { className: 'answer-field mono', dataset: { field: f.name }, title: f.type ? `${f.type}${f.required === false ? ', optional' : ''}` : undefined })),
      answerSchema.length > VISIBLE_FIELDS ? el('span', { className: 'muted' }, `+${answerSchema.length - VISIBLE_FIELDS} more`) : null,
    ),
    choices.length > 0 ? muted(`Choices: ${choices.slice(0, VISIBLE_FIELDS).join(', ')}${choices.length > VISIBLE_FIELDS ? ', …' : ''}`) : null,
    warnings.map((message) => notice('warning', message)),
  ];
}

export function renderPreviewStep(ctx) {
  const { draft, template } = ctx;
  const rowCount = draft.data.rows.length;
  const index = Math.min(Math.max(0, draft.previewRow), rowCount - 1);
  const row = draft.data.rows[index];
  const goToRow = (next) => ctx.update({ previewRow: Math.min(Math.max(0, next), rowCount - 1) });

  const answerBody = el('div', { id: 'answer-fields-body' }, answerFieldsBody(ctx, row));
  // 템플릿이 JS 로 문항을 그리는 동안에는 빈 목록이 먼저 온다. 이미 읽은 목록을 빈 값으로 덮지 않는다.
  const onSchema = (fields) => {
    const current = ctx.draft.answerSchema;
    if (fields.length === 0 && current.length > 0) return;
    ctx.update({ answerSchema: fields }, { rerender: false });
    answerBody.replaceChildren(...[answerFieldsBody(ctx, row)].flat(2).filter(Boolean));
  };

  const frame = previewFrame({ html: template.html, row, height: FRAME_HEIGHT, onSchema });

  const rowInput = el('input', { type: 'number', id: 'preview-row', min: 1, max: rowCount, step: 1, value: String(index + 1), 'aria-label': 'Row number' });
  rowInput.addEventListener('change', () => {
    const value = Number.parseInt(rowInput.value, 10);
    if (Number.isInteger(value)) goToRow(value - 1);
  });

  const node = el(
    'div',
    { className: 'step', id: 'step-preview' },
    el('div', { className: 'card', id: 'answer-fields' }, el('h4', { className: 'card-title' }, 'Answer fields found in this row'), answerBody),
    el(
      'section',
      { className: 'panel', id: 'task-preview' },
      el(
        'div',
        { className: 'panel-head' },
        el('h3', { className: 'panel-title' }, 'Task preview'),
        el(
          'div',
          { className: 'row-nav' },
          el('button', { type: 'button', className: 'btn btn-small', id: 'prev-row', disabled: index === 0, onClick: () => goToRow(index - 1) }, '‹ Prev row'),
          el('span', {}, 'Row'),
          rowInput,
          el('span', { id: 'row-count' }, `of ${rowCount.toLocaleString('en-US')}`),
          el('button', { type: 'button', className: 'btn btn-small', id: 'next-row', disabled: index >= rowCount - 1, onClick: () => goToRow(index + 1) }, 'Next row ›'),
        ),
      ),
      muted(`This is the page a worker sees for row ${index + 1}. It runs in a sandboxed iframe; Submit is intercepted and nothing is sent.`),
      frame.node,
    ),
    el(
      'section',
      { className: 'panel step-footer-panel' },
      stepFooter({ onBack: () => ctx.goTo(0), onNext: () => ctx.goTo(2) }),
    ),
  );
  return { node, cleanup: frame.destroy };
}
