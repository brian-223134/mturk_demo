// 5.2 (3) Settings: HIT 설정, Qualification 세 가지, worker pool 포함/제외, attention rule, Review의 대조 기준

import {
  Alert,
  Card,
  Checkbox,
  Col,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Switch,
  Typography,
} from 'antd';
import type { WorkerPool } from '../../../api/types';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import { HIGH_FEE_MIN_ASSIGNMENTS, FEE_PERCENT_10_OR_MORE } from '../../../domain/cost';
import type { CsvData } from '../csv';
import {
  COUNTRY_CODE,
  MAX_AUTO_APPROVAL_DAYS,
  MIN_REWARD,
  describeReferenceCell,
  normalizeCountries,
  type SettingsValues,
} from '../settings';
import type { DraftUpdate } from '../useCreateDraft';
import StepFooter from './StepFooter';

// 케이스 스터디의 worker가 주로 있던 곳과 MTurk에서 흔히 쓰는 영어권 국가. 다른 코드는 직접 입력한다.
const COMMON_COUNTRIES = [
  { value: 'US', label: 'US – United States' },
  { value: 'CA', label: 'CA – Canada' },
  { value: 'GB', label: 'GB – United Kingdom' },
  { value: 'AU', label: 'AU – Australia' },
  { value: 'NZ', label: 'NZ – New Zealand' },
  { value: 'IE', label: 'IE – Ireland' },
  { value: 'IN', label: 'IN – India' },
  { value: 'KR', label: 'KR – South Korea' },
];

const NUMBER_WIDTH = { width: '100%' };
// Qualification 한 줄: 체크박스 라벨 폭을 맞춰 입력란이 세로로 정렬되게 한다
const QUALIFICATION_LABEL = { width: 300, marginBottom: 12 };
const QUALIFICATION_VALUE = { marginBottom: 12 };

// Review reference의 첫 선택지. 폼에서는 ''로 다루고 draft에는 null로 둔다 (Select는 null을 값으로 보여 주지 못한다)
const MAJORITY_OPTION = { value: '', label: 'Majority of the other workers on the same HIT' };

interface Props {
  settings: SettingsValues;
  update: (change: DraftUpdate) => void;
  /** 올린 CSV. Review reference의 컬럼 선택지와 첫 행 안내에 쓴다 */
  data: CsvData | null;
  pools: WorkerPool[] | undefined;
  poolsLoading: boolean;
  poolsError: unknown;
  onBack: () => void;
  onNext: () => void;
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Divider orientation="left" orientationMargin={0} style={{ marginTop: 8 }}>
      {children}
    </Divider>
  );
}

export default function SettingsStep({ settings, update, data, pools, poolsLoading, poolsError, onBack, onNext }: Props) {
  const [form] = Form.useForm<SettingsValues>();
  const maxAssignments = Form.useWatch('MaxAssignments', form) ?? settings.MaxAssignments;
  const approvalRateEnabled = Form.useWatch('approvalRateEnabled', form) ?? settings.approvalRateEnabled;
  const approvedHitsEnabled = Form.useWatch('approvedHitsEnabled', form) ?? settings.approvedHitsEnabled;
  const countriesEnabled = Form.useWatch('countriesEnabled', form) ?? settings.countriesEnabled;
  const attentionEnabled = Form.useWatch('attentionEnabled', form) ?? settings.attentionEnabled;
  const requiredPoolIds = Form.useWatch('requiredPoolIds', form) ?? settings.requiredPoolIds;
  const excludedPoolIds = Form.useWatch('excludedPoolIds', form) ?? settings.excludedPoolIds;
  const referenceColumn = Form.useWatch('referenceColumn', form) ?? settings.referenceColumn;

  const columns = data?.columns ?? [];
  const referenceOptions = [MAJORITY_OPTION, ...columns.map((column) => ({ value: column, label: `Input column: ${column}` }))];
  // 고른 컬럼의 첫 행이 어떤 형식으로 읽히는지. CSV를 바꿔 컬럼이 사라졌으면 검증이 막는다
  const referenceNote =
    referenceColumn && data && columns.includes(referenceColumn) ? describeReferenceCell(data.rows[0]?.[referenceColumn] ?? '') : null;

  // 같은 pool을 포함과 제외에 동시에 넣을 수 없다. 반대쪽에서 고른 pool은 선택지에서 막는다.
  const poolOptions = (takenByOther: string[]) =>
    (pools ?? []).map((pool) => ({
      value: pool.id,
      label: `${pool.name} (${pool.workerIds.length} worker${pool.workerIds.length === 1 ? '' : 's'})`,
      disabled: takenByOther.includes(pool.id),
    }));

  const next = async () => {
    try {
      await form.validateFields();
    } catch (error) {
      const first = (error as { errorFields?: { name: (string | number)[] }[] }).errorFields?.[0];
      if (first) form.scrollToField(first.name, { block: 'center' });
      return;
    }
    onNext();
  };

  return (
    <Card title="Settings">
      <Form
        form={form}
        layout="vertical"
        initialValues={settings}
        // 조건부로 숨긴 항목은 폼 값에서 빠지므로, 바뀐 값만 draft에 합친다
        onValuesChange={(changed: Partial<SettingsValues>) =>
          update((current) => ({ settings: { ...current.settings, ...changed } }))
        }
      >
        <SectionTitle>What workers see in the HIT list</SectionTitle>
        <Form.Item name="Title" label="Title" rules={[{ required: true, whitespace: true, message: 'Enter a title.' }]}>
          <Input maxLength={128} showCount />
        </Form.Item>
        <Form.Item
          name="Description"
          label="Description"
          rules={[{ required: true, whitespace: true, message: 'Enter a description.' }]}
        >
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Form.Item name="Keywords" label="Keywords" extra="Comma separated.">
          <Input maxLength={1000} />
        </Form.Item>

        <SectionTitle>Payment and timing</SectionTitle>
        <Row gutter={16}>
          <Col span={5}>
            <Form.Item
              name="Reward"
              label="Reward per assignment"
              rules={[
                { required: true, message: 'Enter a reward.' },
                {
                  validator: (_, value: string | null) =>
                    value === null || value === undefined || value === '' || Number.parseFloat(value) >= Number.parseFloat(MIN_REWARD)
                      ? Promise.resolve()
                      : Promise.reject(new Error(`The minimum reward is $${MIN_REWARD}.`)),
                },
              ]}
            >
              <InputNumber<string> stringMode min={MIN_REWARD} step="0.01" precision={2} prefix="$" style={NUMBER_WIDTH} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item
              name="MaxAssignments"
              label="MaxAssignments"
              tooltip="Number of workers (labels) per HIT."
              rules={[{ required: true, type: 'integer', min: 1, message: 'Enter a whole number, 1 or more.' }]}
            >
              <InputNumber min={1} max={1000} precision={0} style={NUMBER_WIDTH} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item
              name="durationMinutes"
              label="Time allotted"
              tooltip="AssignmentDurationInSeconds: how long a worker has to finish one assignment."
              rules={[{ required: true, type: 'number', min: 1, message: 'Enter at least 1 minute.' }]}
            >
              <InputNumber min={1} max={525600} precision={0} suffix="minutes" style={NUMBER_WIDTH} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item
              name="lifetimeDays"
              label="HIT lifetime"
              tooltip="LifetimeInSeconds: how long the HITs stay available to workers."
              rules={[{ required: true, type: 'number', min: 1, message: 'Enter at least 1 day.' }]}
            >
              <InputNumber min={1} max={365} precision={0} suffix="days" style={NUMBER_WIDTH} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item
              name="autoApprovalDays"
              label="Auto-approval delay"
              tooltip={`AutoApprovalDelayInSeconds: submissions that are not reviewed within this time are approved automatically. MTurk allows at most ${MAX_AUTO_APPROVAL_DAYS} days.`}
              rules={[
                {
                  required: true,
                  type: 'number',
                  min: 1,
                  max: MAX_AUTO_APPROVAL_DAYS,
                  message: `Enter 1 to ${MAX_AUTO_APPROVAL_DAYS} days.`,
                },
              ]}
            >
              <InputNumber min={1} max={MAX_AUTO_APPROVAL_DAYS} precision={0} suffix="days" style={NUMBER_WIDTH} />
            </Form.Item>
          </Col>
        </Row>
        {maxAssignments >= HIGH_FEE_MIN_ASSIGNMENTS && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`With MaxAssignments of ${HIGH_FEE_MIN_ASSIGNMENTS} or more, the MTurk fee becomes ${FEE_PERCENT_10_OR_MORE}% of the reward.`}
          />
        )}

        <SectionTitle>Qualification requirements</SectionTitle>
        <Flex vertical style={{ marginBottom: 12 }}>
          <Flex align="flex-start" gap={12}>
            <Form.Item name="approvalRateEnabled" valuePropName="checked" style={QUALIFICATION_LABEL}>
              <Checkbox>HIT approval rate (%) is at least</Checkbox>
            </Form.Item>
            <Form.Item
              name="approvalRate"
              style={QUALIFICATION_VALUE}
              rules={approvalRateEnabled ? [{ required: true, type: 'integer', min: 0, max: 100, message: 'Enter 0 to 100.' }] : []}
            >
              <InputNumber min={0} max={100} precision={0} suffix="%" disabled={!approvalRateEnabled} style={{ width: 140 }} />
            </Form.Item>
          </Flex>
          <Flex align="flex-start" gap={12}>
            <Form.Item name="approvedHitsEnabled" valuePropName="checked" style={QUALIFICATION_LABEL}>
              <Checkbox>Number of approved HITs is at least</Checkbox>
            </Form.Item>
            <Form.Item
              name="approvedHits"
              style={QUALIFICATION_VALUE}
              rules={approvedHitsEnabled ? [{ required: true, type: 'integer', min: 0, message: 'Enter 0 or more.' }] : []}
            >
              <InputNumber min={0} max={10_000_000} precision={0} disabled={!approvedHitsEnabled} style={{ width: 140 }} />
            </Form.Item>
          </Flex>
          <Flex align="flex-start" gap={12}>
            <Form.Item name="countriesEnabled" valuePropName="checked" style={QUALIFICATION_LABEL}>
              <Checkbox>Worker location is one of</Checkbox>
            </Form.Item>
            <Form.Item
              name="countries"
              normalize={normalizeCountries}
              style={{ ...QUALIFICATION_VALUE, flex: 1, maxWidth: 560 }}
              rules={
                countriesEnabled
                  ? [
                      { required: true, type: 'array', min: 1, message: 'Choose at least one country.' },
                      {
                        validator: (_, codes: string[] | undefined) => {
                          const bad = (codes ?? []).filter((code) => !COUNTRY_CODE.test(code));
                          return bad.length === 0
                            ? Promise.resolve()
                            : Promise.reject(new Error(`Use two-letter country codes (ISO 3166). Not valid: ${bad.join(', ')}`));
                        },
                      },
                    ]
                  : []
              }
            >
              <Select
                mode="tags"
                options={COMMON_COUNTRIES}
                optionLabelProp="value"
                tokenSeparators={[',', ' ']}
                placeholder="US, CA, GB … (type any two-letter code)"
                disabled={!countriesEnabled}
              />
            </Form.Item>
          </Flex>
        </Flex>

        <SectionTitle>Worker pools</SectionTitle>
        <QueryErrorAlert error={poolsError} />
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              name="requiredPoolIds"
              label="Only workers in"
              extra="Leave empty to allow everyone who meets the qualification requirements."
            >
              <Select
                mode="multiple"
                allowClear
                loading={poolsLoading}
                options={poolOptions(excludedPoolIds)}
                optionFilterProp="label"
                placeholder="Any worker"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="excludedPoolIds"
              label="Exclude workers in"
              dependencies={['requiredPoolIds']}
              rules={[
                {
                  validator: (_, ids: string[] | undefined) => {
                    const both = (ids ?? []).filter((id) => requiredPoolIds.includes(id));
                    if (both.length === 0) return Promise.resolve();
                    const names = both.map((id) => pools?.find((p) => p.id === id)?.name ?? id);
                    return Promise.reject(new Error(`A pool cannot be both required and excluded: ${names.join(', ')}`));
                  },
                },
              ]}
            >
              <Select
                mode="multiple"
                allowClear
                loading={poolsLoading}
                options={poolOptions(requiredPoolIds)}
                optionFilterProp="label"
                placeholder="Nobody excluded"
              />
            </Form.Item>
          </Col>
        </Row>

        <SectionTitle>Attention check</SectionTitle>
        <Flex align="center" gap={12} style={{ marginBottom: 16 }}>
          <Form.Item name="attentionEnabled" valuePropName="checked" noStyle>
            <Switch />
          </Form.Item>
          <Typography.Text>This template has attention checks</Typography.Text>
        </Flex>
        {attentionEnabled ? (
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="attentionPrefix"
                label="Answer name prefix"
                tooltip="Answers whose name starts with this prefix are attention checks. All other answers are real questions."
                rules={[{ required: true, whitespace: true, message: 'Enter the prefix.' }]}
              >
                <Input placeholder="attention_" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="attentionExpected"
                label="Expected value"
                tooltip="The answer value that counts as correct. It differs by template: not_grounded, Not Covered, not_covered …"
                rules={[{ required: true, whitespace: true, message: 'Enter the expected value, e.g. not_grounded.' }]}
              >
                <Input placeholder="e.g. not_grounded" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="attentionMinRatio"
                label="Minimum correct ratio"
                tooltip="An assignment passes when correct attention answers / all attention answers is at least this value. 1 means all of them."
                rules={[{ required: true, type: 'number', min: 0, max: 1, message: 'Enter a value from 0 to 1.' }]}
              >
                <InputNumber min={0} max={1} step={0.05} style={NUMBER_WIDTH} />
              </Form.Item>
            </Col>
          </Row>
        ) : (
          <Typography.Paragraph type="secondary">
            Without a rule, Review shows no attention result and nothing can be selected by “attention failed”.
          </Typography.Paragraph>
        )}

        <SectionTitle>Review reference</SectionTitle>
        <Form.Item
          name="referenceColumn"
          label="Compare answers with"
          extra="Review shows this next to each worker's answers. Choose a CSV column that holds ground truth or LLM labels; keep the default when the CSV has no such column."
          style={{ maxWidth: 560 }}
          getValueProps={(value: string | null) => ({ value: value ?? '' })}
          normalize={(value: string | null) => (value ? value : null)}
          rules={[
            {
              validator: (_, column: string | null) =>
                !column || columns.includes(column)
                  ? Promise.resolve()
                  : Promise.reject(new Error(`Column "${column}" is not in the uploaded CSV. Choose another column or the majority.`)),
            },
          ]}
        >
          <Select options={referenceOptions} optionFilterProp="label" showSearch />
        </Form.Item>
        {referenceNote && <Alert type={referenceNote.type} showIcon style={{ marginBottom: 16 }} message={referenceNote.message} />}
      </Form>

      <StepFooter onBack={onBack} onNext={() => void next()} />
    </Card>
  );
}
