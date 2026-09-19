// 5.4 Worker 상세: 지표 요약(8.5), batch별 assignment 이력, 메모. pool과 차단도 여기서 바꿀 수 있다.

import { InfoCircleOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Breadcrumb,
  Button,
  Card,
  Col,
  Flex,
  Input,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { AssignmentStatus, WorkerAssignmentSummary, WorkerDetail } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import StatusTag from '../../components/StatusTag';
import { EMPTY, formatDate, formatDateTime, formatPercent, formatSeconds } from '../../components/format';
import BlockWorkersModal from './BlockWorkersModal';
import PoolMenuButton from './PoolMenuButton';
import { errorText, invalidateWorkerData } from './shared';
import { useWorkerActions } from './useWorkerActions';

type BatchRow = WorkerDetail['batches'][number];

const STATUSES: AssignmentStatus[] = ['Submitted', 'Approved', 'Rejected'];
const tabular = { fontVariantNumeric: 'tabular-nums' } as const;

/** Manage의 Review 탭이 `worker` query param을 읽어 이 worker의 assignment만 보여준다. */
function reviewLink(batchId: string, workerId: string): string {
  return `/manage/${batchId}/review?worker=${encodeURIComponent(workerId)}`;
}

function Stat({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  const label: ReactNode = hint ? (
    <Tooltip title={hint}>
      {title} <InfoCircleOutlined style={{ fontSize: 12 }} />
    </Tooltip>
  ) : (
    title
  );
  return <Statistic title={label} value={value} valueStyle={{ fontSize: 22, ...tabular }} />;
}

function NoteEditor({ worker }: { worker: WorkerDetail }) {
  const queryClient = useQueryClient();
  const { message, notification } = App.useApp();
  const [note, setNote] = useState(worker.note);
  const [saving, setSaving] = useState(false);

  // 저장된 메모가 바뀌었을 때만 맞춘다. pool 변경 같은 다른 갱신이 쓰던 내용을 지우지 않게 한다.
  useEffect(() => setNote(worker.note), [worker.note]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateWorkerNote(worker.WorkerId, note);
      await invalidateWorkerData(queryClient);
      message.success('Note saved.');
    } catch (error) {
      notification.error({ message: 'Could not save the note', description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="small" title="Note" style={{ height: '100%' }}>
      <Input.TextArea
        rows={4}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Anything worth remembering about this worker. Only visible in this console."
      />
      <Flex justify="flex-end" align="center" gap={12} style={{ marginTop: 8 }}>
        {note !== worker.note && <Typography.Text type="secondary">Unsaved changes</Typography.Text>}
        <Button type="primary" disabled={note === worker.note} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </Flex>
    </Card>
  );
}

export default function WorkerDetailPage() {
  const { workerId = '' } = useParams();
  const worker = useQuery({ queryKey: ['worker', workerId], queryFn: () => api.getWorker(workerId) });
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api.listPools() });
  const actions = useWorkerActions();
  const [blockOpen, setBlockOpen] = useState(false);

  const data = worker.data;
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? id;
  const batchName = (id: string) => data?.batches.find((b) => b.batchId === id)?.batchName ?? id;

  const batchColumns: TableColumnsType<BatchRow> = [
    {
      title: 'Batch',
      key: 'batch',
      render: (_, b) => <Link to={reviewLink(b.batchId, workerId)}>{b.batchName}</Link>,
    },
    { title: 'Submitted', dataIndex: 'total', align: 'right', width: 100 },
    { title: 'Approved', dataIndex: 'approved', align: 'right', width: 100 },
    { title: 'Rejected', dataIndex: 'rejected', align: 'right', width: 100 },
    { title: 'Pending', dataIndex: 'pending', align: 'right', width: 90 },
    {
      title: 'Rej%',
      key: 'rejectRate',
      align: 'right',
      width: 80,
      // 8.5와 같은 정의: 반려 / (승인 + 반려)
      render: (_, b) => formatPercent(b.approved + b.rejected > 0 ? b.rejected / (b.approved + b.rejected) : null),
    },
  ];

  const assignmentColumns: TableColumnsType<WorkerAssignmentSummary> = [
    {
      title: 'Submitted',
      key: 'SubmitTime',
      width: 160,
      sorter: (a, b) => a.SubmitTime.localeCompare(b.SubmitTime),
      render: (_, a) => formatDateTime(a.SubmitTime),
    },
    {
      title: 'Batch',
      key: 'batch',
      ellipsis: true,
      filters: data?.batches.map((b) => ({ text: b.batchName, value: b.batchId })),
      onFilter: (value, a) => a.batchId === value,
      render: (_, a) => <Link to={reviewLink(a.batchId, workerId)}>{batchName(a.batchId)}</Link>,
    },
    { title: 'Row', dataIndex: 'rowIndex', width: 70, align: 'right', sorter: (a, b) => a.rowIndex - b.rowIndex },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      filters: STATUSES.map((s) => ({ text: s, value: s })),
      onFilter: (value, a) => a.AssignmentStatus === value,
      render: (_, a) => <StatusTag status={a.AssignmentStatus} />,
    },
    {
      title: 'Work time',
      key: 'workTime',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.workTimeInSeconds - b.workTimeInSeconds,
      render: (_, a) => <span style={tabular}>{formatSeconds(a.workTimeInSeconds)}</span>,
    },
    {
      title: 'Attention',
      key: 'attention',
      width: 120,
      render: (_, a) =>
        a.attention ? (
          <Typography.Text type={a.attention.passed ? 'success' : 'danger'} style={tabular}>
            {a.attention.correct}/{a.attention.total} {a.attention.passed ? 'PASS' : 'FAIL'}
          </Typography.Text>
        ) : (
          EMPTY
        ),
    },
    {
      title: 'Feedback',
      dataIndex: 'RequesterFeedback',
      ellipsis: { showTitle: true },
      render: (text?: string) => text || EMPTY,
    },
  ];

  return (
    <>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <Link to="/workers">Worker Pool</Link> },
          { title: <Typography.Text code>{workerId}</Typography.Text> },
        ]}
      />
      <QueryErrorAlert error={worker.error} />
      {worker.error && <Link to="/workers">← Back to the worker list</Link>}
      {worker.isLoading && <Skeleton active />}

      {data && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Flex justify="space-between" align="center" gap={16}>
            <Space size="small" wrap>
              <Typography.Title level={4} style={{ margin: 0, marginRight: 8 }} copyable>
                {data.WorkerId}
              </Typography.Title>
              {data.poolIds.map((id) => (
                <Tag key={id}>{poolName(id)}</Tag>
              ))}
              {data.poolIds.length === 0 && !data.blocked && (
                <Typography.Text type="secondary">Not in any pool</Typography.Text>
              )}
              {data.blocked && <Tag color="red">Blocked</Tag>}
            </Space>
            <Space>
              <PoolMenuButton
                mode="add"
                pools={pools.data}
                workerIds={[data.WorkerId]}
                disabled={actions.busy}
                onPick={(pool) => actions.addToPool(pool, [data.WorkerId])}
              />
              <PoolMenuButton
                mode="remove"
                pools={pools.data}
                workerIds={[data.WorkerId]}
                disabled={actions.busy}
                onPick={(pool) => actions.removeFromPool(pool, [data.WorkerId])}
              />
              {data.blocked ? (
                <Button loading={actions.busy} onClick={() => void actions.unblock([data.WorkerId])}>
                  Unblock
                </Button>
              ) : (
                <Button danger disabled={actions.busy} onClick={() => setBlockOpen(true)}>
                  Block…
                </Button>
              )}
            </Space>
          </Flex>

          {data.blocked && (
            <Alert
              type="error"
              showIcon
              message="This worker is blocked"
              description={
                <>
                  Reason: {data.blockReason || EMPTY}
                  <br />
                  Blocking can harm the worker's MTurk account. If the goal is only to keep them out of future batches,
                  unblock and use the Excluded pool instead.
                </>
              }
            />
          )}

          <Card size="small">
            <Row gutter={[16, 16]}>
              <Col flex="20%">
                <Stat title="Submitted" value={data.stats.total} />
              </Col>
              <Col flex="20%">
                <Stat title="Approved" value={data.stats.approved} />
              </Col>
              <Col flex="20%">
                <Stat title="Rejected" value={data.stats.rejected} />
              </Col>
              <Col flex="20%">
                <Stat title="Pending review" value={data.stats.pending} />
              </Col>
              <Col flex="20%">
                <Stat title="Batches" value={data.stats.batchCount} />
              </Col>
              <Col flex="20%">
                <Stat title="Reject rate" value={formatPercent(data.stats.rejectRate)} hint="Rejected / (approved + rejected)" />
              </Col>
              <Col flex="20%">
                <Stat
                  title="Attention fail rate"
                  value={formatPercent(data.stats.attentionFailRate)}
                  hint="Assignments that failed the attention check / assignments that had one"
                />
              </Col>
              <Col flex="20%">
                <Stat
                  title="Majority agreement"
                  value={formatPercent(data.stats.majorityAgreement)}
                  hint="Share of this worker's answers that equal the majority of the other workers on the same item. Ties are skipped."
                />
              </Col>
              <Col flex="20%">
                <Stat title="Median work time" value={formatSeconds(data.stats.medianWorkTimeInSeconds)} />
              </Col>
              <Col flex="20%">
                <Stat title="Last active" value={formatDate(data.stats.lastActiveAt)} />
              </Col>
            </Row>
          </Card>

          <Row gutter={16}>
            <Col span={15}>
              <Card size="small" title="By batch" style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
                <Table
                  rowKey="batchId"
                  size="small"
                  columns={batchColumns}
                  dataSource={data.batches}
                  pagination={false}
                  locale={{ emptyText: 'No assignments yet.' }}
                />
              </Card>
            </Col>
            <Col span={9}>
              <NoteEditor key={data.WorkerId} worker={data} />
            </Col>
          </Row>

          <Card size="small" title={`Assignment history (${data.assignments.length})`} styles={{ body: { padding: 0 } }}>
            <Table
              rowKey="AssignmentId"
              size="small"
              columns={assignmentColumns}
              dataSource={data.assignments}
              pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true, style: { marginInline: 12 } }}
              locale={{ emptyText: 'No assignments yet.' }}
            />
          </Card>
        </Space>
      )}

      {blockOpen && data && (
        <BlockWorkersModal
          workerIds={[data.WorkerId]}
          onCancel={() => setBlockOpen(false)}
          onDone={() => setBlockOpen(false)}
        />
      )}
    </>
  );
}
