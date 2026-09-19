// 5.4 Pool 목록과 편집: pool 생성, 인원 보기/빼기(행 펼침), "조건으로 채우기"

import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Flex, Space, Table, Typography, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { api } from '../../api/client';
import type { WorkerPool } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import { EMPTY } from '../../components/format';
import CreatePoolModal from './CreatePoolModal';
import FillByCriteriaModal from './FillByCriteriaModal';
import PoolMembers from './PoolMembers';

export default function PoolListPage() {
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api.listPools() });
  const [createOpen, setCreateOpen] = useState(false);
  const [fillPoolId, setFillPoolId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const fillPool = pools.data?.find((p) => p.id === fillPoolId);
  const expand = (id: string) => setExpandedIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
  const toggle = (id: string) =>
    setExpandedIds((previous) => (previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id]));

  const columns: TableColumnsType<WorkerPool> = [
    {
      title: 'Name',
      dataIndex: 'name',
      width: 220,
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    { title: 'Description', dataIndex: 'description' },
    {
      title: 'Workers',
      key: 'workers',
      width: 100,
      align: 'right',
      render: (_, pool) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{pool.workerIds.length}</span>,
    },
    {
      title: 'QualificationTypeId',
      dataIndex: 'QualificationTypeId',
      width: 250,
      render: (id?: string) =>
        id ? <Typography.Text code>{id}</Typography.Text> : <Typography.Text type="secondary">{EMPTY} (set after integration)</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 270,
      align: 'right',
      render: (_, pool) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => toggle(pool.id)}>
            {expandedIds.includes(pool.id) ? 'Hide members' : 'View members'}
          </Button>
          <Button type="link" size="small" onClick={() => setFillPoolId(pool.id)}>
            Fill by criteria…
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Flex justify="space-between" align="center" gap={16} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">
          Require or exclude a pool for a batch in Create › Settings. After integration each pool maps to one custom
          Qualification.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          New pool
        </Button>
      </Flex>
      <QueryErrorAlert error={pools.error} />
      <Table
        rowKey="id"
        columns={columns}
        dataSource={pools.data}
        loading={pools.isLoading}
        pagination={false}
        size="middle"
        expandable={{
          expandedRowKeys: expandedIds,
          onExpandedRowsChange: (keys) => setExpandedIds(keys.map(String)),
          expandedRowRender: (pool) => <PoolMembers pool={pool} />,
        }}
      />

      {createOpen && <CreatePoolModal onCancel={() => setCreateOpen(false)} onCreated={() => setCreateOpen(false)} />}
      {fillPool && (
        <FillByCriteriaModal
          pool={fillPool}
          onCancel={() => setFillPoolId(null)}
          onDone={(pool) => {
            setFillPoolId(null);
            expand(pool.id); // 방금 넣은 worker가 바로 보이게
          }}
        />
      )}
    </>
  );
}
