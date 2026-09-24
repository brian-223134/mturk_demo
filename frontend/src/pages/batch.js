// Manage › batch 상세. Overview 는 BatchDetail 만으로 그리고(진행률, 응답 현황, 비용, 설정), Review / HITs / Results 탭은
// 각각 listAssignments, listHits, getResults 를 불러 표를 그린다. 이 단계의 backend 는 그 셋을 501 로 답하므로 그때는
// "Not implemented" 안내가 보인다. 탭은 경로(/manage/:batchId/:tab)로 정하므로 새로고침해도 같은 탭이 열린다.

import { api } from '../api-client/client.js';
import { attentionTag, needsReviewTag, statusTag, tag } from '../components/badges.js';
import { el, join } from '../components/dom.js';
import { EMPTY, formatCents, formatDateTime, formatDurationSeconds, formatFixed, formatMoney, formatPercent, formatSeconds } from '../components/format.js';
import { errorNotice, loading, muted } from '../components/notice.js';
import { CATEGORY_COLORS, STATUS_COLORS, stackedBar } from '../components/stackedBar.js';
import { num, pager, table } from '../components/table.js';
import { navigate } from '../router.js';

const TABS = ['overview', 'review', 'hits', 'results'];
const PAGE_SIZE = 25;

// MTurk 의 시스템 Qualification ID → 이름
const SYSTEM_QUALIFICATIONS = {
  '000000000000000000L0': 'Approval rate (%)',
  '00000000000000000040': 'Approved HITs',
  '00000000000000000071': 'Locale',
};

export async function render(root, params, signal) {
  const batchId = params.batchId;
  if (params.tab !== undefined && !TABS.includes(params.tab)) {
    navigate(`/manage/${encodeURIComponent(batchId)}/overview`, { replace: true });
    return;
  }
  const tab = params.tab ?? 'overview';

  const title = el('span', { className: 'crumb-current', id: 'batch-name' }, batchId);
  const header = el(
    'div',
    { className: 'page-header' },
    el('nav', { className: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '/manage' }, 'Manage'), el('span', { className: 'crumb-sep' }, '›'), title),
  );
  const body = el('div', { id: 'batch-body' }, loading());
  root.append(header, body);

  let detail;
  try {
    detail = await api.getBatch(batchId);
  } catch (error) {
    if (signal.aborted) return;
    body.replaceChildren(errorNotice(error, 'Batch'));
    return;
  }
  if (signal.aborted) return;

  title.textContent = detail.batch.name;
  header.append(statusTag(detail.status));
  if (detail.needsReview) header.append(needsReviewTag(detail.progress.submitted));

  const submitted = detail.progress.submitted;
  const labels = { overview: 'Overview', review: submitted > 0 ? `Review (${submitted})` : 'Review', hits: 'HITs', results: 'Results' };
  const tabBar = el(
    'div',
    { className: 'tabs', role: 'tablist' },
    TABS.map((key) =>
      el(
        'a',
        { href: `/manage/${encodeURIComponent(batchId)}/${key}`, className: `tab${key === tab ? ' active' : ''}`, role: 'tab', dataset: { tab: key }, 'aria-selected': key === tab ? 'true' : 'false' },
        labels[key],
      ),
    ),
  );
  const panel = el('div', { className: 'tab-panel', id: `tab-${tab}`, dataset: { tab } });
  body.replaceChildren(tabBar, panel);

  if (tab === 'overview') renderOverview(panel, detail);
  else if (tab === 'hits') await renderHits(panel, detail, signal);
  else if (tab === 'review') await renderReview(panel, detail, signal);
  else await renderResults(panel, detail, signal);
}

// ── Overview ────────────────────────────────────────────────────────────────

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

function renderOverview(panel, detail) {
  const { batch, progress, cost } = detail;
  const s = batch.settings;
  const completedRatio = progress.hitsTotal === 0 ? 0 : progress.hitsCompleted / progress.hitsTotal;

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
      el('div', { className: 'stat-row' }, stat('Waiting for review', String(progress.submitted)), stat('Reject rate', formatPercent(progress.rejectRate))),
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

  panel.append(cards, settings, muted('Top-up, expire and export actions come in a later phase.'));
}

// ── HITs ────────────────────────────────────────────────────────────────────

async function renderHits(panel, detail, signal) {
  const { batch } = detail;
  const keyColumn = batch.inputColumns.includes('qid') ? 'qid' : (batch.inputColumns[0] ?? '');
  const columns = [
    { title: 'Row', width: 60, align: 'right', render: (h) => num(h.rowIndex) },
    { title: keyColumn || 'Input', className: 'cell-ellipsis', render: (h) => el('span', { className: 'ellipsis', title: h.inputPreview?.[keyColumn] ?? '' }, h.inputPreview?.[keyColumn] ?? '') },
    { title: 'Max', width: 60, align: 'right', render: (h) => num(h.MaxAssignments) },
    { title: 'Approved', width: 90, align: 'right', render: (h) => num(h.progress.approved) },
    { title: 'Rejected', width: 90, align: 'right', render: (h) => num(h.progress.rejected) },
    { title: 'Submitted', width: 95, align: 'right', render: (h) => num(h.progress.submitted) },
    { title: 'Open', width: 60, align: 'right', render: (h) => num(h.progress.open) },
    {
      title: 'State',
      width: 210,
      render: (h) => [
        h.progress.completed ? tag('Completed', 'green') : tag('Incomplete', 'default'),
        !h.progress.completed && h.progress.shortfall > 0 ? tag(`needs +${h.progress.shortfall}`, 'orange') : null,
        !h.progress.completed && h.expired ? tag('Expired', 'gold') : null,
      ],
    },
    { title: 'Expires', width: 150, render: (h) => formatDateTime(h.Expiration) },
  ];

  let page = 1;
  async function load() {
    panel.replaceChildren(loading());
    let result;
    try {
      result = await api.listHits(batch.id, { page, pageSize: PAGE_SIZE, sort: { field: 'rowIndex', order: 'asc' } });
    } catch (error) {
      if (signal.aborted) return;
      panel.replaceChildren(errorNotice(error, 'HITs'));
      return;
    }
    if (signal.aborted) return;
    panel.replaceChildren(
      table({ columns, rows: result.items, rowKey: (h) => h.HITId, empty: 'No HITs.', className: 'hit-table' }),
      pager({ page, pageSize: PAGE_SIZE, total: result.total, unit: 'HITs', onChange: (next) => { page = next; void load(); } }),
      muted('Top-up of selected HITs and the task preview come in a later phase.'),
    );
  }
  await load();
}

// ── Review ──────────────────────────────────────────────────────────────────

const EMPTY_TOKEN = '(empty)';
const WORD_SPLIT = /[^a-z0-9]+/;
const normalizeLabel = (value) => String(value).trim().toLowerCase();

/** 첫 단어의 앞 level 글자(첫 글자만 대문자) + 나머지 단어의 첫 글자 대문자. grounded → G, not_grounded → NG */
function tokenAt(words, level) {
  const [first = '', ...rest] = words;
  const head = first.slice(0, level);
  return head.charAt(0).toUpperCase() + head.slice(1) + rest.map((w) => w.charAt(0).toUpperCase()).join('');
}

/**
 * 답 값 목록 → 짧은 토큰 (값 → 토큰). prototype 의 answerTokens.abbreviate 와 같은 규칙: 단어 첫 글자를 이어 붙이고,
 * 겹치면 첫 단어의 글자 수를 늘리고, 그래도 겹치면 값 전체를 쓴다. 대소문자와 공백만 다른 값은 같은 토큰을 받는다.
 */
function abbreviate(values) {
  const groups = new Map();
  for (const value of [...new Set(values)].sort()) {
    const key = normalizeLabel(value);
    const existing = groups.get(key);
    if (existing) {
      existing.originals.push(value);
      continue;
    }
    const words = key.split(WORD_SPLIT).filter(Boolean);
    groups.set(key, { originals: [value], words, level: 1, full: words.length === 0 });
  }
  const tokenOf = (group, original) => {
    if (!group.full) return tokenAt(group.words, group.level);
    return original.trim() === '' ? EMPTY_TOKEN : original;
  };
  for (let guard = 0; guard < 64; guard += 1) {
    const byToken = new Map();
    for (const group of groups.values()) {
      for (const original of group.originals) {
        const token = tokenOf(group, original);
        const holders = byToken.get(token) ?? [];
        if (!holders.includes(group)) holders.push(group);
        byToken.set(token, holders);
      }
    }
    let changed = false;
    for (const holders of byToken.values()) {
      if (holders.length < 2) continue;
      for (const group of holders) {
        if (group.full) continue;
        if (group.level < (group.words[0] ?? '').length) group.level += 1;
        else group.full = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const out = new Map();
  for (const group of groups.values()) for (const original of group.originals) out.set(original, tokenOf(group, original));
  return out;
}

/** 페이지의 토큰 중 가장 긴 것에 맞춘 폭(ch). 값 전체를 쓰는 긴 토큰은 잘라 보이고 title 로 읽는다 */
function tokenWidthOf(tokens) {
  let longest = 1;
  for (const token of tokens.values()) longest = Math.max(longest, token.length);
  return Math.min(longest, 12) + 1;
}

/**
 * Review 표의 Answers 셀: 윗줄 W(this worker), 아랫줄 R(reference). 문항은 제출 순서대로 토큰 하나씩이라
 * hover 없이 한 줄을 훑어 판단한다. attention 문항은 보라 테두리, 기준과 다른 답은 빨강이다.
 */
function answersCell(a, tokens, tokenWidth, attentionPrefix) {
  const pairs = a.answers.map((answer) => {
    const reference = a.reference?.[answer.name];
    return {
      name: answer.name,
      worker: answer.value,
      reference,
      attention: Boolean(attentionPrefix) && answer.name.startsWith(attentionPrefix),
      mismatch: reference !== undefined && normalizeLabel(reference) !== normalizeLabel(answer.value),
      title: `${answer.name} · worker: ${answer.value} · reference: ${reference ?? 'none'}`,
    };
  });
  const token = (text, p, extra = '') =>
    el('span', { className: `token${p.attention ? ' token-attention' : ''}${extra}`, title: p.title, style: { width: `${tokenWidth}ch` } }, text);
  return el(
    'div',
    { className: 'answers' },
    el('div', { className: 'answers-line' }, el('span', { className: 'answers-label' }, 'W'), pairs.map((p) => token(tokens.get(p.worker) ?? p.worker, p, p.mismatch ? ' token-mismatch' : ''))),
    el(
      'div',
      { className: 'answers-line' },
      el('span', { className: 'answers-label' }, 'R'),
      pairs.map((p) => (p.reference === undefined ? token('·', p, ' token-none') : token(tokens.get(p.reference) ?? p.reference, p))),
    ),
  );
}

async function renderReview(panel, detail, signal) {
  const { batch } = detail;
  const attentionPrefix = batch.attentionRule?.namePrefix ?? '';
  // 토큰 약어는 페이지의 값 전체로 정하므로 결과를 받은 뒤 열을 만든다
  const columnsFor = (items) => {
    const values = items.flatMap((a) => [...a.answers.map((x) => x.value), ...Object.values(a.reference ?? {})]);
    const tokens = abbreviate(values);
    const tokenWidth = tokenWidthOf(tokens);
    return [
    { title: 'Row', width: 60, align: 'right', render: (a) => num(a.rowIndex) },
    { title: 'Worker', width: 150, render: (a) => el('code', { className: 'worker-id' }, a.WorkerId) },
    { title: 'Answers', tooltip: 'W: this worker, R: reference. One token per question, in submission order', render: (a) => answersCell(a, tokens, tokenWidth, attentionPrefix) },
    { title: 'Attention', width: 100, render: (a) => attentionTag(a.attention) },
    { title: 'Agree', tooltip: "Share of this worker's answers (attention items excluded) that match the reference", width: 70, align: 'right', render: (a) => num(formatPercent(a.agreement)) },
    { title: 'Time', width: 70, align: 'right', render: (a) => num(formatSeconds(a.workTimeInSeconds)) },
    { title: 'Status', width: 100, render: (a) => statusTag(a.AssignmentStatus) },
    { title: 'Submitted', width: 140, render: (a) => formatDateTime(a.SubmitTime) },
    { title: 'Feedback', width: 180, className: 'cell-ellipsis', render: (a) => el('span', { className: 'ellipsis', title: a.RequesterFeedback ?? '' }, a.RequesterFeedback ?? '') },
    ];
  };

  let page = 1;
  async function load() {
    panel.replaceChildren(loading());
    let result;
    try {
      result = await api.listAssignments(batch.id, { page, pageSize: PAGE_SIZE, sort: { field: 'SubmitTime', order: 'desc' } });
    } catch (error) {
      if (signal.aborted) return;
      panel.replaceChildren(errorNotice(error, 'Review'));
      return;
    }
    if (signal.aborted) return;
    panel.replaceChildren(
      table({ columns: columnsFor(result.items), rows: result.items, rowKey: (a) => a.AssignmentId, empty: 'No assignments.', className: 'assignment-table' }),
      pager({ page, pageSize: PAGE_SIZE, total: result.total, unit: 'assignments', onChange: (next) => { page = next; void load(); } }),
      muted('Approve, reject and the assignment detail come in a later phase.'),
    );
  }
  await load();
}

// ── Results ─────────────────────────────────────────────────────────────────

async function renderResults(panel, detail, signal) {
  const { batch } = detail;
  panel.replaceChildren(loading());
  let data;
  try {
    data = await api.getResults(batch.id);
  } catch (error) {
    if (signal.aborted) return;
    panel.replaceChildren(errorNotice(error, 'Results'));
    return;
  }
  if (signal.aborted) return;

  const labels = Object.keys(data.labelDistribution ?? {});
  const distribution = labels.map((label, i) => ({ key: label, label, value: data.labelDistribution[label], color: CATEGORY_COLORS[i] ?? '#8c8b86' }));

  const columns = [
    { title: 'Row', width: 60, align: 'right', render: (r) => num(r.rowIndex) },
    { title: 'Answer', width: 160, render: (r) => el('code', {}, r.answerName) },
    { title: 'Votes', render: (r) => join(r.votes.map((v, i) => el('span', { title: r.workers?.[i] ?? '' }, v)), ' · ') },
    { title: 'Majority', width: 140, render: (r) => (r.majority === null ? el('span', { className: 'muted' }, 'tie') : r.majority) },
    { title: 'Unanimous', width: 100, render: (r) => (r.unanimous ? tag('yes', 'green') : tag('no', 'default')) },
  ];
  const items = data.items ?? [];

  panel.replaceChildren(
    el(
      'div',
      { className: 'cards' },
      card(
        'Agreement',
        el(
          'div',
          { className: 'stat-row' },
          stat("Fleiss' κ", formatFixed(data.fleissKappa), { title: 'Computed only on items with exactly the target number of approved votes' }),
          stat('Unanimous items', formatPercent(data.unanimousRatio)),
          stat('Items with votes', String(items.length)),
        ),
        muted(`κ uses ${data.kappaItemCount} item(s) with exactly ${data.target} approved votes. Attention items are excluded.`),
      ),
      card('Label distribution (approved votes)', distribution.length === 0 ? muted('No approved votes yet.') : stackedBar(distribution)),
    ),
    el('h3', { className: 'panel-title' }, 'Items'),
    table({ columns, rows: items.slice(0, 200), rowKey: (r) => r.key, empty: 'No items with votes.', className: 'results-table' }),
    items.length > 200 ? muted(`Showing the first 200 of ${items.length} items.`) : null,
    muted('Filters and export come in a later phase.'),
  );
}
