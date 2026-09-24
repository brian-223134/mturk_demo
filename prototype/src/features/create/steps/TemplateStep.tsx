// 5.2 (1) Template: 저장된 템플릿을 고르거나, .html 업로드 또는 붙여넣기로 새로 만든다.

import { UploadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  Input,
  Segmented,
  Space,
  Table,
  Typography,
  Upload,
  type TableColumnsType,
} from 'antd';
import { useState } from 'react';
import { api } from '../../../api/client';
import type { Template } from '../../../api/types';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import { formatBytes, formatDateTime } from '../../../components/format';
import type { CreateDraft } from '../draft';
import type { DraftUpdate } from '../useCreateDraft';
import PlaceholderTags from './PlaceholderTags';
import StepFooter from './StepFooter';

const SAMPLE_TEMPLATE_NAME = 'Sentence-passage relevance (sample)';
// 케이스 스터디의 템플릿 파일은 확장자만 .py이고 내용은 HTML이다 (7.1)
const TEMPLATE_FILE_TYPES = '.html,.htm,.txt,.py';
const VISIBLE_PLACEHOLDERS = 6;

interface Props {
  draft: CreateDraft;
  update: (change: DraftUpdate) => void;
  templates: Template[] | undefined;
  loading: boolean;
  error: unknown;
  /** draft.templateId에 해당하는 템플릿. 목록을 아직 못 받았거나 지워졌으면 null */
  selected: Template | null;
  onNext: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function TemplateStep({ draft, update, templates, loading, error, selected, onNext }: Props) {
  const queryClient = useQueryClient();
  const { message, notification } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const { editor, templateMode } = draft;
  const editing = editor.id ? (templates?.find((t) => t.id === editor.id) ?? null) : null;
  const nameMissing = editor.name.trim() === '';
  const htmlMissing = editor.html.trim() === '';
  // 편집 중인 내용이 저장본과 같은지. 다르면 Next 전에 저장해야 한다 (placeholder는 저장할 때 계산된다)
  const editorSaved = editing !== null && editing.html === editor.html && editing.name === editor.name.trim();
  const editorSelected = editorSaved && editor.id === draft.templateId;

  const setEditor = (change: Partial<CreateDraft['editor']>) =>
    update((current) => ({ editor: { ...current.editor, ...change } }));

  // 템플릿이 바뀌면 이전 템플릿에서 읽은 문항 목록은 버린다
  const select = (id: string) => update({ templateId: id, answerSchema: [] });

  const readFile = async (file: File) => {
    try {
      const html = await file.text();
      update((current) => ({
        editor: { id: null, name: current.editor.name.trim() || file.name.replace(/\.[^.]+$/, ''), html },
      }));
    } catch (e) {
      notification.error({ message: `Could not read ${file.name}`, description: errorText(e) });
    }
  };

  const loadSample = async () => {
    setLoadingSample(true);
    try {
      // example/ 폴더의 파일을 그대로 쓴다. 사람이 직접 올려 보는 파일과 버튼이 채우는 내용이 같다.
      const { default: html } = await import('../../../../../example/1-task-data/template.html?raw');
      // 시연을 반복해도 같은 템플릿이 계속 쌓이지 않게, 이미 저장된 예시가 있으면 그것을 덮어쓴다
      const existing = templates?.find((t) => t.name === SAMPLE_TEMPLATE_NAME);
      update({
        templateMode: 'new',
        editor: { id: existing?.id ?? null, name: SAMPLE_TEMPLATE_NAME, html },
        // 내용까지 같으면 다시 저장할 것이 없으므로 바로 고른다
        ...(existing && existing.html === html ? { templateId: existing.id, answerSchema: [] } : {}),
      });
      setShowErrors(false);
    } catch (e) {
      notification.error({ message: 'Could not load the sample template', description: errorText(e) });
    } finally {
      setLoadingSample(false);
    }
  };

  const save = async () => {
    setShowErrors(true);
    if (nameMissing || htmlMissing) return;
    if (editorSaved && editor.id) {
      // 이미 저장된 내용 그대로다 (저장된 목록에서 다른 템플릿을 골랐다가 돌아온 경우). 다시 저장하지 않고 고르기만 한다
      select(editor.id);
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveTemplate({ ...(editor.id ? { id: editor.id } : {}), name: editor.name, html: editor.html });
      // 목록을 다시 받기 전에도 선택한 템플릿을 찾을 수 있게 캐시에 먼저 넣는다
      queryClient.setQueryData<Template[]>(['templates'], (old) => [saved, ...(old ?? []).filter((t) => t.id !== saved.id)]);
      update({ templateId: saved.id, answerSchema: [], editor: { id: saved.id, name: saved.name, html: saved.html } });
      setShowErrors(false);
      message.success(`Saved template "${saved.name}".`);
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    } catch (e) {
      notification.error({ message: 'Could not save the template', description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<Template> = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string, template) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {template.id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Placeholders',
      dataIndex: 'placeholders',
      render: (placeholders: string[]) => {
        const hidden = placeholders.length - VISIBLE_PLACEHOLDERS;
        return (
          <Space size={[0, 4]} wrap>
            <PlaceholderTags names={placeholders.slice(0, VISIBLE_PLACEHOLDERS)} />
            {hidden > 0 && <Typography.Text type="secondary">+{hidden} more</Typography.Text>}
          </Space>
        );
      },
    },
    { title: 'Size', key: 'size', width: 100, align: 'right', render: (_, t) => formatBytes(t.html.length) },
    { title: 'Updated', dataIndex: 'updatedAt', width: 160, render: (at: string) => formatDateTime(at) },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_, t) => (
        <Button
          type="link"
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            update({ templateMode: 'new', templateId: t.id, answerSchema: [], editor: { id: t.id, name: t.name, html: t.html } });
          }}
        >
          Edit
        </Button>
      ),
    },
  ];

  const canContinue = selected !== null && (templateMode === 'saved' || editorSelected);
  const hint =
    templateMode === 'new' && !canContinue
      ? editorSaved
        ? 'Click "Use this template" to continue.'
        : 'Save the template to continue.'
      : !selected
        ? 'Choose a template to continue.'
        : undefined;

  return (
    <Card
      title="Template"
      extra={
        <Button onClick={() => void loadSample()} loading={loadingSample}>
          Load sample template
        </Button>
      }
    >
      <Segmented
        value={templateMode}
        onChange={(value) => update({ templateMode: value as CreateDraft['templateMode'] })}
        options={[
          { value: 'saved', label: 'Use a saved template' },
          { value: 'new', label: 'Upload or paste HTML' },
        ]}
        style={{ marginBottom: 16 }}
      />

      {templateMode === 'saved' ? (
        <>
          <QueryErrorAlert error={error} />
          <Table
            rowKey="id"
            columns={columns}
            dataSource={templates}
            loading={loading}
            pagination={false}
            size="middle"
            rowSelection={{
              type: 'radio',
              selectedRowKeys: draft.templateId ? [draft.templateId] : [],
              onChange: (keys) => keys[0] !== undefined && select(String(keys[0])),
            }}
            onRow={(template) => ({ onClick: () => select(template.id), style: { cursor: 'pointer' } })}
          />
        </>
      ) : (
        <Form layout="vertical" component="div">
          {editor.id && !editorSaved && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={
                <>
                  Editing saved template <Typography.Text code>{editor.id}</Typography.Text>. Saving overwrites it;
                  batches that were already published keep their own copy.
                </>
              }
              action={
                <Button size="small" onClick={() => setEditor({ id: null })}>
                  Save as a new template instead
                </Button>
              }
            />
          )}
          <Flex gap={16} align="flex-start">
            <Form.Item
              label="Template name"
              required
              style={{ flex: 1, maxWidth: 520 }}
              validateStatus={showErrors && nameMissing ? 'error' : undefined}
              help={showErrors && nameMissing ? 'Enter a name for the template.' : undefined}
            >
              <Input
                value={editor.name}
                onChange={(event) => setEditor({ name: event.target.value })}
                placeholder="e.g. Chunk-Fact Relevance v2"
                maxLength={120}
              />
            </Form.Item>
            <Form.Item label="From a file">
              <Upload
                accept={TEMPLATE_FILE_TYPES}
                showUploadList={false}
                // 서버로 올리지 않고 브라우저에서 읽기만 한다
                beforeUpload={(file) => {
                  void readFile(file);
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />}>Upload .html</Button>
              </Upload>
            </Form.Item>
          </Flex>
          <Form.Item
            label="Template HTML"
            required
            validateStatus={showErrors && htmlMissing ? 'error' : undefined}
            help={
              showErrors && htmlMissing ? (
                'Upload a file or paste the HTML.'
              ) : (
                <>
                  One HTML file with the instructions and the question UI. Use <Typography.Text code>{'${column}'}</Typography.Text>{' '}
                  placeholders (MTurk style) or read <Typography.Text code>window.TASK_DATA</Typography.Text>.
                </>
              )
            }
          >
            <Input.TextArea
              value={editor.html}
              onChange={(event) => setEditor({ html: event.target.value })}
              placeholder="Paste the template HTML here"
              rows={14}
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
            />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={() => void save()} loading={saving} disabled={editorSelected}>
              {editorSaved ? 'Use this template' : editor.id ? 'Save changes' : 'Save template'}
            </Button>
            <Typography.Text type="secondary">
              {editorSaved ? 'Saved.' : `${formatBytes(editor.html.length)}. Placeholders are extracted when you save.`}
            </Typography.Text>
          </Space>
        </Form>
      )}

      {selected && (templateMode === 'saved' || canContinue) && (
        <Descriptions
          bordered
          size="small"
          column={1}
          style={{ marginTop: 24 }}
          styles={{ label: { width: 200 } }}
          items={[
            { key: 'name', label: 'Selected template', children: <Typography.Text strong>{selected.name}</Typography.Text> },
            {
              key: 'placeholders',
              label: `Placeholders (${selected.placeholders.length})`,
              children: <PlaceholderTags names={selected.placeholders} />,
            },
            { key: 'size', label: 'Size', children: `${formatBytes(selected.html.length)}, updated ${formatDateTime(selected.updatedAt)}` },
          ]}
        />
      )}

      <StepFooter onNext={onNext} nextDisabled={!canContinue} hint={hint} />
    </Card>
  );
}
