// 5.4 "조건으로 채우기". 조건에 맞는 worker 수를 먼저 보여주고, 확인하면 그 worker들을 pool에 넣는다.
// 넣는 대상은 미리보기에 나온 목록 그대로다. 그래서 조회가 끝나기 전에는 확인 버튼을 막는다.
// 부모가 열 때마다 새로 마운트한다 (조건부 렌더).

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Alert, Col, Form, InputNumber, Modal, Row, Spin, Table, Typography, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Worker, WorkerPool } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import { formatPercent } from '../../components/format';
import { countWorkers, useDebouncedValue } from './shared';
import { useWorkerActions } from './useWorkerActions';

const MAX_FILL = 1000; // listWorkers의 pageSize 상한
const PREVIEW_ROWS = 10;

// 비율은 화면에서 %로 받고 API에는 0–1로 보낸다. null은 그 조건을 쓰지 않는다는 뜻이다.
interface Criteria {
  minApproved: number | null;
  maxAttentionFailPercent: number | null;
  minAgreementPercent: number | null;
  maxRejectPercent: number | null;
}

// 5.4의 예시 조건: 승인 ≥ 20건, attention 실패 0건, 일치율 ≥ 90%
const DEFAULTS: Criteria = {
  minApproved: 20,
  maxAttentionFailPercent: 0,
  minAgreementPercent: 90,
  maxRejectPercent: null,
};

function toFilters(criteria: Criteria, poolId: string): Record<string, unknown> {
  const ratio = (percent: number | null) => (percent === null ? undefined : percent / 100);
  return {
    minApproved: criteria.minApproved ?? undefined,
    maxAttentionFailRate: ratio(criteria.maxAttentionFailPercent),
    minAgreement: ratio(criteria.minAgreementPercent),
    maxRejectRate: ratio(criteria.maxRejectPercent),
    notInPool: poolId,
  };
}

const previewColumns: TableColumnsType<Worker> = [
  {
    title: 'Worker',
    key: 'WorkerId',
    render: (_, w) => (
      <Link to={`/workers/${w.WorkerId}`} target="_blank">
        <Typography.Text code>{w.WorkerId}</Typography.Text>
      </Link>
    ),
  },
  { title: 'Approved', key: 'approved', align: 'right', width: 90, render: (_, w) => w.stats.approved },
  { title: 'Attn fail', key: 'attention', align: 'right', width: 90, render: (_, w) => formatPercent(w.stats.attentionFailRate) },
  { title: 'Agree', key: 'agreement', align: 'right', width: 80, render: (_, w) => formatPercent(w.stats.majorityAgreement) },
  { title: 'Rej%', key: 'rejectRate', align: 'right', width: 70, render: (_, w) => formatPercent(w.stats.rejectRate) },
];

interface Props {
  pool: WorkerPool;
  onCancel: () => void;
  onDone: (pool: WorkerPool) => void;
}

export default function FillByCriteriaModal({ pool, onCancel, onDone }: Props) {
  const actions = useWorkerActions();
  const [criteria, setCriteria] = useState<Criteria>(DEFAULTS);
  const debounced = useDebouncedValue(criteria, 300);
  const [submitting, setSubmitting] = useState(false);

  const preview = useQuery({
    queryKey: ['workers', 'fill-preview', pool.id, debounced],
    queryFn: () =>
      api.listWorkers({
        page: 1,
        pageSize: MAX_FILL,
        sort: { field: 'stats.approved', order: 'desc' },
        filters: toFilters(debounced, pool.id),
      }),
    placeholderData: keepPreviousData,
    // 넣은 직후의 무효화로 다시 조회하면, 닫히기 직전에 미리보기가 "0 workers match"로 바뀌어 보인다
    enabled: !submitting,
  });
  // fixture가 작아서 기본 조건으로는 0명이 나온다. 어디까지 낮춰야 하는지 가늠할 기준을 함께 보여준다.
  const top = useQuery({
    queryKey: ['workers', 'max-approved'],
    queryFn: () => api.listWorkers({ page: 1, pageSize: 1, sort: { field: 'stats.approved', order: 'desc' } }),
  });
  const maxApproved = top.data?.items[0]?.stats.approved;

  // 화면의 조건과 보이는 결과가 같은 것일 때만 확정할 수 있다
  const settled = debounced === criteria && !preview.isFetching && !preview.isPlaceholderData && !!preview.data;
  const matched = preview.data?.items ?? [];
  // 차단한 worker는 pool에 넣지 않는다. 몇 명이 빠졌는지 알려주려고 필터로 거르지 않고 여기서 뺀다.
  const eligible = matched.filter((w) => !w.blocked);
  const blockedCount = matched.length - eligible.length;
  const truncated = (preview.data?.total ?? 0) > matched.length;

  const set = (patch: Partial<Criteria>) => setCriteria((previous) => ({ ...previous, ...patch }));
  const percentInput = (key: keyof Criteria) => (
    <InputNumber
      min={0}
      max={100}
      suffix="%"
      placeholder="No limit"
      style={{ width: '100%' }}
      value={criteria[key]}
      onChange={(value) => set({ [key]: value })}
    />
  );

  const confirm = async () => {
    if (!settled || eligible.length === 0) return;
    setSubmitting(true);
    if (await actions.addToPool(pool, eligible.map((w) => w.WorkerId))) onDone(pool);
    else setSubmitting(false);
  };

  return (
    <Modal
      open
      width={640}
      title={`Fill "${pool.name}" by criteria`}
      okText={settled ? `Add ${countWorkers(eligible.length)}` : 'Add workers'}
      okButtonProps={{ disabled: !settled || eligible.length === 0 }}
      confirmLoading={submitting}
      onOk={() => void confirm()}
      onCancel={onCancel}
      cancelButtonProps={{ disabled: submitting }}
      closable={!submitting}
      keyboard={!submitting}
      maskClosable={!submitting}
    >
      <Typography.Paragraph type="secondary">
        Finds workers by their record across all batches. Workers already in this pool and blocked workers are left
        out. A worker with no data for a criterion (for example, no attention checks yet) does not match it.
      </Typography.Paragraph>

      <Form layout="vertical">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label="Minimum approved assignments">
              <InputNumber
                min={0}
                precision={0}
                placeholder="No limit"
                style={{ width: '100%' }}
                value={criteria.minApproved}
                onChange={(value) => set({ minApproved: value })}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Maximum attention-fail rate">{percentInput('maxAttentionFailPercent')}</Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Minimum majority agreement">{percentInput('minAgreementPercent')}</Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="Maximum reject rate (optional)">{percentInput('maxRejectPercent')}</Form.Item>
          </Col>
        </Row>
      </Form>

      <QueryErrorAlert error={preview.error} />
      <Spin spinning={!settled && !preview.error}>
        <div style={{ minHeight: 96 }}>
          {preview.data && (
            <>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {countWorkers(eligible.length)} match{eligible.length === 1 ? 'es' : ''}
                </Typography.Text>{' '}
                <Typography.Text type="secondary">(not yet in this pool)</Typography.Text>
                {blockedCount > 0 && (
                  <Typography.Text type="secondary">
                    {' · '}
                    {blockedCount} blocked {blockedCount === 1 ? 'worker also matches and is' : 'workers also match and are'}{' '}
                    left out
                  </Typography.Text>
                )}
              </Typography.Paragraph>
              {eligible.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="No workers match all of these criteria"
                  description={
                    <>
                      Loosen a criterion and the count updates.
                      {maxApproved !== undefined && (
                        <>
                          {' '}
                          For reference, the most approved assignments any worker has is <b>{maxApproved}</b>.
                        </>
                      )}
                    </>
                  }
                />
              ) : (
                <>
                  <Table
                    rowKey="WorkerId"
                    size="small"
                    pagination={false}
                    columns={previewColumns}
                    dataSource={eligible.slice(0, PREVIEW_ROWS)}
                  />
                  {eligible.length > PREVIEW_ROWS && (
                    <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                      and {eligible.length - PREVIEW_ROWS} more
                    </Typography.Text>
                  )}
                </>
              )}
              {truncated && (
                <Typography.Text type="warning" style={{ display: 'block', marginTop: 8 }}>
                  More than {MAX_FILL} workers match. Only the first {MAX_FILL} are added; run the fill again for the rest.
                </Typography.Text>
              )}
            </>
          )}
        </div>
      </Spin>
    </Modal>
  );
}
