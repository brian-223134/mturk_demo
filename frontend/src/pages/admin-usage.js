// admin 의 API usage(/admin/usage): 유료 LLM 호출(OpenRouter)에 쓴 비용.
//   OpenRouter 의 실제 크레딧 잔액과 키 한도 (조회는 비용이 들지 않는다)
//   이 콘솔에서 쓴 비용: 오늘·7일·30일·기록 전체, 종류별, 사람별, 날짜별, 최근 호출
// 콘솔의 호출(binding, Describe your task 의 과제·페이지·배치 판정)은 호출마다, Generate from raw data 는 job 마다 기록된다.
// 계산은 lib/api-usage.js, 보고서는 backend 의 app/usage.py 가 만든다.

import { admin } from '../api-client/client.js';
import { el } from '../components/dom.js';
import { formatDateTime } from '../components/format.js';
import { errorNotice, loading, notice } from '../components/notice.js';
import { replace } from '../components/render.js';
import { table } from '../components/table.js';
import { formatUsd, summarizeUsage } from '../lib/api-usage.js';

const number = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '—');
const callsText = (count) => `${number(count)} call${count === 1 ? '' : 's'}`;
const unpricedNote = (count) => (count > 0 ? el('span', { className: 'muted small' }, ` (${count} without a price)`) : null);

function stat(label, total, id) {
  return el('div', { className: 'stat', id }, el('div', { className: 'stat-label' }, label), el('div', { className: 'stat-value' }, formatUsd(total.cost)), el('div', { className: 'muted small' }, `${callsText(total.calls)} · ${number(total.tokens)} tokens`, unpricedNote(total.unpriced)));
}

function balanceCard(openrouter) {
  if (!openrouter?.available) {
    return el('section', { className: 'card', id: 'usage-balance' }, el('h4', { className: 'card-title' }, 'OpenRouter balance'), notice('warning', 'The balance is not available', openrouter?.error ?? null));
  }
  return el(
    'section',
    { className: 'card', id: 'usage-balance' },
    el('h4', { className: 'card-title' }, 'OpenRouter balance'),
    el('div', { className: 'stat' }, el('div', { className: 'stat-label' }, 'Credits left on the account'), el('div', { className: 'stat-value big' }, formatUsd(openrouter.balance)), el('div', { className: 'muted small' }, `${formatUsd(openrouter.totalUsage)} used of ${formatUsd(openrouter.totalCredits)} bought`)),
    el('div', { className: 'stat' }, el('div', { className: 'stat-label' }, "This console's key"), el('div', { className: 'stat-value' }, openrouter.keyLimit === null ? 'No limit' : `${formatUsd(openrouter.keyRemaining)} left`), el('div', { className: 'muted small' }, `${formatUsd(openrouter.keyUsage)} used${openrouter.keyLimit === null ? '' : ` of a ${formatUsd(openrouter.keyLimit)} limit`}. The account balance also counts other keys.`)),
  );
}

function spentCard(report, summary) {
  return el(
    'section',
    { className: 'card', id: 'usage-spent' },
    el('h4', { className: 'card-title' }, 'Spent from this console'),
    // .stat + .stat 의 위쪽 여백 때문에 한 줄의 두 칸이 어긋나지 않게 한다
    el('div', { className: 'stat-row' }, stat('Today', summary.today, 'usage-today'), stat('Last 7 days', summary.last7, 'usage-7d')),
    el('div', { className: 'stat-row' }, stat('Last 30 days', summary.last30, 'usage-30d'), stat('All recorded', report.total, 'usage-all')),
    el('p', { className: 'muted small' }, report.recordedSince ? `Recorded since ${formatDateTime(report.recordedSince)}. Calls made before that, or outside this console, appear only in the OpenRouter balance.` : 'Nothing has been recorded yet.'),
  );
}

const costColumns = [
  { key: 'calls', title: 'Calls', align: 'right', render: (row) => number(row.calls) },
  { key: 'tokens', title: 'Tokens', align: 'right', render: (row) => number(row.tokens) },
  { key: 'cost', title: 'Cost', align: 'right', render: (row) => [formatUsd(row.cost), unpricedNote(row.unpriced)] },
];

export async function renderApiUsage(container, _params, signal) {
  const slot = el('div', {}, loading());
  container.append(
    el('div', { className: 'page-title' }, el('h2', {}, 'API usage')),
    el('p', { className: 'muted' }, 'What the paid LLM calls cost. Prices come from OpenRouter with each answer. Checking the balance is free.'),
    slot,
  );
  try {
    const report = await admin.getApiUsage();
    if (signal.aborted) return;
    const summary = summarizeUsage(report.rows);
    replace(
      slot,
      el('div', { className: 'cards' }, balanceCard(report.openrouter), spentCard(report, summary)),
      el('section', { className: 'panel', id: 'usage-by-kind' }, el('h3', { className: 'panel-title' }, 'By kind of call (all recorded)'), table({ columns: [{ key: 'label', title: 'Kind' }, ...costColumns], rows: report.byKind, rowKey: (row) => row.key, empty: 'No calls yet' })),
      el('section', { className: 'panel', id: 'usage-by-user' }, el('h3', { className: 'panel-title' }, 'By person (all recorded)'), table({ columns: [{ key: 'name', title: 'Person', render: (row) => [row.name, row.email ? el('div', { className: 'muted small' }, row.email) : null] }, ...costColumns], rows: report.byUser, rowKey: (row) => row.key ?? 'none', empty: 'No calls yet' })),
      el('section', { className: 'panel', id: 'usage-by-day' }, el('h3', { className: 'panel-title' }, 'By day (last 30 days)'), table({ columns: [{ key: 'day', title: 'Day' }, ...costColumns], rows: summary.byDay, rowKey: (row) => row.day, empty: 'No calls in the last 30 days' })),
      el(
        'section',
        { className: 'panel', id: 'usage-recent' },
        el('h3', { className: 'panel-title' }, 'Recent calls (last 30 days)'),
        table({
          columns: [
            { key: 'at', title: 'When', render: (row) => formatDateTime(row.at) },
            { key: 'user', title: 'Who', render: (row) => row.user ?? '—' },
            { key: 'kindLabel', title: 'Kind' },
            { key: 'model', title: 'Model', render: (row) => [row.model ?? '—', row.provider ? el('div', { className: 'muted small' }, row.provider) : null] },
            ...costColumns,
          ],
          rows: report.rows.slice(0, 100),
          rowKey: (row, index) => `${row.at}-${index}`,
          empty: 'No calls in the last 30 days',
        }),
      ),
    );
  } catch (error) {
    if (!signal.aborted) replace(slot, errorNotice(error, 'API usage'));
  }
}
