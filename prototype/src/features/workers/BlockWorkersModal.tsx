// 5.4 차단 안내. 차단은 worker 계정에 불이익을 줄 수 있어서(11장 "차단의 부작용") 기본 동선은
// "Excluded pool에 추가"이고, 차단은 사유를 적어야만 할 수 있는 두 번째 선택지다.
// 부모가 열 때마다 새로 마운트하므로(조건부 렌더) 입력 상태를 따로 초기화하지 않는다.

import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { api } from '../../api/client';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import { EXCLUDED_POOL_ID, countWorkers } from './shared';
import { useWorkerActions } from './useWorkerActions';

const SHOWN_IDS = 8;

interface Props {
  workerIds: string[];
  onCancel: () => void;
  /** pool에 넣었거나 차단한 뒤. 부모는 모달을 닫고 선택을 푼다. */
  onDone: () => void;
}

export default function BlockWorkersModal({ workerIds, onCancel, onDone }: Props) {
  const actions = useWorkerActions();
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api.listPools() });
  const [pickedPoolId, setPickedPoolId] = useState<string>();
  const [blockAnyway, setBlockAnyway] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [running, setRunning] = useState<'exclude' | 'block'>(); // 어느 버튼에 진행 표시를 할지

  const excluded = pools.data?.find((p) => p.id === EXCLUDED_POOL_ID);
  // Excluded pool이 없으면(다른 데이터를 import한 경우) 어느 pool을 제외용으로 쓸지 고르게 한다
  const targetPool = excluded ?? pools.data?.find((p) => p.id === pickedPoolId);
  // 이미 전원이 제외 pool에 있으면 기본 동선이 할 일이 없다. 차단할 이유도 거의 없다는 것을 알려준다.
  const allExcluded = !!targetPool && workerIds.every((id) => targetPool.workerIds.includes(id));
  const who = workerIds.length === 1 ? 'this worker' : 'these workers';

  const exclude = async () => {
    if (!targetPool) return;
    setRunning('exclude');
    if (await actions.addToPool(targetPool, workerIds)) onDone();
  };

  const block = async () => {
    if (!blockAnyway) {
      setBlockAnyway(true);
      return;
    }
    if (!reason.trim()) {
      setReasonMissing(true);
      return;
    }
    setRunning('block');
    if (await actions.block(workerIds, reason.trim())) onDone();
  };

  return (
    <Modal
      open
      width={600}
      title={`Block ${countWorkers(workerIds.length)}?`}
      onCancel={onCancel}
      maskClosable={!actions.busy}
      footer={
        <Space>
          <Button onClick={onCancel} disabled={actions.busy}>
            Cancel
          </Button>
          <Button
            danger
            onClick={() => void block()}
            disabled={actions.busy && running !== 'block'}
            loading={actions.busy && running === 'block'}
          >
            {blockAnyway ? `Block ${countWorkers(workerIds.length)}` : 'Block anyway…'}
          </Button>
          <Button
            type="primary"
            autoFocus
            onClick={() => void exclude()}
            disabled={!targetPool || allExcluded || (actions.busy && running !== 'exclude')}
            loading={actions.busy && running === 'exclude'}
          >
            {allExcluded
              ? `Already in "${targetPool.name}"`
              : excluded || !targetPool
                ? 'Add to Excluded pool instead'
                : `Add to "${targetPool.name}" instead`}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
        <Alert
          type="warning"
          showIcon
          message="Blocking can harm the worker's MTurk account"
          description={
            <>
              Blocks count against the worker on MTurk, and accumulated blocks can penalize the account. For research
              the convention is an exclusion pool instead: excluded workers simply do not see your HITs, and nothing is
              held against them.
            </>
          }
        />

        <Space size={[4, 4]} wrap>
          {workerIds.slice(0, SHOWN_IDS).map((id) => (
            <Typography.Text key={id} code>
              {id}
            </Typography.Text>
          ))}
          {workerIds.length > SHOWN_IDS && (
            <Typography.Text type="secondary">and {workerIds.length - SHOWN_IDS} more</Typography.Text>
          )}
        </Space>

        <QueryErrorAlert error={pools.error} />
        {excluded && allExcluded ? (
          <Typography.Text>
            {workerIds.length === 1 ? 'This worker is' : 'These workers are'} already in the <b>{excluded.name}</b>{' '}
            pool, so batches that exclude this pool (Create › Settings) stay hidden from them. Blocking adds little on
            top of that.
          </Typography.Text>
        ) : excluded ? (
          <Typography.Text>
            <b>Recommended:</b> add {who} to the <b>{excluded.name}</b> pool. Batches that exclude this pool (Create ›
            Settings) stay hidden from them.
          </Typography.Text>
        ) : (
          pools.data && (
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <b>Recommended:</b> add {who} to an exclusion pool.
                There is no "Excluded" pool in this data, so choose which pool to use.
              </Typography.Paragraph>
              <Select
                style={{ width: 280 }}
                placeholder={pools.data.length > 0 ? 'Choose a pool' : 'No pools yet. Create one under Pools.'}
                disabled={pools.data.length === 0}
                value={pickedPoolId}
                onChange={setPickedPoolId}
                options={pools.data.map((p) => ({ value: p.id, label: `${p.name} (${p.workerIds.length})` }))}
              />
            </div>
          )
        )}

        {blockAnyway && (
          <Form layout="vertical">
            <Form.Item
              label="Reason for blocking"
              required
              style={{ marginBottom: 0 }}
              validateStatus={reasonMissing ? 'error' : undefined}
              help={reasonMissing ? 'A reason is required to block. MTurk records it.' : 'MTurk records the reason with the block.'}
            >
              <Input.TextArea
                autoFocus
                rows={2}
                maxLength={1024}
                value={reason}
                placeholder="e.g. Repeatedly submitted answers that fail the attention check."
                onChange={(event) => {
                  setReason(event.target.value);
                  setReasonMissing(false);
                }}
              />
            </Form.Item>
          </Form>
        )}
      </Space>
    </Modal>
  );
}
