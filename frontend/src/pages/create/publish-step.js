// Create (5) Publish: 요약을 확인하고 게시한다. 게시 후에는 해당 batch 의 Overview(/manage/<id>)로 간다.

import { api } from '../../api-client/client.js';
import { envBadge, tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { notice } from '../../components/notice.js';
import { formatCents } from '../../lib/cost.js';
import { balanceCentsOf, buildCreateBatchRequest, describeQualifications, toAttentionRule, toHitSettings, toReviewReference } from '../../lib/settings.js';
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

export function renderPublishStep(ctx) {
  const { draft, template, estimate, account, pools } = ctx;
  const { data, settings } = draft;

  // 이름을 아직 정하지 않았으면 "<템플릿 이름> <날짜>" 를 제안한다. 처음 들어왔을 때만이고, 사용자가 지운 이름을 다시 채우지는 않는다.
  if (draft.batchName === '') ctx.update({ batchName: `${template.name} ${todayText()}` }, { rerender: false });

  const hitSettings = toHitSettings(settings);
  const attentionRule = toAttentionRule(settings);
  const reference = toReviewReference(settings);
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
      { key: 'template', label: 'Template', value: template.name },
      { key: 'data', label: 'Data', value: `${data.fileName}: ${plural(data.rows.length, 'row')} → ${plural(data.rows.length, 'HIT')}, ${plural(data.columns.length, 'column')}`, wide: true },
      { key: 'title', label: 'Title', value: hitSettings.Title, wide: true },
      { key: 'reward', label: 'Reward', value: `$${hitSettings.Reward} per assignment` },
      { key: 'max', label: 'MaxAssignments', value: `${hitSettings.MaxAssignments} per HIT` },
      { key: 'duration', label: 'Time allotted', value: plural(settings.durationMinutes, 'minute') },
      { key: 'lifetime', label: 'HIT lifetime', value: plural(settings.lifetimeDays, 'day') },
      { key: 'auto', label: 'Auto-approval delay', value: plural(settings.autoApprovalDays, 'day') },
      { key: 'qualifications', label: 'Qualifications', value: qualifications.length > 0 ? qualifications.join('; ') : el('span', { className: 'muted' }, 'None') },
      { key: 'required', label: 'Only workers in', value: poolNames(settings.requiredPoolIds, 'Any worker') },
      { key: 'excluded', label: 'Exclude workers in', value: poolNames(settings.excludedPoolIds, 'Nobody') },
      {
        key: 'attention',
        label: 'Attention rule',
        wide: true,
        value: attentionRule
          ? el('span', {}, 'Answers named ', el('code', {}, `${attentionRule.namePrefix}*`), ' must be ', el('code', {}, attentionRule.expectedValue), `; pass at ${Math.round(attentionRule.minCorrectRatio * 100)}% correct or more`)
          : el('span', { className: 'muted' }, 'None'),
      },
      {
        key: 'reference',
        label: 'Review reference',
        wide: true,
        value: reference.source === 'column' ? el('span', {}, 'Input column ', el('code', {}, reference.column)) : 'Majority of the other workers on the same HIT',
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
    el('h3', { className: 'panel-title' }, 'Publish'),
    nameField,
    summary,
    overBalance ? notice('error', 'The total cost exceeds the available balance. Go back and lower the reward, MaxAssignments or the number of rows.') : null,
    isProduction
      ? notice(
          'warning',
          'This batch will be published to PRODUCTION and will spend real money.',
          null,
          field({ id: 'confirm-name', label: 'Type the batch name to confirm', control: confirmInput, className: 'field-wide' }),
        )
      : null,
    errorSlot,
    el('div', { className: 'step-footer' }, hint, el('button', { type: 'button', className: 'btn', id: 'back-btn', onClick: () => ctx.goTo(3) }, 'Back'), button),
  );
  return { node };
}
