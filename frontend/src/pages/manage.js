// Manage: batch 목록. 이름, 환경, 생성 시각, 진행률(완료 HIT / 전체), 응답 수(S / A / R), 반려율, 비용(지출 / 예상), 상태.
// 최근에 만든 batch 가 위로 온다. 이름을 누르면 상세(Overview)로, "Needs review" 를 누르면 Review 탭으로 간다.

import { api } from '../api-client/client.js';
import { envBadge, needsReviewTag, statusTag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { formatCents, formatDateTime, formatPercent } from '../components/format.js';
import { errorNotice, loading } from '../components/notice.js';
import { num, table } from '../components/table.js';

const COLUMNS = [
  {
    title: 'Name',
    render: ({ batch, needsReview, progress }) =>
      el(
        'span',
        { className: 'cell-name' },
        el('a', { href: `/manage/${encodeURIComponent(batch.id)}`, className: 'batch-name' }, batch.name),
        needsReview ? needsReviewTag(progress.submitted, `/manage/${encodeURIComponent(batch.id)}/review`) : null,
      ),
  },
  { title: 'Env', width: 110, render: ({ batch }) => envBadge(batch.env) },
  { title: 'Created', width: 150, className: 'cell-created', render: ({ batch }) => formatDateTime(batch.createdAt) },
  {
    title: 'HITs',
    tooltip: 'Completed HITs / all HITs',
    width: 100,
    align: 'right',
    className: 'cell-hits',
    render: ({ progress }) => num(`${progress.hitsCompleted} / ${progress.hitsTotal}`),
  },
  {
    title: 'Assignments (S / A / R)',
    tooltip: 'Submitted / Approved / Rejected',
    width: 190,
    align: 'right',
    className: 'cell-assignments',
    render: ({ progress }) =>
      el(
        'span',
        { className: 'tabular' },
        el('span', { className: progress.submitted > 0 ? 'text-warning' : null }, String(progress.submitted)),
        ` / ${progress.approved} / ${progress.rejected}`,
      ),
  },
  {
    title: 'Reject rate',
    width: 110,
    align: 'right',
    className: 'cell-reject-rate',
    render: ({ progress }) => num(formatPercent(progress.rejectRate)),
  },
  {
    title: 'Cost',
    tooltip: 'Spent (approved) / estimated total, fees included',
    width: 160,
    align: 'right',
    className: 'cell-cost',
    render: ({ cost }) => num(`${formatCents(cost.spentCents)} / ${formatCents(cost.estimatedCents)}`),
  },
  { title: 'Status', width: 120, className: 'cell-status', render: ({ status }) => statusTag(status) },
];

export async function render(root, _params, signal) {
  root.append(el('h2', { className: 'page-title' }, 'Batches'));
  const body = el('div', { id: 'batch-list' }, loading());
  root.append(body);

  let batches;
  try {
    batches = await api.listBatches();
  } catch (error) {
    if (signal.aborted) return;
    body.replaceChildren(errorNotice(error, 'Batches'));
    return;
  }
  if (signal.aborted) return;

  const rows = [...batches].sort((a, b) => String(b.batch.createdAt).localeCompare(String(a.batch.createdAt)));
  body.replaceChildren(
    table({
      columns: COLUMNS,
      rows,
      rowKey: (row) => row.batch.id,
      rowAttrs: (row) => ({ dataset: { batchId: row.batch.id } }),
      empty: 'No batches yet.',
      className: 'batch-table',
    }),
  );
}
