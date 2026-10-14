// Publish Batch (4) Confirm and publish: 비용 견적과 요약을 확인하고 게시한다 (MTurk 의 "Confirm and publish batch").
// 게시 후에는 해당 batch 의 Overview(/manage/<id>)로 간다.

import { api } from '../../api-client/client.js';
import { envBadge, tag } from '../../components/badges.js';
import { el, join } from '../../components/dom.js';
import { errorNotice, muted, notice } from '../../components/notice.js';
import { table } from '../../components/table.js';
import { formatCents, rewardToCents } from '../../lib/cost.js';
import { balanceCentsOf, buildCreateBatchRequest, describeQualifications, normalizeSuffixes, toAttentionRule, toHitSettings, toReviewReference } from '../../lib/settings.js';
import { workerColumns } from '../../lib/worker-tasks.js';
import { navigate } from '../../router.js';
import { descList, failureNotice, field, refreshBalance } from './common.js';

function plural(count, unit) {
  return `${count.toLocaleString('en-US')} ${unit}${count === 1 ? '' : 's'}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** 오늘 날짜 "YYYY-MM-DD" (로컬). */
export function todayText(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** attention 규칙 한 줄. 접두어 방식과 기대 답 컬럼 방식을 모두 설명한다. */
function attentionRuleText(rule) {
  if (!rule) return el('span', { className: 'muted' }, 'None');
  const pass = `; pass at ${Math.round(rule.minCorrectRatio * 100)}% correct or more`;
  if (typeof rule.column === 'string') {
    return el('span', {}, 'Answers listed in the input column ', el('code', {}, rule.column), ' of each HIT must equal their expected values', pass);
  }
  return el('span', {}, 'Answers named ', el('code', {}, `${rule.namePrefix}*`), ' must be ', el('code', {}, rule.expectedValue), pass);
}

/** worker 의 작업 화면에 보낼 입력 컬럼. 나머지(정답이 든 컬럼, 템플릿이 쓰지 않는 컬럼)는 worker 에게 보내지 않는다. */
function workerColumnsText({ visible, hidden }) {
  return el(
    'span',
    { id: 'worker-columns' },
    visible.length > 0 ? join(visible.map((c) => el('code', {}, c))) : el('span', { className: 'muted' }, 'No input columns'),
    hidden.length > 0 ? el('span', { className: 'muted' }, '; not sent to workers: ', join(hidden.map((c) => el('code', {}, c)))) : null,
  );
}

/** 비용 견적 표: 보상 소계, 수수료, 합계, 잔액. */
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
      { key: 'fee', item: `Fee (${estimate.feePercent}%)`, detail: `${assignments.toLocaleString('en-US')} assignments × ${estimate.feePercent}% of the reward (at least $0.01 each)`, amount: formatCents(estimate.feeCents) },
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
    body = notice('error', 'The cost cannot be estimated. Edit the project and check the reward and the number of assignments.');
  }
  return el(
    'div',
    { className: 'card', id: 'cost-panel' },
    el('h4', { className: 'card-title' }, 'Cost estimate'),
    accountError ? errorNotice(accountError, 'Account') : null,
    body,
    muted('Top-ups after rejections are not included.'),
  );
}

export function renderConfirmStep(ctx) {
  const { draft, template, estimate, account, pools } = ctx;
  const { data, settings } = draft;

  // 이름을 아직 정하지 않았으면 "<Project 이름> <날짜>" 를 제안한다. 처음 들어왔을 때만이고, 사용자가 지운 이름을 다시 채우지는 않는다.
  if (draft.batchName === '') ctx.update({ batchName: `${template.name} ${todayText()}` }, { rerender: false });

  const hitSettings = toHitSettings(settings);
  const attentionRule = toAttentionRule(settings);
  const reference = toReviewReference(settings);
  const freeTextSuffixes = normalizeSuffixes(settings.freeTextSuffixes ?? []);
  const isProduction = account?.env === 'production';
  const balanceCents = balanceCentsOf(account);
  const overBalance = estimate !== null && balanceCents !== null && estimate.totalCents > balanceCents;
  let touched = false;
  let publishing = false;

  const nameInput = el('input', { type: 'text', id: 'batch-name', maxlength: 120, placeholder: 'e.g. close-ended chunk-fact pilot', 'aria-label': 'Batch name', value: ctx.draft.batchName });
  const nameField = field({ id: 'batch-name', label: 'Batch name', control: nameInput, required: true, hint: 'Shown in the Manage list. It is not visible to workers.', className: 'field-wide' });
  const confirmInput = el('input', { type: 'text', id: 'confirm-name', autocomplete: 'off', 'aria-label': 'Confirm batch name', placeholder: ctx.draft.batchName.trim() });
  const errorSlot = el('div', { id: 'publish-error' });
  const hint = el('span', { className: 'muted step-hint', id: 'publish-hint' });
  const button = el('button', { type: 'button', className: 'btn btn-primary', id: 'publish-btn' }, `Publish ${plural(data.rows.length, 'HIT')}`);

  const name = () => ctx.draft.batchName.trim();
  // production 에서는 batch 이름을 직접 입력해야 버튼이 활성화된다
  const confirmed = () => !isProduction || confirmInput.value.trim() === name();
  const canPublish = () => name() !== '' && account !== undefined && account !== null && estimate !== null && !overBalance && confirmed();

  function refresh() {
    nameField.setError(touched && name() === '' ? 'Enter a batch name.' : '');
    confirmInput.placeholder = name();
    button.disabled = publishing || (touched ? !canPublish() : !confirmed() || overBalance || name() === '');
    hint.textContent = isProduction && !confirmed() ? 'Type the batch name to enable Publish.' : '';
  }
  nameInput.addEventListener('input', () => {
    ctx.update({ batchName: nameInput.value }, { rerender: false });
    refresh();
  });
  confirmInput.addEventListener('input', refresh);

  async function publish() {
    touched = true;
    refresh();
    if (!canPublish()) return;
    const request = buildCreateBatchRequest({ name: name(), template, data, settings, answerSchema: ctx.draft.answerSchema });
    publishing = true;
    button.textContent = 'Publishing…';
    errorSlot.replaceChildren();
    refresh();
    try {
      const batch = await api.createBatch(request);
      if (ctx.signal.aborted) return;
      ctx.reset({ rerender: false }); // 게시가 끝나면 입력을 비운다 (저장본도 지운다)
      void refreshBalance();
      navigate(`/manage/${batch.id}`);
    } catch (error) {
      if (ctx.signal.aborted) return;
      publishing = false;
      button.textContent = `Publish ${plural(data.rows.length, 'HIT')}`;
      errorSlot.replaceChildren(failureNotice('Could not publish the batch', error));
      refresh();
    }
  }
  button.addEventListener('click', () => void publish());

  const poolNames = (ids, none) =>
    ids.length === 0
      ? el('span', { className: 'muted' }, none)
      : ids.map((id) => {
          const pool = (pools ?? []).find((p) => p.id === id);
          return tag(pool ? `${pool.name} (${pool.workerIds?.length ?? 0})` : id);
        });
  const qualifications = describeQualifications(settings);

  const summary = descList(
    [
      { key: 'env', label: 'Environment', value: account ? envBadge(account.env) : '…' },
      { key: 'template', label: 'Project', value: template.name },
      { key: 'data', label: 'Data', value: `${data.fileName}: ${plural(data.rows.length, 'row')} → ${plural(data.rows.length, 'HIT')}, ${plural(data.columns.length, 'column')}`, wide: true },
      { key: 'title', label: 'Title', value: hitSettings.Title, wide: true },
      { key: 'reward', label: 'Reward', value: `$${hitSettings.Reward} per assignment` },
      { key: 'max', label: 'Assignments per task', value: `${hitSettings.MaxAssignments} per HIT` },
      { key: 'duration', label: 'Time allotted', value: plural(settings.durationMinutes, 'minute') },
      { key: 'lifetime', label: 'Task expires in', value: plural(settings.lifetimeDays, 'day') },
      { key: 'auto', label: 'Auto-approve in', value: plural(settings.autoApprovalDays, 'day') },
      { key: 'qualifications', label: 'Qualifications', value: qualifications.length > 0 ? qualifications.join('; ') : el('span', { className: 'muted' }, 'None') },
      { key: 'required', label: 'Only workers in', value: poolNames(settings.requiredPoolIds, 'Any worker') },
      { key: 'excluded', label: 'Exclude workers in', value: poolNames(settings.excludedPoolIds, 'Nobody') },
      { key: 'attention', label: 'Attention rule', wide: true, value: attentionRuleText(attentionRule) },
      {
        key: 'free-text',
        label: 'Free-text answers',
        wide: true,
        value:
          freeTextSuffixes.length > 0
            ? el('span', {}, 'Answers named ', join(freeTextSuffixes.map((suffix) => el('code', {}, `*${suffix}`))), '; shown as text, left out of κ, majority, agreement and the reference')
            : el('span', { className: 'muted' }, 'None'),
      },
      {
        key: 'reference',
        label: 'Review reference',
        wide: true,
        value: reference.source === 'column' ? el('span', {}, 'Input column ', el('code', {}, reference.column)) : 'Majority of the other workers on the same HIT',
      },
      {
        key: 'worker-columns',
        label: 'Workers receive',
        wide: true,
        value: workerColumnsText(workerColumns({ inputColumns: data.columns, templateHtml: template.html, attentionRule, reference })),
      },
      {
        key: 'cost',
        label: 'Total cost',
        wide: true,
        value: estimate
          ? el('span', {}, el('strong', { className: 'tabular', id: 'publish-total' }, formatCents(estimate.totalCents)), ` (reward ${formatCents(estimate.rewardCents)} + ${estimate.feePercent}% fee ${formatCents(estimate.feeCents)})${account ? `, balance $${account.AvailableBalance}` : ''}`)
          : '–',
      },
    ],
    { id: 'publish-summary' },
  );

  refresh();
  const node = el(
    'section',
    { className: 'panel step', id: 'step-publish' },
    el('h3', { className: 'panel-title' }, 'Confirm and publish'),
    costPanel(ctx),
    nameField,
    summary,
    overBalance ? notice('error', `The total ${formatCents(estimate.totalCents)} exceeds the available balance ${formatCents(balanceCents)}.`, 'Edit the project to lower the reward or the number of assignments, or upload fewer rows.') : null,
    isProduction
      ? notice(
          'warning',
          'This batch will be published to PRODUCTION and will spend real money.',
          null,
          field({ id: 'confirm-name', label: 'Type the batch name to confirm', control: confirmInput, className: 'field-wide' }),
        )
      : null,
    errorSlot,
    el('div', { className: 'step-footer' }, hint, el('button', { type: 'button', className: 'btn', id: 'back-btn', onClick: () => ctx.goTo(2) }, 'Back'), button),
  );
  return { node };
}
