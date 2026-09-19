// 5.3 Review의 응답 상세: 문항별로 이 worker의 값, 같은 HIT 다른 worker의 값, majority를 나란히 보여준다.

import { useQuery } from '@tanstack/react-query';
import { Button, Descriptions, Drawer, Flex, Space, Switch, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { AssignmentListItem, BatchDetail } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import StatusTag from '../../components/StatusTag';
import { formatDateTime, formatPercent, formatSeconds } from '../../components/format';
import { majority } from '../../domain/agreement';
import { DEFAULT_ATTENTION_PREFIX, isAttentionName } from '../../domain/attention';
import AttentionTag from './AttentionTag';
import TaskPreviewModal from './TaskPreviewModal';
import type { ReviewAction } from './ReviewActionModal';

interface Props {
  detail: BatchDetail;
  assignment: AssignmentListItem | null;
  onClose: () => void;
  onAction: (kind: ReviewAction['kind'], assignment: AssignmentListItem) => void;
}

interface AnswerRow {
  name: string;
  own: string;
  others: { workerId: string; value: string; rejected: boolean }[];
  othersMajority: string | null;
  attention: boolean;
}

export default function AssignmentDrawer({ detail, assignment, onClose, onAction }: Props) {
  const { batch } = detail;
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const hitId = assignment?.HITId;

  const siblings = useQuery({
    queryKey: ['hit-assignments', batch.id, hitId],
    queryFn: () => api.listAssignments(batch.id, { page: 1, pageSize: 100, filters: { HITId: hitId } }),
    enabled: hitId !== undefined,
  });

  const rows = useMemo((): AnswerRow[] => {
    if (!assignment) return [];
    const prefix = batch.attentionRule?.namePrefix ?? DEFAULT_ATTENTION_PREFIX;
    const others = (siblings.data?.items ?? []).filter((a) => a.AssignmentId !== assignment.AssignmentId);
    return assignment.answers.map((answer) => {
      const votes = others.flatMap((other) => {
        const value = other.answers.find((x) => x.name === answer.name)?.value;
        return value === undefined ? [] : [{ workerId: other.WorkerId, value, rejected: other.AssignmentStatus === 'Rejected' }];
      });
      return {
        name: answer.name,
        own: answer.value,
        others: votes,
        // 반려된 응답은 비교 기준에 넣지 않는다 (표의 Agree 열과 같은 기준)
        othersMajority: majority(votes.filter((v) => !v.rejected).map((v) => v.value)),
        attention: isAttentionName(answer.name, prefix),
      };
    });
  }, [assignment, siblings.data, batch.attentionRule]);

  const expected = batch.attentionRule?.expectedValue;
  const disagrees = (row: AnswerRow) =>
    row.attention ? expected !== undefined && row.own !== expected : row.othersMajority !== null && row.othersMajority !== row.own;
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
    {
      title: 'Expected / majority',
      key: 'majority',
      width: 170,
      render: (_, row) =>
        row.attention ? (
          expected ? <Tag color="purple">{expected}</Tag> : <Typography.Text type="secondary">–</Typography.Text>
        ) : row.othersMajority === null ? (
          <Typography.Text type="secondary">{row.others.length === 0 ? '–' : 'tie'}</Typography.Text>
        ) : (
          <Tag>{row.othersMajority}</Tag>
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
            <Typography.Text strong>
              Answers ({rows.length}){rows.some(disagrees) && `, ${rows.filter(disagrees).length} differ`}
            </Typography.Text>
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
