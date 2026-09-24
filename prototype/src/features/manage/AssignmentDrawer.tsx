// 5.3 Review의 응답 상세: 문항별로 이 worker의 값, 대조 기준(reference), 같은 HIT 다른 worker의 값을 나란히 보여준다.

import { useQuery } from '@tanstack/react-query';
import { Button, Descriptions, Drawer, Flex, Space, Switch, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { AssignmentListItem, BatchDetail } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import StatusTag from '../../components/StatusTag';
import { formatDateTime, formatPercent, formatSeconds } from '../../components/format';
import { DEFAULT_ATTENTION_PREFIX, isAttentionName } from '../../domain/attention';
import { normalizeLabel } from '../../domain/reference';
import AttentionTag from './AttentionTag';
import TaskPreviewModal from './TaskPreviewModal';
import type { ReviewAction } from './ReviewActionModal';
import { describeReferenceSource } from './referenceSource';

interface Props {
  detail: BatchDetail;
  assignment: AssignmentListItem | null;
  onClose: () => void;
  onAction: (kind: ReviewAction['kind'], assignment: AssignmentListItem) => void;
}

interface AnswerRow {
  name: string;
  own: string;
  reference: string | undefined; // 없으면 기준 없음 (column 모드에서 대응 안 됨, majority 모드에서 다른 worker 없음/동률)
  others: { workerId: string; value: string; rejected: boolean }[];
  attention: boolean;
}

export default function AssignmentDrawer({ detail, assignment, onClose, onAction }: Props) {
  const { batch } = detail;
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const hitId = assignment?.HITId;

  // 같은 HIT의 다른 worker 답을 보여 주는 데만 쓴다 (reference는 목록 항목에 이미 들어 있다)
  const siblings = useQuery({
    queryKey: ['hit-assignments', batch.id, hitId],
    queryFn: () => api.listAssignments(batch.id, { page: 1, pageSize: 100, filters: { HITId: hitId } }),
    enabled: hitId !== undefined,
  });

  const rows = useMemo((): AnswerRow[] => {
    if (!assignment) return [];
    const prefix = batch.attentionRule?.namePrefix ?? DEFAULT_ATTENTION_PREFIX;
    const others = (siblings.data?.items ?? []).filter((a) => a.AssignmentId !== assignment.AssignmentId);
    return assignment.answers.map((answer) => ({
      name: answer.name,
      own: answer.value,
      reference: assignment.reference[answer.name],
      others: others.flatMap((other) => {
        const value = other.answers.find((x) => x.name === answer.name)?.value;
        return value === undefined ? [] : [{ workerId: other.WorkerId, value, rejected: other.AssignmentStatus === 'Rejected' }];
      }),
      attention: isAttentionName(answer.name, prefix),
    }));
  }, [assignment, siblings.data, batch.attentionRule]);

  // 표의 Answers 열과 같은 기준: reference가 있는 문항만, normalizeLabel로 비교한다
  const disagrees = (row: AnswerRow) => row.reference !== undefined && normalizeLabel(row.reference) !== normalizeLabel(row.own);
  const shown = onlyDisagreements ? rows.filter(disagrees) : rows;

  const columns: TableColumnsType<AnswerRow> = [
    {
      title: 'Item',
      dataIndex: 'name',
      width: 190,
      render: (name: string, row) => (
        <Space size={4}>
          <Typography.Text code>{name}</Typography.Text>
          {row.attention && <Tag color="purple">attention</Tag>}
        </Space>
      ),
    },
    {
      title: 'This worker',
      dataIndex: 'own',
      width: 150,
      render: (own: string, row) => <Tag color={disagrees(row) ? 'red' : undefined}>{own}</Tag>,
    },
    {
      title: 'Reference',
      dataIndex: 'reference',
      width: 150,
      render: (reference: string | undefined, row) =>
        reference === undefined ? (
          <Typography.Text type="secondary">–</Typography.Text>
        ) : (
          <Tag color={row.attention ? 'purple' : undefined}>{reference}</Tag>
        ),
    },
    {
      title: 'Other workers on this HIT',
      key: 'others',
      render: (_, row) =>
        row.others.length === 0 ? (
          <Typography.Text type="secondary">none yet</Typography.Text>
        ) : (
          <Space size={[4, 4]} wrap>
            {row.others.map((o) => (
              <Tag key={o.workerId} style={o.rejected ? { textDecoration: 'line-through', opacity: 0.6 } : undefined} title={`${o.workerId}${o.rejected ? ' (rejected)' : ''}`}>
                {o.value}
              </Tag>
            ))}
          </Space>
        ),
    },
  ];

  return (
    <Drawer
      open={assignment !== null}
      onClose={onClose}
      width={860}
      title={assignment ? `Row ${assignment.rowIndex} · assignment ${assignment.AssignmentId.slice(0, 10)}…` : ''}
      extra={
        assignment && (
          <Space>
            <Button onClick={() => setPreviewOpen(true)}>Open task</Button>
            {assignment.AssignmentStatus === 'Submitted' && (
              <>
                <Button type="primary" onClick={() => onAction('approve', assignment)}>Approve</Button>
                <Button danger onClick={() => onAction('reject', assignment)}>Reject…</Button>
              </>
            )}
            {assignment.AssignmentStatus === 'Rejected' && (
              <Button onClick={() => onAction('revert', assignment)}>Revert to approved…</Button>
            )}
          </Space>
        )
      }
    >
      {assignment && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="Worker">
              <Link to={`/workers/${assignment.WorkerId}`}><Typography.Text code>{assignment.WorkerId}</Typography.Text></Link>
            </Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={assignment.AssignmentStatus} /></Descriptions.Item>
            <Descriptions.Item label="Work time">{formatSeconds(assignment.workTimeInSeconds)}</Descriptions.Item>
            <Descriptions.Item label="Attention"><AttentionTag attention={assignment.attention} /></Descriptions.Item>
            <Descriptions.Item label="Agreement">{formatPercent(assignment.agreement)}</Descriptions.Item>
            <Descriptions.Item label="Submitted">{formatDateTime(assignment.SubmitTime)}</Descriptions.Item>
            {assignment.RequesterFeedback && (
              <Descriptions.Item label="Feedback" span={3}>{assignment.RequesterFeedback}</Descriptions.Item>
            )}
          </Descriptions>

          <Flex justify="space-between" align="center">
            <Space size={8}>
              <Typography.Text strong>
                Answers ({rows.length}){rows.some(disagrees) && `, ${rows.filter(disagrees).length} differ`}
              </Typography.Text>
              <Typography.Text type="secondary">Reference: {describeReferenceSource(batch.reference)}</Typography.Text>
            </Space>
            <Space size={6}>
              <Switch size="small" checked={onlyDisagreements} onChange={setOnlyDisagreements} />
              <Typography.Text type="secondary">Only differences</Typography.Text>
            </Space>
          </Flex>
          <QueryErrorAlert error={siblings.error} />
          <Table rowKey="name" size="small" columns={columns} dataSource={shown} loading={siblings.isLoading} pagination={false} />
        </Space>
      )}
      {assignment && previewOpen && (
        <TaskPreviewModal batch={batch} hitId={assignment.HITId} rowIndex={assignment.rowIndex} onClose={() => setPreviewOpen(false)} />
      )}
    </Drawer>
  );
}
