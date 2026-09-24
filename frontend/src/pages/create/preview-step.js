// Create (4) Preview & Cost: 선택한 행으로 템플릿을 렌더해 worker 화면 그대로 보여 주고(components/preview-frame.js), 비용을 견적한다.

import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { errorNotice, muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { table } from '../../components/table.js';
import { formatCents, rewardToCents } from '../../lib/cost.js';
import { balanceCentsOf } from '../../lib/settings.js';
import { stepFooter } from './common.js';

const VISIBLE_FIELDS = 10;
const FRAME_HEIGHT = 640;

function costPanel(ctx) {
  const { draft, estimate, account, accountError } = ctx;
  const rowCount = draft.data.rows.length;
  const settings = draft.settings;
  const balanceCents = balanceCentsOf(account);
  const overBalance = estimate !== null && balanceCents !== null && estimate.totalCents > balanceCents;
  const assignments = rowCount * settings.MaxAssignments;

  let body;
  if (estimate) {
    const rows = [
      { key: 'reward', item: 'Reward subtotal', detail: `${rowCount.toLocaleString('en-US')} HITs × ${settings.MaxAssignments} assignments × ${formatCents(rewardToCents(settings.Reward))}`, amount: formatCents(estimate.rewardCents) },
      { key: 'fee', item: `MTurk fee (${estimate.feePercent}%)`, detail: `${assignments.toLocaleString('en-US')} assignments × ${estimate.feePercent}% of the reward (at least $0.01 each)`, amount: formatCents(estimate.feeCents) },
      { key: 'total', item: el('strong', {}, 'Total'), detail: 'Held from the balance when the batch is published', amount: el('strong', {}, formatCents(estimate.totalCents)) },
      {
        key: 'balance',
        item: 'Available balance',
        detail: el('span', { className: 'muted' }, balanceCents === null || overBalance ? '' : `${formatCents(balanceCents - estimate.totalCents)} left after publishing`),
        amount: balanceCents === null ? '…' : formatCents(balanceCents),
      },
    ];
    body = table({
      columns: [
        { title: 'Item', width: 200, render: (r) => r.item },
        { title: 'Calculation', render: (r) => r.detail },
        { title: 'Amount', width: 120, align: 'right', className: 'tabular', render: (r) => r.amount },
      ],
      rows,
      rowKey: (r) => r.key,
      rowAttrs: (r) => ({ dataset: { cost: r.key } }),
      className: 'cost-table',
    });
  } else {
    body = notice('error', 'The cost cannot be estimated. Go back to Settings and check Reward and MaxAssignments.');
  }
  return el(
    'div',
    { className: 'card', id: 'cost-panel' },
    el('h4', { className: 'card-title' }, 'Cost estimate'),
    accountError ? errorNotice(accountError, 'Account') : null,
    body,
    muted('Top-ups after rejections are not included.'),
    overBalance ? notice('error', `The total ${formatCents(estimate.totalCents)} exceeds the available balance ${formatCents(balanceCents)}.`, 'Lower the reward or MaxAssignments, or use fewer rows.') : null,
  );
}

function answerFieldsBody(ctx) {
  const { answerSchema, settings } = ctx.draft;
  if (answerSchema.length === 0) {
    return muted('None yet. Fields are read from the radio buttons, checkboxes and selects in the preview below. A template that draws a question only after a click reports it once you open that question. This list is optional.');
  }
  const attentionFields = settings.attentionEnabled ? answerSchema.filter((f) => f.name.startsWith(settings.attentionPrefix)) : [];
  const expectedMissing = attentionFields.filter((f) => !f.values.includes(settings.attentionExpected));
  const choices = [...new Set(answerSchema.flatMap((f) => f.values))];
  return [
    el('p', {}, `${answerSchema.length} field(s)${settings.attentionEnabled ? `, ${attentionFields.length} of them attention checks` : ''}. Used to generate fake submissions in the mock environment.`),
    el(
      'div',
      { className: 'answer-field-list' },
      answerSchema.slice(0, VISIBLE_FIELDS).map((f) => tag(f.name, attentionFields.includes(f) ? 'gold' : 'default', { className: 'answer-field mono', dataset: { field: f.name } })),
      answerSchema.length > VISIBLE_FIELDS ? el('span', { className: 'muted' }, `+${answerSchema.length - VISIBLE_FIELDS} more`) : null,
    ),
    choices.length > 0 ? muted(`Choices: ${choices.slice(0, VISIBLE_FIELDS).join(', ')}${choices.length > VISIBLE_FIELDS ? ', …' : ''}`) : null,
    settings.attentionEnabled && attentionFields.length === 0 ? notice('warning', `No field name starts with "${settings.attentionPrefix}". Check the attention rule in Settings.`) : null,
    expectedMissing.length > 0 ? notice('warning', `"${settings.attentionExpected}" is not one of the choices of ${expectedMissing[0].name} (${expectedMissing[0].values.join(', ')}).`) : null,
  ];
}

export function renderPreviewStep(ctx) {
  const { draft, template, estimate, account } = ctx;
  const rowCount = draft.data.rows.length;
  const index = Math.min(Math.max(0, draft.previewRow), rowCount - 1);
  const row = draft.data.rows[index];
  const goToRow = (next) => ctx.update({ previewRow: Math.min(Math.max(0, next), rowCount - 1) });

  const balanceCents = balanceCentsOf(account);
  const overBalance = estimate !== null && balanceCents !== null && estimate.totalCents > balanceCents;

  const answerBody = el('div', { id: 'answer-fields-body' }, answerFieldsBody(ctx));
  // 템플릿이 JS 로 문항을 그리는 동안에는 빈 목록이 먼저 온다. 이미 읽은 목록을 빈 값으로 덮지 않는다.
  const onSchema = (fields) => {
    const current = ctx.draft.answerSchema;
    if (fields.length === 0 && current.length > 0) return;
    ctx.update({ answerSchema: fields }, { rerender: false });
    answerBody.replaceChildren(...[answerFieldsBody(ctx)].flat().filter(Boolean));
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
    el(
      'div',
      { className: 'two-col' },
      costPanel(ctx),
      el('div', { className: 'card', id: 'answer-fields' }, el('h4', { className: 'card-title' }, 'Answer fields found in this row'), answerBody),
    ),
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
      stepFooter({
        onBack: () => ctx.goTo(2),
        onNext: () => ctx.goTo(4),
        nextDisabled: overBalance || estimate === null,
        hint: overBalance ? 'The total exceeds the available balance.' : undefined,
      }),
    ),
  );
  return { node, cleanup: frame.destroy };
}
