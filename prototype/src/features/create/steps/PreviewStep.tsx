// 5.2 (4) Preview & Cost: 선택한 행으로 템플릿을 렌더해 worker 화면 그대로 보여주고(5.5), 비용을 견적한다(8.1).

import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Flex, InputNumber, Row, Space, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useCallback, type ReactNode } from 'react';
import type { Account, AnswerField, Template } from '../../../api/types';
import MoneyText from '../../../components/MoneyText';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import TaskPreviewFrame from '../../../components/TaskPreviewFrame';
import { formatCents, rewardToCents, type CostEstimate } from '../../../domain/cost';
import type { CsvData } from '../csv';
import { balanceCentsOf, type SettingsValues } from '../settings';
import type { DraftUpdate } from '../useCreateDraft';
import StepFooter from './StepFooter';

const VISIBLE_FIELDS = 10;

interface Props {
  template: Template;
  data: CsvData;
  settings: SettingsValues;
  previewRow: number;
  answerSchema: AnswerField[];
  estimate: CostEstimate | null;
  account: Account | undefined;
  accountError: unknown;
  update: (change: DraftUpdate) => void;
  onBack: () => void;
  onNext: () => void;
}

interface CostLine {
  key: string;
  item: ReactNode;
  detail: ReactNode;
  amount: ReactNode;
}

const costColumns: TableColumnsType<CostLine> = [
  { title: 'Item', dataIndex: 'item', width: 200 },
  { title: 'Calculation', dataIndex: 'detail' },
  { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right' },
];

export default function PreviewStep({
  template,
  data,
  settings,
  previewRow,
  answerSchema,
  estimate,
  account,
  accountError,
  update,
  onBack,
  onNext,
}: Props) {
  const rowCount = data.rows.length;
  const index = Math.min(Math.max(0, previewRow), rowCount - 1);
  const row = data.rows[index];
  const goTo = (next: number) => update({ previewRow: Math.min(Math.max(0, next), rowCount - 1) });

  // 템플릿이 JS로 문항을 그리는 동안에는 빈 목록이 먼저 온다. 이미 읽은 목록을 빈 값으로 덮지 않는다.
  const onSchema = useCallback(
    (fields: AnswerField[]) =>
      update((current) => (fields.length > 0 || current.answerSchema.length === 0 ? { answerSchema: fields } : {})),
    [update],
  );

  const balanceCents = balanceCentsOf(account);
  const overBalance = estimate !== null && balanceCents !== null && estimate.totalCents > balanceCents;
  const assignments = rowCount * settings.MaxAssignments;

  const costLines: CostLine[] = estimate
    ? [
        {
          key: 'reward',
          item: 'Reward subtotal',
          detail: `${rowCount.toLocaleString()} HITs × ${settings.MaxAssignments} assignments × ${formatCents(rewardToCents(settings.Reward))}`,
          amount: <MoneyText cents={estimate.rewardCents} />,
        },
        {
          key: 'fee',
          item: `MTurk fee (${estimate.feePercent}%)`,
          detail: `${assignments.toLocaleString()} assignments × ${estimate.feePercent}% of the reward (at least $0.01 each)`,
          amount: <MoneyText cents={estimate.feeCents} />,
        },
        {
          key: 'total',
          item: <Typography.Text strong>Total</Typography.Text>,
          detail: 'Held from the balance when the batch is published',
          amount: (
            <Typography.Text strong>
              <MoneyText cents={estimate.totalCents} />
            </Typography.Text>
          ),
        },
      ]
    : [];

  const attentionFields = settings.attentionEnabled
    ? answerSchema.filter((field) => field.name.startsWith(settings.attentionPrefix))
    : [];
  const expectedMissing = attentionFields.filter((field) => !field.values.includes(settings.attentionExpected));
  const choices = [...new Set(answerSchema.flatMap((field) => field.values))];

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      <Row gutter={16} align="stretch">
        <Col span={14}>
          <Card title="Cost estimate" size="small" style={{ height: '100%' }}>
            <QueryErrorAlert error={accountError} />
            {estimate ? (
              <Table
                rowKey="key"
                columns={costColumns}
                dataSource={costLines}
                pagination={false}
                size="small"
                summary={() => (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>Available balance</Table.Summary.Cell>
                    <Table.Summary.Cell index={1}>
                      <Typography.Text type="secondary">
                        {balanceCents === null || overBalance
                          ? ''
                          : `${formatCents(balanceCents - estimate.totalCents)} left after publishing`}
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      {balanceCents === null ? '…' : <MoneyText cents={balanceCents} />}
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
              />
            ) : (
              <Alert type="error" showIcon message="The cost cannot be estimated. Go back to Settings and check Reward and MaxAssignments." />
            )}
            <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>
              Top-ups after rejections are not included.
            </Typography.Paragraph>
            {overBalance && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message={`The total ${formatCents(estimate.totalCents)} exceeds the available balance ${formatCents(balanceCents)}.`}
                description="Lower the reward or MaxAssignments, or use fewer rows."
              />
            )}
          </Card>
        </Col>
        <Col span={10}>
          <Card title="Answer fields found in this row" size="small" style={{ height: '100%' }}>
            {answerSchema.length === 0 ? (
              <Typography.Text type="secondary">
                None yet. Fields are read from the radio buttons, checkboxes and selects in the preview below. A
                template that draws a question only after a click reports it once you open that question. This list
                is optional.
              </Typography.Text>
            ) : (
              <>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  {answerSchema.length} field(s)
                  {settings.attentionEnabled && `, ${attentionFields.length} of them attention checks`}. Used to generate
                  fake submissions in the mock environment.
                </Typography.Paragraph>
                <Space size={[0, 4]} wrap>
                  {answerSchema.slice(0, VISIBLE_FIELDS).map((field) => (
                    <Tag
                      key={field.name}
                      color={attentionFields.includes(field) ? 'gold' : undefined}
                      style={{ fontFamily: 'monospace' }}
                    >
                      {field.name}
                    </Tag>
                  ))}
                  {answerSchema.length > VISIBLE_FIELDS && (
                    <Typography.Text type="secondary">+{answerSchema.length - VISIBLE_FIELDS} more</Typography.Text>
                  )}
                </Space>
                {choices.length > 0 && (
                  <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
                    Choices: {choices.slice(0, VISIBLE_FIELDS).join(', ')}
                    {choices.length > VISIBLE_FIELDS && ', …'}
                  </Typography.Paragraph>
                )}
                {settings.attentionEnabled && attentionFields.length === 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 12 }}
                    message={`No field name starts with "${settings.attentionPrefix}". Check the attention rule in Settings.`}
                  />
                )}
                {expectedMissing.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 12 }}
                    message={`"${settings.attentionExpected}" is not one of the choices of ${expectedMissing[0]!.name} (${expectedMissing[0]!.values.join(', ')}).`}
                  />
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>

      <Card
        title="Task preview"
        size="small"
        extra={
          <Space>
            <Button size="small" icon={<LeftOutlined />} onClick={() => goTo(index - 1)} disabled={index === 0}>
              Prev row
            </Button>
            <Typography.Text>Row</Typography.Text>
            <InputNumber
              size="small"
              min={1}
              max={rowCount}
              precision={0}
              value={index + 1}
              onChange={(value) => typeof value === 'number' && goTo(value - 1)}
              style={{ width: 80 }}
              aria-label="Row number"
            />
            <Typography.Text>of {rowCount.toLocaleString()}</Typography.Text>
            <Button size="small" onClick={() => goTo(index + 1)} disabled={index >= rowCount - 1} iconPosition="end" icon={<RightOutlined />}>
              Next row
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={8}>
          <Typography.Text type="secondary">
            This is the page a worker sees for row {index + 1}. It runs in a sandboxed iframe; Submit is intercepted and
            nothing is sent.
          </Typography.Text>
          {row && <TaskPreviewFrame html={template.html} row={row} onSchema={onSchema} height={640} />}
        </Flex>
      </Card>

      <StepFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={overBalance || estimate === null}
        hint={overBalance ? 'The total exceeds the available balance.' : undefined}
      />
    </Space>
  );
}
