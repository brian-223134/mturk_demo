// 5.3 검수 동작: 승인(피드백 선택), 반려(피드백 필수, 프리셋 세 개), 반려 번복(OverrideRejection)

import { App, Alert, Input, Modal, Radio, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AssignmentListItem } from '../../api/types';
import { REJECT_PRESETS } from './shared';

export interface ReviewAction {
  kind: 'approve' | 'reject' | 'revert';
  assignments: AssignmentListItem[];
}

const CUSTOM = '__custom__';

const COPY = {
  approve: { title: 'Approve', ok: 'Approve', danger: false },
  reject: { title: 'Reject', ok: 'Reject', danger: true },
  revert: { title: 'Revert to approved', ok: 'Revert to approved', danger: false },
};

interface Props {
  action: ReviewAction | null;
  onCancel: () => void;
  onDone: (action: ReviewAction) => void;
}

export default function ReviewActionModal({ action, onCancel, onDone }: Props) {
  const { notification } = App.useApp();
  const [preset, setPreset] = useState<string>(REJECT_PRESETS[0]!);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 열릴 때마다 처음 상태로. attention 실패 건만 고른 경우가 가장 흔하므로 첫 프리셋이 기본이다.
    setPreset(REJECT_PRESETS[0]!);
    setText('');
  }, [action]);

  if (!action) return null;
  const { kind, assignments } = action;
  const copy = COPY[kind];
  const feedback = kind === 'reject' ? (preset === CUSTOM ? text.trim() : preset) : text.trim();
  const workers = new Set(assignments.map((a) => a.WorkerId)).size;
  const passedAttention = assignments.filter((a) => a.attention?.passed).length;

  const submit = async () => {
    setBusy(true);
    try {
      const ids = assignments.map((a) => a.AssignmentId);
      if (kind === 'reject') await api.rejectAssignments(ids, feedback);
      else await api.approveAssignments(ids, feedback || undefined, kind === 'revert');
      onDone(action);
    } catch (error) {
      notification.error({ message: `${copy.title} failed`, description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`${copy.title} ${assignments.length} assignment(s) from ${workers} worker(s)`}
      okText={copy.ok}
      okButtonProps={{ danger: copy.danger, disabled: kind === 'reject' && feedback === '' }}
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onCancel}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
        {kind === 'reject' && (
          <>
            <Typography.Text>
              Rejected workers are not paid and see this reason. Feedback is required.
            </Typography.Text>
            {passedAttention > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${passedAttention} of the selected assignment(s) passed the attention check.`}
              />
            )}
            <Radio.Group value={preset} onChange={(event) => setPreset(event.target.value as string)}>
              <Space direction="vertical">
                {REJECT_PRESETS.map((reason) => (
                  <Radio key={reason} value={reason}>
                    {reason}
                  </Radio>
                ))}
                <Radio value={CUSTOM}>Other reason</Radio>
              </Space>
            </Radio.Group>
            {preset === CUSTOM && (
              <Input.TextArea autoFocus rows={3} maxLength={1024} showCount value={text} onChange={(e) => setText(e.target.value)} placeholder="Reason shown to the worker" />
            )}
          </>
        )}
        {kind === 'approve' && (
          <>
            <Typography.Text>Approved workers are paid the reward. Feedback is optional.</Typography.Text>
            <Input.TextArea rows={2} maxLength={1024} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional message to the worker" />
          </>
        )}
        {kind === 'revert' && (
          <>
            <Typography.Text>
              The rejection is overridden and the worker is paid (MTurk <Typography.Text code>OverrideRejection</Typography.Text>).
              MTurk allows this only within 30 days of the rejection.
            </Typography.Text>
            <Input.TextArea rows={2} maxLength={1024} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional message to the worker" />
          </>
        )}
      </Space>
    </Modal>
  );
}
