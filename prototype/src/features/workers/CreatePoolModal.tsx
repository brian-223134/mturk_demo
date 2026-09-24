// 5.4 pool 생성. 이름 중복 같은 검증은 API가 하고, 그 오류를 이름 칸 아래에 그대로 보여준다.
// 부모가 열 때마다 새로 마운트한다 (조건부 렌더).

import { useQueryClient } from '@tanstack/react-query';
import { App, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { api } from '../../api/client';
import type { WorkerPool } from '../../api/types';
import { errorText, invalidateWorkerData } from './shared';

interface Props {
  onCancel: () => void;
  onCreated: (pool: WorkerPool) => void;
}

export default function CreatePoolModal({ onCancel, onCreated }: Props) {
  const queryClient = useQueryClient();
  const { message, notification } = App.useApp();
  const [form] = Form.useForm<{ name: string; description?: string }>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return; // Enter를 연달아 눌러도 한 번만 만든다
    const values = await form.validateFields().catch(() => null); // 검증 실패는 칸 아래에 이미 표시된다
    if (!values) return;
    setBusy(true);
    try {
      const pool = await api.createPool({ name: values.name, description: values.description ?? '' });
      await invalidateWorkerData(queryClient);
      message.success(`Created pool "${pool.name}".`);
      onCreated(pool);
    } catch (error) {
      // createPool의 INVALID_REQUEST는 전부 이름에 관한 것이다 (빈 이름, 중복)
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'INVALID_REQUEST') form.setFields([{ name: 'name', errors: [errorText(error)] }]);
      else notification.error({ message: 'Could not create the pool', description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New pool"
      okText="Create pool"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onCancel}
    >
      <Form form={form} layout="vertical" requiredMark="optional" onFinish={() => void submit()}>
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, whitespace: true, message: 'Pool name is required.' }]}
          extra="Shown in Create › Settings when choosing pools to require or exclude."
        >
          <Input autoFocus maxLength={60} placeholder="e.g. Trusted (pilot round)" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={3} maxLength={300} placeholder="What this pool is for" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
