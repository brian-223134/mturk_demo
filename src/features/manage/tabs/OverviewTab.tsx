// 5.3 Overview: 진행률과 비용, 설정 요약, 동작 버튼 (미완료 HIT 재모집, 지금 만료, Export)

import { DownOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Descriptions, Dropdown, Flex, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api } from '../../../api/client';
import type { BatchDetail, ExportFormat } from '../../../api/types';
import MoneyText from '../../../components/MoneyText';
import StackedBar, { STATUS_COLORS } from '../../../components/StackedBar';
import { downloadFile } from '../../../components/download';
import { formatDateTime, formatPercent } from '../../../components/format';
import { describeTopUp, invalidateBatchData } from '../shared';

const SYSTEM_QUALIFICATIONS: Record<string, string> = {
  '000000000000000000L0': 'Approval rate (%)',
  '00000000000000000040': 'Approved HITs',
  '00000000000000000071': 'Locale',
};

function duration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${Math.round(seconds / 60)} min`;
}

export default function OverviewTab({ detail }: { detail: BatchDetail }) {
  const { batch, progress, cost, status } = detail;
  const queryClient = useQueryClient();
  const { modal, notification, message } = App.useApp();
  const [busy, setBusy] = useState<'topup' | 'expire' | null>(null);

  const fail = (title: string, error: unknown) =>
    notification.error({ message: title, description: error instanceof Error ? error.message : String(error) });

  const topUpIncomplete = async () => {
    setBusy('topup');
    try {
      const incomplete = await api.listHits(batch.id, { page: 1, pageSize: 1000, filters: { incomplete: true } });
      if (incomplete.total === 0) {
        message.info('Every HIT already has enough approved assignments.');
        return;
      }
      const result = await api.addAssignments(incomplete.items.map((h) => h.HITId), 'fill-to-target');
      await invalidateBatchData(queryClient, batch.id);
      const { title, lines } = describeTopUp(result);
      modal.info({ title, content: <>{lines.map((line) => <p key={line} style={{ margin: '4px 0' }}>{line}</p>)}</>, width: 520 });
    } catch (error) {
      fail('Top-up failed', error);
    } finally {
      setBusy(null);
    }
  };

  const expireNow = () => {
    modal.confirm({
      title: 'Expire this batch now?',
      content: 'Workers will no longer see its HITs. Submitted work stays and can still be reviewed. A top-up reopens expired HITs.',
      okText: 'Expire now',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.expireBatch(batch.id);
          await invalidateBatchData(queryClient, batch.id);
          message.success('Batch expired.');
        } catch (error) {
          fail('Could not expire the batch', error);
        }
      },
    });
  };

  const exportAs = async (format: ExportFormat) => {
    try {
      downloadFile(await api.exportBatch(batch.id, format));
    } catch (error) {
      fail('Export failed', error);
    }
  };

  const completedRatio = progress.hitsTotal === 0 ? 0 : progress.hitsCompleted / progress.hitsTotal;
  const s = batch.settings;

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Flex justify="flex-end" gap={8}>
        <Button type="primary" loading={busy === 'topup'} onClick={() => void topUpIncomplete()}>
          Top up incomplete HITs
        </Button>
        <Button danger disabled={status !== 'in_progress'} onClick={expireNow}>
          Expire now
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: 'mturk-csv', label: 'MTurk results CSV (same columns as the Requester website export)' },
              { key: 'labels-json', label: 'Labels JSON (votes, majority, workers per item)' },
            ],
            onClick: ({ key }) => void exportAs(key as ExportFormat),
          }}
        >
          <Button>
            Export <DownOutlined />
          </Button>
        </Dropdown>
      </Flex>

      <Row gutter={16}>
        <Col span={8}>
          <Card size="small" title="HITs completed" style={{ height: '100%' }}>
            <Statistic value={progress.hitsCompleted} suffix={`/ ${progress.hitsTotal}`} />
            <Progress percent={Math.round(completedRatio * 100)} strokeColor="#2a78d6" size="small" style={{ marginTop: 8 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              A HIT is complete when it has {s.MaxAssignments} approved assignments.
            </Typography.Text>
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="Assignments" style={{ height: '100%' }}>
            <Flex gap={32} style={{ marginBottom: 12 }}>
              <Statistic title="Waiting for review" value={progress.submitted} />
              <Statistic title="Reject rate" value={formatPercent(progress.rejectRate)} />
            </Flex>
            <StackedBar
              segments={[
                { key: 'approved', label: 'Approved', value: progress.approved, color: STATUS_COLORS.good },
                { key: 'submitted', label: 'Submitted', value: progress.submitted, color: STATUS_COLORS.warning },
                { key: 'rejected', label: 'Rejected', value: progress.rejected, color: STATUS_COLORS.critical },
                { key: 'open', label: 'Open', value: progress.open, color: STATUS_COLORS.neutral },
              ]}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" title="Cost (fees included)" style={{ height: '100%' }}>
            <Statistic title="Spent on approved work" valueRender={() => <MoneyText cents={cost.spentCents} />} />
            <Statistic
              title="Estimated total"
              valueRender={() => <MoneyText cents={cost.estimatedCents} />}
              style={{ marginTop: 12 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Total if every remaining assignment is approved. Rejected work is not charged.
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Descriptions title="Settings" bordered size="small" column={2}>
        <Descriptions.Item label="Title" span={2}>{s.Title}</Descriptions.Item>
        <Descriptions.Item label="Description" span={2}>{s.Description}</Descriptions.Item>
        <Descriptions.Item label="Reward">${s.Reward}</Descriptions.Item>
        <Descriptions.Item label="MaxAssignments (target labels)">{s.MaxAssignments}</Descriptions.Item>
        <Descriptions.Item label="Time allotted">{duration(s.AssignmentDurationInSeconds)}</Descriptions.Item>
        <Descriptions.Item label="Auto-approval delay">{duration(s.AutoApprovalDelayInSeconds)}</Descriptions.Item>
        <Descriptions.Item label="HIT lifetime">{duration(s.LifetimeInSeconds)}</Descriptions.Item>
        <Descriptions.Item label="Created">{formatDateTime(batch.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="Attention rule" span={2}>
          {batch.attentionRule ? (
            <>
              answers named <Typography.Text code>{batch.attentionRule.namePrefix}*</Typography.Text> must be{' '}
              <Typography.Text code>{batch.attentionRule.expectedValue}</Typography.Text> (pass at ≥{' '}
              {formatPercent(batch.attentionRule.minCorrectRatio)} correct)
            </>
          ) : (
            'None'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Review reference" span={2}>
          {batch.reference?.source === 'column' ? (
            <>
              input column <Typography.Text code>{batch.reference.column}</Typography.Text>
            </>
          ) : (
            'majority of the other workers on the same HIT (rejected answers excluded)'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="Qualifications" span={2}>
          {s.QualificationRequirements.length === 0
            ? 'None recorded'
            : s.QualificationRequirements.map((q, i) => (
                <Tag key={i}>
                  {SYSTEM_QUALIFICATIONS[q.QualificationTypeId] ?? q.QualificationTypeId} {q.Comparator}{' '}
                  {q.IntegerValues?.join(', ') ?? q.LocaleValues?.map((l) => l.Country).join(', ') ?? ''}
                </Tag>
              ))}
        </Descriptions.Item>
        <Descriptions.Item label="Worker pools" span={2}>
          {batch.requiredPoolIds.length + batch.excludedPoolIds.length === 0 && 'No pool restrictions'}
          {batch.requiredPoolIds.map((id) => <Tag key={id} color="blue">only {id}</Tag>)}
          {batch.excludedPoolIds.map((id) => <Tag key={id} color="red">exclude {id}</Tag>)}
        </Descriptions.Item>
        <Descriptions.Item label="Template">{batch.templateId}</Descriptions.Item>
        <Descriptions.Item label="Input columns">{batch.inputColumns.length}</Descriptions.Item>
      </Descriptions>
    </Space>
  );
}
