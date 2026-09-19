// 5.3 Review: assignment 표, 필터, 일괄 승인/반려, 반려 번복. 행을 누르면 응답 상세 Drawer가 열린다.

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Flex, Input, InputNumber, Select, Space, Table, Tooltip, Typography, type TableColumnsType, type TableProps } from 'antd';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client';
import type { AssignmentListItem, BatchDetail, ListQuery } from '../../../api/types';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import StatusTag from '../../../components/StatusTag';
import { formatDateTime, formatPercent, formatSeconds } from '../../../components/format';
import AssignmentDrawer from '../AssignmentDrawer';
import AttentionTag from '../AttentionTag';
import ReviewActionModal, { type ReviewAction } from '../ReviewActionModal';
import { describeTopUp, invalidateBatchData } from '../shared';

const DEFAULT_SORT: NonNullable<ListQuery['sort']> = { field: 'SubmitTime', order: 'desc' };

export default function ReviewTab({ detail }: { detail: BatchDetail }) {
  const batchId = detail.batch.id;
  const queryClient = useQueryClient();
  const { modal, message, notification } = App.useApp();
  const [searchParams] = useSearchParams();

  // Worker 상세 화면에서 ?worker=<id>로 넘어온다
  const [query, setQuery] = useState<ListQuery>(() => ({
    page: 1,
    pageSize: 25,
    sort: DEFAULT_SORT,
    filters: { workerSearch: searchParams.get('worker') ?? undefined },
  }));
  // 페이지를 넘겨도 선택이 유지되도록 행 자체를 들고 있는다 (버튼 활성화에 상태가 필요하다)
  const [selected, setSelected] = useState<Map<string, AssignmentListItem>>(new Map());
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [opened, setOpened] = useState<AssignmentListItem | null>(null);
  const [selectingFailed, setSelectingFailed] = useState(false);

  const assignments = useQuery({
    queryKey: ['assignments', batchId, query],
    queryFn: () => api.listAssignments(batchId, query),
    placeholderData: keepPreviousData,
  });

  const setFilter = (name: string, value: unknown) =>
    setQuery((previous) => ({ ...previous, page: 1, filters: { ...previous.filters, [name]: value } }));

  const chosen = [...selected.values()];
  const allSubmitted = chosen.length > 0 && chosen.every((a) => a.AssignmentStatus === 'Submitted');
  const allRejected = chosen.length > 0 && chosen.every((a) => a.AssignmentStatus === 'Rejected');

  const selectAttentionFailed = async () => {
    setSelectingFailed(true);
    try {
      const failed = await api.listAssignments(batchId, {
        page: 1,
        pageSize: 1000,
        filters: { AssignmentStatus: 'Submitted', attention: 'fail' },
      });
      setSelected(new Map(failed.items.map((a) => [a.AssignmentId, a])));
      if (failed.total === 0) message.info('No submitted assignment failed the attention check.');
      else message.success(`Selected ${failed.total} submitted assignment(s) that failed the attention check.`);
    } catch (error) {
      notification.error({ message: 'Could not select', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSelectingFailed(false);
    }
  };

  /** 5.3: 반려해도 MTurk는 자리를 다시 열어 주지 않으므로, 반려를 확정하면 재모집할지 묻는다. */
  const offerTopUp = (rejected: AssignmentListItem[]) => {
    const hitIds = [...new Set(rejected.map((a) => a.HITId))];
    modal.confirm({
      title: `Top up the ${hitIds.length} affected HIT(s)?`,
      content:
        'MTurk does not reopen a slot when you reject. A top-up adds exactly as many assignments as each HIT still needs to reach its target, and extends expired HITs.',
      okText: 'Top up',
      cancelText: 'Not now',
      onOk: async () => {
        try {
          const result = await api.addAssignments(hitIds, 'fill-to-target');
          await invalidateBatchData(queryClient, batchId);
          const { title, lines } = describeTopUp(result);
          modal.info({ title, content: <>{lines.map((line) => <p key={line} style={{ margin: '4px 0' }}>{line}</p>)}</>, width: 520 });
        } catch (error) {
          notification.error({ message: 'Top-up failed', description: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  };

  const onActionDone = async (done: ReviewAction) => {
    setAction(null);
    setSelected(new Map());
    setOpened(null);
    await invalidateBatchData(queryClient, batchId);
    message.success(
      `${done.kind === 'reject' ? 'Rejected' : done.kind === 'revert' ? 'Reverted to approved' : 'Approved'} ${done.assignments.length} assignment(s).`,
    );
    if (done.kind === 'reject') offerTopUp(done.assignments);
  };

  const sortOrderOf = (field: string) =>
    query.sort?.field === field ? (query.sort.order === 'asc' ? ('ascend' as const) : ('descend' as const)) : null;

  const columns: TableColumnsType<AssignmentListItem> = [
    { title: 'Row', key: 'rowIndex', width: 70, align: 'right', sorter: true, sortOrder: sortOrderOf('rowIndex'), render: (_, a) => a.rowIndex },
    {
      title: 'Worker',
      key: 'WorkerId',
      width: 160,
      sorter: true,
      sortOrder: sortOrderOf('WorkerId'),
      render: (_, a) => (
        <Link to={`/workers/${a.WorkerId}`} onClick={(event) => event.stopPropagation()}>
          <Typography.Text code>{a.WorkerId}</Typography.Text>
        </Link>
      ),
    },
    { title: 'Status', key: 'AssignmentStatus', width: 110, sorter: true, sortOrder: sortOrderOf('AssignmentStatus'), render: (_, a) => <StatusTag status={a.AssignmentStatus} /> },
    { title: 'Time', key: 'workTimeInSeconds', width: 90, align: 'right', sorter: true, sortOrder: sortOrderOf('workTimeInSeconds'), render: (_, a) => formatSeconds(a.workTimeInSeconds) },
    { title: 'Attention', key: 'attention.correct', width: 120, render: (_, a) => <AttentionTag attention={a.attention} /> },
    {
      title: <Tooltip title="Share of this worker's answers that match the majority of the other workers on the same HIT">Agree</Tooltip>,
      key: 'agreement',
      width: 90,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('agreement'),
      render: (_, a) => formatPercent(a.agreement),
    },
    { title: 'Submitted', key: 'SubmitTime', width: 150, sorter: true, sortOrder: sortOrderOf('SubmitTime'), render: (_, a) => formatDateTime(a.SubmitTime) },
    { title: 'Feedback', key: 'feedback', ellipsis: true, render: (_, a) => <Typography.Text type="secondary">{a.RequesterFeedback}</Typography.Text> },
  ];

  const onTableChange: TableProps<AssignmentListItem>['onChange'] = (pagination, _filters, sorter) => {
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
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          allowClear
          placeholder="Status"
          style={{ minWidth: 190 }}
          value={(query.filters?.AssignmentStatus as string[] | undefined) ?? []}
          onChange={(value: string[]) => setFilter('AssignmentStatus', value)}
          options={['Submitted', 'Approved', 'Rejected'].map((value) => ({ value, label: value }))}
        />
        <Select
          allowClear
          placeholder="Attention"
          style={{ width: 150 }}
          value={query.filters?.attention as string | undefined}
          onChange={(value?: string) => setFilter('attention', value)}
          options={[{ value: 'pass', label: 'Passed' }, { value: 'fail', label: 'Failed' }, { value: 'none', label: 'No attention items' }]}
        />
        <Input.Search
          allowClear
          placeholder="WorkerId"
          style={{ width: 200 }}
          defaultValue={(query.filters?.workerSearch as string | undefined) ?? ''}
          onSearch={(value) => setFilter('workerSearch', value)}
        />
        <InputNumber
          placeholder="Work time under"
          suffix="s"
          min={1}
          style={{ width: 190 }}
          value={query.filters?.maxWorkTime as number | undefined}
          onChange={(value) => setFilter('maxWorkTime', value ?? undefined)}
        />
      </Flex>

      <Flex gap={8} align="center" style={{ marginBottom: 12 }}>
        <Button loading={selectingFailed} onClick={() => void selectAttentionFailed()}>
          Select attention-failed
        </Button>
        <Button type="primary" disabled={!allSubmitted} onClick={() => setAction({ kind: 'approve', assignments: chosen })}>
          Approve selected
        </Button>
        <Button danger disabled={!allSubmitted} onClick={() => setAction({ kind: 'reject', assignments: chosen })}>
          Reject selected…
        </Button>
        {allRejected && (
          <Button onClick={() => setAction({ kind: 'revert', assignments: chosen })}>Revert to approved…</Button>
        )}
        {chosen.length > 0 && (
          <Space size={4}>
            <Typography.Text type="secondary">{chosen.length} selected</Typography.Text>
            <Button type="link" size="small" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
            {!allSubmitted && !allRejected && (
              <Typography.Text type="secondary">· select only Submitted (to review) or only Rejected (to revert)</Typography.Text>
            )}
          </Space>
        )}
      </Flex>

      <QueryErrorAlert error={assignments.error} />
      <Table
        rowKey="AssignmentId"
        size="middle"
        columns={columns}
        dataSource={assignments.data?.items}
        loading={assignments.isFetching}
        onChange={onTableChange}
        onRow={(record) => ({ onClick: () => setOpened(record), style: { cursor: 'pointer' } })}
        rowSelection={{
          selectedRowKeys: [...selected.keys()],
          preserveSelectedRowKeys: true,
          onChange: (keys, rows) => {
            const known = new Map([...selected, ...rows.filter(Boolean).map((r) => [r.AssignmentId, r] as const)]);
            setSelected(new Map(keys.flatMap((key) => (known.has(String(key)) ? [[String(key), known.get(String(key))!] as const] : []))));
          },
        }}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total: assignments.data?.total,
          showSizeChanger: true,
          pageSizeOptions: [25, 50, 100],
          showTotal: (total) => `${total} assignments`,
        }}
      />

      <AssignmentDrawer
        detail={detail}
        assignment={opened}
        onClose={() => setOpened(null)}
        onAction={(kind, assignment) => setAction({ kind, assignments: [assignment] })}
      />
      <ReviewActionModal action={action} onCancel={() => setAction(null)} onDone={(done) => void onActionDone(done)} />
    </>
  );
}
