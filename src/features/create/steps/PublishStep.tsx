// 5.2 (5) Publish: 요약을 확인하고 게시한다. 게시 후에는 해당 batch의 Overview로 간다.

import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Card, Descriptions, Form, Input, Space, Tag, Typography, type DescriptionsProps } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api/client';
import type { Account, AnswerField, CreateBatchRequest, Template, WorkerPool } from '../../../api/types';
import EnvBadge from '../../../components/EnvBadge';
import MoneyText from '../../../components/MoneyText';
import type { CostEstimate } from '../../../domain/cost';
import type { CsvData } from '../csv';
import { balanceCentsOf, describeQualifications, toAttentionRule, toHitSettings, type SettingsValues } from '../settings';
import type { DraftUpdate } from '../useCreateDraft';
import StepFooter from './StepFooter';

interface Props {
  template: Template;
  data: CsvData;
  settings: SettingsValues;
  batchName: string;
  answerSchema: AnswerField[];
  estimate: CostEstimate | null;
  account: Account | undefined;
  pools: WorkerPool[] | undefined;
  update: (change: DraftUpdate) => void;
  /** 게시가 끝나 draft를 버릴 때 */
  onPublished: () => void;
  onBack: () => void;
}

function plural(count: number, unit: string): string {
  return `${count.toLocaleString()} ${unit}${count === 1 ? '' : 's'}`;
}

export default function PublishStep({
  template,
  data,
  settings,
  batchName,
  answerSchema,
  estimate,
  account,
  pools,
  update,
  onPublished,
  onBack,
}: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message, notification } = App.useApp();
  const [publishing, setPublishing] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [touched, setTouched] = useState(false);

  // 이름을 아직 정하지 않았으면 "<템플릿 이름> <날짜>"를 제안한다
  useEffect(() => {
    if (batchName === '') update({ batchName: `${template.name} ${dayjs().format('YYYY-MM-DD')}` });
    // 처음 들어왔을 때만 제안한다. 사용자가 지운 이름을 다시 채우지는 않는다.
  }, []);

  const name = batchName.trim();
  const hitSettings = toHitSettings(settings);
  const attentionRule = toAttentionRule(settings);
  const isProduction = account?.env === 'production';
  const balanceCents = balanceCentsOf(account);
  const overBalance = estimate !== null && balanceCents !== null && estimate.totalCents > balanceCents;
  // 5.2: production에서는 batch 이름을 직접 입력해야 버튼이 활성화된다
  const confirmed = !isProduction || confirmName.trim() === name;
  const canPublish = name !== '' && account !== undefined && estimate !== null && !overBalance && confirmed;

  const poolNames = (ids: string[]) =>
    ids.length === 0 ? null : (
      <Space size={[0, 4]} wrap>
        {ids.map((id) => {
          const pool = pools?.find((p) => p.id === id);
          return <Tag key={id}>{pool ? `${pool.name} (${pool.workerIds.length})` : id}</Tag>;
        })}
      </Space>
    );

  const publish = async () => {
    setTouched(true);
    if (!canPublish) return;
    const request: CreateBatchRequest = {
      name,
      templateId: template.id,
      rows: data.rows,
      inputColumns: data.columns,
      settings: hitSettings,
      attentionRule,
      requiredPoolIds: settings.requiredPoolIds,
      excludedPoolIds: settings.excludedPoolIds,
      ...(answerSchema.length > 0 ? { answerSchema } : {}),
    };
    setPublishing(true);
    try {
      const batch = await api.createBatch(request);
      onPublished();
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      message.success(`Published "${batch.name}" with ${plural(data.rows.length, 'HIT')}.`);
      navigate(`/manage/${batch.id}/overview`);
    } catch (error) {
      notification.error({
        message: 'Could not publish the batch',
        description: error instanceof Error ? error.message : String(error),
        duration: 0,
      });
      setPublishing(false);
    }
  };

  const qualifications = describeQualifications(settings);

  const items: DescriptionsProps['items'] = [
    { key: 'env', label: 'Environment', children: account ? <EnvBadge env={account.env} /> : '…' },
    { key: 'template', label: 'Template', children: template.name },
    {
      key: 'data',
      label: 'Data',
      span: 2,
      children: `${data.fileName}: ${plural(data.rows.length, 'row')} → ${plural(data.rows.length, 'HIT')}, ${plural(data.columns.length, 'column')}`,
    },
    { key: 'title', label: 'Title', span: 2, children: hitSettings.Title },
    { key: 'reward', label: 'Reward', children: `$${hitSettings.Reward} per assignment` },
    { key: 'max', label: 'MaxAssignments', children: `${hitSettings.MaxAssignments} per HIT` },
    { key: 'duration', label: 'Time allotted', children: plural(settings.durationMinutes, 'minute') },
    { key: 'lifetime', label: 'HIT lifetime', children: plural(settings.lifetimeDays, 'day') },
    { key: 'auto', label: 'Auto-approval delay', children: plural(settings.autoApprovalDays, 'day') },
    {
      key: 'qualifications',
      label: 'Qualifications',
      children: qualifications.length > 0 ? qualifications.join('; ') : <Typography.Text type="secondary">None</Typography.Text>,
    },
    {
      key: 'required',
      label: 'Only workers in',
      children: poolNames(settings.requiredPoolIds) ?? <Typography.Text type="secondary">Any worker</Typography.Text>,
    },
    {
      key: 'excluded',
      label: 'Exclude workers in',
      children: poolNames(settings.excludedPoolIds) ?? <Typography.Text type="secondary">Nobody</Typography.Text>,
    },
    {
      key: 'attention',
      label: 'Attention rule',
      span: 2,
      children: attentionRule ? (
        <>
          Answers named <Typography.Text code>{attentionRule.namePrefix}*</Typography.Text> must be{' '}
          <Typography.Text code>{attentionRule.expectedValue}</Typography.Text>; pass at{' '}
          {Math.round(attentionRule.minCorrectRatio * 100)}% correct or more
        </>
      ) : (
        <Typography.Text type="secondary">None</Typography.Text>
      ),
    },
    {
      key: 'cost',
      label: 'Total cost',
      span: 2,
      children: estimate ? (
        <>
          <Typography.Text strong>
            <MoneyText cents={estimate.totalCents} />
          </Typography.Text>{' '}
          (reward <MoneyText cents={estimate.rewardCents} /> + {estimate.feePercent}% fee{' '}
          <MoneyText cents={estimate.feeCents} />
          ){account && <>, balance ${account.AvailableBalance}</>}
        </>
      ) : (
        '–'
      ),
    },
  ];

  return (
    <Card title="Publish">
      <Form layout="vertical" component="div">
        <Form.Item
          label="Batch name"
          required
          style={{ maxWidth: 640 }}
          validateStatus={touched && name === '' ? 'error' : undefined}
          help={touched && name === '' ? 'Enter a batch name.' : 'Shown in the Manage list. It is not visible to workers.'}
        >
          <Input
            value={batchName}
            onChange={(event) => update({ batchName: event.target.value })}
            maxLength={120}
            placeholder="e.g. close-ended chunk-fact pilot"
            aria-label="Batch name"
          />
        </Form.Item>
      </Form>

      {/* margin은 위 Form.Item의 margin과 겹쳐 사라지므로 padding으로 띄운다 */}
      <div style={{ paddingTop: 12 }}>
        <Descriptions bordered size="small" column={2} items={items} styles={{ label: { width: 180 } }} />
      </div>

      {overBalance && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 16 }}
          message="The total cost exceeds the available balance. Go back and lower the reward, MaxAssignments or the number of rows."
        />
      )}

      {isProduction && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="This batch will be published to PRODUCTION and will spend real money."
          description={
            <Form layout="vertical" component="div">
              <Form.Item label="Type the batch name to confirm" style={{ marginBottom: 0, maxWidth: 480 }}>
                <Input
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder={name}
                  aria-label="Confirm batch name"
                  autoComplete="off"
                />
              </Form.Item>
            </Form>
          }
        />
      )}

      <StepFooter
        onBack={onBack}
        onNext={() => void publish()}
        nextLabel={`Publish ${plural(data.rows.length, 'HIT')}`}
        nextLoading={publishing}
        nextDisabled={touched ? !canPublish : !confirmed || overBalance}
        hint={isProduction && !confirmed ? 'Type the batch name to enable Publish.' : undefined}
      />
    </Card>
  );
}
