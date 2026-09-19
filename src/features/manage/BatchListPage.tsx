// 5.3 Batch 목록

import { useQuery } from '@tanstack/react-query';
import { Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { BatchSummary } from '../../api/types';
import EnvBadge from '../../components/EnvBadge';
import MoneyText from '../../components/MoneyText';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import StatusTag from '../../components/StatusTag';
import { formatDateTime, formatPercent } from '../../components/format';

const columns: TableColumnsType<BatchSummary> = [
  {
    title: 'Name',
    key: 'name',
    sorter: (a, b) => a.batch.name.localeCompare(b.batch.name),
    render: (_, { batch, needsReview, progress }) => (
      <Space size="small">
        <Link to={`/manage/${batch.id}/overview`}>{batch.name}</Link>
        {needsReview && (
          <Tooltip title={`${progress.submitted} submitted assignment(s) waiting for review`}>
            <Link to={`/manage/${batch.id}/review`}>
              <Tag color="gold">Needs review</Tag>
            </Link>
          </Tooltip>
        )}
      </Space>
    ),
  },
  { title: 'Env', key: 'env', width: 110, render: (_, { batch }) => <EnvBadge env={batch.env} /> },
  {
    title: 'Created',
    key: 'created',
    width: 160,
    defaultSortOrder: 'descend',
    sorter: (a, b) => a.batch.createdAt.localeCompare(b.batch.createdAt),
    render: (_, { batch }) => formatDateTime(batch.createdAt),
  },
  {
    title: <Tooltip title="Completed HITs / all HITs">HITs</Tooltip>,
    key: 'hits',
    width: 100,
    align: 'right',
    render: (_, { progress }) => `${progress.hitsCompleted} / ${progress.hitsTotal}`,
  },
  {
    title: <Tooltip title="Submitted / Approved / Rejected">Assignments (S / A / R)</Tooltip>,
    key: 'assignments',
    width: 190,
    align: 'right',
    render: (_, { progress }) => (
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        <Typography.Text type={progress.submitted > 0 ? 'warning' : undefined}>
          {progress.submitted}
        </Typography.Text>
        {` / ${progress.approved} / ${progress.rejected}`}
      </span>
    ),
  },
  {
    title: 'Reject rate',
    key: 'rejectRate',
    width: 110,
    align: 'right',
    sorter: (a, b) => (a.progress.rejectRate ?? -1) - (b.progress.rejectRate ?? -1),
    render: (_, { progress }) => formatPercent(progress.rejectRate),
  },
  {
    title: <Tooltip title="Spent (approved) / estimated total, fees included">Cost</Tooltip>,
    key: 'cost',
    width: 160,
    align: 'right',
    render: (_, { cost }) => (
      <>
        <MoneyText cents={cost.spentCents} /> / <MoneyText cents={cost.estimatedCents} />
      </>
    ),
  },
  {
    title: 'Status',
    key: 'status',
    width: 120,
    render: (_, { status }) => <StatusTag status={status} />,
  },
];

export default function BatchListPage() {
  const batches = useQuery({ queryKey: ['batches'], queryFn: () => api.listBatches() });

  return (
    <>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Batches
      </Typography.Title>
      <QueryErrorAlert error={batches.error} />
      <Table
        rowKey={(row) => row.batch.id}
        columns={columns}
        dataSource={batches.data}
        loading={batches.isLoading}
        pagination={false}
        size="middle"
      />
    </>
  );
}
