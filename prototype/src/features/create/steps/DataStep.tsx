// 5.2 (2) Data: CSV 업로드와 placeholder 검증

import { FileTextOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Flex, Space, Table, Tag, Tooltip, Typography, Upload, type TableColumnsType } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import type { Template } from '../../../api/types';
import { formatBytes } from '../../../components/format';
import { QUESTION_SIZE_LIMIT_BYTES, type DataCheck } from '../../../domain/dataCheck';
import { CsvError, parseCsv, readCsvFile, type CsvData } from '../csv';
import type { DraftUpdate } from '../useCreateDraft';
import PlaceholderTags from './PlaceholderTags';
import StepFooter from './StepFooter';

const PREVIEW_ROWS = 5;
const INDEX_COLUMN_WIDTH = 56;
const DATA_COLUMN_WIDTH = 240;
// 셀 하나가 100KB를 넘기도 한다 (9장). 표와 tooltip에는 잘라서 넣는다.
const CELL_CHARS = 80;
const TOOLTIP_CHARS = 1000;
const LISTED_ITEMS = 8;

interface Props {
  template: Template;
  data: CsvData | null;
  check: DataCheck | null;
  update: (change: DraftUpdate) => void;
  onBack: () => void;
  onNext: () => void;
}

const LEVELS = {
  ok: { color: 'success', label: 'OK' },
  error: { color: 'error', label: 'ERROR' },
  warn: { color: 'warning', label: 'WARN' },
  info: { color: 'processing', label: 'INFO' },
} as const;

function CheckLine({ level, children }: { level: keyof typeof LEVELS; children: ReactNode }) {
  return (
    <Flex gap={12} align="flex-start" style={{ padding: '10px 0', borderTop: '1px solid #f0f0f0' }}>
      <Tag color={LEVELS[level].color} style={{ width: 60, textAlign: 'center', marginInlineEnd: 0, flex: 'none' }}>
        {LEVELS[level].label}
      </Tag>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </Flex>
  );
}

function listSome(items: string[]): string {
  const shown = items.slice(0, LISTED_ITEMS).join(', ');
  return items.length > LISTED_ITEMS ? `${shown}, … (+${items.length - LISTED_ITEMS} more)` : shown;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function PreviewCell({ text }: { text: string }) {
  if (text === '') return <Typography.Text type="secondary">(empty)</Typography.Text>;
  if (text.length <= CELL_CHARS) return <>{text}</>;
  const tip =
    text.length > TOOLTIP_CHARS
      ? `${text.slice(0, TOOLTIP_CHARS)}… (${text.length.toLocaleString()} characters in total)`
      : text;
  return (
    <Tooltip title={tip} styles={{ root: { maxWidth: 560 }, body: { maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' } }}>
      <span>{truncate(text, CELL_CHARS)}</span>
    </Tooltip>
  );
}

export default function DataStep({ template, data, check, update, onBack, onNext }: Props) {
  const { notification } = App.useApp();
  const [reading, setReading] = useState(false);
  const usesTaskData = template.placeholders.length === 0;

  const accept = (next: CsvData) => update({ data: next, previewRow: 0 });

  const fail = (what: string, error: unknown) =>
    notification.error({
      message: `Could not read ${what}`,
      description: error instanceof CsvError || error instanceof Error ? error.message : String(error),
    });

  const readFile = async (file: File) => {
    setReading(true);
    try {
      accept(await readCsvFile(file));
    } catch (error) {
      fail(file.name, error);
    } finally {
      setReading(false);
    }
  };

  const loadSample = async () => {
    setReading(true);
    try {
      // example/ 폴더의 파일을 그대로 쓴다. 사람이 직접 올려 보는 파일과 버튼이 채우는 내용이 같다.
      const { default: text } = await import('../../../../../example/1-task-data/data.csv?raw');
      accept(parseCsv(text, 'data.csv'));
    } catch (error) {
      fail('the sample CSV', error);
    } finally {
      setReading(false);
    }
  };

  const columns = useMemo<TableColumnsType<{ index: number; row: Record<string, string> }>>(
    () => [
      { title: '#', key: 'index', width: INDEX_COLUMN_WIDTH, fixed: 'left', align: 'right', render: (_, r) => r.index + 1 },
      ...(data?.columns ?? []).map((name) => ({
        title: name,
        key: `col:${name}`,
        width: DATA_COLUMN_WIDTH,
        ellipsis: true,
        render: (_: unknown, r: { row: Record<string, string> }) => <PreviewCell text={r.row[name] ?? ''} />,
      })),
    ],
    [data],
  );
  const previewRows = useMemo(
    () => (data?.rows ?? []).slice(0, PREVIEW_ROWS).map((row, index) => ({ index, row })),
    [data],
  );

  const blocked = !data || !check || check.missingColumns.length > 0;

  return (
    <Card
      title="Data"
      extra={
        <Button onClick={() => void loadSample()} loading={reading}>
          Load sample CSV
        </Button>
      }
    >
      <Upload.Dragger
        accept=".csv,text/csv"
        multiple={false}
        showUploadList={false}
        disabled={reading}
        // 서버로 올리지 않고 브라우저에서 읽기만 한다
        beforeUpload={(file) => {
          void readFile(file);
          return false;
        }}
        style={{ padding: '4px 0' }}
      >
        {data ? (
          // 파일을 올린 뒤에는 검증 결과가 바로 보이게 낮춘다
          <p className="ant-upload-hint" style={{ margin: 0 }}>
            <InboxOutlined /> Drop another CSV here, or click to replace {data.fileName}
          </p>
        ) : (
          <>
            <p className="ant-upload-drag-icon" style={{ marginBottom: 8 }}>
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Drop a CSV file here, or click to choose one</p>
            <p className="ant-upload-hint">
              One row becomes one HIT. The header row names the columns. UTF-8; large cells are fine.
            </p>
          </>
        )}
      </Upload.Dragger>

      {data && check && (
        <>
          <Flex justify="space-between" align="center" style={{ marginTop: 16 }}>
            <Space size="middle">
              <Typography.Text strong>
                <FileTextOutlined /> {data.fileName}
              </Typography.Text>
              <Typography.Text>
                {check.rowCount.toLocaleString()} rows, {check.columnCount} columns, UTF-8{data.hadBom ? ' (BOM removed)' : ''}
              </Typography.Text>
            </Space>
            <Button size="small" onClick={() => update({ data: null, previewRow: 0 })}>
              Remove
            </Button>
          </Flex>

          {data.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="The file was read with warnings"
              description={
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {data.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              }
            />
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Placeholder check
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Template: {template.name}
          </Typography.Paragraph>
          <div style={{ borderBottom: '1px solid #f0f0f0' }}>
            {check.missingColumns.length > 0 && (
              <CheckLine level="error">
                <div>{check.missingColumns.length} placeholder(s) have no matching CSV column:</div>
                <PlaceholderTags names={check.missingColumns} color="error" />
                <div style={{ marginTop: 4 }}>
                  <Typography.Text type="secondary">
                    An unsubstituted <Typography.Text code>{'${x}'}</Typography.Text> stays in the page as it is and
                    breaks the template's JavaScript. Add the column(s) to the CSV, or go back and choose another
                    template.
                  </Typography.Text>
                </div>
              </CheckLine>
            )}
            {usesTaskData ? (
              <CheckLine level="ok">
                This template has no <Typography.Text code>{'${...}'}</Typography.Text> placeholders. It reads the row
                from <Typography.Text code>window.TASK_DATA</Typography.Text>, so there is nothing to match.
              </CheckLine>
            ) : (
              check.matchedPlaceholders.length > 0 && (
                <CheckLine level={check.missingColumns.length > 0 ? 'info' : 'ok'}>
                  <div>
                    {check.matchedPlaceholders.length}/{template.placeholders.length} matched with a CSV column:
                  </div>
                  <PlaceholderTags names={check.matchedPlaceholders} />
                </CheckLine>
              )
            )}
            {check.unusedColumns.length > 0 && (
              <CheckLine level={usesTaskData ? 'info' : 'warn'}>
                {usesTaskData ? (
                  <>
                    {check.unusedColumns.length} column(s) are available to the template through{' '}
                    <Typography.Text code>window.TASK_DATA</Typography.Text>: {listSome(check.unusedColumns)}. Not a
                    problem.
                  </>
                ) : (
                  <>
                    {check.unusedColumns.length} column(s) not used by the template: {listSome(check.unusedColumns)}.
                    They are still stored with each HIT.
                  </>
                )}
              </CheckLine>
            )}
            {check.rowsWithEmptyCells.length > 0 && (
              <CheckLine level="warn">
                {check.rowsWithEmptyCells.length} row(s) have empty cells: row{' '}
                {listSome(check.rowsWithEmptyCells.map((index) => String(index + 1)))}.
              </CheckLine>
            )}
            <CheckLine level={check.rowsOverQuestionLimit > 0 ? 'warn' : 'info'}>
              Row input size: median {formatBytes(Math.round(check.rowSizeMedianBytes))}, max{' '}
              {formatBytes(check.rowSizeMaxBytes)}.
              {check.rowsOverQuestionLimit > 0 && (
                <>
                  {' '}
                  {check.rowsOverQuestionLimit} row(s) exceed MTurk's {QUESTION_SIZE_LIMIT_BYTES / 1024} KB{' '}
                  <Typography.Text code>Question</Typography.Text> limit, so the MTurk integration will have to publish
                  this batch as an ExternalQuestion. The mock environment is not affected.
                </>
              )}
            </CheckLine>
          </div>

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Preview (first {Math.min(PREVIEW_ROWS, data.rows.length)} rows)
          </Typography.Title>
          <Table
            rowKey="index"
            columns={columns}
            dataSource={previewRows}
            pagination={false}
            size="small"
            bordered
            // 컬럼 폭을 고정해 여러 컬럼이 한눈에 들어오게 하고, 넘치면 가로로 스크롤한다
            scroll={{ x: INDEX_COLUMN_WIDTH + data.columns.length * DATA_COLUMN_WIDTH }}
            tableLayout="fixed"
          />
        </>
      )}

      <StepFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={blocked}
        hint={!data ? 'Upload a CSV to continue.' : blocked ? 'Fix the missing columns to continue.' : undefined}
      />
    </Card>
  );
}
