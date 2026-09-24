// 5.1의 Mock tools. mock 환경에서만 보인다.

import { DownOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Dropdown, Form, InputNumber, Modal, Select, type MenuProps } from 'antd';
import { useRef, useState } from 'react';
import { api, apiMode, mockTools } from '../api/client';
import { downloadFile } from './download';
import { formatDateTime } from './format';

const BACKEND_LABELS = { sqlite: 'SQLite (server)', indexeddb: 'IndexedDB (this browser)', memory: 'Memory' };

export default function MockToolsMenu() {
  const queryClient = useQueryClient();
  const { modal, message, notification } = App.useApp();
  const [fakeOpen, setFakeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [form] = Form.useForm<{ count: number; batchId: string }>();

  const info = useQuery({ queryKey: ['mock-store-info'], queryFn: () => mockTools.getInfo() });
  const batches = useQuery({ queryKey: ['batches'], queryFn: () => api.listBatches(), enabled: fakeOpen });

  // 보고 있지 않은 화면의 캐시는 버려서 이전 데이터가 잠깐이라도 보이지 않게 하고, 보고 있는 화면은
  // 새 데이터가 올 때까지 기존 내용을 유지한다 (resetQueries는 헤더의 배지와 이 메뉴까지 깜빡이게 한다).
  const refreshAll = async () => {
    queryClient.removeQueries({ type: 'inactive' });
    await queryClient.invalidateQueries();
  };

  const showError = (title: string, error: unknown) =>
    notification.error({ message: title, description: error instanceof Error ? error.message : String(error) });

  const confirmReset = () => {
    modal.confirm({
      title: 'Reset to fixtures?',
      content:
        'All changes (reviews, new batches, templates, pools) are discarded and the contents of the data/ folder are loaded again.',
      okText: 'Reset',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await mockTools.reset();
          await refreshAll();
          message.success('Reset to fixtures.');
        } catch (error) {
          showError('Reset failed', error);
        }
      },
    });
  };

  const generate = async () => {
    const { count, batchId } = await form.validateFields();
    setBusy(true);
    try {
      const result = await mockTools.generateFakeSubmissions({ count, batchId: batchId === 'all' ? undefined : batchId });
      await refreshAll();
      setFakeOpen(false);
      const where = result.byBatch.map((b) => `${b.created} in "${b.batchName}"`).join(', ');
      if (result.created === 0) {
        notification.warning({ message: 'No submissions created', description: result.note });
      } else {
        notification.success({
          message: `Created ${result.created} of ${result.requested} fake submissions`,
          description: [where, result.note].filter(Boolean).join('. '),
        });
      }
    } catch (error) {
      showError('Could not generate submissions', error);
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    try {
      downloadFile(await mockTools.exportState());
    } catch (error) {
      showError('Export failed', error);
    }
  };

  const importData = (file: File) => {
    modal.confirm({
      title: 'Import data?',
      content: `The current data is replaced with the contents of ${file.name}.`,
      okText: 'Import',
      onOk: async () => {
        try {
          const result = await mockTools.importState(await file.text());
          await refreshAll();
          message.success(`Imported ${result.counts.batches} batches, ${result.counts.assignments} assignments.`);
        } catch (error) {
          showError('Import failed', error);
        }
      },
    });
  };

  const items: MenuProps['items'] = [
    { key: 'fake', label: 'Generate fake submissions…', onClick: () => setFakeOpen(true) },
    { type: 'divider' },
    { key: 'export', label: 'Export data (JSON)', onClick: () => void exportData() },
    { key: 'import', label: 'Import data (JSON)…', onClick: () => fileInput.current?.click() },
    { key: 'reset', label: 'Reset to fixtures', danger: true, onClick: confirmReset },
    { type: 'divider' },
    {
      key: 'info',
      disabled: true,
      label: info.data ? (
        <span style={{ fontSize: 12, lineHeight: 1.5, display: 'inline-block' }}>
          API: {apiMode} · Store: {BACKEND_LABELS[info.data.backend]}
          <br />
          {info.data.source === 'snapshot' ? 'Restored saved state' : 'Loaded from data/'}
          {' · '}
          {formatDateTime(info.data.savedAt ?? info.data.seededAt, true)}
        </span>
      ) : (
        '…'
      ),
    },
  ];

  return (
    <>
      <Dropdown menu={{ items }} trigger={['click']}>
        <Button size="small">
          Mock tools <DownOutlined />
        </Button>
      </Dropdown>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ''; // 같은 파일을 다시 골라도 onChange가 불리게
          if (file) importData(file);
        }}
      />

      <Modal
        title="Generate fake submissions"
        open={fakeOpen}
        onCancel={() => setFakeOpen(false)}
        onOk={() => void generate()}
        okText="Generate"
        confirmLoading={busy}
        destroyOnHidden
      >
        <p style={{ marginTop: 0 }}>
          Creates <b>Submitted</b> assignments on HITs that still have open slots, so the review flow can be tried
          without real workers. Attention checks are answered correctly 85% of the time, other questions at random.
          Worker pools of the batch are respected.
        </p>
        <Form form={form} layout="vertical" initialValues={{ count: 20, batchId: 'all' }}>
          <Form.Item name="count" label="How many" rules={[{ required: true, type: 'integer', min: 1, max: 5000 }]}>
            <InputNumber min={1} max={5000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="batchId" label="Batch">
            <Select
              loading={batches.isLoading}
              options={[
                { value: 'all', label: 'Any batch with open assignments' },
                ...(batches.data ?? []).map((b) => ({
                  value: b.batch.id,
                  label: `${b.batch.name} (${b.progress.open} open${b.status === 'expired' ? ', expired' : ''})`,
                })),
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
