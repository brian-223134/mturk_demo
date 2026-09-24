// Overview 탭: 진행률과 비용, 설정 요약, 동작 버튼 (미완료 HIT 재모집, 지금 만료, Export).

import { api } from '../../api-client/client.js';
import { refreshBalance } from '../../components/account.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { EMPTY, formatCents, formatDateTime, formatDurationSeconds, formatMoney, formatPercent } from '../../components/format.js';
import { confirmModal, infoModal } from '../../components/modal.js';
import { muted } from '../../components/notice.js';
import { STATUS_COLORS, stackedBar } from '../../components/stackedBar.js';
import { toast } from '../../components/toast.js';
import { EXPORT_FORMATS, exportMenu } from './resultsTab.js';
import { errorText } from './shared.js';
import { describeTopUp, planBatchTopUp, planTopUp } from './topUp.js';

// MTurk 의 시스템 Qualification ID → 이름
const SYSTEM_QUALIFICATIONS = {
  '000000000000000000L0': 'Approval rate (%)',
  '00000000000000000040': 'Approved HITs',
  '00000000000000000071': 'Locale',
};

const OVERVIEW_EXPORTS = [EXPORT_FORMATS[1], EXPORT_FORMATS[0]];

function card(title, ...children) {
  return el('section', { className: 'card' }, el('h4', { className: 'card-title' }, title), ...children);
}

function stat(label, value, attrs = {}) {
  return el('div', { className: 'stat', ...attrs }, el('div', { className: 'stat-label' }, label), el('div', { className: 'stat-value tabular' }, value));
}

/** 설명 목록의 한 항목. wide 면 두 칸을 차지한다. */
function item(label, value, wide = false) {
  return [el('dt', { className: wide ? 'wide' : null }, label), el('dd', { className: wide ? 'wide' : null }, value)];
}

function qualificationText(q) {
  const name = SYSTEM_QUALIFICATIONS[q.QualificationTypeId] ?? q.QualificationTypeId;
  const values = q.IntegerValues?.join(', ') ?? q.LocaleValues?.map((l) => l.Country).join(', ') ?? '';
  return `${name} ${q.Comparator} ${values}`.trim();
}

export function renderOverview(panel, ctx) {
  const detail = ctx.detail;
  const { batch, progress, cost, status } = detail;
  const s = batch.settings;
  const completedRatio = progress.hitsTotal === 0 ? 0 : progress.hitsCompleted / progress.hitsTotal;

  const repaint = async () => {
    await Promise.all([ctx.refreshDetail(), refreshBalance()]);
    if (ctx.signal.aborted) return;
    panel.replaceChildren();
    renderOverview(panel, ctx);
  };

  /** 부족한 HIT 전부를 목표까지 채운다. 수와 비용을 먼저 확인받는다. */
  const topUpIncomplete = async (button) => {
    button.disabled = true;
    try {
      const incomplete = await api.listHits(batch.id, { page: 1, pageSize: 1000, filters: { incomplete: true } });
      if (ctx.signal.aborted) return;
      if (incomplete.total === 0) {
        toast.info('Every HIT already has enough approved assignments.');
        return;
      }
      const plan = planBatchTopUp(batch, incomplete.items, 'fill-to-target');
      // 서버와 같은 판정: 부족분을 추가하는 HIT 와, 부족분은 없지만 만료되어 막힌 HIT(빈자리가 있음)는 게시 기간이 연장된다
      const touched = incomplete.items.filter((h) => planTopUp(h, h.progress, 'fill-to-target').add > 0 || (h.expired && h.progress.shortfall === 0 && h.progress.open > 0));
      const extended = touched.filter((h) => h.expired).length;
      const untouched = incomplete.total - touched.length;
      const lines = [
        `${incomplete.total} HIT(s) are incomplete.`,
        plan.addTotal > 0 ? `This adds ${plan.addTotal} assignment(s) to ${plan.hitsAdded} HIT(s) for ${formatCents(plan.costCents)}, reserved from the balance.` : 'No assignments need to be added: open and submitted assignments already cover the target.',
        extended > 0 ? `${extended} expired HIT(s) get their expiration extended so workers can see them again.` : null,
        untouched > 0 ? `${untouched} HIT(s) are left as they are (nothing to add, or over the MTurk limit).` : null,
      ].filter(Boolean);
      const ok = await confirmModal({
        title: `Top up ${incomplete.total} incomplete HIT(s)?`,
        message: el('div', { id: 'topup-confirm' }, lines.map((line) => el('p', { className: 'modal-text' }, line))),
        okText: 'Top up',
      });
      if (!ok || ctx.signal.aborted) return;
      const result = await api.addAssignments(incomplete.items.map((h) => h.HITId), 'fill-to-target');
      await repaint();
      const summary = describeTopUp(result);
      infoModal({ title: summary.title, lines: summary.lines });
    } catch (error) {
      toast.error('Top-up failed', errorText(error));
    } finally {
      button.disabled = false;
    }
  };

  const expireNow = async () => {
    const ok = await confirmModal({
      title: 'Expire this batch now?',
      message: 'Workers will no longer see its HITs. Submitted work stays and can still be reviewed. A top-up reopens expired HITs.',
      okText: 'Expire now',
      danger: true,
    });
    if (!ok || ctx.signal.aborted) return;
    try {
      await api.expireBatch(batch.id);
      await repaint();
      toast.success('Batch expired.');
    } catch (error) {
      toast.error('Could not expire the batch', errorText(error));
    }
  };

  const topUpButton = el('button', { type: 'button', className: 'btn btn-primary', id: 'top-up-incomplete', onClick: () => void topUpIncomplete(topUpButton) }, 'Top up incomplete HITs');
  const actions = el(
    'div',
    { className: 'toolbar toolbar-right', id: 'overview-actions' },
    topUpButton,
    el('button', { type: 'button', className: 'btn btn-danger', id: 'expire-now', disabled: status !== 'in_progress', onClick: () => void expireNow() }, 'Expire now'),
    exportMenu(batch.id, OVERVIEW_EXPORTS),
  );

  const cards = el(
    'div',
    { className: 'cards' },
    card(
      'HITs completed',
      el('div', { className: 'stat-value big tabular', id: 'hits-completed' }, `${progress.hitsCompleted} `, el('span', { className: 'muted' }, `/ ${progress.hitsTotal}`)),
      el('div', { className: 'progress', role: 'progressbar', 'aria-valuenow': String(Math.round(completedRatio * 100)) }, el('div', { className: 'progress-fill', style: { width: `${Math.round(completedRatio * 100)}%` } })),
      muted(`A HIT is complete when it has ${s.MaxAssignments} approved assignments.`),
    ),
    card(
      'Assignments',
      el('div', { className: 'stat-row' }, stat('Waiting for review', String(progress.submitted), { id: 'waiting-for-review' }), stat('Reject rate', formatPercent(progress.rejectRate))),
      stackedBar([
        { key: 'approved', label: 'Approved', value: progress.approved, color: STATUS_COLORS.good },
        { key: 'submitted', label: 'Submitted', value: progress.submitted, color: STATUS_COLORS.warning },
        { key: 'rejected', label: 'Rejected', value: progress.rejected, color: STATUS_COLORS.critical },
        { key: 'open', label: 'Open', value: progress.open, color: STATUS_COLORS.neutral },
      ]),
    ),
    card(
      'Cost (fees included)',
      stat('Spent on approved work', formatCents(cost.spentCents), { id: 'cost-spent' }),
      stat('Estimated total', formatCents(cost.estimatedCents), { id: 'cost-estimated' }),
      muted('Total if every remaining assignment is approved. Rejected work is not charged.'),
    ),
  );

  const attention = batch.attentionRule
    ? el('span', {}, 'answers named ', el('code', {}, `${batch.attentionRule.namePrefix}*`), ' must be ', el('code', {}, batch.attentionRule.expectedValue), ` (pass at ≥ ${formatPercent(batch.attentionRule.minCorrectRatio)} correct)`)
    : 'None';
  const reference =
    batch.reference?.source === 'column'
      ? el('span', {}, 'input column ', el('code', {}, batch.reference.column))
      : 'majority of the other workers on the same HIT (rejected answers excluded)';
  const qualifications = s.QualificationRequirements.length === 0 ? 'None recorded' : s.QualificationRequirements.map((q) => tag(qualificationText(q), 'default'));
  const pools =
    batch.requiredPoolIds.length + batch.excludedPoolIds.length === 0
      ? 'No pool restrictions'
      : [...batch.requiredPoolIds.map((id) => tag(`only ${id}`, 'blue')), ...batch.excludedPoolIds.map((id) => tag(`exclude ${id}`, 'red'))];

  const settings = el(
    'section',
    { className: 'panel' },
    el('h3', { className: 'panel-title' }, 'Settings'),
    el(
      'dl',
      { className: 'desc', id: 'settings' },
      item('Title', s.Title, true),
      item('Description', s.Description, true),
      item('Reward', formatMoney(s.Reward)),
      item('MaxAssignments (target labels)', String(s.MaxAssignments)),
      item('Time allotted', formatDurationSeconds(s.AssignmentDurationInSeconds)),
      item('Auto-approval delay', formatDurationSeconds(s.AutoApprovalDelayInSeconds)),
      item('HIT lifetime', formatDurationSeconds(s.LifetimeInSeconds)),
      item('Created', formatDateTime(batch.createdAt)),
      item('Keywords', s.Keywords || EMPTY, true),
      item('Attention rule', attention, true),
      item('Review reference', reference, true),
      item('Qualifications', qualifications, true),
      item('Worker pools', pools, true),
      item('Template', el('code', {}, batch.templateId)),
      item('Input columns', el('span', { title: batch.inputColumns.join(', ') }, String(batch.inputColumns.length))),
    ),
  );

  panel.append(actions, cards, settings);
}
