// 5.3 HITs: HIT별 진행률, "미완료만" 필터, 선택한 HIT 재모집, 입력으로 task 화면 열기

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Flex, InputNumber, Modal, Radio, Select, Space, Switch, Table, Tag, Typography, type TableColumnsType, type TableProps } from 'antd';
import { useState } from 'react';
import { api } from '../../../api/client';
import type { AddAssignmentsMode, BatchDetail, HitListItem, ListQuery } from '../../../api/types';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import { formatDateTime } from '../../../components/format';
import TaskPreviewModal from '../TaskPreviewModal';
import { describeTopUp, invalidateBatchData } from '../shared';

const DEFAULT_SORT: NonNullable<ListQuery['sort']> = { field: 'rowIndex', order: 'asc' };

export default function HitsTab({ detail }: { detail: BatchDetail }) {
  const { batch } = detail;
  const queryClient = useQueryClient();
  const { modal, notification } = App.useApp();

  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 25, sort: DEFAULT_SORT });
  // 대표 입력 컬럼. batch마다 고를 수 있고, qid가 있으면 그것부터 보여준다.
  const [keyColumn, setKeyColumn] = useState(() => (batch.inputColumns.includes('qid') ? 'qid' : (batch.inputColumns[0] ?? '')));
  const [selected, setSelected] = useState<string[]>([]);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [mode, setMode] = useState<'fill' | 'count'>('fill');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<HitListItem | null>(null);

  const hits = useQuery({
    queryKey: ['hits', batch.id, query],
    queryFn: () => api.listHits(batch.id, query),
    placeholderData: keepPreviousData,
  });

  const topUp = async () => {
    setBusy(true);
    try {
      const request: AddAssignmentsMode = mode === 'fill' ? 'fill-to-target' : count;
      const result = await api.addAssignments(selected, request);
      await invalidateBatchData(queryClient, batch.id);
      setTopUpOpen(false);
      setSelected([]);
      const { title, lines } = describeTopUp(result);
      modal.info({ title, content: <>{lines.map((line) => <p key={line} style={{ margin: '4px 0' }}>{line}</p>)}</>, width: 520 });
    } catch (error) {
      notification.error({ message: 'Top-up failed', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const sortOrderOf = (field: string) =>
    query.sort?.field === field ? (query.sort.order === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;
  const numeric = (title: string, key: string, pick: (h: HitListItem) => number, width = 90) => ({
    title,
    key,
    width,
    align: 'right' as const,
    sorter: true,
    sortOrder: sortOrderOf(key),
    render: (_: unknown, hit: HitListItem) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{pick(hit)}</span>,
  });

  const columns: TableColumnsType<HitListItem> = [
    numeric('Row', 'rowIndex', (h) => h.rowIndex, 70),
    {
      title: keyColumn || 'Input',
      key: 'input',
      ellipsis: true,
      render: (_, hit) => <Typography.Text>{hit.inputPreview[keyColumn] ?? ''}</Typography.Text>,
    },
    numeric('Max', 'MaxAssignments', (h) => h.MaxAssignments, 80),
    numeric('Approved', 'progress.approved', (h) => h.progress.approved, 100),
    numeric('Rejected', 'progress.rejected', (h) => h.progress.rejected, 100),
    numeric('Submitted', 'progress.submitted', (h) => h.progress.submitted, 105),
    numeric('Open', 'progress.open', (h) => h.progress.open, 80),
    {
      title: 'State',
      key: 'progress.completed',
      width: 210,
      render: (_, hit) => (
        <Space size={4} wrap>
          {hit.progress.completed ? <Tag color="green">Completed</Tag> : <Tag>Incomplete</Tag>}
          {!hit.progress.completed && hit.progress.shortfall > 0 && <Tag color="orange">needs +{hit.progress.shortfall}</Tag>}
          {!hit.progress.completed && hit.expired && <Tag color="gold">Expired</Tag>}
        </Space>
      ),
    },
    { title: 'Expires', key: 'Expiration', width: 150, sorter: true, sortOrder: sortOrderOf('Expiration'), render: (_, hit) => formatDateTime(hit.Expiration) },
    {
      title: '',
      key: 'open',
      width: 100,
      render: (_, hit) => (
        <Button type="link" size="small" onClick={() => setPreview(hit)}>
          Open task
        </Button>
      ),
    },
  ];

  const onTableChange: TableProps<HitListItem>['onChange'] = (pagination, _filters, sorter) => {
    const active = Array.isArray(sorter) ? sorter[0] : sorter;
    setQuery((previous) => ({
      ...previous,
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? previous.pageSize,
      sort:
        active?.order && typeof active.columnKey === 'string'
          ? { field: active.columnKey, order: active.order === 'ascend' ? 'asc' : 'desc' }
          : DEFAULT_SORT,
    }));
  };

  return (
    <>
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Space size="middle">
          <Button type="primary" disabled={selected.length === 0} onClick={() => setTopUpOpen(true)}>
            Top up selected…
          </Button>
          {selected.length > 0 && <Typography.Text type="secondary">{selected.length} selected</Typography.Text>}
          <Space size={6}>
            <Switch
              size="small"
              checked={query.filters?.incomplete === true}
              onChange={(checked) => setQuery((p) => ({ ...p, page: 1, filters: { ...p.filters, incomplete: checked || undefined } }))}
            />
            <Typography.Text>Incomplete only</Typography.Text>
          </Space>
        </Space>
        <Space size={6}>
          <Typography.Text type="secondary">Show input column</Typography.Text>
          <Select
            showSearch
            style={{ width: 260 }}
            value={keyColumn}
            onChange={setKeyColumn}
            options={batch.inputColumns.map((column) => ({ value: column, label: column }))}
          />
        </Space>
      </Flex>

      <QueryErrorAlert error={hits.error} />
      <Table
        rowKey="HITId"
        size="middle"
        columns={columns}
        dataSource={hits.data?.items}
        loading={hits.isFetching}
        onChange={onTableChange}
        rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: (keys) => setSelected(keys.map(String)) }}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total: hits.data?.total,
          showSizeChanger: true,
          pageSizeOptions: [25, 50, 100],
          showTotal: (total) => `${total} HITs`,
        }}
      />

      <Modal
        title={`Top up ${selected.length} HIT(s)`}
        open={topUpOpen}
        okText="Top up"
        confirmLoading={busy}
        onOk={() => void topUp()}
        onCancel={() => setTopUpOpen(false)}
      >
        <Radio.Group value={mode} onChange={(event) => setMode(event.target.value as 'fill' | 'count')}>
          <Space direction="vertical">
            <Radio value="fill">
              Fill to target: add what each HIT still needs to reach {batch.settings.MaxAssignments} approved
            </Radio>
            <Radio value="count">
              Add a fixed number to every selected HIT{' '}
              <InputNumber size="small" min={1} max={8} value={count} disabled={mode !== 'count'} onChange={(v) => setCount(v ?? 1)} />
            </Radio>
          </Space>
        </Radio.Group>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          A HIT created with fewer than 10 assignments can never exceed 9 in total (MTurk rule); such HITs are skipped
          with the reason shown. Expired HITs are extended by the batch lifetime. The cost is reserved from the balance.
        </Typography.Paragraph>
      </Modal>

      {preview && <TaskPreviewModal batch={batch} hitId={preview.HITId} rowIndex={preview.rowIndex} onClose={() => setPreview(null)} />}
    </>
  );
}
