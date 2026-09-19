// 5.4 pool 편집: pool 행을 펼치면 나오는 인원 표. 한 명씩 또는 여러 명을 골라 pool에서 뺀다.

import { useQuery } from '@tanstack/react-query';
import { Button, Flex, Popconfirm, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Worker, WorkerPool } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import { formatDate, formatPercent } from '../../components/format';
import { countWorkers } from './shared';
import { useWorkerActions } from './useWorkerActions';

const MAX_MEMBERS = 1000; // listWorkers의 pageSize 상한

export default function PoolMembers({ pool }: { pool: WorkerPool }) {
  const actions = useWorkerActions();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // 지표까지 보여주려고 pool.workerIds 대신 listWorkers로 받는다. ['workers']로 시작해서 변경 뒤에 함께 갱신된다.
  const members = useQuery({
    queryKey: ['workers', 'pool-members', pool.id],
    queryFn: () =>
      api.listWorkers({
        page: 1,
        pageSize: MAX_MEMBERS,
        sort: { field: 'stats.total', order: 'desc' },
        filters: { poolId: pool.id },
      }),
  });

  const remove = async (workerIds: string[]) => {
    if (await actions.removeFromPool(pool, workerIds)) {
      setSelectedIds((previous) => previous.filter((id) => !workerIds.includes(id)));
    }
  };

  const columns: TableColumnsType<Worker> = [
    {
      title: 'Worker',
      key: 'WorkerId',
      render: (_, w) => (
        <Space size="small">
          <Link to={`/workers/${w.WorkerId}`}>
            <Typography.Text code>{w.WorkerId}</Typography.Text>
          </Link>
          {w.blocked && <Tag color="red">Blocked</Tag>}
        </Space>
      ),
    },
    { title: 'Subm', key: 'total', align: 'right', width: 80, render: (_, w) => w.stats.total },
    { title: 'Appr', key: 'approved', align: 'right', width: 80, render: (_, w) => w.stats.approved },
    { title: 'Rej%', key: 'rejectRate', align: 'right', width: 80, render: (_, w) => formatPercent(w.stats.rejectRate) },
    { title: 'Attn fail', key: 'attention', align: 'right', width: 90, render: (_, w) => formatPercent(w.stats.attentionFailRate) },
    { title: 'Agree', key: 'agreement', align: 'right', width: 80, render: (_, w) => formatPercent(w.stats.majorityAgreement) },
    { title: 'Last active', key: 'lastActive', width: 120, render: (_, w) => formatDate(w.stats.lastActiveAt) },
    {
      title: '',
      key: 'actions',
      width: 90,
      align: 'right',
      render: (_, w) => (
        <Button type="link" size="small" disabled={actions.busy} onClick={() => void remove([w.WorkerId])}>
          Remove
        </Button>
      ),
    },
  ];

  const total = members.data?.total ?? pool.workerIds.length;

  return (
    <div style={{ paddingBlock: 4 }}>
      <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">
          {countWorkers(total)} in "{pool.name}"
          {total > MAX_MEMBERS && ` (showing the first ${MAX_MEMBERS})`}
        </Typography.Text>
        <Popconfirm
          title={`Remove ${countWorkers(selectedIds.length)} from "${pool.name}"?`}
          okText="Remove"
          disabled={selectedIds.length === 0 || actions.busy}
          onConfirm={() => remove(selectedIds)}
        >
          <Button size="small" danger disabled={selectedIds.length === 0 || actions.busy}>
            Remove selected{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
        </Popconfirm>
      </Flex>
      <QueryErrorAlert error={members.error} />
      <Table
        rowKey="WorkerId"
        size="small"
        columns={columns}
        dataSource={members.data?.items}
        loading={members.isFetching || actions.busy}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(String)),
        }}
        pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        locale={{
          emptyText: 'No workers in this pool yet. Add them from the Workers list, or use "Fill by criteria…".',
        }}
      />
    </div>
  );
}
